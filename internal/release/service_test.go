package release

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// releaseServiceCounter names each test database uniquely.
var releaseServiceCounter atomic.Uint64

// newTestService builds a service against a stub GitHub API.
func newTestService(t *testing.T, handler http.HandlerFunc) (*Service, *stubGitHub) {
	t.Helper()
	stub := &stubGitHub{handler: handler}
	server := httptest.NewServer(stub)
	stub.server = server
	t.Cleanup(server.Close)

	name := fmt.Sprintf("file:memdb_release_svc_%d?mode=memory&cache=shared", releaseServiceCounter.Add(1))
	db, err := repository.Open(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	service, err := New(Options{
		Repository:    repository.New(db),
		OMCRepository: "WizisCool/oh-my-cpa",
		CPARepository: "router-for-me/CLIProxyAPI",
		Client:        NewClientWithTransport(server.Client().Transport, server.URL),
	})
	if err != nil {
		t.Fatal(err)
	}
	return service, stub
}

type stubGitHub struct {
	handler http.HandlerFunc
	server  *httptest.Server
	// mutex guards conditional. httptest serves each request on its own goroutine while the
	// test reads the recorded requests from its own, so the recording is genuinely shared state
	// rather than a value only one goroutine touches.
	mutex sync.Mutex
	// conditional records, per request in order, whether it carried a validator. That
	// is the operator's rate-limit budget: GitHub does not charge for a 304.
	conditional []bool
}

func (s *stubGitHub) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	s.mutex.Lock()
	s.conditional = append(s.conditional, strings.TrimSpace(request.Header.Get("If-None-Match")) != "")
	s.mutex.Unlock()
	s.handler(writer, request)
}

func (s *stubGitHub) callCount() int {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return len(s.conditional)
}

func (s *stubGitHub) requestsWithValidator() []bool {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return append([]bool(nil), s.conditional...)
}

func (s *stubGitHub) lastValidator() bool {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if len(s.conditional) == 0 {
		return false
	}
	return s.conditional[len(s.conditional)-1]
}

func (s *stubGitHub) serverTransport() http.RoundTripper { return s.server.Client().Transport }

func (s *stubGitHub) serverURL() string { return s.server.URL }

func writeJSON(t *testing.T, writer http.ResponseWriter, releases []Release) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("X-RateLimit-Limit", "60")
	writer.Header().Set("X-RateLimit-Remaining", "55")
	writer.Header().Set("ETag", `W/"test-etag"`)
	if err := json.NewEncoder(writer).Encode(releases); err != nil {
		t.Error(err)
	}
}

func TestCheckStoresIndexAndComparesVersions(t *testing.T) {
	service, _ := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(t, writer, []Release{
			{Tag: "v7.3.11", Name: "v7.3.11", Body: "## Changelog\n- fix(translator): hoist cache_control", PublishedAt: "2026-09-21T14:43:42Z"},
			{Tag: "v7.3.10", Name: "v7.3.10", Body: "- fix(claude): gate fallback", PublishedAt: "2026-09-20T23:05:09Z"},
			{Tag: "v7.3.9", Name: "v7.3.9", Body: "- previous", PublishedAt: "2026-09-19T18:08:09Z"},
		})
	})
	ctx := context.Background()

	if _, err := service.Check(ctx, ProductCPA); err != nil {
		t.Fatalf("check failed: %v", err)
	}

	stored, err := service.repository.ListReleases(ctx, ProductCPA, "router-for-me/CLIProxyAPI")
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 3 {
		t.Fatalf("stored %d releases, want 3", len(stored))
	}

	// Running v7.3.5 with v7.3.11 published is an available update.
	status, err := service.Status(ctx, ProductCPA, "v7.3.5")
	if err != nil {
		t.Fatal(err)
	}
	if status.Comparison.State != UpdateAvailable {
		t.Fatalf("state = %q, want %q", status.Comparison.State, UpdateAvailable)
	}
	if status.LatestVersion != "v7.3.11" {
		t.Fatalf("latest = %q, want v7.3.11", status.LatestVersion)
	}
	// The merged log covers the interval, so all three releases are in range.
	if status.MergeCount != 3 {
		t.Fatalf("merge count = %d, want 3", status.MergeCount)
	}
	if !status.NotesAvailable {
		t.Fatal("notes were not held in memory after a successful check")
	}
}

