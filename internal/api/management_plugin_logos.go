package api

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

/**
 * Plugin-declared logos are fetched here, by the process, rather than by the
 * browser that renders them.
 *
 * A plugin publishes its logo as an absolute URL, usually on a CDN, and the console
 * needs the plugin's own mark: a provider's brand is the plugin's to declare, and the
 * console's vendored icon catalog cannot be updated by installing a plugin. But the
 * bundle's contract is that a deployment has no CDN or static-file dependency - the
 * SPA is served from the Go binary, and its own CSP allows images only from itself or
 * inline (`img-src 'self' data: blob:`) - so a browser-side fetch of that URL would
 * both break offline operation and contradict the policy the console is served under.
 *
 * Fetching it here resolves the two: the mark is the plugin's, and the browser only
 * ever loads an inline `data:` URL. The response is bounded, must be an image type
 * this console is willing to render, and is cached - including failures, since the
 * console polls the plugin list and an unreachable host must not be retried on every
 * poll. A logo that cannot be inlined is reported as absent, which is what makes the
 * surfaces fall back to the catalog mark.
 */

const (
	// maxPluginLogoBytes bounds what one logo may add to a plugin-list response. A
	// brand mark is a few kilobytes; the ceiling exists so a hostile or broken host
	// cannot make the console buffer something else entirely.
	maxPluginLogoBytes = 512 * 1024
	// pluginLogoFetchTimeout bounds one fetch. It is short because this fetch sits
	// inside the plugin-list request the console polls: a slow host must not become a
	// slow console.
	pluginLogoFetchTimeout = 5 * time.Second
	// pluginLogoCachingTTL is how long an inlined logo - or the knowledge that it
	// cannot be inlined - is reused before the host is asked again.
	pluginLogoCachingTTL = time.Hour
	// maxPluginLogoCacheEntries bounds the cache's memory. Logos are strings in a map,
	// and a deployment has a handful of plugins; the cap is what keeps a plugin list
	// that keeps changing from growing it without bound.
	maxPluginLogoCacheEntries = 64
	// maxPluginLogosPerFetch bounds the parallel fetches one plugin list may start.
	maxPluginLogosPerFetch = 8
	// maxPluginLogoRedirects mirrors the model-pull ceiling: a redirect chain is
	// followed only within the same origin, and only this far.
	maxPluginLogoRedirects = 5
)

var (
	errPluginLogoRedirectRefused = errors.New("plugin logo redirect refused")
	errPluginLogoAddressRefused  = errors.New("plugin logo address refused")
	// errPluginLogoUnusable is a definitive answer about the logo itself - the scheme is
	// not fetchable, the host said no, the response is not an image, it is too large.
	// It is cached, because a retry would ask the same question and get the same answer.
	errPluginLogoUnusable = errors.New("plugin logo is not usable")
)

// renderableLogoMediaTypes is the allowlist of image types a plugin logo may be
// inlined as. Anything else - including `text/html`, `image/svg+xml`'s script-bearing
// cousins, or an unlabelled `application/octet-stream` - is refused rather than
// sniffed: the point of the allowlist is that the value reaching the DOM is known to
// be an image. An SVG is inert in an `<img>`, which is the only way the console
// renders one.
var renderableLogoMediaTypes = map[string]bool{
	"image/svg+xml":            true,
	"image/png":                true,
	"image/jpeg":               true,
	"image/gif":                true,
	"image/webp":               true,
	"image/avif":               true,
	"image/x-icon":             true,
	"image/vnd.microsoft.icon": true,
}

type pluginLogoCacheEntry struct {
	// dataURL is the inlined logo, or empty when this URL could not be inlined.
	// Empty is cached deliberately: a broken logo must not be refetched per poll.
	dataURL   string
	expiresAt time.Time
}

// pluginLogoFetcher inlines plugin-declared logos for the plugin list.
//
// It is safe for concurrent use, and it holds the only mutable state the plugin
// facade keeps: the previously resolved logos.
type pluginLogoFetcher struct {
	client *http.Client
	now    func() time.Time

	mu      sync.Mutex
	entries map[string]pluginLogoCacheEntry
}

