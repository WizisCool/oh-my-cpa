package repository

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestClassifyStatement(t *testing.T) {
	// Every string that must pass the gate. The table is the classifier's contract: a
	// write that appears here as a read would be a hole, and the conservative bias means
	// several of these are reads that are gated anyway.
	writes := []string{
		`INSERT INTO usage_events(id) VALUES (1)`,
		`  insert into usage_events(id) values (1)`,
		"\n\tUPDATE usage_events SET id = 1",
		`DELETE FROM usage_events`,
		`CREATE TABLE probe(id INTEGER PRIMARY KEY)`,
		`DROP TABLE probe`,
		`ALTER TABLE probe ADD COLUMN v TEXT`,
		`REPLACE INTO probe(id) VALUES (1)`,
		`BEGIN IMMEDIATE`,
		`COMMIT`,
		`ROLLBACK`,
		// A pragma is gated whatever its argument, because the family mixes reads
		// and writes: `journal_mode` reads, `journal_mode=WAL` writes, and
		// `wal_checkpoint(TRUNCATE)` writes while reporting a result row.
		`PRAGMA journal_mode`,
		`PRAGMA journal_mode=WAL`,
		`PRAGMA wal_checkpoint(TRUNCATE)`,
		`PRAGMA optimize`,
		// A comment must not hide the real statement from the classifier.
		"-- a leading comment\nINSERT INTO probe(id) VALUES (1)",
		"/* block */ DELETE FROM probe",
		// A CTE can introduce a write and its first keyword does not say which, so WITH
		// is gated whether or not the statement selects. The one WITH in this repository
		// pays a wait during a rebuild for a guarantee that needs no re-checking.
		`WITH day_range(day_index) AS (SELECT 1) SELECT * FROM day_range`,
		`WITH x AS (SELECT 1) DELETE FROM probe`,
		// Any semicolon at all is gated, whatever it separates and whatever surrounds it.
		// The rule is deliberately crude: the scanner that tried to distinguish a
		// separator from a semicolon inside a literal had a hole - `SELECT 1;; DELETE`
		// passed - and a classifier that is nearly right is worse than one that is
		// obviously conservative.
		`SELECT 1; DELETE FROM probe`,
		`SELECT 1;DROP TABLE probe`,
		`SELECT 1;; DELETE FROM probe`,
		`SELECT 1; ; DELETE FROM probe`,
		`SELECT 1;-- comment\nDELETE FROM probe`,
		// These three contain a semicolon inside a literal or a comment, which cannot be a
		// separator. They are gated anyway: the cost is one wait, and paying it keeps the
		// rule checkable by reading one line.
		`SELECT ';' AS separator`,
		`SELECT 1 -- trailing comment; with a semicolon`,
		`SELECT 1 /* block; with a semicolon */`,
	}
	for _, query := range writes {
		if !classifyStatement(query) {
			t.Errorf("classifyStatement(%q) = false, want true (must pass the gate)", query)
		}
	}

	reads := []string{
		`SELECT COUNT(*) FROM usage_events`,
		`  select 1`,
		"\n\tSELECT id FROM probe",
		`VALUES (1)`,
		`EXPLAIN SELECT 1`,
		``,
		`   `,
		`-- only a comment`,
	}
	for _, query := range reads {
		if classifyStatement(query) {
			t.Errorf("classifyStatement(%q) = true, want false (a read must not queue behind maintenance)", query)
		}
	}
}

