package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/migrations"
	_ "modernc.org/sqlite"
)

var ErrMigrationBackupRequired = errors.New("an encrypted migration backup is required before changing the database")
var ErrBackupRestoreFailed = errors.New("backup restore smoke test failed")

// BackupConfig controls the secured migration backup created before a pending
// migration changes an existing on-disk database.
type BackupConfig struct {
	Cipher       *appcrypto.Cipher
	Directory    string
	Retention    int
	MinFreeBytes uint64
	FreeSpace    func(string) (uint64, error)
}

// OpenOption customizes database startup without changing the simple Open call
// used by in-memory tests and small integrations.
type OpenOption func(*openConfig) error

type openConfig struct {
	cipher       *appcrypto.Cipher
	backup       BackupConfig
	migrateUntil int
}

// withMigrationsUntil stops Open's migration at a version, so an upgrade test
// can build a real database at an older schema and then run the rest.
func withMigrationsUntil(version int) OpenOption {
	return func(config *openConfig) error {
		config.migrateUntil = version
		return nil
	}
}

// WithMigrationBackup enables encrypted migration backups and also wires the
// application cipher into repositories created from the returned DB.
func WithMigrationBackup(cipher *appcrypto.Cipher, directory string, retention int) OpenOption {
	return func(config *openConfig) error {
		if cipher == nil {
			return errors.New("migration backup cipher is required")
		}
		config.cipher = cipher
		config.backup = BackupConfig{Cipher: cipher, Directory: directory, Retention: retention}
		return nil
	}
}

// WithCipher wires the application cipher into a DB without enabling backups.
// It is useful for tests and for repositories that only need raw-payload
// encryption during normal ingestion.
func WithCipher(cipher *appcrypto.Cipher) OpenOption {
	return func(config *openConfig) error {
		if cipher == nil {
			return errors.New("database cipher is required")
		}
		config.cipher = cipher
		config.backup.Cipher = cipher
		return nil
	}
}

// WithBackupConfig supplies the full backup policy, including injectable disk
// accounting for deterministic tests.
func WithBackupConfig(backup BackupConfig) OpenOption {
	return func(config *openConfig) error {
		if backup.Cipher == nil {
			return errors.New("migration backup cipher is required")
		}
		config.cipher = backup.Cipher
		config.backup = backup
		return nil
	}
}

// DB wraps SQLite and retains the security services needed by repository
// boundaries. SQL remains exposed for the existing analytics package API.
type DB struct {
	SQL *sql.DB

	cipher    *appcrypto.Cipher
	backup    BackupConfig
	path      string
	driver    string
	writeGate *writeGate
	// migrateUntil, when positive, is the last migration version Migrate applies.
	migrateUntil int

	// The read-only pool operator queries run on, opened on first use (readonly_query.go).
	readOnlyOnce sync.Once
	readOnly     *sql.DB
	readOnlyErr  error
}

// Cipher returns the application cipher associated with this connection.
func (db *DB) Cipher() *appcrypto.Cipher {
	if db == nil {
		return nil
	}
	return db.cipher
}

