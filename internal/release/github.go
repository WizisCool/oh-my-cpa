package release

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// GitHubAPIHost is the only host this package will contact.
//
// It is a constant rather than configuration because the surface exists to read
// published release notes, not to fetch arbitrary URLs. An operator can point the
// check at their own fork by naming a repository, but not at another origin: a
// configurable host would turn an update indicator into a server-side request
// forwarder reachable from the console.
const GitHubAPIHost = "api.github.com"

const (
	// requestTimeout bounds one feed read. The console answers a page from its
	// cached index and never waits on this call.
	requestTimeout = 15 * time.Second
	// maxFeedBytes caps one response. A release feed for a busy project is tens of
	// kilobytes; the cap exists so a hostile or broken response cannot be read into
	// memory in full.
	maxFeedBytes = 4 << 20
	// userAgent identifies this client, as the GitHub API requires.
	userAgent = "oh-my-cpa-release-check"
	// maxFeedPages bounds pagination. Each page is one request from the operator's
	// unauthenticated budget of sixty per hour, so an unbounded walk of a long
	// release history could spend the entire allowance in one check.
	maxFeedPages = 2
	// feedPageSize is the number of releases requested per page. It is chosen to
	// cover a long interval of patch releases in one request.
	feedPageSize = 30
)

// repoPattern validates an "owner/name" repository identifier. It is deliberately
// strict - the value reaches a URL path, and a permissive pattern would allow path
// traversal or an embedded query string.
var repoPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$`)

// ValidateRepository reports whether an operator-supplied repository identifier is
// acceptable, returning a description of what is wrong when it is not.
func ValidateRepository(repository string) error {
	trimmed := strings.TrimSpace(repository)
	if trimmed == "" {
		return errors.New("repository must not be empty")
	}
	if !repoPattern.MatchString(trimmed) {
		return fmt.Errorf("repository %q must look like owner/name", repository)
	}
	return nil
}

// Release is one release as the feed described it.
type Release struct {
	// Tag is the release tag, used as the version.
	Tag string `json:"tag_name"`
	// Name is the release's display title, which may be empty.
	Name string `json:"name"`
	// Body is the release notes in Markdown. It is never persisted (see migration
	// 024) and is treated as untrusted text by every renderer.
	Body string `json:"body"`
	// Prerelease marks a release that was not offered as stable.
	Prerelease bool `json:"prerelease"`
	// Draft releases are never shown; the field exists so they can be filtered out.
	Draft bool `json:"draft"`
	// PublishedAt is an RFC 3339 timestamp.
	PublishedAt string `json:"published_at"`
}

// PublishedAtMS parses the publication time, returning zero when absent or
// unparsable rather than inventing a time.
func (r Release) PublishedAtMS() int64 {
	if strings.TrimSpace(r.PublishedAt) == "" {
		return 0
	}
	parsed, err := time.Parse(time.RFC3339, r.PublishedAt)
	if err != nil {
		return 0
	}
	return parsed.UnixMilli()
}

// Feed is a read of a repository's releases.
type Feed struct {
	Repository string
	Releases   []Release
	// ETag is the validator for the first page of the representation in Releases. It
	// is only meaningful alongside a body, so a caller that cannot keep the body must
	// not store it, and it only covers a single-page read: a validator for page one
	// says nothing about page two, which is why a conditional request is only made
	// when the previous read was one page.
	ETag string
	// ReceivedCount is how many entries the server returned for the last page read.
	ReceivedCount int
	// PageCount is how many pages this read walked.
	PageCount int
	// NotModified is true when the server answered 304, meaning Releases is empty
	// because the caller's cached copy is still current.
	NotModified bool
	// Truncated is true when the walk stopped at the page limit with more releases
	// available. The console says so rather than presenting a partial interval as
	// complete.
	Truncated bool
	// RateLimit is the budget state the server reported, used to explain a failure.
	RateLimit RateLimit
}

// RateLimit is GitHub's rate-limit state as reported by response headers.
type RateLimit struct {
	Limit     int64
	Remaining int64
	// ResetAtMS is when the window resets. Zero when the server did not say.
	ResetAtMS int64
}

// Exhausted reports whether the budget was used up.
func (r RateLimit) Exhausted() bool { return r.Limit > 0 && r.Remaining <= 0 }

// ErrRateLimited is returned when GitHub refuses a request because the
// unauthenticated budget for this address is spent.
var ErrRateLimited = errors.New("the GitHub API rate limit for this address is exhausted")

// Client reads release feeds from the fixed GitHub API host.
//
// The transport is the process default, which honours HTTP_PROXY and HTTPS_PROXY
// exactly as the pricing sync does. That is a deliberate consistency: both are
// reads of a public endpoint from a fixed host, and an operator who needs a proxy
// to reach the internet configures it once. The plugin-logo fetch is the opposite
// case - it follows a URL an installed plugin chose - and that difference is why
// it bypasses the proxy.
type Client struct {
	httpClient *http.Client
	// baseURL exists for tests, which point it at an httptest server. Production
	// always uses the constant host through newRequest.
	baseURL string
}

// NewClient returns a client for the fixed GitHub API host.
func NewClient() *Client {
	return &Client{httpClient: &http.Client{Timeout: requestTimeout, CheckRedirect: restrictRedirects("")}}
}

// NewClientWithTransport returns a client using the supplied transport and base
// URL. It exists for tests; the production host constant is not reached through it.
func NewClientWithTransport(transport http.RoundTripper, baseURL string) *Client {
	return &Client{httpClient: &http.Client{Timeout: requestTimeout, Transport: transport, CheckRedirect: restrictRedirects(baseURL)}, baseURL: baseURL}
}

// restrictRedirects refuses a redirect that leaves the intended origin.
//
// A constant initial host does not constrain what http.Client follows: by default it
// follows up to ten redirects wherever they point, and this process would then issue a
// request to a host the operator never named - including one from a `Location` header
// inside a response body it does not control. Only the same origin is followed, and
// only over the same scheme.
func restrictRedirects(baseURL string) func(*http.Request, []*http.Request) error {
	return func(request *http.Request, via []*http.Request) error {
		if len(via) == 0 {
			return nil
		}
		origin := via[0].URL
		if baseURL != "" {
			if parsed, err := url.Parse(baseURL); err == nil && parsed.Host != "" {
				origin = parsed
			}
		}
		if request.URL.Host != origin.Host || request.URL.Scheme != origin.Scheme {
			return fmt.Errorf("release feed redirected to %s, which is not the configured origin", request.URL.Host)
		}
		return nil
	}
}

// FetchReleases reads a repository's releases, optionally conditionally.
//
// `etag` is the validator from a previous successful read. Passing it is only
// correct while the caller still holds the body that validator describes; a 304
// answers "unchanged" about content the caller must already have.
func (c *Client) FetchReleases(ctx context.Context, repository, etag string) (Feed, error) {
	if err := ValidateRepository(repository); err != nil {
		return Feed{}, err
	}
	feed := Feed{Repository: repository}

	for page := 1; page <= maxFeedPages; page++ {
		pageFeed, err := c.fetchPage(ctx, repository, etag, page)
		if err != nil {
			return feed, err
		}
		if pageFeed.NotModified {
			feed.NotModified = true
			feed.ETag = etag
			feed.RateLimit = pageFeed.RateLimit
			return feed, nil
		}
		feed.Releases = append(feed.Releases, pageFeed.Releases...)
		feed.RateLimit = pageFeed.RateLimit
		feed.PageCount = page
		if page == 1 {
			feed.ETag = pageFeed.ETag
		}
		// A short page is the last page. A full page at the limit means the walk
		// stopped early, which is reported rather than hidden.
		if pageFeed.ReceivedCount < feedPageSize {
			return feed, nil
		}
		if page == maxFeedPages {
			feed.Truncated = true
		}
	}
	return feed, nil
}

func (c *Client) fetchPage(ctx context.Context, repository, etag string, page int) (Feed, error) {
	requestURL, err := c.pageURL(repository, page)
	if err != nil {
		return Feed{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return Feed{}, fmt.Errorf("build release request: %w", err)
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if page == 1 && strings.TrimSpace(etag) != "" {
		request.Header.Set("If-None-Match", strings.TrimSpace(etag))
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return Feed{}, fmt.Errorf("read releases for %s: %w", repository, err)
	}
	defer response.Body.Close()

	pageFeed := Feed{Repository: repository, RateLimit: rateLimitFrom(response.Header)}
	switch {
	case response.StatusCode == http.StatusNotModified:
		pageFeed.NotModified = true
		return pageFeed, nil
	case response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusTooManyRequests:
		if pageFeed.RateLimit.Exhausted() {
			return Feed{}, fmt.Errorf("%w (resets %s)", ErrRateLimited, resetDescription(pageFeed.RateLimit))
		}
		return Feed{}, fmt.Errorf("release feed refused the request: status %d", response.StatusCode)
	case response.StatusCode == http.StatusNotFound:
		return Feed{}, fmt.Errorf("release feed has no repository %q", repository)
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return Feed{}, fmt.Errorf("release feed answered status %d", response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxFeedBytes+1))
	if err != nil {
		return Feed{}, fmt.Errorf("read release feed body: %w", err)
	}
	if int64(len(body)) > maxFeedBytes {
		return Feed{}, errors.New("release feed response exceeds the size limit")
	}
	decoded := make([]Release, 0, feedPageSize)
	if err := json.Unmarshal(body, &decoded); err != nil {
		return Feed{}, fmt.Errorf("decode release feed: %w", err)
	}
	// The page size is compared against the number of entries the server returned, not
	// against the number left after filtering. A page of thirty where five were drafts
	// is still a full page, and measuring the filtered length would end the walk early
	// and silently drop the older releases behind it.
	pageFeed.ReceivedCount = len(decoded)
	// Drafts are not published releases and must never be presented as versions.
	releases := decoded[:0]
	for _, item := range decoded {
		if item.Draft || strings.TrimSpace(item.Tag) == "" {
			continue
		}
		releases = append(releases, item)
	}
	pageFeed.Releases = releases
	pageFeed.ETag = strings.TrimSpace(response.Header.Get("ETag"))
	return pageFeed, nil
}

// pageURL builds the request URL.
//
// In production the host is the constant. In tests it is a loopback server, and
// the path is still constructed from the validated repository identifier, so a test
// client cannot widen what a production client would send.
func (c *Client) pageURL(repository string, page int) (string, error) {
	base := c.baseURL
	if base == "" {
		base = "https://" + GitHubAPIHost
	}
	parsed, err := url.Parse(strings.TrimSuffix(base, "/"))
	if err != nil {
		return "", fmt.Errorf("parse release base URL: %w", err)
	}
	parsed.Path = "/repos/" + repository + "/releases"
	query := parsed.Query()
	query.Set("per_page", strconv.Itoa(feedPageSize))
	query.Set("page", strconv.Itoa(page))
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func rateLimitFrom(header http.Header) RateLimit {
	return RateLimit{
		Limit:     headerInt(header, "X-RateLimit-Limit"),
		Remaining: headerInt(header, "X-RateLimit-Remaining"),
		ResetAtMS: headerInt(header, "X-RateLimit-Reset") * 1000,
	}
}

func headerInt(header http.Header, name string) int64 {
	raw := strings.TrimSpace(header.Get(name))
	if raw == "" {
		return 0
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return value
}

func resetDescription(limit RateLimit) string {
	if limit.ResetAtMS == 0 {
		return "later"
	}
	return time.UnixMilli(limit.ResetAtMS).UTC().Format(time.RFC3339)
}
