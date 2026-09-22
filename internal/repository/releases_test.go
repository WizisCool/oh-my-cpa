package repository

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
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

// TestReleaseColumnsConvergeFromBothMigrationHistories covers the upgrade the release tables
// actually have to survive, and the fresh-database case is the least interesting of the three.
//
// The column that records a truncated walk lived inside `024_release_index.sql` for a period
// before it was split into `025`. That produces two real histories, and the repair has to handle
// both:
//
//   - a database that applied the original 024, which has the table *without* the column, so the
//     flag must be added; and
//   - a database created during the window, which already has the column and still has 025
//     pending, so the add must be skipped - an unconditional `ADD COLUMN` fails there with
//     `duplicate column name`, and a failed statement aborts the migration transaction and stops
//     the process from starting.
//
// Each case is built by applying only the migrations up to 024, mutating the schema to the
// history under test, and then running the real migrator over the result. The earlier test in this
// file opened a fresh database and asserted the columns existed, which the initial creation
// satisfies without exercising either upgrade at all.
func TestReleaseColumnsConvergeFromBothMigrationHistories(t *testing.T) {
	for _, testCase := range []struct {
		name string
		// preparing mutates the schema after 024 has been applied, reproducing one history.
		preparing func(t *testing.T, database *DB)
	}{
		{
			name:      "the column is absent, as the original 024 created it",
			preparing: func(t *testing.T, database *DB) {}, // nothing to do: 024 alone leaves it out
		},
		{
			name: "the column is already present, as the window revision created it",
			preparing: func(t *testing.T, database *DB) {
				if _, err := database.SQL.Exec(
					`ALTER TABLE release_check_state ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0`); err != nil {
					t.Fatalf("prepare the window history: %v", err)
				}
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			database := openDatabaseAtMigration(t, 24)
			testCase.preparing(t, database)

			// Now the pending migrations run over that schema, which is what an upgrade is.
			if err := database.Migrate(ctx); err != nil {
				t.Fatalf("migrating from that history failed: %v", err)
			}

			repository := New(database)
			// The round trip the repair exists for: record a result and read it back.
			if err := repository.ReplaceReleaseIndex(ctx, ReleaseProductCPA, "owner/name", []ReleaseRecord{{Tag: "v1.0.0"}}); err != nil {
				t.Fatal(err)
			}
			if err := repository.RecordReleaseCheckSuccess(ctx, ReleaseProductCPA, "owner/name", "v1.0.0", "etag", true); err != nil {
				t.Fatalf("recording a successful check failed after migrating from this history: %v", err)
			}
			state, err := repository.GetReleaseCheckState(ctx, ReleaseProductCPA)
			if err != nil {
				t.Fatal(err)
			}
			if !state.Truncated {
				t.Error("the truncation flag did not survive the round trip")
			}
			if state.LatestTag != "v1.0.0" {
				t.Errorf("latest tag = %q, want v1.0.0", state.LatestTag)
			}
		})
	}

	// And a fresh database still converges, which is the case the initial creation covers.
	t.Run("a fresh database", func(t *testing.T) {
		ctx := context.Background()
		database, err := Open(ctx, filepath.Join(t.TempDir(), "fresh.db"))
		if err != nil {
			t.Fatal(err)
		}
		defer database.Close()
		repository := New(database)
		if err := repository.RecordReleaseCheckSuccess(ctx, ReleaseProductCPA, "owner/name", "v1.0.0", "etag", true); err != nil {
			t.Fatalf("recording a check on a fresh database failed: %v", err)
		}
	})
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
	// The column is added by a Go hook rather than by the SQL, because an unconditional
	// `ADD COLUMN` fails on a database that already has it - which is a real history here, since
	// the column briefly lived inside 024. So the assertion is on the hook being registered and
	// the migration being present, not on the statement text.
	if _, err := migrations.Files.ReadFile("025_release_check_truncated.sql"); err != nil {
		t.Fatal(err)
	}
	if migrationHook(25) == nil {
		t.Fatal("migration 025 has no hook, so the truncation column would never be added")
	}
	// Only executable lines count: the file's comments explain the failure an unconditional
	// statement would cause, and mentioning it there is the documentation rather than the defect.
	for _, line := range strings.Split(string(addition), "\n") {
		statement := strings.TrimSpace(line)
		if statement == "" || strings.HasPrefix(statement, "--") {
			continue
		}
		if strings.Contains(strings.ToUpper(statement), "ADD COLUMN") {
			t.Fatalf("migration 025 adds the column in SQL (%q): an unconditional ADD COLUMN fails "+
				"with 'duplicate column name' on a database created while the column lived inside 024",
				statement)
		}
	}
}

