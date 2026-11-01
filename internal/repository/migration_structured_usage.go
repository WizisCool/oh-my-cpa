package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/migrations"
)

// restoreStructuredUsageTx repairs databases whose plugin development migrations
// occupied versions 053–055 before structured usage shipped as 053. Inspect the
// column because databases that applied the shipped 053 already have its trigger.
func restoreStructuredUsageTx(ctx context.Context, tx *sql.Tx, _ *DB) error {
	exists, err := tableHasColumn(ctx, tx, "usage_events", "structured_usage")
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	script, err := migrations.Files.ReadFile("053_usage_structured_details.sql")
	if err != nil {
		return fmt.Errorf("read structured usage schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, string(script)); err != nil {
		return fmt.Errorf("restore structured usage schema: %w", err)
	}
	return nil
}