func Open(ctx context.Context, databasePath string, options ...OpenOption) (*DB, error) {
	if strings.TrimSpace(databasePath) == "" {
		return nil, fmt.Errorf("database path is required")
	}
	config := openConfig{}
	for _, option := range options {
		if option == nil {
			continue
		}
		if err := option(&config); err != nil {
			return nil, fmt.Errorf("configure database: %w", err)
		}
	}
	// SQLite stages table-rebuild work in a temporary directory; migration 046
	// rebuilds usage_events. Containers run with a read-only root filesystem and one
	// writable data volume, so the default /tmp cannot hold those files. SQLite
	// consults SQLITE_TMPDIR before TMPDIR; keep an explicit operator setting.
	if isFileDatabase(databasePath) {
		if _, configured := os.LookupEnv("SQLITE_TMPDIR"); !configured {
			if err := os.Setenv("SQLITE_TMPDIR", filepath.Dir(databasePath)); err != nil {
				return nil, fmt.Errorf("set SQLite temporary directory: %w", err)
			}
		}
	}

	// busy_timeout and WAL are connection settings; the URI applies them to
	// every pooled connection opened by modernc.org/sqlite. The pool is opened
	// through this package's gated driver, which is what makes a maintenance job
	// and a writer unable to overlap - see writegate.go for why that boundary is
	// at the driver rather than in the call sites. Preserve an existing SQLite URI
	// query (notably file::memory:?cache=shared).
	registerGatedDriver()
	dsn := gatedDSN(databasePath)
	// One gate per DB. Every pool derived from this value - the application pool and the
	// maintenance service's own connection - receives the same gate, so they exclude each
	// other while a different database is unaffected.
	//
	// The boundary is the DB value rather than the file path: two separate Open calls over
	// the same path each get their own gate and would not exclude each other. That is
	// deliberate and cheap to rely on, because a process runs one Open; stating it here keeps
	// the contract honest instead of implying a per-path registry that does not exist.
	gate := &writeGate{}
	database := openGatedPool(dsn, gate)
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	if err := database.PingContext(ctx); err != nil {
		database.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	wrapped := &DB{SQL: database, cipher: config.backup.Cipher, backup: config.backup, path: databasePath, driver: gatedDriverName, writeGate: gate, migrateUntil: config.migrateUntil}
	if wrapped.cipher == nil {
		wrapped.cipher = config.cipher
	}
	if err := wrapped.Migrate(ctx); err != nil {
		database.Close()
		return nil, err
	}
	return wrapped, nil
}

func (db *DB) Close() error {
	if db == nil || db.SQL == nil {
		return nil
	}
	var readOnlyErr error
	if db.readOnly != nil {
		readOnlyErr = db.readOnly.Close()
	}
	return errors.Join(db.SQL.Close(), readOnlyErr)
}

type migrationSpec struct {
	version int
	name    string
	script  string
}

var (
	migrationsOnce    sync.Once
	cachedMigrations  []migrationSpec
	cachedMigrateErr  error
	freshBootstrapMu  sync.Mutex
	freshBootstrapSQL string
)

func loadMigrations() ([]migrationSpec, error) {
	migrationsOnce.Do(func() {
		entries, err := fs.ReadDir(migrations.Files, ".")
		if err != nil {
			cachedMigrateErr = fmt.Errorf("read migrations: %w", err)
			return
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		seenVersions := make(map[int]string, len(entries))
		specs := make([]migrationSpec, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
				continue
			}
			version, err := migrationVersion(entry.Name())
			if err != nil {
				cachedMigrateErr = err
				return
			}
			if previous, exists := seenVersions[version]; exists {
				cachedMigrateErr = fmt.Errorf("duplicate migration version %d in %q and %q", version, previous, entry.Name())
				return
			}
			seenVersions[version] = entry.Name()
			script, err := fs.ReadFile(migrations.Files, entry.Name())
			if err != nil {
				cachedMigrateErr = fmt.Errorf("read migration %s: %w", entry.Name(), err)
				return
			}
			specs = append(specs, migrationSpec{
				version: version,
				name:    entry.Name(),
				script:  string(script),
			})
		}
		cachedMigrations = specs
	})
	return cachedMigrations, cachedMigrateErr
}

func (db *DB) Migrate(ctx context.Context) error {
	if db == nil || db.SQL == nil {
		return fmt.Errorf("database is not initialized")
	}
	if _, err := db.SQL.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at INTEGER NOT NULL
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	specs, err := loadMigrations()
	if err != nil {
		return err
	}

	appliedVersions := make(map[int]bool, len(specs))
	rows, err := db.SQL.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read applied migrations: %w", err)
	}
	for rows.Next() {
		var v int
		if scanErr := rows.Scan(&v); scanErr != nil {
			_ = rows.Close()
			return fmt.Errorf("scan applied migration: %w", scanErr)
		}
		appliedVersions[v] = true
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("iterate applied migrations: %w", err)
	}
	_ = rows.Close()

	pending := make([]migrationSpec, 0, len(specs))
	for _, spec := range specs {
		if db.migrateUntil > 0 && spec.version > db.migrateUntil {
			continue
		}
		if !appliedVersions[spec.version] {
			pending = append(pending, spec)
		}
	}
	if len(pending) == 0 {
		return nil
	}

	canFastBootstrap := db.migrateUntil == 0 && db.path != "file::memory:?cache=shared" && len(appliedVersions) == 0 && isFreshEmptyDatabase(ctx, db.SQL)
	if canFastBootstrap {
		freshBootstrapMu.Lock()
		bootstrapSQL := freshBootstrapSQL
		freshBootstrapMu.Unlock()
		if bootstrapSQL != "" {
			tx, err := db.SQL.BeginTx(ctx, nil)
			if err == nil {
				if _, execErr := tx.ExecContext(ctx, bootstrapSQL); execErr == nil {
					if commitErr := tx.Commit(); commitErr == nil {
						return nil
					}
				}
				_ = tx.Rollback()
			}
		}
	}

	if db.requiresMigrationBackup(ctx) {
		if err := db.createMigrationBackup(ctx, pending[0].version); err != nil {
			return err
		}
	}

	for _, spec := range pending {
		version := spec.version
		started := time.Now()
		slog.DebugContext(ctx, "database migration started", "migration", version)
		tx, err := db.SQL.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %d: %w", version, err)
		}
		migrationSucceeded := false
		defer func() {
			if !migrationSucceeded {
				_ = tx.Rollback()
			}
		}()
		if err := db.applyMigrationSpec(ctx, tx, spec); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %d: %w", version, err)
		}
		migrationSucceeded = true
		slog.DebugContext(ctx, "database migration completed", "migration", version, "duration", time.Since(started))
	}

	if canFastBootstrap {
		freshBootstrapMu.Lock()
		if freshBootstrapSQL == "" {
			if snapshot, snapErr := buildFreshBootstrapSQL(ctx, db.SQL, specs); snapErr == nil {
				freshBootstrapSQL = snapshot
			}
		}
		freshBootstrapMu.Unlock()
	}
	return nil
}

