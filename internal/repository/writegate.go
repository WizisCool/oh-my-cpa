package repository

import (
	"context"
	"database/sql/driver"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync"
)

/**
 * The write gate: one exclusive holder that must not overlap any writer.
 *
 * Why this exists at the driver level rather than in the repository call sites.
 *
 * SQLite's own locking cannot express this. Under WAL a reader never blocks a
 * writer and a writer never blocks a reader, so `PRAGMA wal_checkpoint(TRUNCATE)`
 * and `VACUUM` are the two statements that need exclusive access - and the second
 * needs it badly, because it rewrites every page of the file. `busy_timeout` is
 * not the mechanism either: it makes a blocked SQLite call retry, it does not stop
 * a writer from starting, and VACUUM neither retries nor defers.
 *
 * The consequence of getting this wrong is not a slow request. The usage
 * collector treats a failed write as fatal (`internal/app` returns an error from
 * Run when the pipeline stops, because silently stale history is worse than a
 * crash), so a writer that loses a race against VACUUM takes the process down
 * with it. A gate at the statement boundary is therefore not an optimisation: it
 * is what makes the maintenance actions safe to offer at all.
 *
 * Classification is deliberately asymmetric. A statement whose first keyword is
 * not unambiguously a read is treated as a write and passes the gate, because the
 * two mistakes do not cost the same: gating a read only makes it wait behind a
 * maintenance job, while letting a write through can terminate the process. Every
 * statement in this repository is a static SQL literal, so the classifier is a
 * property of the code rather than of operator input - but it is also why the
 * default is "gate it" instead of "allow it".
 */

// readKeywords are the statement lead keywords treated as reads. An empty
// statement is also treated as a read: it cannot write, and refusing it would
// invent a failure mode for something that does nothing.
//
// `WITH` is deliberately absent. A common table expression can introduce an
// `UPDATE`, `DELETE` or `INSERT`, so its first keyword does not tell you what the
// statement does - and treating it as a read would let a write through, which is the
// direction this classifier must never fail in. The one `WITH` in this repository
// selects from a `VALUES` list and therefore pays one wait during a rebuild for a
// guarantee that holds without anyone having to re-check it.
var readKeywords = map[string]bool{
	"SELECT":  true,
	"VALUES":  true,
	"EXPLAIN": true,
}

// classifyStatement reports whether a statement must pass the write gate.
//
// PRAGMA is the awkward case and gets its own rule. `PRAGMA journal_mode` reads
// while `PRAGMA journal_mode=WAL` writes, and `PRAGMA wal_checkpoint(TRUNCATE)`
// writes while claiming to be a pragma. Splitting that family by its argument text
// would be guesswork, so every PRAGMA is gated. The database's own connection
// setup pragmas do not travel this path at all - they are applied from the DSN
// inside the driver, below this wrapper - so what is left here is a handful of
// statements that can afford to wait.
func classifyStatement(query string) bool {
	// Checked before the keyword, because a second statement is exactly the case a
	// first-keyword classifier cannot see: `SELECT 1; DELETE FROM probe` leads with a
	// read and does not end as one. This must be a separate refusal rather than a
	// missing keyword, because a genuinely empty statement is also keywordless and that
	// one cannot write.
	if hasStatementSeparator(query) {
		return true
	}
	keyword, ok := leadingKeyword(query)
	if !ok {
		// No keyword at all: an empty string or a comment. It cannot write.
		return false
	}
	return !readKeywords[keyword]
}

