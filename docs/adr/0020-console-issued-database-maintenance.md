# ADR 0020: Console-issued database maintenance runs behind a driver-level write gate

- Status: Accepted
- Date: 2026-09-22

## Context

The System Information page offers two operators' actions against the SQLite file: a
WAL-truncating checkpoint and a rebuild (`VACUUM`). Both are database-wide, and the
second rewrites every page.

The obstacle is not performance. `internal/usage/ingest`'s flush records an ingest gap
and returns an error, and `app.Run` treats a stopped pipeline as fatal on purpose
("treat it as fatal rather than serving silently stale numbers"). So a writer that
loses a race against a rebuild does not produce a slow request: it terminates the
process. Offering these buttons without a coordination mechanism would be shipping a
crash trigger.

Three facts ruled out the obvious mechanisms:

- **SQLite's own locking cannot express it.** Under WAL a reader never blocks a writer
  and a writer never blocks a reader, so the usual "the database will serialise them"
  does not apply to a statement that needs the file to itself.
- **`busy_timeout` is not the mechanism.** It makes a blocked SQLite call retry; it does
  not stop a writer from starting, and it cannot make a VACUUM wait for anything.
- **Context deadlines are not protection either.** With one pooled connection a queued
  caller waits in Go's pool, which `busy_timeout` does not govern, and its request
  context can expire while it waits — producing exactly the error that is fatal.

## Decision

**A write gate at the driver boundary, defaulting to "this is a write".**
`internal/repository` wraps its SQLite driver. A statement whose leading keyword is not
unambiguously a read (`SELECT`, `WITH`, `VALUES`, `EXPLAIN`) passes a gate that
maintenance holds exclusively. Every `PRAGMA` is gated whatever its argument, because
the family mixes reads and writes (`journal_mode` reads, `journal_mode=WAL` writes,
`wal_checkpoint(TRUNCATE)` writes while reporting a result row). The asymmetry is
deliberate: gating a read only makes it wait, while letting a write through can end the
process, so the classifier is written to fail in the safe direction.

**Writers wait, and a queued writer can leave.** A writer that returned an error here
would be treated as a fatal pipeline failure, so writers block. The wait is
cancellable, which `sync.RWMutex` cannot offer: `VACUUM` runs for minutes, and a writer
that cannot abandon the wait would pin an HTTP handler past the server's own write
timeout. The gate is therefore purpose-built, FIFO, and context-aware on both sides.

**A transaction holds the gate until it ends.** SQLite's write lock outlives the
statements inside a transaction, so a gate released per statement would let a rebuild
in while the file was still write-locked.

**Maintenance runs on its own connection, and its own statements bypass the gate.**
Two distinct reasons. The bypass exists because there is otherwise a self-deadlock: a
maintenance statement passing the gate it already holds would queue behind itself. The
separate connection exists because of a deadlock that was actually observed — a writer
takes the gate inside its driver call, by which point `database/sql` has already handed
it a connection, so a writer waiting for the gate is *holding* a connection while it
waits. With one shared connection, maintenance needs that connection and the writer
needs the gate. Giving maintenance its own connection breaks the cycle: a waiting
writer's connection is idle as far as SQLite is concerned, because its statement has
not run and no transaction is open on it. `TestMaintenanceDoesNotDeadlockAgainstAWriterHoldingAConnection`
reproduces the scenario.

**A reservation is named, and only its holder may act on it.** `Reserve` returns a handle that
`Launch` and `Release` require. An unnamed release was a real hazard rather than a tidiness
concern: it is called when an admission audit fails, and an unconditional clear could erase a
*newer* reservation a later request had just made - so a job the operator had been told was accepted
would never start, while the page showed it as running. A release naming a superseded reservation is
a no-op, and a second launch of the same handle is refused.

**No request performs database work after admitting a job.** The starting request
measures admission, records *that admission* in the audit trail, starts the job, and
returns the status the start returned. It performs no further database read or write,
because any of those would queue for the gate the job now holds and the operator's `202`
would not arrive until the rebuild had finished.

**The gate is released before a job's outcome is announced.** The service publishes its
terminal state only after it has left the exclusive section. This ordering was learned
the hard way: an observer of a finished job writes to the database — the audit trail does
— and a write waits for the gate the job holds, so publishing from inside the exclusive
section deadlocked the job against its own observer. The symptoms were a checkpoint
whose audit record failed with a cancelled context and an HTTP response that never
arrived, while the status endpoint showed the job still running.
`TestCompletionObserverMayWriteToTheDatabase` performs exactly that write and fails if
the ordering regresses.

**Completion is recorded by the job, not by the request that started it.** A `202`
describes admission, not success, so admission and completion are two audit events with
different results, the second carrying the measured outcome and any redacted error.