// openDatabaseAtMigration opens a database with every migration up to and including `through`
// applied, leaving the later ones pending.
//
// It exists so a test can reproduce the schema a deployment actually has when an upgrade begins,
// which is the only state in which an upgrade can be tested at all. Applying every migration and
// then asserting the result proves the fresh-database path and nothing about the upgrade.
func openDatabaseAtMigration(t *testing.T, through int) *DB {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), fmt.Sprintf("through-%d.db", through))

	// Opened with a backup cipher, because migrating a database that already holds applied
	// migrations requires an encrypted backup first: the gate correctly refuses to change an
	// existing schema without a recoverable copy, and this test is exercising exactly that path.
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	database, err := Open(ctx, path, WithMigrationBackup(cipher, filepath.Join(t.TempDir(), "backups"), 3))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	// Roll the schema back to the requested point. Deleting the migration rows alone would leave
	// the schema at its final shape while claiming the later migrations are pending, so the next
	// run would exercise the "already applied" path and never the upgrade. The schema has to move
	// with the history, which for 025 means dropping the column it adds.
	if _, err := database.SQL.ExecContext(ctx, `DELETE FROM schema_migrations WHERE version > ?`, through); err != nil {
		t.Fatalf("reset migration history to %d: %v", through, err)
	}
	if through < 25 {
		if _, err := database.SQL.ExecContext(ctx, `ALTER TABLE release_check_state DROP COLUMN truncated`); err != nil {
			t.Fatalf("drop the column migration 025 adds: %v", err)
		}
	}
	return database
}

// TestPublishReleaseSnapshotIsAtomic pins that the index and its success metadata are one fact.
//
// Committing them separately left a window where a reader could see this feed's versions beside
// the previous source's success time and latest tag - the new index with the old provenance. The
// assertion is on the observable outcome of a failed publish: the previous coherent snapshot stands
// rather than a mixture of the two.
func TestPublishReleaseSnapshotIsAtomic(t *testing.T) {
	ctx := context.Background()
	repository := releaseTestRepository(t)

	// A first coherent snapshot, as a successful check against the upstream would leave it.
	if err := repository.PublishReleaseSnapshot(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI",
		[]ReleaseRecord{{Tag: "v7.3.10"}}, "v7.3.10", "etag-1", false); err != nil {
		t.Fatal(err)
	}
	first, err := repository.GetReleaseCheckState(ctx, ReleaseProductCPA)
	if err != nil {
		t.Fatal(err)
	}

	// A publish that fails after its first statement. The trigger refuses the success write, which is
	// the second statement in the transaction - so the index rows have already been written when the
	// failure arrives, which is exactly the half-visible state a split commit produced. Using the
	// database's own mechanism makes the failure deterministic rather than a race to arrange.
	if _, err := repository.SQL().ExecContext(ctx, `
		CREATE TRIGGER refuse_release_success BEFORE INSERT ON release_check_state
		BEGIN SELECT RAISE(ABORT, 'induced failure'); END`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = repository.SQL().ExecContext(ctx, `DROP TRIGGER refuse_release_success`)
	}()

	err = repository.PublishReleaseSnapshot(ctx, ReleaseProductCPA, "someone/fork",
		[]ReleaseRecord{{Tag: "v9.9.9", Name: "fork release"}}, "v9.9.9", "etag-2", true)
	if err == nil {
		t.Fatal("a snapshot whose success write was refused was reported as published")
	}

	// The previous snapshot must be intact and whole: same source, same latest tag, same success
	// time, no truncation flag from the failure.
	after, err := repository.GetReleaseCheckState(ctx, ReleaseProductCPA)
	if err != nil {
		t.Fatal(err)
	}
	if after.Repository != first.Repository {
		t.Errorf("source = %q after a failed publish, want the previous %q", after.Repository, first.Repository)
	}
	if after.LatestTag != "v7.3.10" {
		t.Errorf("latest tag = %q after a failed publish, want the previous v7.3.10", after.LatestTag)
	}
	if after.Truncated {
		t.Error("a failed publish set the truncation flag")
	}
	if first.LastSuccessAtMS == nil || after.LastSuccessAtMS == nil || *after.LastSuccessAtMS != *first.LastSuccessAtMS {
		t.Errorf("success time changed across a failed publish: %v -> %v", first.LastSuccessAtMS, after.LastSuccessAtMS)
	}

	// And the index still names the previous release rather than a mixture.
	stored, err := repository.ListReleases(ctx, ReleaseProductCPA, "router-for-me/CLIProxyAPI")
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || stored[0].Tag != "v7.3.10" {
		t.Fatalf("index after a failed publish = %+v, want the previous release", stored)
	}
}
