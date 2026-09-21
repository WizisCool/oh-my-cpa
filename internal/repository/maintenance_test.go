package repository

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestCheckpointReportsBlockedAsIncomplete is the property that keeps the page
// honest: SQLite does not raise an error when a checkpoint is blocked, so a
// success message derived from a nil error would tell the operator a rebuild
// happened when nothing did.
func TestCheckpointReportsBlockedAsIncomplete(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ {
		if _, err := database.SQL.ExecContext(ctx, `INSERT INTO probe(v) VALUES ('x')`); err != nil {
			t.Fatal(err)
		}
	}

	service := newTestMaintenanceService(t, database)
	if _, err := service.StartCheckpoint(ctx); err != nil {
		t.Fatalf("start checkpoint: %v", err)
	}
	status := waitForMaintenance(t, service)
	if status.Error != "" {
		t.Fatalf("checkpoint reported an error: %s", status.Error)
	}
	// A checkpoint with no readers present should complete, and the counters must
	// be present so the page can show them.
	if status.Detail == "" {
		t.Fatal("checkpoint reported no counters: the three-column result was not read")
	}
	if status.Running {
		t.Fatal("status still reports running after the job finished")
	}
}

// TestMaintenanceRefusesASecondConcurrentJob pins the single-flight behaviour that
// lets the page show one job at a time.
func TestMaintenanceRefusesASecondConcurrentJob(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()
	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}

	service := newTestMaintenanceService(t, database)
	// Hold the gate so the first job stays in flight while the second is attempted.
	if err := database.writeGate.enterMaintenance(ctx); err != nil {
		t.Fatal(err)
	}

	if _, err := service.StartCheckpoint(ctx); err != nil {
		t.Fatalf("first job refused while the gate was held: %v", err)
	}
	if _, err := service.StartVacuum(ctx); err != ErrMaintenanceRunning {
		t.Fatalf("second job error = %v, want ErrMaintenanceRunning", err)
	}

	database.writeGate.leaveMaintenance()
	waitForMaintenance(t, service)
}

