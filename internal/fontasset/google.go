package fontasset

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/publicsuffix"
)

// Installing from Google Fonts is a download made by this process, never by the
// browser: the console's contract is that a page it serves loads nothing from another
// origin, and that a deployment keeps working with no network once it is installed.
// The server fetches the family's stylesheet once, downloads every file the stylesheet
// names - for a CJK family that is about a hundred `unicode-range` slices per weight,
// the same cut the built-in typeface uses - and the console serves them from its own
// origin from then on. The operator's browser never contacts Google.

// DefaultGoogleFontsURL is the stylesheet API the installer reads. A deployment that
// cannot reach it can name a compatible mirror with OMCPA_GOOGLE_FONTS_URL.
const DefaultGoogleFontsURL = "https://fonts.googleapis.com"

// GoogleWeights are the two weights the console draws: its type scale uses regular
// and bold only, so installing more would store files nothing reads.
var GoogleWeights = []int{400, 700}

const (
	maxStylesheetBytes = 2 * 1024 * 1024
	// MaxInstallBytes bounds one installed family. A two-weight CJK family is about
	// 15 MiB of woff2 slices.
	MaxInstallBytes  = 96 * 1024 * 1024
	maxInstallFaces  = 600
	installParallel  = 8
	installTimeout   = 3 * time.Minute
	stylesheetAgent  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
	maxRedirectCount = 3
)

var (
	ErrGoogleFamilyMissing = errors.New("font_google_family_not_found")
	ErrGoogleUnreachable   = errors.New("font_google_unreachable")
)

// Face is one `@font-face` rule with its file.
type Face struct {
	WeightMin    int
	WeightMax    int
	Italic       bool
	UnicodeRange string
	Format       Format
	Content      []byte
}

// GoogleInstaller downloads a family from Google Fonts or a compatible mirror.
type GoogleInstaller struct {
	base   *url.URL
	client *http.Client
}

// NewGoogleInstaller builds an installer for a stylesheet API base URL. The client
// honours the process's proxy environment: the hosts are fixed rather than chosen by
// a request, and a deployment behind an egress proxy is exactly the one that needs it.
func NewGoogleInstaller(baseURL string, transport http.RoundTripper) (*GoogleInstaller, error) {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultGoogleFontsURL
	}
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" || base.User != nil {
		return nil, fmt.Errorf("google fonts URL must be an http(s) URL, got %q", baseURL)
	}
	installer := &GoogleInstaller{base: base}
	installer.client = &http.Client{
		Transport: transport,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirectCount || !installer.isAllowedHost(request.URL) {
				return errors.New("font redirect refused")
			}
			return nil
		},
	}
	return installer, nil
}

// isAllowedHost keeps every download on the stylesheet API's own site or on Google's
// static font hosts. The stylesheet decides which URLs are fetched, so without this a
// compromised or misconfigured mirror could point the server at any address.
func (g *GoogleInstaller) isAllowedHost(target *url.URL) bool {
	if target == nil || target.User != nil {
		return false
	}
	if target.Scheme != "https" && !(target.Scheme == g.base.Scheme && target.Host == g.base.Host) {
		return false
	}
	host := strings.ToLower(target.Hostname())
	switch host {
	case "fonts.gstatic.com", "fonts.gstatic.cn", "fonts.googleapis.com", "fonts.googleapis.cn":
		return true
	}
	baseHost := strings.ToLower(g.base.Hostname())
	if host == baseHost {
		return true
	}
	// Private suffixes separate tenants just like ICANN suffixes separate sites.
	// Unlisted local suffixes have no shared-site boundary; only the exact host is trusted.
	suffix, isICANN := publicsuffix.PublicSuffix(baseHost)
	if !isICANN && !strings.Contains(suffix, ".") {
		return false
	}
	baseSite, baseErr := publicsuffix.EffectiveTLDPlusOne(baseHost)
	targetSite, targetErr := publicsuffix.EffectiveTLDPlusOne(host)
	return baseErr == nil && targetErr == nil && baseSite == targetSite
}