// leadingKeyword returns the first SQL keyword of a statement, skipping leading
// whitespace, line and block comments, and any parenthesised prefix. Keyword
// matching is case-insensitive.
func leadingKeyword(query string) (string, bool) {
	trimmed := strings.TrimSpace(query)
	for {
		switch {
		case trimmed == "":
			return "", false
		case strings.HasPrefix(trimmed, "--"):
			end := strings.IndexByte(trimmed, '\n')
			if end < 0 {
				return "", false
			}
			trimmed = strings.TrimSpace(trimmed[end+1:])
		case strings.HasPrefix(trimmed, "/*"):
			end := strings.Index(trimmed[2:], "*/")
			if end < 0 {
				return "", false
			}
			trimmed = strings.TrimSpace(trimmed[end+4:])
		case strings.HasPrefix(trimmed, "("):
			trimmed = strings.TrimSpace(trimmed[1:])
		default:
			end := strings.IndexFunc(trimmed, func(r rune) bool {
				return !isIdentifierRune(r)
			})
			if end < 0 {
				end = len(trimmed)
			}
			if end == 0 {
				return "", false
			}
			return strings.ToUpper(trimmed[:end]), true
		}
	}
}

// hasStatementSeparator reports whether a statement string contains a semicolon.
//
// The rule is intentionally crude, and it replaced a scanner that tried to be clever.
// That scanner skipped quoted literals and comments so a semicolon inside a value would
// not count, and it had a hole: `SELECT 1;; DELETE FROM probe` leads with a semicolon
// whose remainder begins with another semicolon, so the scan concluded there was no
// second statement and let a write through unguarded. A SQL classifier that is nearly
// right is worse than none, because the guarantee is only as strong as its least-tested
// branch.
//
// So any semicolon at all is treated as a possible second statement. A false positive
// costs one wait behind a rebuild, and this repository pays it in exactly the places that
// deserve it: the multi-statement strings in `pricing_catalog.go` and the migration
// scripts are writes, and they run inside a transaction that has already passed the gate.
// No read in this repository contains a semicolon.
func hasStatementSeparator(query string) bool {
	return strings.ContainsRune(query, ';')
}

func isIdentifierRune(r rune) bool {
	return r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

// writeGate serialises writers against an exclusive maintenance holder.
//
// Writers hold the shared side for as long as their statement or transaction is
// open; maintenance holds the exclusive side for as long as its job runs. Two
// properties are required and neither comes free:
//
//   - Waiting, not failing. A writer that returned an error here would be handled
//     as a fatal pipeline failure by the usage collector, so a writer must wait
//     for maintenance to finish. This is why the gate exists.
//   - Waiting is cancellable. VACUUM on a large database runs for minutes, and a
//     writer that cannot abandon the wait would pin an HTTP handler - and, on the
//     pool's single connection, could hold a request open past the server's own
//     write timeout with nothing to report.
//
// sync.RWMutex offers the first but not the second: neither RLock nor Lock takes a
// context, and a queued writer cannot be recalled. Hence a purpose-built gate:
// writers queue on their own contexts and are woken in order, so a client that
// goes away is removed from the queue instead of parking behind a rebuild.
//
// Fairness is FIFO. A stream of short writes behind a waiting maintenance job
// would otherwise be able to starve it indefinitely, which on a busy collector is
// the normal case rather than an edge case.
type writeGate struct {
	mutex sync.Mutex

	// writers is the number of shared holders currently inside the gate.
	writers int
	// isMaintenanceHeld is true while the exclusive holder is inside.
	isMaintenanceHeld bool
	// isMaintenanceWaiting is true while an exclusive holder is queued, and it is
	// what makes new writers queue behind it instead of overtaking.
	isMaintenanceWaiting bool
	// writerQueue holds queued writers in arrival order. An entry is removed by its
	// own context being cancelled or by being granted.
	writerQueue []*gateWaiter
	// maintenanceQueue holds queued maintenance holders. It can hold at most one
	// entry in practice; the slice keeps the wake-up logic uniform.
	maintenanceQueue []*gateWaiter
}

// gateWaiter is one queued acquisition.
type gateWaiter struct {
	granted chan struct{}
	err     error
}

func (g *writeGate) enterWrite(ctx context.Context) error {
	return g.acquire(ctx, false)
}

func (g *writeGate) enterMaintenance(ctx context.Context) error {
	return g.acquire(ctx, true)
}

// acquire queues for the requested side and waits until it is granted or the
// caller's context ends.
func (g *writeGate) acquire(ctx context.Context, maintenance bool) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	g.mutex.Lock()
	if maintenance {
		if g.isMaintenanceHeld {
			// A second maintenance job cannot run at the same time on one database.
			g.mutex.Unlock()
			return errMaintenanceInProgress
		}
		if g.writers == 0 {
			g.isMaintenanceHeld = true
			g.mutex.Unlock()
			return nil
		}
		waiter := &gateWaiter{granted: make(chan struct{})}
		g.maintenanceQueue = append(g.maintenanceQueue, waiter)
		g.isMaintenanceWaiting = true
		g.mutex.Unlock()
		return g.wait(ctx, waiter, g.cancelMaintenanceWaiter)
	}

	if !g.isMaintenanceHeld && !g.isMaintenanceWaiting {
		g.writers++
		g.mutex.Unlock()
		return nil
	}
	waiter := &gateWaiter{granted: make(chan struct{})}
	g.writerQueue = append(g.writerQueue, waiter)
	g.mutex.Unlock()
	return g.wait(ctx, waiter, g.cancelWriterWaiter)
}

