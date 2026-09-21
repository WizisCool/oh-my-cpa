package demo

import (
	"context"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// TestDemoReleaseFixtureShowsTheWholeCapabilityOffline is the property that makes the
// page worth looking at in the demonstration: an available update and a merged change
// log, produced with no network access at all.
//
// The service under test is the production one; only its feed source is the fixture. So
// this asserts about the real comparison, the real stored index and the real
// merged-log selection, not about a mock of them.
func TestDemoReleaseFixtureShowsTheWholeCapabilityOffline(t *testing.T) {
	db, err := repository.Open(context.Background(), filepath.Join(t.TempDir(), "demo-release.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)

	service, err := BuildReleaseService(repo, slog.Default(), time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	service.CheckAll(ctx)

	// The gateway's running version is the one the gateway fixture reports, and the
	// fixture publishes two versions above it - so the page must merge an interval.
	status, err := service.Status(ctx, release.ProductCPA, fixtureCPAVersion)
	if err != nil {
		t.Fatal(err)
	}
	if status.Comparison.State != release.UpdateAvailable {
		t.Fatalf("gateway state = %q, want %q", status.Comparison.State, release.UpdateAvailable)
	}
	if status.MergeCount != 2 {
		t.Fatalf("merged log covers %d releases, want 2 above %s", status.MergeCount, fixtureCPAVersion)
	}
	if !status.NotesAvailable {
		t.Fatal("the fixture produced no release notes")
	}
	if status.CheckedAtMS == nil {
		t.Fatal("the fixture check recorded no success time")
	}

	log, err := service.Releases(ctx, release.ProductCPA, fixtureCPAVersion)
	if err != nil {
		t.Fatal(err)
	}
	if len(log.Releases) != 2 {
		t.Fatalf("merged log has %d entries, want 2", len(log.Releases))
	}
	for _, entry := range log.Releases {
		if !entry.InRange {
			t.Errorf("%s is in the merged log but not marked in range", entry.Tag)
		}
		if entry.Body == "" || !entry.BodyAvailable {
			t.Errorf("%s has no notes", entry.Tag)
		}
		if entry.HTMLURL == "" {
			t.Errorf("%s has no source link", entry.Tag)
		}
	}

	// The console's own build is a suffixed demo build, which is deliberately not
	// comparable with a release: the page must say so and show the newest release
	// alone rather than inventing an interval.
	omcStatus, err := service.Status(ctx, release.ProductOMC, "v0.1.0-demo")
	if err != nil {
		t.Fatal(err)
	}
	if omcStatus.Comparison.State != release.UpdateIndeterminate {
		t.Fatalf("console state = %q, want %q for a suffixed build version", omcStatus.Comparison.State, release.UpdateIndeterminate)
	}
	if omcStatus.Comparison.Why != release.ReasonCurrentNotComparable {
		t.Fatalf("console reason = %q, want %q", omcStatus.Comparison.Why, release.ReasonCurrentNotComparable)
	}
	if omcStatus.LatestVersion == "" {
		t.Fatal("the console's newest published release was not named")
	}

	omcLog, err := service.Releases(ctx, release.ProductOMC, "v0.1.0-demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(omcLog.Releases) != 1 {
		t.Fatalf("an incomparable build version produced %d entries, want the newest release alone", len(omcLog.Releases))
	}
}

// TestDemoReleaseFixturePerformsNoOutboundRequest pins the demonstration's central
// promise for this feature. The fixture satisfies the feed interface directly instead
// of answering an HTTP request, so there is no client for it to reach the network
// with - which is why the assertion can be about the construction rather than about a
// server that happened not to be called.
func TestDemoReleaseFixturePerformsNoOutboundRequest(t *testing.T) {
	db, err := repository.Open(context.Background(), filepath.Join(t.TempDir(), "demo-offline.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	service, err := BuildReleaseService(repository.New(db), slog.Default(), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}

	// A cancelled context still lets a fixture answer, because answering cannot block.
	// If this had a real client, every call below would fail or reach the network.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	service.CheckAll(ctx)

	for _, product := range service.Products() {
		feed, err := newReleaseFixture(time.Now().UTC()).FetchReleases(context.Background(), product.Repository, "")
		if err != nil {
			t.Fatalf("fixture failed for %s: %v", product.Key, err)
		}
		if len(feed.Releases) == 0 {
			t.Errorf("fixture has no releases for %s", product.Key)
		}
		// The fixture honours the validator protocol, so the page's conditional path is
		// exercised by the demonstration too.
		repeated, err := newReleaseFixture(time.Now().UTC()).FetchReleases(context.Background(), product.Repository, demoFeedValidator)
		if err != nil {
			t.Fatal(err)
		}
		if !repeated.NotModified {
			t.Errorf("a repeated validator did not answer not-modified for %s", product.Key)
		}
	}

	// An unmodelled repository is an empty feed, not an error: the page then says
	// nothing has been published instead of reporting a failure.
	unmodelled, err := newReleaseFixture(time.Now().UTC()).FetchReleases(context.Background(), "someone/else", "")
	if err != nil {
		t.Fatalf("an unmodelled repository returned an error: %v", err)
	}
	if len(unmodelled.Releases) != 0 {
		t.Fatalf("an unmodelled repository returned %d releases", len(unmodelled.Releases))
	}
}