func newPluginLogoFetcher() *pluginLogoFetcher {
	dialer := &net.Dialer{
		Timeout: pluginLogoFetchTimeout,
		// The address check happens where the connection is made, after resolution, so
		// a hostname that resolves into the operator's network is refused there rather
		// than trusted because the name looked public.
		Control: pluginLogoDialControl,
	}
	return &pluginLogoFetcher{
		client: &http.Client{
			Timeout: pluginLogoFetchTimeout,
			// No proxy from the environment, deliberately. Through one, the connection is
			// made to the proxy and `pluginLogoDialControl` would be asked about the
			// proxy's address rather than the target's - which is exactly the check that
			// makes a plugin-declared URL unable to reach the operator's network. A
			// deployment that mandates an egress proxy therefore cannot inline plugin
			// logos and falls back to the bundled mark, which is the safe direction.
			Transport:     &http.Transport{DialContext: dialer.DialContext},
			CheckRedirect: sameOriginRedirectGuard(errPluginLogoRedirectRefused, maxPluginLogoRedirects),
		},
		now:     time.Now,
		entries: make(map[string]pluginLogoCacheEntry),
	}
}

// pluginLogoDialControl is the dial-time half of the destination policy; see
// outbound_fetch.go for why a plugin-declared URL is held to a stricter rule than an
// operator-typed one.
func pluginLogoDialControl(_ string, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return errPluginLogoAddressRefused
	}
	if !isResolvedAddressAllowed(net.ParseIP(host)) {
		return errPluginLogoAddressRefused
	}
	return nil
}

// isPluginLogoURLAllowed is the name-checked half of the policy. A literal internal
// address is refused here; a name that resolves into internal space is refused at dial
// time, which is what closes the gap between "looks public" and "is public".
func isPluginLogoURLAllowed(parsed *url.URL) bool {
	if parsed == nil {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return !isInternalAddressLiteral(parsed.Hostname())
	case "http":
		return isLoopbackPlaintextHostAllowed(parsed.Hostname())
	default:
		return false
	}
}

// isInternalAddressLiteral reports whether a host string is a literal address inside
// the operator's own network.
func isInternalAddressLiteral(host string) bool {
	address := hostAddressLiteral(host)
	return address != nil && !isResolvedAddressAllowed(address)
}

// inline replaces every plugin's declared logo with an inline `data:` URL, or clears
// it when no usable logo could be produced.
//
// The plugin list itself is never failed by a logo: a plugin whose artwork cannot be
// fetched is still a plugin the operator can manage, and the console falls back to the
// catalog mark for its provider.
func (f *pluginLogoFetcher) inline(ctx context.Context, plugins []management.PluginItem) {
	if f == nil {
		return
	}
	// Distinct targets only: two plugins may publish the same logo URL, and the cache
	// would otherwise be asked twice for the same answer in the same call.
	targets := make([]string, 0, len(plugins))
	seen := make(map[string]int, len(plugins))
	perPlugin := make([]int, len(plugins))
	for index := range plugins {
		raw := pluginLogoURL(plugins[index])
		if raw == "" {
			perPlugin[index] = -1
			continue
		}
		if target, ok := seen[raw]; ok {
			perPlugin[index] = target
			continue
		}
		seen[raw] = len(targets)
		perPlugin[index] = len(targets)
		targets = append(targets, raw)
	}

	// One deadline for the whole plugin list, not one per logo: this fetch sits inside an
	// endpoint the console polls, so what has to be bounded is the response, not each
	// request. Whatever has not resolved when the budget runs out is reported as absent
	// (and deliberately not cached), which leaves the catalog mark on screen.
	fetchCtx, cancel := context.WithTimeout(ctx, pluginLogoFetchTimeout)
	defer cancel()

	inlined := f.resolveAll(fetchCtx, targets)

	for index := range plugins {
		resolved := ""
		if target := perPlugin[index]; target >= 0 {
			resolved = inlined[target]
		}
		// Both places the list reports a logo carry the same resolved value, so a
		// consumer reading either field cannot see a URL the browser may not load.
		plugins[index].Logo = resolved
		if plugins[index].Metadata != nil {
			plugins[index].Metadata.Logo = resolved
		}
	}
}

// resolveAll resolves each target, with bounded parallelism.
//
// Each worker writes its own slot, so the results need no lock: the shared state is
// the cache inside the fetcher, which guards itself.
func (f *pluginLogoFetcher) resolveAll(ctx context.Context, targets []string) []string {
	results := make([]string, len(targets))
	if len(targets) == 0 {
		return results
	}
	workers := len(targets)
	if workers > maxPluginLogosPerFetch {
		workers = maxPluginLogosPerFetch
	}

	slots := make(chan int)
	var waitGroup sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for index := range slots {
				results[index], _ = f.dataURL(ctx, targets[index])
			}
		}()
	}
	for index := range targets {
		slots <- index
	}
	close(slots)
	waitGroup.Wait()
	return results
}

