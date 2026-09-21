package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Maintenance actions the console can run against the database.
const (
	MaintenanceCheckpoint = "wal_checkpoint"
	MaintenanceVacuum     = "vacuum"
)

// maintenanceJobTimeout bounds one maintenance job.
//
// VACUUM rewrites the whole file, so this is a ceiling on how long writers can be
// made to wait rather than an estimate. Passing it cancels the statement, which
// SQLite interrupts; a plain VACUUM is transactional, so an interrupted one leaves
// the original database intact.
const maintenanceJobTimeout = 10 * time.Minute

// MaintenanceStatus is the live state of the maintenance surface. It carries no
// wire tags: the API layer owns its own DTO allowlist and maps this onto it.
type MaintenanceStatus struct {
	// Action is the running or last-finished action, empty when none has run.
	Action string
	// Running is true while a job holds the database exclusively.
	Running bool
	// StartedAtMS is when the running (or last) job started.
	StartedAtMS int64
	// FinishedAtMS is zero while a job is running.
	FinishedAtMS int64
	// SizeBeforeBytes and SizeAfterBytes are the observed total footprint of the
	// main database plus its WAL and shared-memory files, around the job. They are
	// measurements, not promises: a checkpoint that could not truncate reports the
	// same number on both sides and says so through Incomplete.
	SizeBeforeBytes int64
	SizeAfterBytes  int64
	// ReclaimedBytes is SizeBeforeBytes - SizeAfterBytes, never negative.
	ReclaimedBytes int64
	// Incomplete is true when the statement ran but did not fully do its job: a
	// checkpoint blocked by a reader reports SQLite's own busy flag here rather
	// than a success.
	Incomplete bool
	// Detail carries SQLite's own counters for the last job, so the page can show
	// what actually happened instead of asserting it worked.
	Detail string
	// Error is a redacted failure sentence, empty on success.
	Error string
}

// MaintenanceService runs the two database-wide maintenance actions.
//
// Status lives in memory rather than in a table, and that is not an optimisation.
// A VACUUM holds a connection for its whole duration, so a status endpoint that had
// to read the database would be unable to report anything while the job it reports on
// is running - precisely when the operator is asking. The price of keeping it in
// memory is that the status resets on restart, which is acceptable and is stated in
// the UI: a job cannot survive a restart because the process that was running it is
// gone.
type MaintenanceService struct {
	db *DB
	// work is a connection pool of this service's own, and it is what keeps a
	// maintenance job from deadlocking against the writers it is waiting for.
	//
	// The deadlock it avoids is not hypothetical, and it was observed: a writer takes
	// the gate inside its driver call, by which point database/sql has already handed it
	// a connection - so a writer waiting for the gate holds a connection while it waits.
	// With a single pooled connection, a maintenance job needing that connection would
	// wait for a writer that is waiting for the job, and both would hang until a request
	// timed out. Giving maintenance its own connection removes the cycle: from SQLite's
	// point of view a waiting writer's connection is idle, because its statement has not
	// run and no transaction has been opened on it.
	work *sql.DB
	// lifecycle is the process's context, not the requesting request's. A maintenance
	// job must outlive the request that started it - otherwise a browser navigating
	// away would cancel a rebuild - but it must not outlive the process: shutdown has
	// to be able to end it and wait for it before the connection pool is closed
	// underneath it.
	lifecycle       context.Context
	cancelLifecycle context.CancelFunc
	running         sync.WaitGroup

	mutex    sync.Mutex
	isClosed bool
	status   MaintenanceStatus
	// reservedBytes is the footprint captured at reservation, kept out of the published
	// status so a reservation cannot be confused with a running job.
	reservedBytes int64
	// reservation counts claims of the single-flight slot and launchedReservation records the
	// last one started. Comparing them is what distinguishes a live reservation from one already
	// launched: `status.Running` cannot, because it is true on both sides of a launch, so a second
	// Launch would find a running status and start the job again.
	reservation         int64
	launchedReservation int64
	// observers are notified after a job reaches its terminal state. The API layer uses
	// this to record the outcome in the audit trail, which cannot be done by the
	// requesting handler: that request has already been answered, and its write would
	// race the gate the job holds.
	observers []func(MaintenanceStatus)
}

// OnCompletion registers a callback invoked once per finished job.
func (s *MaintenanceService) OnCompletion(observer func(MaintenanceStatus)) {
	if s == nil || observer == nil {
		return
	}
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.observers = append(s.observers, observer)
}

