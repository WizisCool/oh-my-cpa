package release

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ProjectRepository is the repository the console's header links to, and the one whose
// star count is shown beside that link.
//
// It is a constant rather than the configured OMC release source: an operator may point
// the update check at a fork, but the header link names this project, and a count read
// from a different repository than the link opens would be a number about something else.
const ProjectRepository = "WizisCool/oh-my-cpa"

// StargazerFloor is the shortest interval between two reads of the star count.
//
// The read shares the unauthenticated per-address budget `CheckFloor` protects, and the
// header that shows the count is mounted on every page, so without a floor every console
// load would spend a request. An hour costs at most one of the sixty, and a star count
// that is an hour old is still the right number to show. Like `CheckFloor` it is measured
// from the last attempt, so a failing read is not repeated on every page view.
const StargazerFloor = time.Hour

// maxRepositoryBytes caps the repository document, which is a few kilobytes.
const maxRepositoryBytes = 1 << 20

// StargazerSource reads a repository's star count.
//
// It is separate from FeedSource so a source that only models releases stays valid: the
// demonstration's fixture does not implement it, and its header then shows the link
// without a count rather than an invented number about a real repository.
type StargazerSource interface {
	FetchStargazers(ctx context.Context, repository string) (int64, error)
}

// stargazerCache is the last star count this process read. It is held in memory only: a
// restart costs one request to learn it again, which is cheaper than a schema for a number.
type stargazerCache struct {
	mutex       sync.Mutex
	count       int64
	isKnown     bool
	attemptedAt time.Time
}

// FetchStargazers reads the star count of a repository on the fixed GitHub API host.
func (c *Client) FetchStargazers(ctx context.Context, repository string) (int64, error) {
	if err := ValidateRepository(repository); err != nil {
		return 0, err
	}
	requestURL, err := c.repositoryURL(repository)
	if err != nil {
		return 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return 0, fmt.Errorf("build repository request: %w", err)
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return 0, fmt.Errorf("read repository %s: %w", repository, err)
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusTooManyRequests {
		if limit := rateLimitFrom(response.Header); limit.Exhausted() {
			return 0, fmt.Errorf("%w (resets %s)", ErrRateLimited, resetDescription(limit))
		}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return 0, fmt.Errorf("repository read answered status %d", response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxRepositoryBytes+1))
	if err != nil {
		return 0, fmt.Errorf("read repository body: %w", err)
	}
	if len(body) > maxRepositoryBytes {
		return 0, errors.New("repository response exceeds the size limit")
	}
	// A pointer distinguishes a document without the field from a repository with no
	// stars: the first is not a count and must not be shown as zero.
	var decoded struct {
		StargazersCount *int64 `json:"stargazers_count"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return 0, fmt.Errorf("decode repository: %w", err)
	}
	if decoded.StargazersCount == nil || *decoded.StargazersCount < 0 {
		return 0, errors.New("repository response carries no star count")
	}
	return *decoded.StargazersCount, nil
}

func (c *Client) repositoryURL(repository string) (string, error) {
	base := c.baseURL
	if base == "" {
		base = "https://" + GitHubAPIHost
	}
	parsed, err := url.Parse(strings.TrimSuffix(base, "/"))
	if err != nil {
		return "", fmt.Errorf("parse repository base URL: %w", err)
	}
	parsed.Path = "/repos/" + repository
	return parsed.String(), nil
}

// Stargazers returns the project's star count and whether one is known.
//
// `mayFetch` is the caller's permission to spend a request when the cached answer is
// older than the floor. Without it the answer is whatever the last read left, which is
// how a deployment that forbids page-visit requests still shows the count its sweep read.
// A failed read keeps the previous count: a stale number with a working link is more use
// than a count that disappears whenever the network does.
func (s *Service) Stargazers(ctx context.Context, mayFetch bool) (int64, bool) {
	source, ok := s.client.(StargazerSource)
	cache := &s.stargazers
	// The lock is held across the read so concurrent page loads cost one request: the
	// rest wait, then find the attempt inside the floor and answer from it.
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	if !ok || !mayFetch || (!cache.attemptedAt.IsZero() && time.Since(cache.attemptedAt) < StargazerFloor) {
		return cache.count, cache.isKnown
	}
	cache.attemptedAt = time.Now()
	fetchCtx, cancel := context.WithTimeout(ctx, stargazerTimeout)
	defer cancel()
	count, err := source.FetchStargazers(fetchCtx, ProjectRepository)
	if err != nil {
		s.logger.Warn("star count read failed", "repository", ProjectRepository, "error", err)
		return cache.count, cache.isKnown
	}
	cache.count, cache.isKnown = count, true
	return cache.count, cache.isKnown
}

// stargazerTimeout bounds the read a page load may wait on. It is shorter than the
// client's own timeout because the header renders its link first and the count second;
// an answer that takes longer than this is better delivered by the next read.
const stargazerTimeout = 5 * time.Second