// dataURL returns the inline logo for one URL, from the cache when it is fresh. A false
// result means "no usable logo", never "retry immediately".
func (f *pluginLogoFetcher) dataURL(ctx context.Context, raw string) (string, bool) {
	if _, ok := inlineImageMediaType(raw); ok {
		// Self-contained artwork: the plugin already published something the browser
		// can load, so there is nothing to fetch and nothing to cache.
		return raw, true
	}
	now := f.now()

	f.mu.Lock()
	if entry, ok := f.entries[raw]; ok && now.Before(entry.expiresAt) {
		f.mu.Unlock()
		return entry.dataURL, entry.dataURL != ""
	}
	f.mu.Unlock()

	inlined, err := f.fetch(ctx, raw)

	f.mu.Lock()
	// Everything is cached except a budget that ran out: running out of time is not an
	// answer about the logo, and caching it would cost the plugin its mark for an hour
	// because one poll was slow. An unreachable host is cached, which is what keeps a
	// poll from hammering it.
	if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		f.store(raw, pluginLogoCacheEntry{dataURL: inlined, expiresAt: f.now().Add(pluginLogoCachingTTL)})
	}
	f.mu.Unlock()
	return inlined, err == nil
}

// store writes one entry, evicting expired ones first and then, if the cache is still
// at its cap, dropping it entirely. Dropping everything is deliberate: the alternative
// is a recency policy no caller needs, and a plugin list is small enough that refilling
// costs a handful of fetches.
func (f *pluginLogoFetcher) store(raw string, entry pluginLogoCacheEntry) {
	if _, exists := f.entries[raw]; !exists && len(f.entries) >= maxPluginLogoCacheEntries {
		now := f.now()
		for key, existing := range f.entries {
			if now.After(existing.expiresAt) {
				delete(f.entries, key)
			}
		}
		if len(f.entries) >= maxPluginLogoCacheEntries {
			f.entries = make(map[string]pluginLogoCacheEntry)
		}
	}
	f.entries[raw] = entry
}

// fetch retrieves one logo and inlines it. It reports errPluginLogoUnusable for a
// definitive refusal, and the transport's own error otherwise, so the caller can tell
// an answer about the logo from a fetch that did not get one.
func (f *pluginLogoFetcher) fetch(ctx context.Context, raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || !isPluginLogoURLAllowed(parsed) {
		return "", errPluginLogoUnusable
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return "", errPluginLogoUnusable
	}
	// A logo is fetched, not negotiated: an explicit image preference keeps a host
	// that content-negotiates from answering with a page.
	request.Header.Set("Accept", "image/*")

	response, err := f.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return "", errPluginLogoUnusable
	}
	mediaType, ok := renderableLogoMediaType(response.Header.Get("Content-Type"))
	if !ok {
		return "", errPluginLogoUnusable
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxPluginLogoBytes+1))
	if err != nil {
		return "", err
	}
	if len(body) == 0 || len(body) > maxPluginLogoBytes {
		return "", errPluginLogoUnusable
	}

	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(body), nil
}

// renderableLogoMediaType narrows a Content-Type header to the media type allowlist.
func renderableLogoMediaType(header string) (string, bool) {
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(header))
	if err != nil {
		return "", false
	}
	mediaType = strings.ToLower(mediaType)
	if !renderableLogoMediaTypes[mediaType] {
		return "", false
	}
	return mediaType, true
}

// pluginLogoURL is the URL a plugin publishes for its own mark, preferring the entry
// the store installs over the registration metadata's copy. An empty result means the
// plugin publishes nothing this console can render.
func pluginLogoURL(plugin management.PluginItem) string {
	candidate := strings.TrimSpace(plugin.Logo)
	if candidate == "" && plugin.Metadata != nil {
		candidate = strings.TrimSpace(plugin.Metadata.Logo)
	}
	if candidate == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(candidate), "data:") {
		// Already inline: self-contained artwork, so there is nothing to fetch. It is
		// still checked, because this value is served to a browser as-is.
		if _, ok := inlineImageMediaType(candidate); !ok {
			return ""
		}
	}
	return candidate
}

// inlineImageMediaType reports the media type of an inline `data:` image URL, and
// whether the console is willing to render it.
//
// The payload is measured against the same ceiling a fetched logo is held to, or a
// plugin could bypass the bound by publishing the artwork inline instead of at a URL:
// this value is forwarded to the browser as it stands.
func inlineImageMediaType(raw string) (string, bool) {
	rest, found := strings.CutPrefix(raw, "data:")
	if !found {
		return "", false
	}
	header, payload, found := strings.Cut(rest, ",")
	if !found || len(payload) == 0 || len(payload) > maxPluginLogoBytes {
		return "", false
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.SplitN(header, ";", 2)[0]))
	if !renderableLogoMediaTypes[mediaType] {
		return "", false
	}
	return mediaType, true
}