// Install downloads one family's regular and bold faces.
func (g *GoogleInstaller) Install(ctx context.Context, family string) (string, []Face, error) {
	family, err := CleanFamily(family)
	if err != nil {
		return "", nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()
	stylesheet, err := g.stylesheet(ctx, family+":wght@"+joinWeights(GoogleWeights))
	if errors.Is(err, ErrGoogleFamilyMissing) {
		// A family published in one weight only answers 400 to a request for two;
		// asking for the family alone returns the weight it has.
		stylesheet, err = g.stylesheet(ctx, family)
	}
	if err != nil {
		return "", nil, err
	}
	rules, err := ParseStylesheet(stylesheet)
	if err != nil {
		return "", nil, err
	}
	if len(rules) == 0 || len(rules) > maxInstallFaces {
		return "", nil, ErrGoogleFamilyMissing
	}
	resolvedFamily := rules[0].Family
	for _, rule := range rules {
		if !g.isAllowedHost(rule.URL) {
			return "", nil, ErrGoogleUnreachable
		}
	}
	faces := make([]Face, len(rules))
	var (
		total     int64
		totalLock sync.Mutex
		firstErr  error
		wait      sync.WaitGroup
	)
	slots := make(chan struct{}, installParallel)
	for index, rule := range rules {
		wait.Add(1)
		go func() {
			defer wait.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			content, err := g.download(ctx, rule.URL)
			totalLock.Lock()
			defer totalLock.Unlock()
			if err == nil {
				total += int64(len(content))
				if total > MaxInstallBytes {
					err = ErrTooLarge
				}
			}
			if err != nil {
				if firstErr == nil {
					firstErr = err
					cancel()
				}
				return
			}
			format, sniffErr := Sniff(content)
			if sniffErr != nil {
				if firstErr == nil {
					firstErr = ErrInvalid
					cancel()
				}
				return
			}
			faces[index] = Face{WeightMin: rule.WeightMin, WeightMax: rule.WeightMax, Italic: rule.Italic, UnicodeRange: rule.UnicodeRange, Format: format, Content: content}
		}()
	}
	wait.Wait()
	if firstErr != nil {
		return "", nil, firstErr
	}
	return resolvedFamily, faces, nil
}

func joinWeights(weights []int) string {
	parts := make([]string, len(weights))
	for index, weight := range weights {
		parts[index] = strconv.Itoa(weight)
	}
	return strings.Join(parts, ";")
}

func (g *GoogleInstaller) stylesheet(ctx context.Context, familyQuery string) (string, error) {
	target := *g.base
	target.Path = strings.TrimRight(target.Path, "/") + "/css2"
	// The family is a query value, so `url.Values` would encode its `:` and `;` and
	// the API reads those as syntax; spaces become `+`, which it expects.
	target.RawQuery = "family=" + strings.ReplaceAll(url.QueryEscape(familyQuery), "%3A", ":") + "&display=swap"
	target.RawQuery = strings.NewReplacer("%40", "@", "%3B", ";", "%2C", ",").Replace(target.RawQuery)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return "", ErrGoogleUnreachable
	}
	// The API answers each browser with the format it supports; a current Chrome
	// identity is what makes it answer with woff2 and `unicode-range` slices.
	request.Header.Set("User-Agent", stylesheetAgent)
	request.Header.Set("Accept", "text/css,*/*;q=0.1")
	response, err := g.client.Do(request)
	if err != nil {
		return "", ErrGoogleUnreachable
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusBadRequest || response.StatusCode == http.StatusNotFound {
		return "", ErrGoogleFamilyMissing
	}
	if response.StatusCode != http.StatusOK {
		return "", ErrGoogleUnreachable
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxStylesheetBytes+1))
	if err != nil || len(body) > maxStylesheetBytes {
		return "", ErrGoogleUnreachable
	}
	return string(body), nil
}