// NewMaintenanceService returns the maintenance surface for one database. The
// returned service owns a second connection to the same file and must be closed.
//
// `lifecycle` bounds every job this service runs: a rebuild is cancelled when the
// process is shutting down, and Close waits for it to finish unwinding before the
// connection is released.
func NewMaintenanceService(lifecycle context.Context, db *DB) (*MaintenanceService, error) {
	if db == nil {
		return nil, errors.New("database is not initialized")
	}
	if lifecycle == nil {
		lifecycle = context.Background()
	}
	// The maintenance connection shares the database's gate rather than taking one of its
	// own: the point of the second connection is to avoid contending for a pooled
	// connection, not to bypass the exclusion the gate provides.
	work := openGatedPool(gatedDSN(db.path), db.writeGate)
	// One connection is all a maintenance job needs; a second would only give it
	// something to contend with itself.
	work.SetMaxOpenConns(1)
	work.SetMaxIdleConns(1)
	serviceCtx, cancel := context.WithCancel(lifecycle)
	return &MaintenanceService{db: db, work: work, lifecycle: serviceCtx, cancelLifecycle: cancel}, nil
}

// Close ends any job in flight and waits for it, then releases the maintenance
// connection. Waiting matters: closing the pool under a running statement would turn
// shutdown into a failed rebuild whose result nobody records.
func (s *MaintenanceService) Close() error {
	if s == nil {
		return nil
	}
	// Closed is marked before cancelling, so a start racing this call is refused rather
	// than admitted and then abandoned.
	s.mutex.Lock()
	s.isClosed = true
	s.mutex.Unlock()
	if s.cancelLifecycle != nil {
		s.cancelLifecycle()
	}
	s.running.Wait()
	if s.work == nil {
		return nil
	}
	return s.work.Close()
}

// ErrMaintenanceRunning is returned when a job is already in flight.
var ErrMaintenanceRunning = errors.New("a maintenance job is already running")

// ErrMaintenanceClosed is returned once the service has been closed, so a shut-down
// process cannot admit a job that would run against a released connection.
var ErrMaintenanceClosed = errors.New("the maintenance service is closed")

// ErrInsufficientDiskSpace is returned when VACUUM's documented space requirement
// cannot be met.
var ErrInsufficientDiskSpace = errors.New("not enough free disk space to rebuild the database")

// Status returns a copy of the current state.
func (s *MaintenanceService) Status() MaintenanceStatus {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.status
}

// StartCheckpoint reserves and begins a WAL truncating checkpoint.
//
// It is reserve-then-launch for callers that have nothing to do in between. The API layer
// uses the two steps separately so it can audit the admission first.
func (s *MaintenanceService) StartCheckpoint(ctx context.Context) (MaintenanceStatus, error) {
	status, err := s.Reserve(ctx, MaintenanceCheckpoint)
	if err != nil {
		return status, err
	}
	if err := s.Launch(ctx); err != nil {
		s.Release(ctx)
		return status, err
	}
	return status, nil
}

// StartVacuum reserves and begins a VACUUM.
func (s *MaintenanceService) StartVacuum(ctx context.Context) (MaintenanceStatus, error) {
	status, err := s.Reserve(ctx, MaintenanceVacuum)
	if err != nil {
		return status, err
	}
	if err := s.Launch(ctx); err != nil {
		s.Release(ctx)
		return status, err
	}
	return status, nil
}

// Reserve claims the single-flight slot and validates admission without starting any
// work.
//
// It exists so the API layer can record the admission in the audit trail BEFORE the job
// starts. The reverse order - start, then audit - puts a gated write in flight behind a
// job that already holds the gate, so the operator's 202 would not arrive until the job
// had finished. Auditing first also means a job that never runs (because the audit write
// failed and the caller released the reservation) leaves no gap between what the audit
// trail claims and what happened.
func (s *MaintenanceService) Reserve(ctx context.Context, action string) (MaintenanceStatus, error) {
	s.mutex.Lock()
	if s.isClosed {
		s.mutex.Unlock()
		return MaintenanceStatus{}, ErrMaintenanceClosed
	}
	if s.status.Running {
		status := s.status
		s.mutex.Unlock()
		return status, ErrMaintenanceRunning
	}
	if s.db == nil || s.db.SQL == nil {
		s.mutex.Unlock()
		return MaintenanceStatus{}, errors.New("database is not initialized")
	}
	if s.work == nil {
		s.mutex.Unlock()
		return MaintenanceStatus{}, errors.New("the maintenance connection is not available")
	}
	// The space check runs before the slot is claimed, so a refusal never leaves a job
	// marked as running. It is a conservative pre-check against SQLite's documented
	// requirement - as much as twice the database file - reported as a check rather than
	// as a guarantee that the rebuild will fit.
	if action == MaintenanceVacuum {
		if err := s.checkVacuumSpace(); err != nil {
			s.mutex.Unlock()
			return MaintenanceStatus{}, err
		}
	}

	before := s.db.FootprintBytes()
	s.reservation++
	s.status = MaintenanceStatus{
		Action:          action,
		Running:         true,
		StartedAtMS:     time.Now().UnixMilli(),
		SizeBeforeBytes: before,
	}
	status := s.status
	s.reservedBytes = before
	s.mutex.Unlock()
	return status, nil
}