func isFreshEmptyDatabase(ctx context.Context, sqlDB *sql.DB) bool {
	var otherTables int
	if err := sqlDB.QueryRowContext(ctx, `SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'`).Scan(&otherTables); err != nil {
		return false
	}
	return otherTables == 0
}

func buildFreshBootstrapSQL(ctx context.Context, sqlDB *sql.DB, specs []migrationSpec) (string, error) {
	rows, err := sqlDB.QueryContext(ctx, `
		SELECT sql
		FROM sqlite_master
		WHERE sql IS NOT NULL
		  AND name NOT LIKE 'sqlite_%'
		  AND name <> 'schema_migrations'
		ORDER BY CASE type
			WHEN 'table' THEN 1
			WHEN 'index' THEN 2
			WHEN 'view' THEN 3
			WHEN 'trigger' THEN 4
			ELSE 5
		END, rowid`)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	var builder strings.Builder
	for rows.Next() {
		var ddl string
		if err := rows.Scan(&ddl); err != nil {
			return "", err
		}
		builder.WriteString(ddl)
		builder.WriteString(";\n")
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	builder.WriteString("INSERT INTO pricing_catalog_state (id, updated_at_ms) VALUES (1, 0);\n")
	builder.WriteString("INSERT INTO usage_aggregation_checkpoints (name, last_usage_event_id, created_at_ms, updated_at_ms) VALUES ('facts', 0, unixepoch() * 1000, unixepoch() * 1000);\n")
	for _, spec := range specs {
		fmt.Fprintf(&builder, "INSERT INTO schema_migrations(version, applied_at) VALUES (%d, unixepoch());\n", spec.version)
	}
	return builder.String(), nil
}

func (db *DB) applyMigrationSpec(ctx context.Context, tx *sql.Tx, spec migrationSpec) error {
	version := spec.version
	if version == 4 {
		if err := checkJSON1(ctx, tx); err != nil {
			return fmt.Errorf("migration %d requires SQLite JSON1: %w", version, err)
		}
	}
	if _, err := tx.ExecContext(ctx, spec.script); err != nil {
		return fmt.Errorf("apply migration %s: %w", spec.name, err)
	}
	if hook := migrationHook(version); hook != nil {
		if err := hook(ctx, tx, db); err != nil {
			return fmt.Errorf("govern migration %d: %w", version, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES (?, unixepoch())`, version); err != nil {
		return fmt.Errorf("record migration %d: %w", version, err)
	}
	return nil
}

func (db *DB) requiresMigrationBackup(ctx context.Context) bool {
	if !isFileDatabase(db.path) {
		return false
	}
	var tableExists int
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).Scan(&tableExists); err != nil {
		// Unknown schema state: fail closed and attempt a backup.
		return true
	}
	if tableExists == 0 {
		return false
	}
	var applied int
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(1) FROM schema_migrations`).Scan(&applied); err != nil {
		// A table that exists but cannot be read makes the database state
		// unknown. Do not let the migration proceed without a recoverable copy.
		return true
	}
	if applied == 0 {
		return false
	}
	return true
}

func isFileDatabase(path string) bool {
	trimmed := strings.TrimSpace(path)
	return trimmed != "" && !strings.HasPrefix(strings.ToLower(trimmed), "file:") && !strings.Contains(trimmed, ":memory:")
}

func checkJSON1(ctx context.Context, tx *sql.Tx) error {
	var valid int
	if err := tx.QueryRowContext(ctx, `SELECT json_valid('{}')`).Scan(&valid); err != nil {
		return err
	}
	if valid != 1 {
		return errors.New("JSON1 returned an invalid result")
	}
	return nil
}

func migrationHook(version int) func(context.Context, *sql.Tx, *DB) error {
	switch version {
	case 4:
		return sanitizeHistoricalDataTx
	case 25:
		return addReleaseCheckTruncatedTx
	case 56:
		return restoreStructuredUsageTx
	}
	return nil
}

func migrationVersionMust(name string) int {
	version, _ := migrationVersion(name)
	return version
}

func migrationVersion(name string) (int, error) {
	var version int
	if _, err := fmt.Sscanf(name, "%d_", &version); err != nil || version <= 0 {
		return 0, fmt.Errorf("invalid migration filename %q", name)
	}
	return version, nil
}