// wait blocks until the waiter is granted or the context ends. The cancel
// function removes the waiter from its queue under the gate's own lock.
func (g *writeGate) wait(ctx context.Context, waiter *gateWaiter, cancel func(*gateWaiter) bool) error {
	select {
	case <-waiter.granted:
		return waiter.err
	case <-ctx.Done():
		if cancel(waiter) {
			return ctx.Err()
		}
		// The grant won the race: the caller owns the gate now and must be told it
		// was granted even though its context has ended. Returning the context error
		// here would leak the grant and stall every later writer, so the acquisition
		// is reported as successful and the caller releases it normally.
		return nil
	}
}

// cancelWriterWaiter removes a queued writer. It reports false when the writer was
// granted in the meantime, which means the grant must be honoured.
func (g *writeGate) cancelWriterWaiter(waiter *gateWaiter) bool {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	for index, queued := range g.writerQueue {
		if queued != waiter {
			continue
		}
		g.writerQueue = append(g.writerQueue[:index], g.writerQueue[index+1:]...)
		return true
	}
	return false
}

// cancelMaintenanceWaiter removes a queued maintenance holder. It reports false
// when it was granted in the meantime.
func (g *writeGate) cancelMaintenanceWaiter(waiter *gateWaiter) bool {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	for index, queued := range g.maintenanceQueue {
		if queued != waiter {
			continue
		}
		g.maintenanceQueue = append(g.maintenanceQueue[:index], g.maintenanceQueue[index+1:]...)
		g.isMaintenanceWaiting = len(g.maintenanceQueue) > 0
		// A cancelled holder that was the one blocking the writer queue must hand the
		// gate on. Without this the writers behind it stay parked until some unrelated
		// event wakes them - which in a quiet deployment is never.
		if !g.isMaintenanceHeld && !g.isMaintenanceWaiting {
			g.grantQueuedWritersLocked()
		}
		return true
	}
	return false
}

func (g *writeGate) leaveWrite() {
	g.mutex.Lock()
	if g.writers > 0 {
		g.writers--
	}
	// A maintenance job waiting on this writer may now be able to start. Queued
	// writers are not admitted here: while maintenance is waiting they are behind
	// it, and admitting them would starve it.
	g.grantMaintenanceLocked()
	g.mutex.Unlock()
}

func (g *writeGate) leaveMaintenance() {
	g.mutex.Lock()
	g.isMaintenanceHeld = false
	g.grantMaintenanceLocked()
	// Only after maintenance is fully out may queued writers proceed, and only if
	// no maintenance job is queued behind them.
	if !g.isMaintenanceHeld && !g.isMaintenanceWaiting {
		g.grantQueuedWritersLocked()
	}
	g.mutex.Unlock()
}