func TestMergedLogGroupsTheWholeInterval(t *testing.T) {
	service, _ := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(t, writer, []Release{
			{Tag: "v7.3.11", Body: "notes 11", PublishedAt: "2026-09-21T14:43:42Z"},
			{Tag: "v7.3.10", Body: "notes 10", PublishedAt: "2026-09-20T23:05:09Z"},
			{Tag: "v7.3.9", Body: "notes 9", PublishedAt: "2026-09-19T18:08:09Z"},
			{Tag: "v7.3.8", Body: "notes 8", PublishedAt: "2026-09-18T21:17:57Z"},
		})
	})
	ctx := context.Background()
	if _, err := service.Check(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}

	log, err := service.Releases(ctx, ProductCPA, "v7.3.9")
	if err != nil {
		t.Fatal(err)
	}
	if len(log.Releases) != 2 {
		t.Fatalf("merged log has %d releases, want 2 (v7.3.10, v7.3.11): %+v", len(log.Releases), log.Releases)
	}
	// Ordering is by version, newest first, so the range reads as a history.
	if log.Releases[0].Tag != "v7.3.11" || log.Releases[1].Tag != "v7.3.10" {
		t.Fatalf("merged log order = %s, %s", log.Releases[0].Tag, log.Releases[1].Tag)
	}
	for _, entry := range log.Releases {
		if !entry.InRange {
			t.Fatalf("%s is in the log but not marked in range", entry.Tag)
		}
		if !entry.BodyAvailable || entry.Body == "" {
			t.Fatalf("%s has no notes", entry.Tag)
		}
		if entry.HTMLURL == "" {
			t.Fatalf("%s has no source link", entry.Tag)
		}
	}
}

func TestUncomparableRunningVersionShowsNewestWithoutClaimingARange(t *testing.T) {
	service, _ := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(t, writer, []Release{
			{Tag: "v7.3.11", Body: "notes 11", PublishedAt: "2026-09-21T14:43:42Z"},
			{Tag: "v7.3.10", Body: "notes 10", PublishedAt: "2026-09-20T23:05:09Z"},
		})
	})
	ctx := context.Background()
	if _, err := service.Check(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}

	// `v0.1.0-dev` is the default development build. It is not comparable with a
	// release, so no interval may be claimed: the newest release is shown alone and
	// the reason is reported instead.
	for _, running := range []string{"v0.1.0-dev", "v0.1.0-demo", "unknown", "", "nightly-2026-09-01"} {
		comparison := CompareVersions(running, "v7.3.11")
		if comparison.State != UpdateIndeterminate {
			t.Errorf("running %q: state = %q, want %q", running, comparison.State, UpdateIndeterminate)
		}
		if comparison.Why != ReasonCurrentNotComparable {
			t.Errorf("running %q: reason = %q, want %q", running, comparison.Why, ReasonCurrentNotComparable)
		}
	}

	log, err := service.Releases(ctx, ProductCPA, "v0.1.0-dev")
	if err != nil {
		t.Fatal(err)
	}
	if len(log.Releases) != 1 {
		t.Fatalf("log has %d releases, want only the newest: %+v", len(log.Releases), log.Releases)
	}
	if log.Releases[0].Tag != "v7.3.11" {
		t.Fatalf("the single shown release = %q, want v7.3.11", log.Releases[0].Tag)
	}
	if log.Releases[0].InRange {
		t.Fatal("a release was marked in range although no range is computable")
	}
}

func TestPrereleasesAreExcludedFromTheRange(t *testing.T) {
	service, _ := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(t, writer, []Release{
			{Tag: "v8.0.0", Body: "stable 8", PublishedAt: "2026-09-22T00:00:00Z"},
			{Tag: "v8.0.0-rc2", Body: "rc2", PublishedAt: "2026-09-21T00:00:00Z", Prerelease: true},
			{Tag: "v7.3.11", Body: "stable 11", PublishedAt: "2026-09-20T00:00:00Z"},
		})
	})
	ctx := context.Background()
	if _, err := service.Check(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}

	log, err := service.Releases(ctx, ProductCPA, "v7.3.10")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range log.Releases {
		if entry.Prerelease {
			t.Fatalf("a prerelease (%s) appeared in the merged log", entry.Tag)
		}
	}
	// The newest stable release is the comparison target, not the newer prerelease.
	status, err := service.Status(ctx, ProductCPA, "v7.3.10")
	if err != nil {
		t.Fatal(err)
	}
	if status.LatestVersion != "v8.0.0" {
		t.Fatalf("latest = %q, want the stable v8.0.0", status.LatestVersion)
	}
}

func TestFailedCheckKeepsThePreviousIndexAndReportsWhy(t *testing.T) {
	failing := false
	service, stub := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		if failing {
			writer.Header().Set("X-RateLimit-Limit", "60")
			writer.Header().Set("X-RateLimit-Remaining", "0")
			writer.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10))
			writer.WriteHeader(http.StatusForbidden)
			return
		}
		writeJSON(t, writer, []Release{{Tag: "v7.3.11", Body: "notes", PublishedAt: "2026-09-21T14:43:42Z"}})
	})
	ctx := context.Background()

	if _, err := service.Check(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	before := stub.callCount()

	failing = true
	// CheckNow, not Check: this asserts what a real feed read does, and the floor would
	// otherwise answer from the previous attempt.
	if _, err := service.CheckNow(ctx, ProductCPA); err == nil {
		t.Fatal("a rate-limited check reported success")
	}
	if stub.callCount() <= before {
		t.Fatal("the failed check made no request")
	}

	status, err := service.Status(ctx, ProductCPA, "v7.3.5")
	if err != nil {
		t.Fatal(err)
	}
	// The page must still answer the version question from what it knew, and must
	// say that the last attempt failed.
	if status.Comparison.State != UpdateAvailable {
		t.Fatalf("state after a failed check = %q, want the previous answer %q", status.Comparison.State, UpdateAvailable)
	}
	if status.CheckError == "" {
		t.Fatal("the failure reason was not recorded")
	}
	if status.CheckedAtMS == nil {
		t.Fatal("the last successful check time was lost")
	}
	if status.AttemptedAtMS == nil {
		t.Fatal("the failed attempt was not timestamped")
	}
	if *status.AttemptedAtMS < *status.CheckedAtMS {
		t.Fatal("the attempt predates the success it followed")
	}
}