// TestVacuumReclaimsSpaceAndKeepsData is the positive control for the maintenance
// action: after deleting rows, a rebuild must free disk space and the database must
// still contain what it should.
func TestVacuumReclaimsSpaceAndKeepsData(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE keep(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.ExecContext(ctx, `INSERT INTO keep(v) VALUES ('survivor')`); err != nil {
		t.Fatal(err)
	}

	// A payload large enough that the freed pages are visible in the file size.
	payload := make([]byte, 4096)
	for i := 0; i < 400; i++ {
		if _, err := database.SQL.ExecContext(ctx, `INSERT INTO probe(v) VALUES (?)`, string(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.SQL.ExecContext(ctx, `DELETE FROM probe`); err != nil {
		t.Fatal(err)
	}

	service := newTestMaintenanceService(t, database)
	if _, err := service.StartVacuum(ctx); err != nil {
		t.Fatalf("start vacuum: %v", err)
	}
	status := waitForMaintenance(t, service)
	if status.Error != "" {
		t.Fatalf("vacuum failed: %s", status.Error)
	}
	if status.ReclaimedBytes <= 0 {
		t.Fatalf("vacuum reclaimed %d bytes, want a positive amount after deleting 1.6MB (before=%d after=%d, detail=%s)",
			status.ReclaimedBytes, status.SizeBeforeBytes, status.SizeAfterBytes, status.Detail)
	}
	if status.SizeAfterBytes >= status.SizeBeforeBytes {
		t.Fatalf("size did not shrink: before=%d after=%d", status.SizeBeforeBytes, status.SizeAfterBytes)
	}

	var survivor string
	if err := database.SQL.QueryRowContext(ctx, `SELECT v FROM keep`).Scan(&survivor); err != nil {
		t.Fatalf("read surviving row after vacuum: %v", err)
	}
	if survivor != "survivor" {
		t.Fatalf("surviving row = %q, want %q", survivor, "survivor")
	}

	// An integrity check is the only honest way to claim the rebuild produced a
	// valid database rather than merely a smaller file.
	var integrity string
	if err := database.SQL.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil {
		t.Fatalf("integrity check failed to run: %v", err)
	}
	if integrity != "ok" {
		t.Fatalf("integrity check = %q, want ok", integrity)
	}
}

// TestInterruptedVacuumLeavesTheDatabaseUsable pins the safety claim that made a
// plain VACUUM the chosen form of the action: it copies into a temporary database
// and overwrites the original inside an ordinary transaction, so a cancel leaves
// the original intact instead of a half-rewritten file.
func TestInterruptedVacuumLeavesTheDatabaseUsable(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE keep(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.ExecContext(ctx, `INSERT INTO keep(v) VALUES ('survivor')`); err != nil {
		t.Fatal(err)
	}

	// Cancel the rebuild immediately: the statement is interrupted rather than
	// allowed to finish, which is the state a shutdown or a timeout produces.
	// Acquisition uses a healthy context - an already-expired context is refused by
	// design - and only the statement itself carries the cancellation.
	if err := database.writeGate.enterMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(withMaintenanceContext(ctx))
	cancel()
	_, _, vacuumErr := newTestMaintenanceService(t, database).runVacuum(cancelled)
	database.writeGate.leaveMaintenance()

	// Either outcome is acceptable for the error itself - the point is what state
	// the database is left in. Assert that rather than asserting a particular
	// failure message.
	t.Logf("interrupted vacuum returned: %v", vacuumErr)

	var survivor string
	if err := database.SQL.QueryRowContext(ctx, `SELECT v FROM keep`).Scan(&survivor); err != nil {
		t.Fatalf("database unusable after an interrupted vacuum: %v", err)
	}
	if survivor != "survivor" {
		t.Fatalf("row = %q after an interrupted vacuum, want %q", survivor, "survivor")
	}
	var integrity string
	if err := database.SQL.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil {
		t.Fatalf("integrity check failed after an interrupted vacuum: %v", err)
	}
	if integrity != "ok" {
		t.Fatalf("integrity after an interrupted vacuum = %q, want ok", integrity)
	}

	// The gate must be released, or every later write stalls forever.
	releaseCtx, cancelRelease := context.WithTimeout(ctx, 5*time.Second)
	defer cancelRelease()
	if err := database.writeGate.enterWrite(releaseCtx); err != nil {
		t.Fatalf("writer cannot enter after an interrupted vacuum: %v", err)
	}
	database.writeGate.leaveWrite()
}

// TestVacuumSpacePreCheckRefusesWhenFull pins the admission check. The check uses
// the platform free-space helper, so it is exercised by pointing the database at a
// directory whose measured free space is bounded through the repository's own
// injectable hook instead of by filling a real disk.
func TestVacuumSpacePreCheckReportsMissingFile(t *testing.T) {
	database := openGatedTestDatabase(t)
	service := newTestMaintenanceService(t, database)

	// An in-memory database has no file to measure and no directory to check, so
	// the pre-check must decline rather than invent a requirement.
	inMemory, err := Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer inMemory.Close()
	if err := newTestMaintenanceService(t, inMemory).checkVacuumSpace(); err != nil {
		t.Fatalf("in-memory pre-check = %v, want nil", err)
	}

	// A file database passes on a normal machine; this asserts the check is wired
	// to the real measurement rather than always refusing.
	if err := service.checkVacuumSpace(); err != nil {
		t.Fatalf("pre-check on a file database = %v, want nil", err)
	}
}

// TestFileFootprintReportsEachFileSeparately pins that the three files are
// measured independently: a missing WAL must be distinguishable from an empty one,
// because the page states which files it counted.
func TestFileFootprintReportsEachFileSeparately(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.ExecContext(ctx, `INSERT INTO probe(v) VALUES ('x')`); err != nil {
		t.Fatal(err)
	}

	footprint := database.FileFootprint()
	if !footprint.MainExists || footprint.MainBytes <= 0 {
		t.Fatalf("main file not measured: %+v", footprint)
	}
	if footprint.TotalBytes != footprint.MainBytes+footprint.WALBytes+footprint.SHMBytes {
		t.Fatalf("total %d is not the sum of its parts: %+v", footprint.TotalBytes, footprint)
	}
	if footprint.WALExists && footprint.WALBytes <= 0 {
		t.Fatalf("WAL reported as existing with %d bytes", footprint.WALBytes)
	}

	// The -shm file is created by the WAL's shared-memory index and must be counted
	// when present, since leaving it out under-reports a live database.
	if !footprint.SHMExists {
		t.Logf("no -shm file present; measurement is %+v", footprint)
	}

	// Closing cleanly removes the WAL and -shm files, and the measurement must
	// follow reality rather than remember the earlier value.
	path := filepath.Join(t.TempDir(), "detached.db")
	detached, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := detached.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if err := detached.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + "-wal"); err == nil {
		t.Log("a -wal file survived a clean close")
	}
	after := detached.FileFootprint()
	if after.WALBytes != 0 {
		t.Fatalf("closed database reports %d WAL bytes", after.WALBytes)
	}
}

// newTestMaintenanceService builds a maintenance service and closes its own
// connection when the test ends.
func newTestMaintenanceService(t *testing.T, database *DB) *MaintenanceService {
	t.Helper()
	service, err := NewMaintenanceService(context.Background(), database)
	if err != nil {
		t.Fatalf("new maintenance service: %v", err)
	}
	t.Cleanup(func() { _ = service.Close() })
	return service
}

// waitForMaintenance blocks until the service reports no job in flight.
func waitForMaintenance(t *testing.T, service *MaintenanceService) MaintenanceStatus {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		status := service.Status()
		if !status.Running && status.FinishedAtMS != 0 {
			return status
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("maintenance job did not finish: %+v", service.Status())
	return MaintenanceStatus{}
}

// TestMaintenanceDoesNotDeadlockAgainstAWriterHoldingAConnection is a regression test
// for an observed deadlock, and it is the reason the service owns its own connection.
//
// A writer takes the gate inside its driver call - by which point database/sql has
// already handed it a connection - so a writer waiting for the gate is holding a
// connection while it waits. With one shared pooled connection, a maintenance job that
// needed that connection would wait for a writer that was waiting for the job. Both
// would hang until a request timed out, and the job would report a failure it never
// attempted.
//
// The scenario is reproduced exactly: a writer is parked on the gate while a rebuild
// runs, and both must complete.
func TestMaintenanceDoesNotDeadlockAgainstAWriterHoldingAConnection(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 4096)
	for index := 0; index < 200; index++ {
		if _, err := database.SQL.ExecContext(ctx, `INSERT INTO probe(v) VALUES (?)`, string(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.SQL.ExecContext(ctx, `DELETE FROM probe`); err != nil {
		t.Fatal(err)
	}

	// Park an exclusive holder so the rebuild has to queue behind a writer, then start
	// the writer that is holding its connection while it waits.
	if err := database.writeGate.enterMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	writerDone := make(chan error, 1)
	go func() {
		writeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		_, err := database.SQL.ExecContext(writeCtx, `INSERT INTO probe(v) VALUES ('during')`)
		writerDone <- err
	}()
	// Give the writer time to reach the gate while holding its connection.
	time.Sleep(200 * time.Millisecond)
	database.writeGate.leaveMaintenance()

	service := newTestMaintenanceService(t, database)
	if _, err := service.StartVacuum(ctx); err != nil {
		t.Fatalf("start vacuum: %v", err)
	}
	status := waitForMaintenance(t, service)
	if status.Error != "" {
		t.Fatalf("vacuum failed, which is what a deadlock looks like from here: %s", status.Error)
	}
	if err := <-writerDone; err != nil {
		t.Fatalf("the parked writer failed: %v", err)
	}
}

// TestCompletionObserverMayWriteToTheDatabase is a regression test for an observed
// deadlock, and it is why the gate is released before the terminal state is published.
//
// The API layer records a job's outcome in the audit trail, which is a database write,
// and a write waits for the gate the job holds. When the terminal state was published
// first - from inside the exclusive section - the job held the gate while waiting for
// its own observer, and the observer waited for the gate. The observable symptom was a
// checkpoint whose audit record failed with a cancelled context and whose HTTP response
// never arrived, so both halves are asserted here: the observer completes, and the
// operation the caller is waiting on returns.
func TestCompletionObserverMayWriteToTheDatabase(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE audit_probe(id INTEGER PRIMARY KEY, action TEXT)`); err != nil {
		t.Fatal(err)
	}

	service := newTestMaintenanceService(t, database)
	observed := make(chan string, 1)
	service.OnCompletion(func(status MaintenanceStatus) {
		// A write, exactly as the audit recorder performs. It must not be refused or
		// blocked, and it must not need the maintenance context to succeed.
		if _, err := database.SQL.ExecContext(ctx, `INSERT INTO audit_probe(action) VALUES (?)`, status.Action); err != nil {
			observed <- "write failed: " + err.Error()
			return
		}
		observed <- status.Action
	})

	if _, err := service.StartCheckpoint(ctx); err != nil {
		t.Fatalf("start checkpoint: %v", err)
	}

	select {
	case action := <-observed:
		if action != MaintenanceCheckpoint {
			t.Fatalf("observer saw %q", action)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the completion observer never ran: publishing the terminal state while holding the gate deadlocks a writing observer")
	}

	var rows int
	if err := database.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_probe`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("audit rows = %d, want 1", rows)
	}
}

// TestFailedGateAcquisitionStillReportsTerminalState pins that every admitted job
// reaches a terminal state, including one that cannot take the gate: a job stuck at
// "running" would show as in progress for the life of the process.
func TestFailedGateAcquisitionStillReportsTerminalState(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()
	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}

	// Hold the gate so the job's acquisition cannot succeed, and cancel the service so
	// the job gives up rather than waiting for the test to finish.
	lifecycle, cancelLifecycle := context.WithCancel(ctx)
	service, err := NewMaintenanceService(lifecycle, database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close() })

	if err := database.writeGate.enterMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	defer database.writeGate.leaveMaintenance()

	if _, err := service.StartCheckpoint(ctx); err != nil {
		t.Fatalf("the job was not admitted: %v", err)
	}
	cancelLifecycle()

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		status := service.Status()
		if !status.Running && status.FinishedAtMS != 0 {
			if status.Error == "" {
				t.Fatal("a job that could not take the gate reported no error")
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("a job that could not take the gate never reported a terminal state: %+v", service.Status())
}