// Release abandons a reservation whose job will never run, which is how a failed
// admission audit is unwound: nothing was executed, so nothing should be reported as
// running or as having run.
func (s *MaintenanceService) Release(ctx context.Context) {
	s.mutex.Lock()
	s.status = MaintenanceStatus{}
	// The reservation is retired as well, so a released one cannot be launched afterwards: a
	// caller that released because its audit failed must not then start the job it abandoned.
	s.launchedReservation = s.reservation
	s.mutex.Unlock()
}

// Launch starts the reserved job. A launch without a successful reservation is refused
// rather than executed, so the reservation and the work cannot come apart.
func (s *MaintenanceService) Launch(ctx context.Context) error {
	s.mutex.Lock()
	if s.isClosed {
		s.mutex.Unlock()
		return ErrMaintenanceClosed
	}
	if !s.status.Running {
		s.mutex.Unlock()
		return errors.New("no maintenance job is reserved")
	}
	// The reservation is consumed, so a second launch finds nothing to start: `status.Running` is
	// true on both sides of a launch, which is why the comparison is on the identity instead.
	if s.reservation <= s.launchedReservation {
		s.mutex.Unlock()
		return errors.New("the maintenance reservation was already launched")
	}
	s.launchedReservation = s.reservation
	action := s.status.Action
	before := s.reservedBytes
	// The wait group is incremented while the mutex is held, before the goroutine exists.
	// Incrementing after unlocking would let Close start and finish waiting in the window
	// between the two, so the job would run against a connection Close had released.
	s.running.Add(1)
	s.mutex.Unlock()

	go func() {
		defer s.running.Done()
		s.run(action, before)
	}()
	return nil
}

// run executes one job and records its outcome. It is the only writer of the terminal
// status fields.
//
// Every admitted job reaches finish exactly once, including the paths that fail before
// touching the database: a job that never reported a terminal state would show as running
// for the life of the process.
func (s *MaintenanceService) run(action string, before int64) {
	jobCtx, cancel := context.WithTimeout(s.lifecycle, maintenanceJobTimeout)
	defer cancel()
	// The statement belongs to the maintenance holder, so it must not queue behind the
	// shared side of the gate this call is holding.
	jobCtx = withMaintenanceContext(jobCtx)

	startedAt := s.currentStartedAt()
	result, holdsGate := s.execute(action, jobCtx, before, startedAt)

	// Exclusivity is released BEFORE the terminal state is published, and the order is not
	// cosmetic. An observer of a finished job may write to the database - the audit trail
	// does - and a write waits for the gate this job is holding. Publishing first would
	// deadlock the job against its own observer: the job would hold the gate while waiting
	// for the observer, and the observer would wait for the gate. This was observed as an
	// audit record failing with a cancelled context and a checkpoint response that never
	// arrived.
	if holdsGate {
		s.db.writeGate.leaveMaintenance()
	}
	s.finish(result)
}

// execute runs one maintenance statement under the exclusive gate and returns the status
// to publish. It reports whether the gate was acquired, so the caller can release it
// before announcing the result.
func (s *MaintenanceService) execute(action string, jobCtx context.Context, before, startedAt int64) (MaintenanceStatus, bool) {
	if err := s.db.writeGate.enterMaintenance(jobCtx); err != nil {
		return MaintenanceStatus{
			Action:          action,
			StartedAtMS:     startedAt,
			FinishedAtMS:    time.Now().UnixMilli(),
			SizeBeforeBytes: before,
			SizeAfterBytes:  s.db.FootprintBytes(),
			Error:           err.Error(),
		}, false
	}

	var detail string
	var incomplete bool
	var jobErr error
	switch action {
	case MaintenanceCheckpoint:
		detail, incomplete, jobErr = s.runCheckpoint(jobCtx)
	case MaintenanceVacuum:
		detail, incomplete, jobErr = s.runVacuum(jobCtx)
	default:
		jobErr = fmt.Errorf("unknown maintenance action %q", action)
	}

	after := s.db.FootprintBytes()
	result := MaintenanceStatus{
		Action:          action,
		StartedAtMS:     startedAt,
		FinishedAtMS:    time.Now().UnixMilli(),
		SizeBeforeBytes: before,
		SizeAfterBytes:  after,
		Incomplete:      incomplete,
		Detail:          detail,
	}
	if after < before {
		result.ReclaimedBytes = before - after
	}
	if jobErr != nil {
		result.Error = jobErr.Error()
	}
	return result, true
}