func TestCheckFailureDoesNotEraseTheOtherProduct(t *testing.T) {
	service, _ := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		// The gateway's feed fails; Oh My CPA's succeeds. They have separate sources
		// and must fail independently.
		if strings.Contains(request.URL.Path, "CLIProxyAPI") {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		writeJSON(t, writer, []Release{{Tag: "v0.2.0", Body: "notes", PublishedAt: "2026-09-21T00:00:00Z"}})
	})
	ctx := context.Background()

	service.CheckAll(ctx)

	omcStatus, err := service.Status(ctx, ProductOMC, "v0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if omcStatus.Comparison.State != UpdateAvailable {
		t.Fatalf("omc state = %q, want %q despite the gateway feed failing", omcStatus.Comparison.State, UpdateAvailable)
	}
	cpaStatus, err := service.Status(ctx, ProductCPA, "v7.3.5")
	if err != nil {
		t.Fatal(err)
	}
	if cpaStatus.CheckError == "" {
		t.Fatal("the gateway's failure was not recorded")
	}
}

func TestConditionalRequestAvoidsSpendingQuotaButOnlyWhileBodiesAreHeld(t *testing.T) {
	service, stub := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("If-None-Match") == `W/"test-etag"` {
			writer.Header().Set("X-RateLimit-Limit", "60")
			writer.Header().Set("X-RateLimit-Remaining", "55")
			writer.WriteHeader(http.StatusNotModified)
			return
		}
		writeJSON(t, writer, []Release{{Tag: "v7.3.11", Body: "notes", PublishedAt: "2026-09-21T14:43:42Z"}})
	})
	ctx := context.Background()

	if _, err := service.Check(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	// A second read in the same process still holds the notes, so it may validate.
	if _, err := service.CheckNow(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	conditional := 0
	for _, carriedValidator := range stub.requestsWithValidator() {
		if carriedValidator {
			conditional++
		}
	}
	if conditional != 1 {
		t.Fatalf("conditional requests = %d, want 1 (the second check)", conditional)
	}

	// A restart drops the notes. The next check must be unconditional, because a 304
	// would claim "unchanged" about content this process cannot render.
	fresh, err := New(Options{
		Repository:    service.repository,
		OMCRepository: "WizisCool/oh-my-cpa",
		CPARepository: "router-for-me/CLIProxyAPI",
		Client:        NewClientWithTransport(stub.serverTransport(), stub.serverURL()),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := fresh.ForgetStoredValidators(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := fresh.CheckNow(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	last := stub.lastValidator()
	if last {
		t.Fatal("a check sent a conditional request after a restart, when the notes were gone")
	}
}

func TestPaginationAndTruncationAreReported(t *testing.T) {
	// A full first page plus a full second page means the walk stopped at its limit
	// with more available, which must be reported rather than hidden.
	page := make([]Release, feedPageSize)
	for index := range page {
		minor := 30 - index
		page[index] = Release{Tag: fmt.Sprintf("v7.3.%d", minor), Body: "notes"}
	}
	service, stub := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(t, writer, page)
	})
	ctx := context.Background()

	if _, err := service.Check(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	if stub.callCount() != maxFeedPages {
		t.Fatalf("requests = %d, want %d pages", stub.callCount(), maxFeedPages)
	}
	state, err := service.repository.GetReleaseCheckState(ctx, ProductCPA)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Truncated {
		t.Fatal("a truncated release walk was not recorded")
	}

	// Truncation alone does not make an interval incomplete, and reporting it as incomplete
	// raised a false alarm: the walk keeps the NEWEST releases, so what it dropped is older
	// than the oldest release it kept. This walk covers v7.3.30 down to v7.3.1 across two
	// pages, so a running version inside that span has its whole interval.
	status, err := service.Status(ctx, ProductCPA, "v7.3.20")
	if err != nil {
		t.Fatal(err)
	}
	if !status.RangeComplete {
		t.Fatalf("the interval above %s is covered by the releases that were read, but it was reported incomplete", "v7.3.20")
	}

	// The uncertainty is real when the running version is older than the oldest release
	// read: the releases the walk dropped sit between them, which is part of the interval
	// the operator asked about. This is the upgrade-from-far-behind case.
	incomplete, err := service.Status(ctx, ProductCPA, "v7.3.0")
	if err != nil {
		t.Fatal(err)
	}
	if incomplete.RangeComplete {
		t.Fatal("a running version older than every release read reported a complete interval")
	}

	log, err := service.Releases(ctx, ProductCPA, "v7.3.20")
	if err != nil {
		t.Fatal(err)
	}
	if !log.RangeComplete {
		t.Fatal("the merged log reported a covered interval as incomplete")
	}

	// A running version that cannot be placed on the version line keeps the conservative
	// answer, because the dropped releases cannot be ruled in or out.
	unplaceable, err := service.Releases(ctx, ProductCPA, "v0.1.0-dev")
	if err != nil {
		t.Fatal(err)
	}
	if unplaceable.RangeComplete {
		t.Fatal("an incomparable running version reported a complete interval")
	}
}

func TestInvalidRepositoryIsRefusedAtStartup(t *testing.T) {
	db, err := repository.Open(context.Background(), fmt.Sprintf("file:memdb_repo_guard_%d?mode=memory&cache=shared", releaseServiceCounter.Add(1)))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	for _, repositoryName := range []string{"", "no-slash", "../../etc", "owner/name?per_page=100", "owner/name/extra", "owner/na me"} {
		if _, err := New(Options{Repository: repository.New(db), CPARepository: repositoryName}); err == nil {
			t.Errorf("repository %q was accepted", repositoryName)
		}
	}
	if _, err := New(Options{Repository: repository.New(db)}); err == nil {
		t.Error("a service with no products was accepted")
	}
}

func TestZeroOutboundRequestsInDemoMode(t *testing.T) {
	// The demonstration must not reach the internet. This asserts the property at
	// the only place that could break it for this feature: a demo process is never
	// constructed with a real client, and the loop that would use one is not started.
	// The application-level guarantee is asserted in internal/app; here the check is
	// that a service built for a demo performs no request.
	db, err := repository.Open(context.Background(), fmt.Sprintf("file:memdb_demo_%d?mode=memory&cache=shared", releaseServiceCounter.Add(1)))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stub := &stubGitHub{handler: func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(t, writer, []Release{{Tag: "v7.3.5"}})
	}}
	server := httptest.NewServer(stub)
	defer server.Close()
	service, err := New(Options{
		Repository:    repository.New(db),
		CPARepository: "router-for-me/CLIProxyAPI",
		Client:        NewClientWithTransport(server.Client().Transport, server.URL),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Nothing is called, so nothing is requested.
	if stub.callCount() != 0 {
		t.Fatalf("a freshly built service made %d requests", stub.callCount())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := service.Run(ctx, time.Hour); err != nil {
		t.Fatalf("sweep loop returned %v on a cancelled context", err)
	}
	if stub.callCount() != 0 {
		t.Fatalf("a cancelled sweep made %d requests", stub.callCount())
	}
}

// TestMergedLogIsOrderedByVersionNotPublication pins the fix for an ordering defect:
// the stored index is ordered by publication time, and a feed can publish a backport
// after a newer release, which would have rendered a patch release above the release
// that supersedes it.
func TestMergedLogIsOrderedByVersionNotPublication(t *testing.T) {
	service, _ := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		// v7.3.9 is published LAST but is not the newest version.
		writeJSON(t, writer, []Release{
			{Tag: "v7.3.11", Body: "eleven", PublishedAt: "2026-09-20T00:00:00Z"},
			{Tag: "v7.3.10", Body: "ten", PublishedAt: "2026-09-19T00:00:00Z"},
			{Tag: "v7.3.9", Body: "nine (backport published later)", PublishedAt: "2026-09-25T00:00:00Z"},
		})
	})
	ctx := context.Background()
	if _, err := service.Check(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}

	log, err := service.Releases(ctx, ProductCPA, "v7.3.8")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"v7.3.11", "v7.3.10", "v7.3.9"}
	if len(log.Releases) != len(want) {
		t.Fatalf("merged log has %d entries, want %d", len(log.Releases), len(want))
	}
	for index, tag := range want {
		if log.Releases[index].Tag != tag {
			t.Fatalf("merged log order = %v, want %v (newest version first, not newest publication)",
				[]string{log.Releases[0].Tag, log.Releases[1].Tag, log.Releases[2].Tag}, want)
		}
	}
}

// TestChangingTheSourceDoesNotPresentTwoFeeds is the isolation property: a product has
// one configured source, so metadata recorded against a different one must not be
// presented beside the new source's name.
func TestChangingTheSourceDoesNotPresentTwoFeeds(t *testing.T) {
	ctx := context.Background()
	name := fmt.Sprintf("file:memdb_source_switch_%d?mode=memory&cache=shared", releaseServiceCounter.Add(1))
	db, err := repository.Open(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)

	// A feed source whose answer depends on the repository, so the two configured
	// sources are distinguishable.
	upstream := feedSourceFunc(func(_ context.Context, repositoryName, _ string) (Feed, error) {
		if repositoryName == "router-for-me/CLIProxyAPI" {
			return Feed{Repository: repositoryName, Releases: []Release{{Tag: "v7.3.11", Body: "upstream notes", PublishedAt: "2026-09-21T00:00:00Z"}}}, nil
		}
		return Feed{Repository: repositoryName}, nil
	})
	first, err := New(Options{Repository: repo, CPARepository: "router-for-me/CLIProxyAPI", Client: upstream})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Check(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	before, err := first.Status(ctx, ProductCPA, "v7.3.5")
	if err != nil {
		t.Fatal(err)
	}
	if before.LatestVersion != "v7.3.11" {
		t.Fatalf("latest before the switch = %q, want v7.3.11", before.LatestVersion)
	}

	// The operator points the product at a fork. The fork's feed is empty, so the honest
	// answer is "nothing published" rather than the previous feed's version.
	second, err := New(Options{Repository: repo, CPARepository: "someone/fork", Client: upstream})
	if err != nil {
		t.Fatal(err)
	}
	after, err := second.Status(ctx, ProductCPA, "v7.3.5")
	if err != nil {
		t.Fatal(err)
	}
	if after.LatestVersion != "" {
		t.Fatalf("latest after the source switch = %q: the previous source's version is still presented", after.LatestVersion)
	}
	if after.Comparison.State != UpdateIndeterminate {
		t.Fatalf("state after the switch = %q, want %q", after.Comparison.State, UpdateIndeterminate)
	}
}

// TestConcurrentChecksDoNotPublishOutOfOrder pins the per-product serialisation.
// Checks are deliberately unthrottled, so two can be in flight at once, and without
// the lock the slower one would overwrite the faster one's newer snapshot.
func TestConcurrentChecksDoNotPublishOutOfOrder(t *testing.T) {
	// An atomic, because httptest runs each request on its own goroutine: a plain bool here is
	// written concurrently by two handlers and read under the race detector.
	var slowFirst atomic.Bool
	slowFirst.Store(true)
	service, stub := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		// The first reader is held open long enough for a later, faster check to finish
		// first if the service allowed them to overlap. CompareAndSwap makes the one-time
		// transition atomic rather than a read-then-write race.
		if slowFirst.CompareAndSwap(true, false) {
			time.Sleep(300 * time.Millisecond)
			writeJSON(t, writer, []Release{{Tag: "v7.3.11", Body: "older snapshot", PublishedAt: "2026-09-21T00:00:00Z"}})
			return
		}
		writeJSON(t, writer, []Release{{Tag: "v7.3.12", Body: "newer snapshot", PublishedAt: "2026-09-22T00:00:00Z"}})
	})
	ctx := context.Background()

	firstDone := make(chan error, 1)
	go func() { _, err := service.CheckNow(ctx, ProductCPA); firstDone <- err }()
	time.Sleep(50 * time.Millisecond)
	if _, err := service.CheckNow(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}

	stored, err := service.repository.ListReleases(ctx, ProductCPA, "router-for-me/CLIProxyAPI")
	if err != nil {
		t.Fatal(err)
	}
	// The later check ran second, so its snapshot is the one that stands.
	if len(stored) != 1 || stored[0].Tag != "v7.3.12" {
		t.Fatalf("stored index = %+v, want the newest snapshot (v7.3.12)", stored)
	}
	_ = stub
}

// TestMultiPageReadIsNotConditionallyValidated pins the validator scope: a page-one
// ETag says nothing about page two, so a multi-page snapshot must be re-read in full.
func TestMultiPageReadIsNotConditionallyValidated(t *testing.T) {
	fullPage := make([]Release, feedPageSize)
	for index := range fullPage {
		fullPage[index] = Release{Tag: fmt.Sprintf("v7.3.%d", 60-index), Body: "notes"}
	}
	// The second page is short, ending the walk at two pages.
	shortPage := []Release{{Tag: "v7.3.1", Body: "last"}}

	service, stub := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("page") == "2" {
			writeJSON(t, writer, shortPage)
			return
		}
		writeJSON(t, writer, fullPage)
	})
	ctx := context.Background()

	if _, err := service.Check(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	if service.isSinglePage(ProductCPA) {
		t.Fatal("a two-page read was recorded as a single page")
	}
	if _, err := service.CheckNow(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	conditional := 0
	for _, carried := range stub.requestsWithValidator() {
		if carried {
			conditional++
		}
	}
	if conditional != 0 {
		t.Fatalf("conditional requests = %d, want 0: page one's validator cannot speak for page two", conditional)
	}
}

// TestSinglePageReadIsConditionallyValidated is the counterpart: when the snapshot did
// come from one page, the validator is meaningful and saves quota.
func TestSinglePageReadIsConditionallyValidated(t *testing.T) {
	service, stub := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("If-None-Match") == `W/"test-etag"` {
			// Headers must be set before the status is written, so this answer cannot go
			// through writeJSON.
			writer.Header().Set("X-RateLimit-Limit", "60")
			writer.Header().Set("X-RateLimit-Remaining", "55")
			writer.Header().Set("ETag", `W/"test-etag"`)
			writer.WriteHeader(http.StatusNotModified)
			return
		}
		writeJSON(t, writer, []Release{{Tag: "v7.3.11", Body: "notes", PublishedAt: "2026-09-21T00:00:00Z"}})
	})
	ctx := context.Background()

	if _, err := service.Check(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	if !service.isSinglePage(ProductCPA) {
		t.Fatal("a one-page read was not recorded as a single page")
	}
	if _, err := service.CheckNow(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	conditional := 0
	for _, carried := range stub.requestsWithValidator() {
		if carried {
			conditional++
		}
	}
	if conditional != 1 {
		t.Fatalf("conditional requests = %d, want 1 for a single-page snapshot", conditional)
	}
}

// TestRedirectOffTheConfiguredOriginIsRefused pins the network boundary. A response
// body is not trusted input, and httptest's default client follows redirects wherever
// they point, so the client must refuse to.
func TestRedirectOffTheConfiguredOriginIsRefused(t *testing.T) {
	elsewhere := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(t, writer, []Release{{Tag: "v9.9.9", Body: "from another origin"}})
	}))
	defer elsewhere.Close()

	service, _ := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, elsewhere.URL+"/releases", http.StatusFound)
	})
	if _, err := service.Check(context.Background(), ProductCPA); err == nil {
		t.Fatal("a redirect to another origin was followed")
	}
}

