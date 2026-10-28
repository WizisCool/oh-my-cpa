package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// USAGE_RETENTION_MAX_DAYS bounds both horizons. Ten years is longer than any
// deployment keeps request detail on purpose; past it a value is a typo.
const USAGE_RETENTION_MAX_DAYS = 3650

// ErrInvalidUsageRetention rejects a horizon outside 0..USAGE_RETENTION_MAX_DAYS.
var ErrInvalidUsageRetention = errors.New("invalid_usage_retention")

// ErrUsageRetentionChanged refuses a write planned against a horizon another
// operator has since replaced. Shortening retention deletes records for good, so
// the horizon a console confirmed must still be the horizon that is in force.
var ErrUsageRetentionChanged = errors.New("usage_retention_changed")

// Where a retention in force came from.
const (
	UsageRetentionSourceEnvironment = "environment"
	UsageRetentionSourceConsole     = "console"
)

// UsageRetention is how long request records and their captured payloads live.
type UsageRetention struct {
	// RequestRecordDays rolls request records, error detail and ingest gaps; zero
	// keeps them. The usage facts behind the dashboard are permanent either way.
	RequestRecordDays int
	// PayloadDays rolls decoded payloads; zero keeps them as long as the request
	// records.
	PayloadDays int
}

// Validate refuses a horizon the table would refuse.
func (r UsageRetention) Validate() error {
	if r.RequestRecordDays < 0 || r.RequestRecordDays > USAGE_RETENTION_MAX_DAYS ||
		r.PayloadDays < 0 || r.PayloadDays > USAGE_RETENTION_MAX_DAYS {
		return ErrInvalidUsageRetention
	}
	return nil
}

// UsageRetentionSetting is the retention in force and where it came from.
type UsageRetentionSetting struct {
	UsageRetention
	Source string
	// UpdatedAtMS is when the console last saved it; zero for the environment.
	UpdatedAtMS int64
}

// ResolveUsageRetention returns the stored retention, or defaults - the
// environment's - for whatever was never saved.
//
// A stored horizon wins: the environment is how a deployment starts, and the
// console is where the operator changes it without a restart. The payload
// horizon is stored only when the API was given one, so a deployment that sets
// request records in the console keeps following the environment for payloads.
func (r *Repository) ResolveUsageRetention(ctx context.Context, defaults UsageRetention) (UsageRetentionSetting, error) {
	if r == nil || r.SQL() == nil {
		return UsageRetentionSetting{}, errors.New("repository is not initialized")
	}
	setting := UsageRetentionSetting{UsageRetention: defaults, Source: UsageRetentionSourceEnvironment}
	var payloadDays sql.NullInt64
	err := r.SQL().QueryRowContext(ctx,
		`SELECT request_record_days, payload_days, updated_at_ms FROM usage_retention_settings WHERE id = 1`).
		Scan(&setting.RequestRecordDays, &payloadDays, &setting.UpdatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return setting, nil
	}
	if err != nil {
		return UsageRetentionSetting{}, fmt.Errorf("read usage retention: %w", err)
	}
	if payloadDays.Valid {
		setting.PayloadDays = int(payloadDays.Int64)
	}
	setting.Source = UsageRetentionSourceConsole
	return setting, nil
}

// SetUsageRetention stores the operator's retention. The maintenance loop reads
// it on every pass, so it takes effect without a restart. A nil payloadDays
// leaves the payload horizon as it was, stored or following the environment.
//
// expectedRequestRecordDays is the horizon the caller planned against. It is
// compared inside the write's transaction, so a console that confirmed a
// shortening against a value another console has since replaced is refused
// instead of deleting records past a horizon nobody chose.
func (r *Repository) SetUsageRetention(ctx context.Context, requestRecordDays int, payloadDays *int, expectedRequestRecordDays int) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	check := UsageRetention{RequestRecordDays: requestRecordDays}
	if payloadDays != nil {
		check.PayloadDays = *payloadDays
	}
	if err := check.Validate(); err != nil {
		return err
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin usage retention transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var current int
	err = tx.QueryRowContext(ctx,
		`SELECT request_record_days FROM usage_retention_settings WHERE id = 1`).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read usage retention for write: %w", err)
	}
	if err == nil && current != expectedRequestRecordDays {
		return ErrUsageRetentionChanged
	}
	// No stored row means the caller planned against the environment's horizon,
	// which no transaction can have changed underneath it.
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO usage_retention_settings (id, request_record_days, payload_days, updated_at_ms)
		VALUES (1, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			request_record_days = excluded.request_record_days,
			payload_days = COALESCE(excluded.payload_days, usage_retention_settings.payload_days),
			updated_at_ms = excluded.updated_at_ms`,
		requestRecordDays, payloadDays, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("write usage retention: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit usage retention transaction: %w", err)
	}
	return nil
}