// grantMaintenanceLocked hands exclusivity to the queued maintenance holder once
// no writer is inside the gate.
//
// Queued writers are deliberately not a precondition: a writer that arrived while
// maintenance was already waiting sits behind it by construction, so requiring an
// empty writer queue here would mean maintenance could never start as soon as one
// writer gave up waiting - the opposite of fairness.
func (g *writeGate) grantMaintenanceLocked() {
	if g.isMaintenanceHeld || len(g.maintenanceQueue) == 0 || g.writers != 0 {
		return
	}
	waiter := g.maintenanceQueue[0]
	g.maintenanceQueue = g.maintenanceQueue[1:]
	g.isMaintenanceWaiting = len(g.maintenanceQueue) > 0
	g.isMaintenanceHeld = true
	close(waiter.granted)
}

// grantQueuedWritersLocked admits every writer that was queued behind
// maintenance. They are all woken at once because shared holders do not exclude
// each other.
func (g *writeGate) grantQueuedWritersLocked() {
	queued := g.writerQueue
	g.writerQueue = nil
	for _, waiter := range queued {
		g.writers++
		close(waiter.granted)
	}
}

// errMaintenanceInProgress is returned to a second concurrent maintenance job.
// The maintenance service holds its own single-flight lock as well; this is the
// gate's own defence so the invariant does not depend on the caller.
var errMaintenanceInProgress = errors.New("another maintenance job is already running")

// maintenanceContextKey marks a context whose database work belongs to the
// exclusive maintenance holder itself. VACUUM runs on the same pool the gate
// protects, so without this marker it would wait for the shared side of a gate it
// is already holding - a self-deadlock on the one connection there is.
type maintenanceContextKey struct{}

// withMaintenanceContext marks a context as belonging to the maintenance holder.
// It is package-private so no other caller can opt itself out of the gate.
func withMaintenanceContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, maintenanceContextKey{}, true)
}

func isMaintenanceContext(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	marked, _ := ctx.Value(maintenanceContextKey{}).(bool)
	return marked
}

// gatedConn wraps a driver connection with the write gate.
//
// Every read goes straight through. Writes and transactions take the shared side.
// A transaction keeps it until Commit or Rollback, because SQLite's write lock
// lives until the transaction ends: releasing the gate at each statement would let
// maintenance in while a transaction still held the file's write lock, which is
// exactly the SQLITE_BUSY the gate is supposed to make impossible.
//
// isGateHeldInTx records that a transaction on this connection already holds the
// shared side, so statements prepared through the transaction must not take it
// again. Go's RWMutex does not allow a reader to acquire a second read lock while
// a writer is waiting, so re-entering here would deadlock the transaction against
// the maintenance job that is waiting for it.
type gatedConn struct {
	inner          driver.Conn
	gate           *writeGate
	isGateHeldInTx bool
}

var (
	_ driver.Conn               = (*gatedConn)(nil)
	_ driver.ConnPrepareContext = (*gatedConn)(nil)
	_ driver.ConnBeginTx        = (*gatedConn)(nil)
	_ driver.ExecerContext      = (*gatedConn)(nil)
	_ driver.QueryerContext     = (*gatedConn)(nil)
	_ driver.Pinger             = (*gatedConn)(nil)
	_ driver.SessionResetter    = (*gatedConn)(nil)
	_ driver.Validator          = (*gatedConn)(nil)
)

func (c *gatedConn) Prepare(query string) (driver.Stmt, error) {
	stmt, err := c.inner.Prepare(query)
	if err != nil {
		return nil, err
	}
	return &gatedStmt{inner: stmt, conn: c, query: query}, nil
}

func (c *gatedConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	preparer, ok := c.inner.(driver.ConnPrepareContext)
	if !ok {
		return c.Prepare(query)
	}
	stmt, err := preparer.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return &gatedStmt{inner: stmt, conn: c, query: query}, nil
}

func (c *gatedConn) Close() error {
	// A connection closed with a transaction still open would otherwise leak the
	// shared side of the gate for the life of the process, stalling every later
	// writer. database/sql normally ends a transaction first, but this is the one
	// place able to observe the leak.
	if c.isGateHeldInTx {
		c.isGateHeldInTx = false
		c.gate.leaveWrite()
	}
	return c.inner.Close()
}