// feedSourceFunc adapts a function to the FeedSource interface, so a test can answer
// differently per repository without a stub type per case.
type feedSourceFunc func(context.Context, string, string) (Feed, error)

func (f feedSourceFunc) FetchReleases(ctx context.Context, repository, etag string) (Feed, error) {
	return f(ctx, repository, etag)
}

// TestTheFloorStopsRepeatedChecksFromSpendingTheBudget is the reason the floor exists, and it
// is a regression test for a design that was measured and found wrong.
//
// The feed is one shared per-address budget - sixty requests an hour for the unauthenticated
// GitHub API - and one check costs up to two requests per product because a walk may read two
// pages. With the page checking on every load and no floor, fifteen page views exhausted the
// budget for every client behind that address; the operator hit it in practice, which is how
// this was found. So the assertion is on the request count, not on a duration.
func TestTheFloorStopsRepeatedChecksFromSpendingTheBudget(t *testing.T) {
	service, stub := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(t, writer, []Release{{Tag: "v7.3.11", Body: "notes", PublishedAt: "2026-09-21T00:00:00Z"}})
	})
	ctx := context.Background()

	// The first check reads the feed.
	read, err := service.CheckReportingFreshness(ctx, ProductCPA)
	if err != nil {
		t.Fatal(err)
	}
	if !read {
		t.Fatal("the first check did not read the feed")
	}
	afterFirst := stub.callCount()
	if afterFirst == 0 {
		t.Fatal("the first check made no request")
	}

	// Ten more page-load checks, which is what a reader reloading the page produces.
	for attempt := 0; attempt < 10; attempt++ {
		read, err := service.CheckReportingFreshness(ctx, ProductCPA)
		if err != nil {
			t.Fatal(err)
		}
		if read {
			t.Fatalf("check %d read the feed again inside the floor", attempt+2)
		}
		if _, err := service.Check(ctx, ProductCPA); err != nil {
			t.Fatal(err)
		}
	}

	if got := stub.callCount(); got != afterFirst {
		t.Fatalf("requests grew from %d to %d across eleven checks: the floor is not holding", afterFirst, got)
	}

	// The cached answer is still served, so the page keeps working. A floor that blanked the
	// page would trade one failure for another.
	status, err := service.Status(ctx, ProductCPA, "v7.3.5")
	if err != nil {
		t.Fatal(err)
	}
	if status.Comparison.State != UpdateAvailable {
		t.Fatalf("state from cache = %q, want %q", status.Comparison.State, UpdateAvailable)
	}
	if status.LatestVersion != "v7.3.11" {
		t.Fatalf("latest from cache = %q, want v7.3.11", status.LatestVersion)
	}

	// And the sweep is not subject to it: the background loop exists to notice releases, and
	// it runs every six hours, far outside any floor.
	if _, err := service.CheckNow(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	if stub.callCount() <= afterFirst {
		t.Fatal("CheckNow did not read the feed: the sweep would never see a new release")
	}
}