// TestWriteGateSerialisesMaintenanceAgainstWriters is the property the whole gate
// exists for: a write issued while maintenance holds exclusivity must wait for it
// and then succeed, never fail. A failing write here is not a slow request - the
// usage collector treats it as fatal and the process exits.
func TestWriteGateSerialisesMaintenanceAgainstWriters(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}

	maintenanceCtx := withMaintenanceContext(ctx)
	gate := database.writeGate

	released := make(chan struct{})
	holdEntered := make(chan struct{})
	go func() {
		if err := gate.enterMaintenance(maintenanceCtx); err != nil {
			t.Error(err)
			return
		}
		close(holdEntered)
		<-released
		gate.leaveMaintenance()
	}()
	<-holdEntered

	writeDone := make(chan error, 1)
	go func() {
		// The writer's own context has a deadline far longer than the hold, so a
		// failure here would mean the gate did not actually make it wait.
		writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		_, err := database.SQL.ExecContext(writeCtx, `INSERT INTO probe(v) VALUES ('during-maintenance')`)
		writeDone <- err
	}()

	select {
	case err := <-writeDone:
		t.Fatalf("writer completed while maintenance held the gate (err=%v): the gate did not serialise", err)
	case <-time.After(200 * time.Millisecond):
		// Still waiting, which is the required behaviour.
	}

	close(released)
	if err := <-writeDone; err != nil {
		t.Fatalf("writer failed after maintenance released the gate: %v", err)
	}

	var rows int
	if err := database.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM probe`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("probe rows = %d, want 1", rows)
	}
}

// TestQueuedWriterAbandonsItsWaitWhenCancelled pins the property sync.RWMutex
// cannot provide: a writer queued behind maintenance must be able to give up.
// Without it one VACUUM would pin every HTTP handler that touched the database
// until it finished, past the server's own write timeout.
func TestQueuedWriterAbandonsItsWaitWhenCancelled(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	gate := database.writeGate
	if err := gate.enterMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	defer gate.leaveMaintenance()

	writeCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := gate.enterWrite(writeCtx); err == nil {
		gate.leaveWrite()
		t.Fatal("writer was granted the gate while maintenance held it")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("cancellation took %v: the queued writer was not woken by its context", elapsed)
	}

	// The abandoned waiter must not have been counted as a holder, or maintenance
	// would never be able to finish and every later writer would stall.
	gate.leaveMaintenance()
	if err := gate.enterWrite(ctx); err != nil {
		t.Fatalf("writer cannot enter after the abandoned wait: %v", err)
	}
	gate.leaveWrite()
}

// TestCancelledWaiterDoesNotStealAGrant covers the race between a grant and a
// cancellation. A waiter granted at the same moment its context ends must be
// reported as holding the gate, because the alternative - reporting a cancelled
// acquisition while the grant stands - leaks the shared side permanently and
// stalls every later writer, including maintenance.
func TestCancelledWaiterDoesNotStealAGrant(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()
	gate := database.writeGate

	for attempt := 0; attempt < 200; attempt++ {
		if err := gate.enterMaintenance(ctx); err != nil {
			t.Fatal(err)
		}
		writeCtx, cancel := context.WithCancel(ctx)
		result := make(chan error, 1)
		go func() { result <- gate.enterWrite(writeCtx) }()
		// Cancel while the writer is queued, then release maintenance so the two
		// happen concurrently.
		cancel()
		gate.leaveMaintenance()

		if err := <-result; err == nil {
			gate.leaveWrite()
		}

		// Whatever the race decided, the gate must be usable again.
		usable := make(chan error, 1)
		go func() { usable <- gate.enterMaintenance(ctx) }()
		select {
		case err := <-usable:
			if err != nil {
				t.Fatalf("attempt %d: maintenance cannot enter after the race: %v", attempt, err)
			}
			gate.leaveMaintenance()
		case <-time.After(5 * time.Second):
			t.Fatalf("attempt %d: the gate stalled after a grant/cancel race", attempt)
		}
	}
}

// TestSecondMaintenanceJobIsRefused pins that exclusivity is real even if a caller
// bypasses the service's own single-flight lock.
func TestSecondMaintenanceJobIsRefused(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()
	gate := database.writeGate

	if err := gate.enterMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	defer gate.leaveMaintenance()

	if err := gate.enterMaintenance(ctx); !errors.Is(err, errMaintenanceInProgress) {
		t.Fatalf("second maintenance acquire = %v, want errMaintenanceInProgress", err)
	}
}

// TestReadsDoNotQueueBehindMaintenance is the other half of the asymmetric
// classification: a read must keep working while maintenance holds exclusivity,
// otherwise a long VACUUM would look like a frozen console.
func TestReadsDoNotQueueBehindMaintenance(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}

	gate := database.writeGate
	released := make(chan struct{})
	holdEntered := make(chan struct{})
	go func() {
		if err := gate.enterMaintenance(withMaintenanceContext(ctx)); err != nil {
			t.Error(err)
			return
		}
		close(holdEntered)
		<-released
		gate.leaveMaintenance()
	}()
	<-holdEntered

	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var rows int
	readErr := make(chan error, 1)
	go func() {
		readErr <- database.SQL.QueryRowContext(readCtx, `SELECT COUNT(*) FROM probe`).Scan(&rows)
	}()

	select {
	case err := <-readErr:
		if err != nil {
			t.Fatalf("read failed while maintenance held the gate: %v", err)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("read did not complete while maintenance held the gate: it was gated by accident")
	}
	close(released)
}

// TestMaintenanceContextRunsUngatedOnItsOwnConnection pins the detail that makes
// maintenance possible at all: with SetMaxOpenConns(1) there is no second
// connection to work on, so the maintenance statement must run on the very
// connection whose gate it already holds. Without this exemption it would queue
// behind the shared side it owns and deadlock.
func TestMaintenanceContextRunsUngatedOnItsOwnConnection(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.ExecContext(ctx, `INSERT INTO probe(v) VALUES ('x')`); err != nil {
		t.Fatal(err)
	}

	gate := database.writeGate
	if err := gate.enterMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	defer gate.leaveMaintenance()

	// The maintenance holder's own work runs on a marked context.
	maintenanceCtx, cancel := context.WithTimeout(withMaintenanceContext(ctx), 30*time.Second)
	defer cancel()

	var idle, logFrames, checkpointed int
	if err := database.SQL.QueryRowContext(maintenanceCtx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&idle, &logFrames, &checkpointed); err != nil {
		t.Fatalf("gated maintenance statement failed: %v", err)
	}

	// The negative control: the same statement on an unmarked context must NOT
	// run, proving the exemption is what let the call above through. It is
	// asserted from a bounded goroutine because the gate is allowed to make this
	// caller wait - that is its job - and a test that waited would hang.
	blocked := make(chan error, 1)
	go func() {
		blockedCtx, cancelBlocked := context.WithTimeout(ctx, 300*time.Millisecond)
		defer cancelBlocked()
		_, err := database.SQL.ExecContext(blockedCtx, `PRAGMA wal_checkpoint(TRUNCATE)`)
		blocked <- err
	}()

	select {
	case err := <-blocked:
		if err == nil {
			t.Fatal("an unmarked statement ran while maintenance held exclusivity: the gate leaked")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the unmarked statement neither ran nor returned: the gate is not honouring its context")
	}
}

// TestTransactionHoldsTheGateUntilItEnds pins that the gate is transaction-scoped.
// SQLite's write lock outlives individual statements inside a transaction, so a
// gate released per statement would let maintenance in while the file was still
// write-locked - the SQLITE_BUSY the gate exists to prevent.
func TestTransactionHoldsTheGateUntilItEnds(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}

	tx, err := database.SQL.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO probe(v) VALUES ('a')`); err != nil {
		t.Fatal(err)
	}

	gate := database.writeGate
	entered := make(chan struct{})
	go func() {
		if err := gate.enterMaintenance(ctx); err != nil {
			t.Error(err)
			return
		}
		close(entered)
		gate.leaveMaintenance()
	}()

	select {
	case <-entered:
		t.Fatal("maintenance entered while a write transaction was still open")
	case <-time.After(200 * time.Millisecond):
	}

	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
		// Maintenance runs after the transaction ended, as required.
	case <-time.After(5 * time.Second):
		t.Fatal("maintenance never entered after the transaction committed")
	}
}

