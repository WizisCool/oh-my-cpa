package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// addReleaseCheckTruncatedTx adds the release checker's truncation flag if it is not already
// there.
//
// The condition is the whole reason this is Go rather than SQL. `025_release_check_truncated.sql`
// has to repair a database that applied the original release-index migration, which created the
// table without the column - and it must not fail against one that already has it, because SQLite
// has no `ADD COLUMN IF NOT EXISTS` and a failed statement aborts the migration transaction, which
// stops the process from starting.
//
// Two histories reach this point, and both are real rather than hypothetical: the column lived
// inside `024_release_index.sql` for a period before it was split out, so a database created
// during that window has the table with the column and `025` still pending.
func addReleaseCheckTruncatedTx(ctx context.Context, tx *sql.Tx, db *DB) error {
	if tx == nil {
		return errors.New("migration transaction is required")
	}
	exists, err := tableHasColumn(ctx, tx, "release_check_state", "truncated")
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `ALTER TABLE release_check_state ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0`); err != nil {
		return fmt.Errorf("add release_check_state.truncated: %w", err)
	}
	return nil
}

// tableHasColumn reads the schema's own description of a table.
//
// A missing table reports false rather than an error, because the caller's question is whether the
// column needs adding and a table that does not exist has no columns to add to.
func tableHasColumn(ctx context.Context, tx *sql.Tx, table, column string) (bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return false, fmt.Errorf("read columns of %s: %w", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return false, fmt.Errorf("scan column of %s: %w", table, err)
		}
		if name == column {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate columns of %s: %w", table, err)
	}
	return false, nil
}