**Status lives in memory.** A status endpoint that read the database could not answer
while a job held the connection — exactly when an operator asks. The price is that the
status does not survive a restart, which is stated in the UI and is true anyway: a job
cannot outlive the process running it.

**The rebuild is a plain `VACUUM`, not `VACUUM INTO` plus a file swap.** The pool holds
an open handle to the file, so replacing it underneath would require closing every
connection and rebuilding the pool while other goroutines still hold references to it —
trading a maintenance action for a window in which ordinary writers see a closed
database. SQLite documents that a plain `VACUUM` copies into a temporary file and
overwrites the original inside an ordinary transaction, so an interrupted rebuild
leaves the original intact. That property is pinned by a test that cancels a rebuild
and then checks both the surviving rows and `PRAGMA integrity_check`.

**Admission is measured and shown before the action.** A rebuild needs up to twice the
database file in free space; the confirmation states the measured requirement against
the measured availability and refuses when it cannot be met. This is a pre-check, not a
guarantee, and it is presented as one.

**A checkpoint that did not complete is reported as incomplete, not as success.**
`PRAGMA wal_checkpoint(TRUNCATE)` returns a row of three integers and raises no error
when it is blocked by a concurrent reader, so the counters are read and the outcome is
derived from them.

Incomplete is a third outcome and is presented as one: a partial result carries a warning,
not the success mark with a caveat underneath. The distinction matters because the two
claims differ - "the log was truncated" and "the log was not truncated" - and a console
that draws the success mark has told the operator the first while meaning the second. The
same rule governs which snapshot the page believes: the polled job state is authoritative
only while polling, because afterwards it is the *previous* job, and letting it win would
pin the panel to a job the operator has moved past.

**Both actions are audited, and both are refused in demo mode** by the route
classification in `internal/api/demo_policy.go`, since a visitor must not be able to
change what the next visitor sees.

**A job is bounded by the application's lifetime.** The service owns a context derived
from the process's, so a rebuild cannot outlive the process, and `Close` cancels and joins
an in-flight job before releasing its connection. A job detached from its starting request
but bound to nothing would otherwise be running while the pool it uses is torn down.

## Consequences

- Every statement in the process now pays a classification on a static SQL literal, and
  every write acquires a mutex-protected gate. Both are negligible next to a database
  call.
- The gate is process-wide and shared by every pool in the process. That is sound for
  this application specifically — ADR 0001 makes it a single-replica modular monolith
  with one SQLite file — and overserialising is the only way it can be wrong.
- A rebuild makes writers wait for its duration, bounded by a ten-minute ceiling. A
  checkpoint is cheap and can be run often.
- Maintenance writes are the only console path that can block ordinary writes, and the
  page states that a job does not survive a restart.
- The gate's row wrappers forward the driver's optional column-metadata interfaces
  (`RowsColumnTypeDatabaseTypeName`, `...Length`, `...Nullable`, `...PrecisionScale`,
  `...ScanType`) and assert at compile time that they do. A wrapper satisfying only
  `driver.Rows` compiles and passes every query test while silently discarding what the
  driver reports about each column's type; the assertion is what keeps a mistyped method
  signature - which is how this was found - from removing the metadata quietly.
- The gate is per database, not per process. Every pool over one file - the application
  pool and the maintenance service's own connection - shares that file's gate, so they
  exclude each other without one database's rebuild stalling writes to another.
- The classifier is a classification of this repository's own static SQL, not a SQL
  parser, and it is deliberately narrow in the safe direction: only `SELECT`, `VALUES` and
  `EXPLAIN` count as reads. `PRAGMA` is gated whatever its argument; `WITH` is gated even
  when the statement selects, because a CTE can introduce a write; and a string holding a
  second statement is gated however it starts. The cost is one wait for the one `WITH` in
  this repository during a rebuild, against a guarantee that needs no re-checking when
  new SQL is added.
- `driver.TxOptions.ReadOnly` does not exempt a transaction. It is a hint that
  modernc.org/sqlite uses only to choose the `BEGIN` mode string, so such a transaction
  can still write; trusting the flag would leave a hole shaped exactly like the path the
  gate protects.

## Alternatives considered

- **Raising `busy_timeout` and letting SQLite sort it out.** Rejected: it converts a
  coordination problem into a longer wait, still ends in the fatal error when the
  rebuild takes longer than the timeout, and degrades unrelated lock contention
  silently.
- **Pausing the collector during maintenance.** Rejected: it needs a pause/resume state
  machine that races the gate it would be ordering against, and a paused collector still
  holds its batch in memory.
- **Refusing to offer maintenance unless ingestion is disabled.** Rejected as useless for
  the deployments that most need it.
- **Wrapping the 45 write call sites instead of the driver.** Rejected: the coverage would
  then depend on nobody ever adding an ungated write, and the failure mode of a missed
  site is a terminated process. A driver boundary covers future writes automatically.