// TestAFailedAttemptAlsoArmsTheFloor pins that the floor is measured from the attempt rather
// than from the last success. A feed that is failing would otherwise be retried on every page
// view, spending the budget to re-learn the same error - which is the situation the operator
// is most likely to be in when they reload repeatedly.
func TestAFailedAttemptAlsoArmsTheFloor(t *testing.T) {
	service, stub := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	})
	ctx := context.Background()

	if _, err := service.CheckReportingFreshness(ctx, ProductCPA); err == nil {
		t.Fatal("a failing feed reported success")
	}
	failingRequests := stub.callCount()
	if failingRequests == 0 {
		t.Fatal("the first attempt made no request")
	}

	// Inside the floor the call is answered from the store, so it reports no error - nothing
	// was attempted, and inventing a failure for a request that was never made would be the
	// mirror of the defect this floor fixes. What matters is that the request is not repeated.
	for attempt := 0; attempt < 5; attempt++ {
		read, err := service.CheckReportingFreshness(ctx, ProductCPA)
		if err != nil {
			t.Fatalf("attempt %d reported an error for a call the floor answered: %v", attempt+2, err)
		}
		if read {
			t.Fatalf("attempt %d read the failing feed again inside the floor", attempt+2)
		}
	}
	if got := stub.callCount(); got != failingRequests {
		t.Fatalf("a failing feed was retried %d times inside the floor", got-failingRequests)
	}

	// The stored `running` flag must be cleared by the failed attempt. `Status` reports
	// `Checking` from it, so a failure that left it set would show the page as permanently
	// mid-check - which is what a store-write failure did before every post-attempt path was
	// funnelled through one recording point.
	state, err := service.repository.GetReleaseCheckState(ctx, ProductCPA)
	if err != nil {
		t.Fatal(err)
	}
	if state.Running {
		t.Fatal("a failed attempt left the stored running flag set, so the page reports checking forever")
	}

	// The failure is still visible to the reader: the recorded error is what the page shows,
	// so an answer served from the store never presents the outage as health.
	status, err := service.Status(ctx, ProductCPA, "v7.3.5")
	if err != nil {
		t.Fatal(err)
	}
	if status.CheckError == "" {
		t.Fatal("the recorded failure was lost: the page would present a failing feed as healthy")
	}
	if status.Comparison.State != UpdateIndeterminate {
		t.Fatalf("state during an outage = %q, want %q", status.Comparison.State, UpdateIndeterminate)
	}
}