// TestReadOnlyTransactionStillPassesTheGate pins that a "read-only" transaction is
// not a way around the gate.
//
// The flag is a hint: modernc.org/sqlite only uses it to choose the BEGIN mode string,
// so such a transaction can still write. A gate that trusted the flag would have a hole
// shaped exactly like the path it is protecting.
func TestReadOnlyTransactionStillPassesTheGate(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}

	gate := database.writeGate
	if err := gate.enterMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	defer gate.leaveMaintenance()

	// The transaction must not open while the exclusive holder is inside.
	opened := make(chan error, 1)
	go func() {
		openCtx, cancel := context.WithTimeout(ctx, 400*time.Millisecond)
		defer cancel()
		tx, err := database.SQL.BeginTx(openCtx, &sql.TxOptions{ReadOnly: true})
		if err == nil {
			_ = tx.Rollback()
		}
		opened <- err
	}()

	select {
	case err := <-opened:
		if err == nil {
			t.Fatal("a read-only transaction bypassed the gate while maintenance held it")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a read-only transaction neither opened nor returned")
	}
}

// TestCancellingTheLastMaintenanceWaiterWakesQueuedWriters covers the wake-up
// transition a cancellation could otherwise strand: a writer queued behind a
// maintenance holder that gives up must be admitted, or it waits for an event that
// never comes.
func TestCancellingTheLastMaintenanceWaiterWakesQueuedWriters(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()
	gate := database.writeGate

	// A writer inside the gate, so the maintenance holder has to queue.
	if err := gate.enterWrite(ctx); err != nil {
		t.Fatal(err)
	}

	maintenanceCtx, cancelMaintenance := context.WithCancel(ctx)
	maintenanceDone := make(chan error, 1)
	go func() { maintenanceDone <- gate.enterMaintenance(maintenanceCtx) }()
	// Let the maintenance holder reach the queue so new writers queue behind it.
	time.Sleep(150 * time.Millisecond)

	writerCtx, cancelWriter := context.WithTimeout(ctx, 10*time.Second)
	defer cancelWriter()
	writerDone := make(chan error, 1)
	go func() { writerDone <- gate.enterWrite(writerCtx) }()
	time.Sleep(150 * time.Millisecond)

	// The maintenance holder gives up while the writer is queued behind it.
	cancelMaintenance()
	if err := <-maintenanceDone; err == nil {
		t.Fatal("the cancelled maintenance acquisition was granted")
	}
	gate.leaveWrite()

	select {
	case err := <-writerDone:
		if err != nil {
			t.Fatalf("the queued writer was not admitted after the maintenance holder gave up: %v", err)
		}
		gate.leaveWrite()
	case <-time.After(5 * time.Second):
		t.Fatal("the queued writer was stranded: cancelling the last maintenance waiter did not wake it")
	}
}

