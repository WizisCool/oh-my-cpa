package repository

import (
	"context"
	"errors"
	"fmt"
)

// DatabaseFacts is what the database says about itself.
//
// Every field here is read from the live connection rather than assumed. The page
// used to report "mode: WAL driver" as a constant, which meant it would keep
// saying so if the database was opened in another mode - a claim about the
// environment that was really a claim about the source code. The point of reading
// these is that they can disagree with what was intended.
type DatabaseFacts struct {
	// JournalMode is SQLite's own answer: "wal", "delete", "memory" and so on.
	JournalMode string
	// PageSize and PageCount describe the file's structure.
	PageSize  int64
	PageCount int64
	// FreelistCount is the number of pages on the free list. It is reported
	// separately from the used size and is never equated with reclaimable disk
	// space: freed pages stay in the file until a rebuild, and a rebuild needs as
	// much free space again while it runs.
	FreelistCount int64
	// Synchronous and ForeignKeys are connection-level settings observed through
	// PRAGMA, reported as absent when the database cannot answer for them.
	Synchronous   *int64
	ForeignKeys   *int64
	BusyTimeout   *int64
	SchemaVersion int64
	// Integrity is set only when an integrity check was actually requested.
	Integrity string
}

// UsedBytes is the space held by pages in use.
func (f DatabaseFacts) UsedBytes() int64 {
	used := f.PageCount - f.FreelistCount
	if used < 0 {
		used = 0
	}
	return used * f.PageSize
}

// FreePageBytes is the space held by pages on the free list.
//
// The name says "free pages" rather than "reclaimable" on purpose. These bytes are
// inside the file and are reused by later writes; they are only returned to the
// filesystem by a rebuild, and the rebuild needs comparable free space to run.
func (f DatabaseFacts) FreePageBytes() int64 {
	if f.FreelistCount < 0 {
		return 0
	}
	return f.FreelistCount * f.PageSize
}

// WALEnabled reports whether the journal mode is the write-ahead log.
func (f DatabaseFacts) WALEnabled() bool {
	return f.JournalMode == "wal"
}

// ReadDatabaseFacts reads the database's own description of itself.
//
// A pragma the connection refuses to answer is left absent instead of being
// defaulted: `foreign_keys` has no persistent value, so reporting "off" for a
// database that simply did not answer would be a fabricated fact. The caller
// renders absent values as unknown.
func (r *Repository) ReadDatabaseFacts(ctx context.Context) (DatabaseFacts, error) {
	if r == nil || r.SQL() == nil {
		return DatabaseFacts{}, errors.New("repository is not initialized")
	}
	facts := DatabaseFacts{}

	// journal_mode returns a row whose value is the mode now in force.
	if err := r.SQL().QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&facts.JournalMode); err != nil {
		return facts, fmt.Errorf("read journal mode: %w", err)
	}
	if err := r.SQL().QueryRowContext(ctx, `PRAGMA page_size`).Scan(&facts.PageSize); err != nil {
		return facts, fmt.Errorf("read page size: %w", err)
	}
	if err := r.SQL().QueryRowContext(ctx, `PRAGMA page_count`).Scan(&facts.PageCount); err != nil {
		return facts, fmt.Errorf("read page count: %w", err)
	}
	if err := r.SQL().QueryRowContext(ctx, `PRAGMA freelist_count`).Scan(&facts.FreelistCount); err != nil {
		return facts, fmt.Errorf("read freelist count: %w", err)
	}

	// Optionals: absent means the database did not answer, and the page says so.
	facts.Synchronous = readOptionalPragma(ctx, r, `PRAGMA synchronous`)
	facts.ForeignKeys = readOptionalPragma(ctx, r, `PRAGMA foreign_keys`)
	facts.BusyTimeout = readOptionalPragma(ctx, r, `PRAGMA busy_timeout`)

	if err := r.SQL().QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&facts.SchemaVersion); err != nil {
		return facts, fmt.Errorf("read schema version: %w", err)
	}
	return facts, nil
}

// readOptionalPragma reads a pragma that may legitimately have no answer, and
// returns nil rather than a fabricated default.
func readOptionalPragma(ctx context.Context, r *Repository, query string) *int64 {
	var value int64
	if err := r.SQL().QueryRowContext(ctx, query).Scan(&value); err != nil {
		return nil
	}
	return &value
}

// DataVolumes are the record counts the page shows beside the storage numbers, so
// that a size can be read against the amount of data that produced it.
type DataVolumes struct {
	UsageEvents  int64
	ErrorEvents  int64
	InboxPending int64
	FirstEventMS *int64
	LastEventMS  *int64
	Credentials  int
	Providers    int
	Plugins      int
	AuditEvents  int64
}

// ReadFileFootprint measures the database files through the repository's own
// connection.
func (r *Repository) ReadFileFootprint() FileFootprint {
	if r == nil || r.db == nil {
		return FileFootprint{}
	}
	return r.db.FileFootprint()
}

// Database exposes the underlying handle for surfaces that manage the file itself,
// such as the maintenance actions. It returns nil rather than panicking when the
// repository was never initialized, so callers can fail closed.
func (r *Repository) Database() *DB {
	if r == nil {
		return nil
	}
	return r.db
}

// ReadDataVolumes counts what is stored.
//
// The usage counts come from the pipeline's existing statistics rather than a
// second set of queries over the largest table, so this page cannot become the
// slowest thing in the console as a deployment ages. The remaining counts are over
// small tables.
func (r *Repository) ReadDataVolumes(ctx context.Context) (DataVolumes, error) {
	if r == nil || r.SQL() == nil {
		return DataVolumes{}, errors.New("repository is not initialized")
	}
	volumes := DataVolumes{}

	stats, err := r.StatsUsagePipeline(ctx)
	if err != nil {
		return volumes, fmt.Errorf("read usage volumes: %w", err)
	}
	volumes.UsageEvents = stats.Events
	volumes.ErrorEvents = stats.ErrorEvents
	volumes.InboxPending = stats.Pending
	volumes.FirstEventMS = stats.FirstEventMS
	volumes.LastEventMS = stats.LastEventMS

	if err := r.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_events`).Scan(&volumes.AuditEvents); err != nil {
		// The audit table is created by an early migration; a missing one means an
		// older schema rather than a broken page, so it reports zero.
		volumes.AuditEvents = 0
	}
	return volumes, nil
}

// SetCredentialAndProviderCounts records counts that come from the gateway rather
// than from this database.
func (v *DataVolumes) SetCredentialAndProviderCounts(credentials, providers, plugins int) {
	v.Credentials = credentials
	v.Providers = providers
	v.Plugins = plugins
}