func (g *GoogleInstaller) download(ctx context.Context, target *url.URL) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, ErrGoogleUnreachable
	}
	request.Header.Set("User-Agent", stylesheetAgent)
	response, err := g.client.Do(request)
	if err != nil {
		return nil, ErrGoogleUnreachable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, ErrGoogleUnreachable
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, MaxFileBytes+1))
	if err != nil {
		return nil, ErrGoogleUnreachable
	}
	if len(content) > MaxFileBytes {
		return nil, ErrTooLarge
	}
	return content, nil
}

// StylesheetRule is one parsed `@font-face` rule.
type StylesheetRule struct {
	Family       string
	WeightMin    int
	WeightMax    int
	Italic       bool
	UnicodeRange string
	URL          *url.URL
}

var (
	fontFaceBlock   = regexp.MustCompile(`(?s)@font-face\s*\{(.*?)\}`)
	declaration     = regexp.MustCompile(`(?s)([a-z-]+)\s*:\s*([^;]+);?`)
	sourceURL       = regexp.MustCompile(`url\(\s*['"]?([^'")\s]+)['"]?\s*\)`)
	unicodeRangeSet = regexp.MustCompile(`^[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?(\s*,\s*[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?)*$`)
)

// ParseStylesheet reads the `@font-face` rules of a Google Fonts stylesheet. Rules that
// share one file - a variable font answering both weights - are merged into one rule
// spanning both, so the file is downloaded and stored once.
func ParseStylesheet(stylesheet string) ([]StylesheetRule, error) {
	var rules []StylesheetRule
	seen := map[string]int{}
	for _, block := range fontFaceBlock.FindAllStringSubmatch(stylesheet, -1) {
		rule := StylesheetRule{}
		for _, match := range declaration.FindAllStringSubmatch(block[1], -1) {
			value := strings.TrimSpace(match[2])
			switch strings.ToLower(match[1]) {
			case "font-family":
				family, err := CleanFamily(strings.Trim(value, `'"`))
				if err != nil {
					return nil, err
				}
				rule.Family = family
			case "font-style":
				rule.Italic = strings.EqualFold(value, "italic")
			case "font-weight":
				low, high, ok := parseWeight(value)
				if !ok {
					return nil, ErrInvalid
				}
				rule.WeightMin, rule.WeightMax = low, high
			case "src":
				found := sourceURL.FindStringSubmatch(value)
				if found == nil {
					return nil, ErrInvalid
				}
				parsed, err := url.Parse(found[1])
				if err != nil {
					return nil, ErrInvalid
				}
				rule.URL = parsed
			case "unicode-range":
				if !unicodeRangeSet.MatchString(value) {
					return nil, ErrInvalid
				}
				rule.UnicodeRange = strings.Join(strings.Fields(value), "")
			}
		}
		if rule.Family == "" || rule.URL == nil || rule.WeightMin == 0 {
			return nil, ErrInvalid
		}
		key := rule.URL.String() + "|" + strconv.FormatBool(rule.Italic) + "|" + rule.UnicodeRange
		if index, ok := seen[key]; ok {
			rules[index].WeightMin = min(rules[index].WeightMin, rule.WeightMin)
			rules[index].WeightMax = max(rules[index].WeightMax, rule.WeightMax)
			continue
		}
		seen[key] = len(rules)
		rules = append(rules, rule)
	}
	return rules, nil
}

func parseWeight(value string) (int, int, bool) {
	fields := strings.Fields(value)
	if len(fields) == 0 || len(fields) > 2 {
		return 0, 0, false
	}
	low, err := strconv.Atoi(fields[0])
	if err != nil {
		return 0, 0, false
	}
	high := low
	if len(fields) == 2 {
		if high, err = strconv.Atoi(fields[1]); err != nil {
			return 0, 0, false
		}
	}
	if low < 1 || high > 1000 || low > high {
		return 0, 0, false
	}
	return low, high, true
}