func (s *MaintenanceService) currentStartedAt() int64 {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.status.StartedAtMS
}

func (s *MaintenanceService) finish(result MaintenanceStatus) {
	s.mutex.Lock()
	result.Running = false
	s.status = result
	observers := make([]func(MaintenanceStatus), len(s.observers))
	copy(observers, s.observers)
	s.mutex.Unlock()

	// Observers run outside the lock: one of them writes to the database, and holding
	// this mutex across a database write would serialize the status read that the page
	// polls during a rebuild.
	for _, observer := range observers {
		observer(result)
	}
}

// runCheckpoint runs PRAGMA wal_checkpoint(TRUNCATE) and reads its result.
//
// SQLite returns one row of three integers and does not raise an error when a
// checkpoint is blocked: the first column is 1 when a RESTART, FULL or TRUNCATE
// checkpoint could not complete because another reader held the database. A nil
// error therefore proves only that the statement ran, so the counters are read and
// the outcome is reported from them.
func (s *MaintenanceService) runCheckpoint(ctx context.Context) (string, bool, error) {
	var busy, logFrames, checkpointed int64
	if err := s.work.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &logFrames, &checkpointed); err != nil {
		return "", false, fmt.Errorf("truncate the write-ahead log: %w", err)
	}
	return interpretCheckpointResult(busy, logFrames, checkpointed)
}

// interpretCheckpointResult turns SQLite's three-column result into an outcome.
//
// It is a separate function because the decision is the part worth testing and the observation is
// not: `PRAGMA wal_checkpoint(TRUNCATE)` returns `(busy, log, checkpointed)` and raises no error
// when a concurrent reader blocks it, so "did this succeed" is answered by the first column rather
// than by the absence of an error. The first column is 1 exactly when a FULL, RESTART or TRUNCATE
// checkpoint could not complete, which is the case that must not be reported as success.
func interpretCheckpointResult(busy, logFrames, checkpointed int64) (string, bool, error) {
	detail := fmt.Sprintf("write-ahead log frames %d, checkpointed %d", logFrames, checkpointed)
	if busy != 0 {
		// A blocked checkpoint is a real answer, not an error: the log stays as it is until the
		// readers that blocked it are gone.
		return detail + "; blocked by a concurrent reader", true, nil
	}
	return detail, false, nil
}

// runVacuum runs a plain VACUUM and then checkpoints the WAL.
//
// VACUUM INTO plus swapping the file was considered and rejected: the pool holds
// an open handle, so replacing the file underneath it would need every connection
// closed and the pool rebuilt while other goroutines still hold references to it,
// turning a maintenance action into a window where ordinary writers see a closed
// database. A plain VACUUM copies into a temporary file and then overwrites the
// original inside an ordinary transaction, so an interrupted or cancelled rebuild
// leaves the original intact - the pool stays valid throughout.
//
// The checkpoint afterwards is what makes the reported size an honest answer. The
// rebuild frees pages in the main file, but it writes them through the
// write-ahead log, so measuring the footprint straight after a VACUUM subtracts a
// smaller main file and adds a larger WAL and can net out to nothing. Truncating
// the log first makes the measured size describe the rebuilt database rather than
// the bookkeeping that produced it.
func (s *MaintenanceService) runVacuum(ctx context.Context) (string, bool, error) {
	if _, err := s.work.ExecContext(ctx, `VACUUM`); err != nil {
		return "", false, fmt.Errorf("rebuild the database: %w", err)
	}
	var busy, logFrames, checkpointed int64
	if err := s.work.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &logFrames, &checkpointed); err != nil {
		// The rebuild itself succeeded, so this is reported as a partial result
		// rather than a failed VACUUM: the file is rebuilt and the log simply could
		// not be truncated.
		return "database rebuilt; the write-ahead log could not be truncated", true, nil
	}
	if busy != 0 {
		return "database rebuilt; the write-ahead log was blocked by a concurrent reader", true, nil
	}
	return fmt.Sprintf("database rebuilt and free pages released (log frames %d, checkpointed %d)", logFrames, checkpointed), false, nil
}

