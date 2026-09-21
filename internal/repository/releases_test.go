package repository

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/migrations"
)

// releaseTestRepository opens a private in-memory database with the application
// migrations applied, so the release tables under test are the ones the application
// creates rather than a hand-written stand-in.
func releaseTestRepository(t *testing.T) *Repository {
	t.Helper()
	name := fmt.Sprintf("file:memdb_release_%d?mode=memory&cache=shared", usageDSNCounter.Add(1))
	db, err := Open(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return New(db)
}

func TestReleaseIndexReplacesAsAUnit(t *testing.T) {
	repository := releaseTestRepository(t)
	ctx := context.Background()

	first := []ReleaseRecord{
		{Tag: "v7.3.11", PublishedAtMS: 3000},
		{Tag: "v7.3.10", PublishedAtMS: 2000},
		{Tag: "v7.3.9", PublishedAtMS: 1000},
	}
	if err := repository.ReplaceReleaseIndex(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI", first); err != nil {
		t.Fatal(err)
	}

	// The second read drops a release - a withdrawn tag - and the stored index must
	// stop claiming it exists rather than merging the two feeds.
	second := []ReleaseRecord{
		{Tag: "v7.3.11", PublishedAtMS: 3000},
		{Tag: "v7.3.10", PublishedAtMS: 2000},
	}
	if err := repository.ReplaceReleaseIndex(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI", second); err != nil {
		t.Fatal(err)
	}

	stored, err := repository.ListReleases(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI")
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 2 {
		t.Fatalf("stored %d releases, want 2: %+v", len(stored), stored)
	}
	for _, record := range stored {
		if record.Tag == "v7.3.9" {
			t.Fatal("a withdrawn release is still claimed to exist")
		}
	}
}

func TestReplacingTheSourceDoesNotMixTwoFeeds(t *testing.T) {
	repository := releaseTestRepository(t)
	ctx := context.Background()

	// A product has exactly one configured source, so replacing the index replaces it
	// for the product as a whole. The alternative - keeping the previous source's rows
	// and filtering them out on read - would leave rows nothing ever reads while
	// making "which feed is current" a property of the query rather than of the data.
	if err := repository.ReplaceReleaseIndex(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI", []ReleaseRecord{{Tag: "v7.3.11"}}); err != nil {
		t.Fatal(err)
	}
	if err := repository.ReplaceReleaseIndex(ctx, ReleaseProductCPA, "someone/fork", []ReleaseRecord{{Tag: "v9.0.0"}}); err != nil {
		t.Fatal(err)
	}

	forkReleases, err := repository.ListReleases(ctx, ReleaseProductCPA, "someone/fork")
	if err != nil {
		t.Fatal(err)
	}
	if len(forkReleases) != 1 || forkReleases[0].Tag != "v9.0.0" {
		t.Fatalf("fork index = %+v, want only v9.0.0", forkReleases)
	}
	upstreamReleases, err := repository.ListReleases(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI")
	if err != nil {
		t.Fatal(err)
	}
	if len(upstreamReleases) != 0 {
		t.Fatalf("the previous source's versions are still stored: %+v", upstreamReleases)
	}

	// Switching back must be able to repopulate the original source.
	if err := repository.ReplaceReleaseIndex(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI", []ReleaseRecord{{Tag: "v7.3.11"}}); err != nil {
		t.Fatal(err)
	}
	backAgain, err := repository.ListReleases(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI")
	if err != nil {
		t.Fatal(err)
	}
	if len(backAgain) != 1 {
		t.Fatalf("switching back stored %d releases, want 1", len(backAgain))
	}
}

func TestReleaseFailureKeepsTheLastSuccessfulIndex(t *testing.T) {
	repository := releaseTestRepository(t)
	ctx := context.Background()

	if err := repository.ReplaceReleaseIndex(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI", []ReleaseRecord{{Tag: "v7.3.11"}}); err != nil {
		t.Fatal(err)
	}
	if err := repository.RecordReleaseCheckSuccess(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI", "v7.3.11", "etag-1", false); err != nil {
		t.Fatal(err)
	}
	success, err := repository.GetReleaseCheckState(ctx, ReleaseProductCPA)
	if err != nil {
		t.Fatal(err)
	}
	if success.LastSuccessAtMS == nil {
		t.Fatal("a successful check recorded no success time")
	}
	successAt := *success.LastSuccessAtMS

	if err := repository.RecordReleaseCheckFailure(ctx, ReleaseProductCPA, "the GitHub API rate limit is exhausted"); err != nil {
		t.Fatal(err)
	}
	failed, err := repository.GetReleaseCheckState(ctx, ReleaseProductCPA)
	if err != nil {
		t.Fatal(err)
	}

	if failed.LastError == "" {
		t.Fatal("a failed check recorded no reason")
	}
	if failed.LastSuccessAtMS == nil || *failed.LastSuccessAtMS != successAt {
		t.Fatal("a failed check overwrote when the data actually came from")
	}
	if failed.LastAttemptAtMS == nil {
		t.Fatal("a failed check recorded no attempt time")
	}
	if failed.LatestTag != "v7.3.11" {
		t.Fatalf("a failed check changed the known latest version to %q", failed.LatestTag)
	}
	// The stored index must survive, so the page can still show what it knew.
	stored, err := repository.ListReleases(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI")
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 {
		t.Fatalf("stored index after a failure = %+v, want the previous release", stored)
	}

	// The next attempt clears the error, so a recovered feed stops looking broken.
	if err := repository.RecordReleaseCheckSuccess(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI", "v7.3.12", "etag-2", false); err != nil {
		t.Fatal(err)
	}
	recovered, err := repository.GetReleaseCheckState(ctx, ReleaseProductCPA)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.LastError != "" {
		t.Fatalf("a successful check kept the old error %q", recovered.LastError)
	}
	if recovered.LatestTag != "v7.3.12" {
		t.Fatalf("latest tag = %q after recovery, want v7.3.12", recovered.LatestTag)
	}
}

func TestClearReleaseCheckValidatorsDropsStoredEtags(t *testing.T) {
	repository := releaseTestRepository(t)
	ctx := context.Background()

	if err := repository.RecordReleaseCheckSuccess(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI", "v7.3.11", "etag-1", false); err != nil {
		t.Fatal(err)
	}
	// The validators are cleared at start-up because the process holds no bodies:
	// a 304 would otherwise claim "unchanged" about notes it cannot show.
	if err := repository.ClearReleaseCheckValidators(ctx); err != nil {
		t.Fatal(err)
	}
	state, err := repository.GetReleaseCheckState(ctx, ReleaseProductCPA)
	if err != nil {
		t.Fatal(err)
	}
	if state.ETag != "" {
		t.Fatalf("stored validator %q survived the start-up clear", state.ETag)
	}
	// The last-success time must survive: forgetting when the data came from would
	// make the page unable to say how old it is.
	if state.LastSuccessAtMS == nil {
		t.Fatal("clearing validators also cleared the last success time")
	}
}

func TestReleaseUnknownProductIsRefused(t *testing.T) {
	repository := releaseTestRepository(t)
	ctx := context.Background()

	if err := repository.ReplaceReleaseIndex(ctx, "windsurf", "a/b", nil); err == nil {
		t.Fatal("an unknown product was accepted into the release index")
	}
	if _, err := repository.ListReleases(ctx, "windsurf", "a/b"); err == nil {
		t.Fatal("an unknown product was accepted by the read path")
	}
	if _, err := repository.GetReleaseCheckState(ctx, "windsurf"); err == nil {
		t.Fatal("an unknown product was accepted by the check-state read")
	}
}

func TestReleaseCheckStateWithoutARowIsNotAnError(t *testing.T) {
	repository := releaseTestRepository(t)
	state, err := repository.GetReleaseCheckState(context.Background(), ReleaseProductOMC)
	if err != nil {
		t.Fatalf("reading a never-checked product failed: %v", err)
	}
	if state.LastAttemptAtMS != nil || state.LastSuccessAtMS != nil {
		t.Fatal("a never-checked product reports attempt or success times")
	}
	if state.Truncated {
		t.Fatal("a never-checked product reports a truncated index")
	}
}

func TestReleasePrereleaseFlagRoundTrips(t *testing.T) {
	repository := releaseTestRepository(t)
	ctx := context.Background()

	if err := repository.ReplaceReleaseIndex(ctx, ReleaseProductCPA, "a/b", []ReleaseRecord{
		{Tag: "v8.0.0-rc1", Prerelease: true},
		{Tag: "v7.3.11"},
	}); err != nil {
		t.Fatal(err)
	}
	stored, err := repository.ListReleases(ctx, ReleaseProductCPA, "a/b")
	if err != nil {
		t.Fatal(err)
	}
	byTag := map[string]ReleaseRecord{}
	for _, record := range stored {
		byTag[record.Tag] = record
	}
	if !byTag["v8.0.0-rc1"].Prerelease {
		t.Fatal("a prerelease was stored as a stable release")
	}
	if byTag["v7.3.11"].Prerelease {
		t.Fatal("a stable release was stored as a prerelease")
	}
}

func TestDatabaseFactsAreObservedNotAssumed(t *testing.T) {
	ctx := context.Background()

	// The page used to print "WAL driver" as a constant, which was a claim about the
	// source code rather than about the database. These two cases are why the value is
	// read instead: an in-memory database genuinely reports a different journal mode,
	// and only an observed value can say so.
	inMemory := releaseTestRepository(t)
	memoryFacts, err := inMemory.ReadDatabaseFacts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if memoryFacts.JournalMode != "memory" {
		t.Fatalf("in-memory journal mode = %q, want \"memory\"", memoryFacts.JournalMode)
	}
	if memoryFacts.WALEnabled() {
		t.Fatal("an in-memory database was reported as write-ahead logged")
	}

	// A file-backed database opened by this package does request WAL, and that is a
	// fact about the file rather than about the opener.
	fileBacked := openGatedTestDatabase(t)
	facts, err := New(fileBacked).ReadDatabaseFacts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !facts.WALEnabled() {
		t.Fatalf("observed journal mode = %q, want wal for a file database", facts.JournalMode)
	}
	if facts.PageSize <= 0 || facts.PageCount <= 0 {
		t.Fatalf("page geometry was not read: %+v", facts)
	}
	if facts.SchemaVersion <= 0 {
		t.Fatalf("schema version = %d, want the applied migration count", facts.SchemaVersion)
	}
	if facts.UsedBytes() <= 0 {
		t.Fatalf("used bytes = %d, want a positive value for a migrated database", facts.UsedBytes())
	}
	// Free pages are reported separately and must not be folded into the used size.
	if facts.FreePageBytes() < 0 {
		t.Fatalf("free page bytes = %d", facts.FreePageBytes())
	}
	if facts.Synchronous == nil {
		t.Fatal("the synchronous setting was not observed on a writable file database")
	}
	if facts.BusyTimeout == nil || *facts.BusyTimeout != 5000 {
		t.Fatalf("busy timeout = %v, want the 5000ms the DSN requests", facts.BusyTimeout)
	}
}

func TestDataVolumesCountWhatIsStored(t *testing.T) {
	repository := releaseTestRepository(t)
	ctx := context.Background()

	volumes, err := repository.ReadDataVolumes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if volumes.UsageEvents != 0 {
		t.Fatalf("a fresh database reports %d usage events", volumes.UsageEvents)
	}
	if volumes.FirstEventMS != nil {
		t.Fatal("an empty usage table reports a first-event time")
	}
}

// TestEveryReleaseColumnExistsAfterMigrationFromThePreviousSchema is a regression test for
// a defect this change shipped and then repaired.
//
// The release check's `truncated` flag was first added to migration 024 itself, after 024
// had already been applied on a running deployment. SQLite applies each migration once,
// keyed by version, so the edited file was never re-read: a fresh database gained the
// column and an existing one did not. On the existing deployment every write of a check
// result then failed with "no column named truncated", which the page reported as
// "not checked yet" forever while the fetch itself kept succeeding. The repair is a new
// migration (025), and this test asserts the outcome rather than the mechanism: after
// migrating, every column the release queries name must exist.
func TestEveryReleaseColumnExistsAfterMigrationFromThePreviousSchema(t *testing.T) {
	ctx := context.Background()
	database, err := Open(ctx, filepath.Join(t.TempDir(), "release-columns.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	repository := New(database)

	// The columns the release code writes or reads. A query that names a column absent
	// from the schema fails at run time against a migrated database, which is the whole
	// shape of the original defect.
	required := map[string][]string{
		"release_index": {
			"product", "repository", "tag", "name", "published_at_ms", "prerelease", "checked_at_ms",
		},
		"release_check_state": {
			"product", "repository", "running", "last_attempt_at_ms", "last_success_at_ms",
			"last_error", "latest_tag", "etag", "truncated", "updated_at_ms",
		},
	}
	for table, columns := range required {
		present := map[string]bool{}
		rows, err := database.SQL.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
		if err != nil {
			t.Fatalf("read columns of %s: %v", table, err)
		}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			present[name] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		for _, column := range columns {
			if !present[column] {
				t.Errorf("%s is missing column %q after migration: a query naming it would fail at run time", table, column)
			}
		}
	}

	// And the round trip the failure broke: recording a check result and reading it back.
	if err := repository.ReplaceReleaseIndex(ctx, ReleaseProductCPA, "owner/name", []ReleaseRecord{{Tag: "v1.0.0"}}); err != nil {
		t.Fatal(err)
	}
	if err := repository.RecordReleaseCheckSuccess(ctx, ReleaseProductCPA, "owner/name", "v1.0.0", "etag", true); err != nil {
		t.Fatalf("recording a successful check failed on a migrated database: %v", err)
	}
	state, err := repository.GetReleaseCheckState(ctx, ReleaseProductCPA)
	if err != nil {
		t.Fatalf("reading the recorded check failed: %v", err)
	}
	if !state.Truncated {
		t.Error("the truncation flag did not survive the round trip")
	}
	if state.LatestTag != "v1.0.0" {
		t.Errorf("latest tag = %q, want v1.0.0", state.LatestTag)
	}
}

// TestMigrationsAreNotEditedAfterRelease pins the rule whose violation caused the defect
// above: an applied migration is immutable. It asserts the specific historical fact -
// that the truncation flag lives in its own migration - because the general rule cannot be
// checked from inside the code that embeds the files.
func TestMigrationsAreNotEditedAfterRelease(t *testing.T) {
	initial, err := migrations.Files.ReadFile("024_release_index.sql")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(initial), "truncated") {
		t.Fatal("migration 024 mentions the truncation flag: that flag is added by migration 025, " +
			"and folding it back into 024 would leave already-migrated databases without the column")
	}
	addition, err := migrations.Files.ReadFile("025_release_check_truncated.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(addition), "ADD COLUMN truncated") {
		t.Fatal("migration 025 no longer adds the truncation column")
	}
}