func (c *gatedConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *gatedConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if isMaintenanceContext(ctx) || c.isGateHeldInTx {
		return c.beginInner(ctx, opts, false)
	}
	// driver.TxOptions.ReadOnly is a hint, not a constraint: modernc.org/sqlite only
	// uses it to pick the BEGIN mode string, so a transaction opened with it can still
	// write and must still pass the gate. Skipping the gate on that flag would hand
	// the write path a hole that looks like a read-only optimisation.
	if err := c.gate.enterWrite(ctx); err != nil {
		return nil, err
	}
	return c.beginInner(ctx, opts, true)
}

func (c *gatedConn) beginInner(ctx context.Context, opts driver.TxOptions, holdsGate bool) (driver.Tx, error) {
	var tx driver.Tx
	var err error
	if beginner, ok := c.inner.(driver.ConnBeginTx); ok {
		tx, err = beginner.BeginTx(ctx, opts)
	} else {
		tx, err = c.inner.Begin()
	}
	if err != nil {
		if holdsGate {
			c.gate.leaveWrite()
		}
		return nil, err
	}
	if holdsGate {
		c.isGateHeldInTx = true
	}
	return &gatedTx{inner: tx, conn: c, holdsGate: holdsGate}, nil
}

func (c *gatedConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if isMaintenanceContext(ctx) || c.isGateHeldInTx || !classifyStatement(query) {
		return c.execInner(ctx, query, args)
	}
	if err := c.gate.enterWrite(ctx); err != nil {
		return nil, err
	}
	defer c.gate.leaveWrite()
	return c.execInner(ctx, query, args)
}

func (c *gatedConn) execInner(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if execer, ok := c.inner.(driver.ExecerContext); ok {
		return execer.ExecContext(ctx, query, args)
	}
	// modernc.org/sqlite implements the statement-level context interfaces but not
	// the deprecated connection-level ones, so this path is the normal one rather
	// than a fallback. Going through the statement is also what preserves
	// cancellation: the statement's own context handling is what interrupts a
	// long-running statement such as VACUUM when its job is cancelled.
	stmt, err := c.inner.Prepare(query)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()
	if execer, ok := stmt.(driver.StmtExecContext); ok {
		return execer.ExecContext(ctx, args)
	}
	return stmt.Exec(namedValuesToValues(args))
}

func (c *gatedConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if isMaintenanceContext(ctx) || c.isGateHeldInTx || !classifyStatement(query) {
		return c.queryInner(ctx, query, args)
	}
	if err := c.gate.enterWrite(ctx); err != nil {
		return nil, err
	}
	rows, err := c.queryInner(ctx, query, args)
	if err != nil {
		c.gate.leaveWrite()
		return nil, err
	}
	// The gate is held until the rows are closed, not merely until this call
	// returns: a statement that writes while streaming rows - `INSERT ... RETURNING`
	// or a pragma that reports its own result - still holds SQLite's write lock
	// across the read of that result.
	return &gatedRows{Rows: rows, gate: c.gate}, nil
}

func (c *gatedConn) queryInner(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if queryer, ok := c.inner.(driver.QueryerContext); ok {
		return queryer.QueryContext(ctx, query, args)
	}
	stmt, err := c.inner.Prepare(query)
	if err != nil {
		return nil, err
	}
	if queryer, ok := stmt.(driver.StmtQueryContext); ok {
		rows, err := queryer.QueryContext(ctx, args)
		if err != nil {
			_ = stmt.Close()
			return nil, err
		}
		return &closingRows{Rows: rows, closer: stmt}, nil
	}
	rows, err := stmt.Query(namedValuesToValues(args))
	if err != nil {
		_ = stmt.Close()
		return nil, err
	}
	return &closingRows{Rows: rows, closer: stmt}, nil
}

// namedValuesToValues adapts arguments for the pre-context statement interface.
func namedValuesToValues(args []driver.NamedValue) []driver.Value {
	values := make([]driver.Value, len(args))
	for index, arg := range args {
		values[index] = arg.Value
	}
	return values
}

func (c *gatedConn) Ping(ctx context.Context) error {
	if pinger, ok := c.inner.(driver.Pinger); ok {
		return pinger.Ping(ctx)
	}
	return nil
}