// MaintenanceAdmission states what a VACUUM would need before it is started.
//
// It exists so the console can show the requirement in its confirmation rather than
// letting the operator discover it as a failure. The values are measurements: a
// measurement that could not be taken reports Allowed false with a reason rather
// than a zero requirement that would read as "no space needed".
type MaintenanceAdmission struct {
	RequiredBytes  int64
	AvailableBytes int64
	Allowed        bool
	Reason         string
}

// Admission measures what a rebuild would need right now.
func (s *MaintenanceService) Admission() MaintenanceAdmission {
	admission := MaintenanceAdmission{Allowed: true}
	if s == nil || s.db == nil {
		admission.Allowed = false
		admission.Reason = "the database is not available"
		return admission
	}
	if !isFileDatabase(s.db.path) {
		// An in-memory database has no file to rebuild and no directory to measure.
		admission.Reason = "this database is held in memory and has no file to rebuild"
		return admission
	}
	mainBytes, err := s.db.MainFileBytes()
	if err != nil {
		admission.Allowed = false
		admission.Reason = "the database file could not be measured"
		return admission
	}
	admission.RequiredBytes = mainBytes * 2
	directory := filepath.Dir(s.db.path)
	available, err := availableBytes(directory)
	if err != nil {
		admission.Allowed = false
		admission.Reason = "the free space on the database's filesystem could not be measured"
		return admission
	}
	admission.AvailableBytes = int64(available)
	if available < uint64(admission.RequiredBytes) {
		admission.Allowed = false
		admission.Reason = fmt.Sprintf("a rebuild needs up to %d bytes free and %d are available", admission.RequiredBytes, admission.AvailableBytes)
	}
	return admission
}

// checkVacuumSpace applies SQLite's documented free-space requirement.
//
// The documentation says VACUUM "works by copying the contents of the database
// into a temporary database file", and that "as much as twice the size of the
// original database file is required in free disk space". The check uses that
// ceiling on the directory that holds the database, because that is where SQLite
// creates the temporary file. It is a pre-check: passing it does not guarantee the
// rebuild fits, since the database can grow while the job runs.
func (s *MaintenanceService) checkVacuumSpace() error {
	admission := s.Admission()
	if admission.Allowed {
		return nil
	}
	if admission.Reason == "the database is not available" {
		return errors.New("database is not initialized")
	}
	return fmt.Errorf("%w: %s", ErrInsufficientDiskSpace, admission.Reason)
}

// MainFileBytes returns the size of the main database file.
func (db *DB) MainFileBytes() (int64, error) {
	if db == nil {
		return 0, errors.New("database is not initialized")
	}
	info, err := os.Stat(db.path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("stat database file: %w", err)
	}
	return info.Size(), nil
}

// FootprintBytes returns the observed on-disk footprint: the main database plus
// the write-ahead log and shared-memory files when they exist.
//
// The three files are what the operator is actually asking about when they ask how
// much space this deployment uses. Counting only the main file under-reports while
// a WAL is large, which is exactly the case an operator looks at this page for.
func (db *DB) FootprintBytes() int64 {
	if db == nil {
		return 0
	}
	return db.FileFootprint().TotalBytes
}

// FileFootprint reports each of the database's files separately.
//
// Each size is reported as it is on disk, and a file that does not exist reports
// zero with Exists false rather than being quietly folded into the total. A -wal
// file is absent whenever the database was closed cleanly, so "no WAL file" and "a
// WAL file of zero bytes" are different answers and are kept different.
type FileFootprint struct {
	MainBytes  int64
	WALBytes   int64
	SHMBytes   int64
	TotalBytes int64
	WALExists  bool
	SHMExists  bool
	MainExists bool
	Path       string
}

func (db *DB) FileFootprint() FileFootprint {
	footprint := FileFootprint{}
	if db == nil {
		return footprint
	}
	footprint.Path = db.path
	footprint.MainBytes, footprint.MainExists = fileSize(db.path)
	footprint.WALBytes, footprint.WALExists = fileSize(db.path + "-wal")
	footprint.SHMBytes, footprint.SHMExists = fileSize(db.path + "-shm")
	footprint.TotalBytes = footprint.MainBytes + footprint.WALBytes + footprint.SHMBytes
	return footprint
}

func fileSize(path string) (int64, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, false
	}
	return info.Size(), true
}