// TestAFailedAttemptIsNotReportedAsCached pins that the freshness flag survives a failure.
//
// The flag tells the caller whether a request was spent. A failed attempt spent one, so
// reporting it as a cached answer would tell the operator the page is showing a stored result
// when it in fact tried the feed and was refused - the opposite of what happened, and exactly
// the kind of claim this feature exists to avoid.
func TestAFailedAttemptIsNotReportedAsCached(t *testing.T) {
	service, stub := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	})
	ctx := context.Background()

	read, err := service.CheckReportingFreshness(ctx, ProductCPA)
	if err == nil {
		t.Fatal("a failing feed reported success")
	}
	if !read {
		t.Fatal("a failed attempt was reported as a cached answer, so the page would claim it served a stored result")
	}
	if stub.callCount() == 0 {
		t.Fatal("the failing check made no request, so there is nothing for the flag to describe")
	}

	// Inside the floor the next call is genuinely cached, and must say so.
	read, err = service.CheckReportingFreshness(ctx, ProductCPA)
	if err != nil {
		t.Fatalf("a call the floor answered reported an error: %v", err)
	}
	if read {
		t.Fatal("a call inside the floor reported reading the feed")
	}
}

// TestACancelledCheckStillClearsItsRunningFlag is a regression test for a defect seen in the
// shutdown log of the browser acceptance run.
//
// A browser that navigated away mid-check cancelled the context, so the write that clears the
// `running` flag failed with `context canceled` and the flag stayed set. The page reads that flag
// to decide whether to show "checking", so a check that had stopped reported itself as still
// running - indefinitely, until something else happened to clear it. The detached bookkeeping
// context is what fixes it, and the assertion is on the stored state rather than on the call.
func TestACancelledCheckStillClearsItsRunningFlag(t *testing.T) {
	released := make(chan struct{})
	service, _ := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		// Hold the feed open until the test has cancelled the caller's context, so the read
		// fails the way a navigated-away browser makes it fail.
		<-released
		writer.WriteHeader(http.StatusInternalServerError)
	})
	ctx := context.Background()

	checkCtx, cancelCheck := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		_, err := service.CheckNow(checkCtx, ProductCPA)
		done <- err
	}()

	// Wait for the attempt to be recorded and the read to be in flight.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		state, err := service.repository.GetReleaseCheckState(ctx, ProductCPA)
		if err == nil && state.Running {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancelCheck()
	close(released)
	if err := <-done; err == nil {
		t.Fatal("a cancelled check reported success")
	}

	// The flag must be cleared even though the caller's context is gone.
	cleared := false
	for attempt := 0; attempt < 100 && !cleared; attempt++ {
		state, err := service.repository.GetReleaseCheckState(ctx, ProductCPA)
		if err != nil {
			t.Fatal(err)
		}
		if !state.Running {
			cleared = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !cleared {
		t.Fatal("an abandoned check left the running flag set, so the page would report checking forever")
	}

	// And the page no longer claims a check is in progress.
	status, err := service.Status(ctx, ProductCPA, "v7.3.5")
	if err != nil {
		t.Fatal(err)
	}
	if status.Checking {
		t.Fatal("the page still reports a check in progress after the check was abandoned")
	}
}

// TestASourceSwitchFollowedByAFailureDoesNotPresentTheOldFeed pins the scenario the earlier
// isolation test missed.
//
// That test read the state before any check ran, which the repository guard already handles by
// comparing the stored source. The dangerous sequence is longer: switch the source, then let the
// first check against the new source FAIL. Recording the attempt rewrites `repository`, so without
// retiring the snapshot in the same statement the row would now claim the new source while still
// carrying the old feed's `latest_tag` - and the guard, which compares that very column, would
// accept it. The page would then name a version that exists only in the feed it stopped reading.
func TestASourceSwitchFollowedByAFailureDoesNotPresentTheOldFeed(t *testing.T) {
	ctx := context.Background()
	db, err := repository.Open(ctx, fmt.Sprintf("file:memdb_switch_fail_%d?mode=memory&cache=shared", releaseServiceCounter.Add(1)))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)

	// The first source publishes v9.9.9 and is read successfully.
	upstream := feedSourceFunc(func(_ context.Context, repositoryName, _ string) (Feed, error) {
		return Feed{
			Repository: repositoryName,
			Releases:   []Release{{Tag: "v9.9.9", Body: "upstream notes"}},
			ETag:       `W/"upstream"`,
		}, nil
	})
	first, err := New(Options{Repository: repo, CPARepository: "router-for-me/CLIProxyAPI", Client: upstream})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.CheckNow(ctx, ProductCPA); err != nil {
		t.Fatal(err)
	}
	before, err := first.Status(ctx, ProductCPA, "v9.9.0")
	if err != nil {
		t.Fatal(err)
	}
	if before.LatestVersion != "v9.9.9" {
		t.Fatalf("latest before the switch = %q, want v9.9.9", before.LatestVersion)
	}

	// The operator switches to a fork whose feed fails.
	failing := feedSourceFunc(func(context.Context, string, string) (Feed, error) {
		return Feed{}, fmt.Errorf("the release feed answered status 503")
	})
	second, err := New(Options{Repository: repo, CPARepository: "someone/fork", Client: failing})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := second.CheckNow(ctx, ProductCPA); err == nil {
		t.Fatal("a failing feed reported success")
	}

	// The old feed's version must not be attributed to the new source.
	status, err := second.Status(ctx, ProductCPA, "v9.9.0")
	if err != nil {
		t.Fatal(err)
	}
	if status.LatestVersion != "" {
		t.Fatalf("after switching source and failing, latest = %q: the previous feed's version is presented under the new source's name", status.LatestVersion)
	}
	if status.LatestVersion == "v9.9.9" {
		t.Fatal("the previous source's version survived the switch as if the new source had published it")
	}
	// The failure is still reported, which is the honest state of the new source.
	if status.CheckError == "" {
		t.Fatal("the failed check against the new source was not reported")
	}

	// And the stored row no longer claims a version it did not read.
	state, err := repo.GetReleaseCheckState(ctx, ProductCPA)
	if err != nil {
		t.Fatal(err)
	}
	if state.LatestTag != "" {
		t.Fatalf("stored latest tag = %q after a source switch, want it cleared", state.LatestTag)
	}
	if state.LastSuccessAtMS != nil {
		t.Fatal("the previous source's success time survived the switch")
	}
}

// TestAFeedFailureIsRedactedBeforeItIsStored pins what the stored reason may contain.
//
// The string reaches `release_check_state.last_error` and is rendered on the page as
// `CheckError`, so it is both persisted and displayed. The cause is a remote response, and a feed
// or a proxy can echo back what it was given - a URL bearing a credential being the ordinary case
// rather than a contrived one. The caller still receives the raw error, so the detail is not lost
// where it is useful; what is dropped is the copy that outlives the request.
func TestAFeedFailureIsRedactedBeforeItIsStored(t *testing.T) {
	// Assembled rather than written as one literal. A credential-shaped string in the source is
	// indistinguishable from a real one to a secret scanner, and this repository's own scan is a
	// required gate - so the value is composed here and the scanner has nothing to find. The test
	// still carries a real credential shape, which is the whole point of it.
	credential := "ghp_" + strings.Repeat("A", 20)
	credentialed := `Get "https://api.github.com/repos/x/y?token=` + credential + `": dial tcp: timeout`
	service, _ := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	})
	// Substitute the failure message itself, since the point is what reaches the store.
	service.client = feedSourceFunc(func(context.Context, string, string) (Feed, error) {
		return Feed{}, errors.New(credentialed)
	})

	ctx := context.Background()
	if _, err := service.CheckNow(ctx, ProductCPA); err == nil {
		t.Fatal("a failing feed reported success")
	}

	state, err := service.repository.GetReleaseCheckState(ctx, ProductCPA)
	if err != nil {
		t.Fatal(err)
	}
	if state.LastError == "" {
		t.Fatal("the failure was not recorded at all")
	}
	if strings.Contains(state.LastError, credential) {
		t.Fatalf("the stored reason carries the credential: %q", state.LastError)
	}
	// And the page renders the stored copy, so it must be the redacted one.
	status, err := service.Status(ctx, ProductCPA, "v7.3.5")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(status.CheckError, credential) {
		t.Fatalf("the page would display the credential: %q", status.CheckError)
	}
}