func (c *gatedConn) ResetSession(ctx context.Context) error {
	c.isGateHeldInTx = false
	if resetter, ok := c.inner.(driver.SessionResetter); ok {
		return resetter.ResetSession(ctx)
	}
	return nil
}

func (c *gatedConn) IsValid() bool {
	if validator, ok := c.inner.(driver.Validator); ok {
		return validator.IsValid()
	}
	return true
}

// closingRows closes the statement that produced a fallback query's rows, since
// database/sql only ever closes the Rows itself.
type closingRows struct {
	driver.Rows
	closer io.Closer
}

// The optional row interfaces are forwarded as in gatedRows, for the same reason: a
// wrapper that satisfies driver.Rows alone would silently drop the column metadata the
// driver reports.
// ColumnTypeDatabaseTypeName returns an empty name when the wrapped rows cannot report
// one, matching the shape the driver interface requires.
func (r *closingRows) ColumnTypeDatabaseTypeName(index int) string {
	typed, ok := r.Rows.(driver.RowsColumnTypeDatabaseTypeName)
	if !ok {
		return ""
	}
	return typed.ColumnTypeDatabaseTypeName(index)
}

func (r *closingRows) ColumnTypeLength(index int) (int64, bool) {
	typed, ok := r.Rows.(driver.RowsColumnTypeLength)
	if !ok {
		return 0, false
	}
	return typed.ColumnTypeLength(index)
}

func (r *closingRows) ColumnTypeNullable(index int) (nullable, ok bool) {
	typed, ok := r.Rows.(driver.RowsColumnTypeNullable)
	if !ok {
		return false, false
	}
	return typed.ColumnTypeNullable(index)
}

func (r *closingRows) ColumnTypePrecisionScale(index int) (precision, scale int64, ok bool) {
	typed, ok := r.Rows.(driver.RowsColumnTypePrecisionScale)
	if !ok {
		return 0, 0, false
	}
	return typed.ColumnTypePrecisionScale(index)
}

func (r *closingRows) ColumnTypeScanType(index int) reflect.Type {
	typed, ok := r.Rows.(driver.RowsColumnTypeScanType)
	if !ok {
		return nil
	}
	return typed.ColumnTypeScanType(index)
}

func (r *closingRows) Close() error {
	rowsErr := r.Rows.Close()
	closeErr := r.closer.Close()
	if rowsErr != nil {
		return rowsErr
	}
	return closeErr
}

// gatedRows holds the shared side of the gate for as long as the rows are open.
type gatedRows struct {
	driver.Rows
	gate    *writeGate
	isEnded bool
}

// The optional row interfaces are forwarded as in closingRows, for the same reason: a
// wrapper that satisfies driver.Rows alone would silently drop the column metadata the
// driver reports.
// ColumnTypeDatabaseTypeName returns an empty name when the wrapped rows cannot report
// one. The interface has no way to say "unknown", which is why the assertion is explicit
// rather than panicking: the caller is told nothing rather than something wrong.
func (r *gatedRows) ColumnTypeDatabaseTypeName(index int) string {
	typed, ok := r.Rows.(driver.RowsColumnTypeDatabaseTypeName)
	if !ok {
		return ""
	}
	return typed.ColumnTypeDatabaseTypeName(index)
}

func (r *gatedRows) ColumnTypeLength(index int) (int64, bool) {
	typed, ok := r.Rows.(driver.RowsColumnTypeLength)
	if !ok {
		return 0, false
	}
	return typed.ColumnTypeLength(index)
}

func (r *gatedRows) ColumnTypeNullable(index int) (nullable, ok bool) {
	typed, ok := r.Rows.(driver.RowsColumnTypeNullable)
	if !ok {
		return false, false
	}
	return typed.ColumnTypeNullable(index)
}

func (r *gatedRows) ColumnTypePrecisionScale(index int) (precision, scale int64, ok bool) {
	typed, ok := r.Rows.(driver.RowsColumnTypePrecisionScale)
	if !ok {
		return 0, 0, false
	}
	return typed.ColumnTypePrecisionScale(index)
}