// TestConcurrentWritersAllSucceedAndGateDoesNotDeadlock is the deadlock control:
// mixed concurrent writers, readers and maintenance must all finish. A gate that
// re-enters the shared side, or that maintenance cannot acquire, shows up here as
// a hung test rather than as a production hang.
func TestConcurrentWritersAllSucceedAndGateDoesNotDeadlock(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}

	const writers = 8
	var waitGroup sync.WaitGroup
	errs := make(chan error, writers+2)

	for worker := 0; worker < writers; worker++ {
		waitGroup.Add(1)
		go func(worker int) {
			defer waitGroup.Done()
			writeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			if _, err := database.SQL.ExecContext(writeCtx, `INSERT INTO probe(v) VALUES (?)`, worker); err != nil {
				errs <- err
			}
		}(worker)
	}

	waitGroup.Add(1)
	go func() {
		defer waitGroup.Done()
		maintenanceCtx, cancel := context.WithTimeout(withMaintenanceContext(ctx), 30*time.Second)
		defer cancel()
		if _, err := database.SQL.ExecContext(maintenanceCtx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
			errs <- err
		}
	}()

	waitGroup.Add(1)
	go func() {
		defer waitGroup.Done()
		for i := 0; i < 20; i++ {
			var count int
			if err := database.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM probe`).Scan(&count); err != nil {
				errs <- err
				return
			}
		}
	}()

	done := make(chan struct{})
	go func() {
		waitGroup.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(60 * time.Second):
		t.Fatal("concurrent writers, readers and maintenance deadlocked")
	}
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent operation failed: %v", err)
	}
}

// openGatedTestDatabase opens a file-backed database through the gated driver, so
// the tests exercise the same construction the application uses rather than a
// hand-built stand-in.
func openGatedTestDatabase(t *testing.T) *DB {
	t.Helper()
	database, err := Open(context.Background(), filepath.Join(t.TempDir(), "gated.db"))
	if err != nil {
		t.Fatalf("open gated database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

// TestGatedDriverIsWiredIntoOpen fails closed if Open is rewired to a driver
// without the gate: every maintenance test in this package would otherwise pass
// while the running application had no protection at all.
func TestGatedDriverIsWiredIntoOpen(t *testing.T) {
	database := openGatedTestDatabase(t)
	if database.writeGate == nil {
		t.Fatal("Open returned a database without a write gate")
	}
	if database.SQL == nil {
		t.Fatal("Open returned a database without a connection pool")
	}
	driverName := database.driverName()
	if !strings.Contains(driverName, gatedDriverName) {
		t.Fatalf("driver name = %q, want a gated driver (%q)", driverName, gatedDriverName)
	}
}

// TestTheGateIsPerDatabase pins that a maintenance job on one database does not block
// writes to another. A process-wide gate passed every earlier test in this package
// because they open one database at a time, which is exactly the kind of coverage gap a
// shared global creates: the defect only appears when two databases are live at once -
// two tests in one run, or a second database in one process.
func TestTheGateIsPerDatabase(t *testing.T) {
	first := openGatedTestDatabase(t)
	second := openGatedTestDatabase(t)
	ctx := context.Background()

	if first.writeGate == second.writeGate {
		t.Fatal("two databases share one gate: a rebuild in one would stall writes in the other")
	}
	for name, database := range map[string]*DB{"first": first, "second": second} {
		if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}

	// Hold the first database's gate exclusively, then write to the second. The write must
	// not wait.
	if err := first.writeGate.enterMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	defer first.writeGate.leaveMaintenance()

	writeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := second.SQL.ExecContext(writeCtx, `INSERT INTO probe(v) VALUES ('unrelated')`)
		done <- err
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a write to an unrelated database was blocked: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a write to an unrelated database waited for another database's maintenance job")
	}

	// The negative control: the same write against the gated database must wait.
	blocked := make(chan error, 1)
	go func() {
		blockedCtx, cancelBlocked := context.WithTimeout(ctx, 400*time.Millisecond)
		defer cancelBlocked()
		_, err := first.SQL.ExecContext(blockedCtx, `INSERT INTO probe(v) VALUES ('gated')`)
		blocked <- err
	}()
	select {
	case err := <-blocked:
		if err == nil {
			t.Fatal("a write to the gated database was admitted while maintenance held it")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the gated write neither ran nor returned")
	}
}

// TestColumnMetadataSurvivesTheGate pins that the driver's optional row interfaces are
// forwarded through the gate's wrappers.
//
// A wrapper that satisfies only driver.Rows compiles, passes every query test, and
// silently drops the column database type, length, nullability, precision and scan type
// that modernc.org/sqlite reports. Nothing in this repository's own queries would notice
// immediately, which is exactly why the forwarding needs an assertion of its own.
func TestColumnMetadataSurvivesTheGate(t *testing.T) {
	database := openGatedTestDatabase(t)
	ctx := context.Background()

	if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE probe(id INTEGER PRIMARY KEY, name TEXT, amount REAL, payload BLOB)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.ExecContext(ctx, `INSERT INTO probe(name, amount, payload) VALUES ('x', 1.5, x'00')`); err != nil {
		t.Fatal(err)
	}

	// A query classified as a read goes through the ungated path; one classified as a
	// write goes through gatedRows. Both must report metadata, so both are exercised.
	for name, query := range map[string]string{
		"read path":        `SELECT id, name, amount, payload FROM probe`,
		"write-classified": `INSERT INTO probe(name, amount, payload) VALUES ('y', 2.5, x'01') RETURNING id, name, amount, payload`,
	} {
		rows, err := database.SQL.QueryContext(ctx, query)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		columnTypes, err := rows.ColumnTypes()
		if err != nil {
			rows.Close()
			t.Fatalf("%s: column types: %v", name, err)
		}
		if len(columnTypes) != 4 {
			rows.Close()
			t.Fatalf("%s: %d column types, want 4", name, len(columnTypes))
		}
		// The text column must be reported as a typed column rather than as an opaque
		// value: this is what the wrapper would hide.
		if got := columnTypes[1].DatabaseTypeName(); got == "" {
			rows.Close()
			t.Fatalf("%s: the TEXT column reported no database type name (metadata was dropped by the wrapper)", name)
		}
		if err := rows.Close(); err != nil {
			t.Fatalf("%s: close: %v", name, err)
		}
	}
}
