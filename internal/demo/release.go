package demo

import (
	"context"
	"log/slog"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// releaseFixture is the demonstration's release feed.
//
// The System Information page's whole capability - a version comparison, a merged
// change log across several releases, and a state that can say "update available" -
// is only visible in the page if there is something to compare against. The
// alternative was to let the page show its empty state in the demo, which would
// demonstrate the least interesting half of the feature and say nothing about
// whether it works.
//
// It performs no network access: it satisfies the feed interface directly rather than
// answering a request, so the demonstration's "no outbound request" property stays a
// fact about the code.
type releaseFixture struct {
	products map[string][]release.Release
}

// newReleaseFixture builds the fixture around the gateway version the gateway
// fixture reports, so the two cannot disagree about what is running here.
func newReleaseFixture(now time.Time) *releaseFixture {
	return &releaseFixture{
		products: map[string][]release.Release{
			// The console's own releases are plain release versions, while the version this
			// process reports is the suffixed build the demonstration actually is. That is
			// the honest pair, and it is also the case the page needs to handle well: a
			// development or demo build cannot be placed on the release line, so no
			// comparison is claimed and the newest release is shown on its own.
			release.ProductOMC: {
				{
					Tag:         "v0.2.0",
					Name:        "v0.2.0",
					PublishedAt: now.Add(-20 * 24 * time.Hour).UTC().Format(time.RFC3339),
					Body: "## Highlights\n\n- The console reports both products' versions and the changes between them.\n" +
						"- The database's own facts are read rather than assumed.\n",
				},
				{
					Tag:         "v0.1.0",
					Name:        "v0.1.0",
					PublishedAt: now.Add(-60 * 24 * time.Hour).UTC().Format(time.RFC3339),
					Body:        "## Highlights\n\n- Request records gained a streaming indicator.\n",
				},
			},
			// The gateway's releases include two versions above the one the fixture
			// reports as running, so the page renders a merged change log across an
			// interval rather than a single release.
			release.ProductCPA: {
				{
					Tag:         "v7.3.7",
					Name:        "v7.3.7",
					PublishedAt: now.Add(-1 * 24 * time.Hour).UTC().Format(time.RFC3339),
					Body: "## Changelog\n\n" +
						"- fix(responses): filter upstream private and telemetry events in SSE streams\n" +
						"- feat(pluginapi): propagate streaming flag to usage plugins\n",
				},
				{
					Tag:         "v7.3.6",
					Name:        "v7.3.6",
					PublishedAt: now.Add(-2 * 24 * time.Hour).UTC().Format(time.RFC3339),
					Body: "## Changelog\n\n" +
						"- fix(translator): hoist tool-result content part cache_control to the block\n" +
						"- fix(xai): allow non-negative TTFT in usage record assertions\n",
				},
				{
					Tag:         fixtureCPAVersion,
					Name:        fixtureCPAVersion,
					PublishedAt: now.Add(-9 * 24 * time.Hour).UTC().Format(time.RFC3339),
					Body: "## Changelog\n\n" +
						"- fix(gemini): enforce array type for schema nodes declaring items\n",
				},
			},
		},
	}
}

// FetchReleases implements release.FeedSource from fixtures.
//
// The validator protocol is honoured the same way the real client honours it: an
// unchanged feed answers NotModified rather than restating itself, so the page's
// conditional-request path is exercised by the demonstration too. The fixture always
// answers "not modified" for a repeated validator because its content never changes
// within one process.
func (f *releaseFixture) FetchReleases(_ context.Context, repository, etag string) (release.Feed, error) {
	releases, ok := f.releasesFor(repository)
	if !ok {
		// An unknown repository is answered as an empty feed rather than an error, which
		// is what makes the page show "nothing published" instead of a failure for a
		// deployment pointed at a repository the fixture does not model.
		return release.Feed{Repository: repository}, nil
	}
	if etag == demoFeedValidator {
		return release.Feed{Repository: repository, NotModified: true, ETag: demoFeedValidator}, nil
	}
	// A copy is returned so a caller cannot mutate the fixture's own slice.
	copied := make([]release.Release, len(releases))
	copy(copied, releases)
	return release.Feed{
		Repository: repository,
		Releases:   copied,
		ETag:       demoFeedValidator,
		RateLimit:  release.RateLimit{Limit: 60, Remaining: 59},
	}, nil
}

func (f *releaseFixture) releasesFor(repository string) ([]release.Release, bool) {
	switch repository {
	case DefaultOMCRepository:
		return f.products[release.ProductOMC], true
	case DefaultCPARepository:
		return f.products[release.ProductCPA], true
	default:
		return nil, false
	}
}

// demoFeedValidator is the fixture's ETag. It is a constant because the fixture's
// content is fixed for the process's lifetime.
const demoFeedValidator = `W/"omc-demo-release-feed"`

// Default release sources the demonstration reports. They name the real projects so
// the links on the page go somewhere meaningful, while the content comes from the
// fixture.
const (
	DefaultOMCRepository = "WizisCool/oh-my-cpa"
	DefaultCPARepository = "router-for-me/CLIProxyAPI"
)

// BuildReleaseService wires the demonstration's release-observation service.
//
// The service is the production one; only its feed source is swapped for the fixture.
// That is deliberate: the demonstration exercises the real comparison, the real stored
// index and the real merged-log selection, so the page it renders is evidence about
// the shipped code rather than about a mock of it. What it does not exercise is the
// HTTP client, which is the one part that must not run here.
func BuildReleaseService(repo *repository.Repository, logger *slog.Logger, now time.Time) (*release.Service, error) {
	return release.New(release.Options{
		Repository:    repo,
		Logger:        logger,
		OMCRepository: DefaultOMCRepository,
		CPARepository: DefaultCPARepository,
		Client:        newReleaseFixture(now),
	})
}