func (r *gatedRows) ColumnTypeScanType(index int) reflect.Type {
	typed, ok := r.Rows.(driver.RowsColumnTypeScanType)
	if !ok {
		return nil
	}
	return typed.ColumnTypeScanType(index)
}

func (r *gatedRows) Close() error {
	err := r.Rows.Close()
	if !r.isEnded {
		r.isEnded = true
		r.gate.leaveWrite()
	}
	return err
}

// gatedTx releases the shared side exactly once, when the transaction ends.
type gatedTx struct {
	inner     driver.Tx
	conn      *gatedConn
	holdsGate bool
	isDone    bool
}

func (t *gatedTx) Commit() error {
	defer t.release()
	return t.inner.Commit()
}

func (t *gatedTx) Rollback() error {
	defer t.release()
	return t.inner.Rollback()
}

func (t *gatedTx) release() {
	if !t.holdsGate || t.isDone {
		return
	}
	t.isDone = true
	t.conn.isGateHeldInTx = false
	t.conn.gate.leaveWrite()
}

// gatedStmt applies the gate to a prepared statement used outside a transaction.
//
// Inside a transaction the statement must not touch the gate again: the
// transaction already holds it, and a second shared acquisition would deadlock
// against a waiting maintenance job.
type gatedStmt struct {
	inner driver.Stmt
	conn  *gatedConn
	query string
}

var (
	_ driver.Stmt             = (*gatedStmt)(nil)
	_ driver.StmtExecContext  = (*gatedStmt)(nil)
	_ driver.StmtQueryContext = (*gatedStmt)(nil)
)

func (s *gatedStmt) Close() error  { return s.inner.Close() }
func (s *gatedStmt) NumInput() int { return s.inner.NumInput() }

func (s *gatedStmt) Exec(args []driver.Value) (driver.Result, error) {
	if s.conn.isGateHeldInTx || !classifyStatement(s.query) {
		return s.inner.Exec(args)
	}
	if err := s.conn.gate.enterWrite(context.Background()); err != nil {
		return nil, err
	}
	defer s.conn.gate.leaveWrite()
	return s.inner.Exec(args)
}

func (s *gatedStmt) Query(args []driver.Value) (driver.Rows, error) {
	if s.conn.isGateHeldInTx || !classifyStatement(s.query) {
		return s.inner.Query(args)
	}
	if err := s.conn.gate.enterWrite(context.Background()); err != nil {
		return nil, err
	}
	rows, err := s.inner.Query(args)
	if err != nil {
		s.conn.gate.leaveWrite()
		return nil, err
	}
	return &gatedRows{Rows: rows, gate: s.conn.gate}, nil
}

func (s *gatedStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	if isMaintenanceContext(ctx) || s.conn.isGateHeldInTx || !classifyStatement(s.query) {
		return s.execInner(ctx, args)
	}
	if err := s.conn.gate.enterWrite(ctx); err != nil {
		return nil, err
	}
	defer s.conn.gate.leaveWrite()
	return s.execInner(ctx, args)
}

func (s *gatedStmt) execInner(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	if execer, ok := s.inner.(driver.StmtExecContext); ok {
		return execer.ExecContext(ctx, args)
	}
	return s.inner.Exec(namedValuesToValues(args))
}

func (s *gatedStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	if isMaintenanceContext(ctx) || s.conn.isGateHeldInTx || !classifyStatement(s.query) {
		return s.queryInner(ctx, args)
	}
	if err := s.conn.gate.enterWrite(ctx); err != nil {
		return nil, err
	}
	rows, err := s.queryInner(ctx, args)
	if err != nil {
		s.conn.gate.leaveWrite()
		return nil, err
	}
	return &gatedRows{Rows: rows, gate: s.conn.gate}, nil
}

func (s *gatedStmt) queryInner(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	if queryer, ok := s.inner.(driver.StmtQueryContext); ok {
		return queryer.QueryContext(ctx, args)
	}
	return s.inner.Query(namedValuesToValues(args))
}
