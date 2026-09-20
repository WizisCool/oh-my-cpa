package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// QuotaSnapshotRecord represents a persisted normalized quota state for a credential.
type QuotaSnapshotRecord struct {
	ID               string `json:"id"`
	AuthIndex        string `json:"auth_index"`
	Provider         string `json:"provider"`
	Status           string `json:"status"`
	PlanType         string `json:"plan_type"`
	PlanTier         string `json:"plan_tier"`
	PlanJSON         string `json:"plan_json,omitempty"`
	WindowsJSON      string `json:"windows_json"`
	ResetCreditsJSON string `json:"reset_credits_json,omitempty"`
	ObservedAtMS     int64  `json:"observed_at_ms"`
	CreatedAtMS      int64  `json:"created_at_ms"`
}

// ActiveCooldownRecord captures correlated error/cooldown state for an auth index.
type ActiveCooldownRecord struct {
	AuthIndex         string `json:"auth_index"`
	IsActive          bool   `json:"is_active"`
	Reason            string `json:"reason,omitempty"`
	RecoverAtMS       *int64 `json:"recover_at_ms,omitempty"`
	RetryAfterSeconds *int64 `json:"retry_after_seconds,omitempty"`
	CorrelatedAtMS    *int64 `json:"correlated_at_ms,omitempty"`
}

// SaveQuotaSnapshot inserts a new snapshot record and trims older snapshots beyond retention limit.
func (r *Repository) SaveQuotaSnapshot(ctx context.Context, snapshot QuotaSnapshotRecord) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	if strings.TrimSpace(snapshot.AuthIndex) == "" {
		return errors.New("auth_index is required")
	}
	if snapshot.ID == "" {
		snapshot.ID = uuid.New().String()
	}
	nowMS := time.Now().UnixMilli()
	if snapshot.CreatedAtMS <= 0 {
		snapshot.CreatedAtMS = nowMS
	}
	if snapshot.ObservedAtMS <= 0 {
		snapshot.ObservedAtMS = nowMS
	}
	if snapshot.WindowsJSON == "" {
		snapshot.WindowsJSON = "[]"
	}

	query := `
		INSERT INTO quota_snapshots (
			id, auth_index, provider, status, plan_type, plan_tier, plan_json,
			windows_json, reset_credits_json, observed_at_ms, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := r.SQL().ExecContext(ctx, query,
		snapshot.ID,
		snapshot.AuthIndex,
		snapshot.Provider,
		snapshot.Status,
		snapshot.PlanType,
		snapshot.PlanTier,
		snapshot.PlanJSON,
		snapshot.WindowsJSON,
		snapshot.ResetCreditsJSON,
		snapshot.ObservedAtMS,
		snapshot.CreatedAtMS,
	)
	if err != nil {
		return fmt.Errorf("insert quota snapshot: %w", err)
	}

	// Trim synchronously so a stuck writer cannot accumulate snapshots without
	// bound.
	_ = r.trimQuotaSnapshots(ctx, snapshot.AuthIndex, 50)

	return nil
}

func (r *Repository) trimQuotaSnapshots(ctx context.Context, authIndex string, keepCount int) error {
	if r == nil || r.SQL() == nil {
		return nil
	}
	trimQuery := `
		DELETE FROM quota_snapshots
		WHERE auth_index = ? AND id NOT IN (
			SELECT id FROM quota_snapshots
			WHERE auth_index = ?
			ORDER BY observed_at_ms DESC
			LIMIT ?
		)
	`
	_, err := r.SQL().ExecContext(ctx, trimQuery, authIndex, authIndex, keepCount)
	return err
}

// GetLatestQuotaSnapshots retrieves the most recent snapshot for each specified auth index in a single batch query.
func (r *Repository) GetLatestQuotaSnapshots(ctx context.Context, authIndexes []string) (map[string]QuotaSnapshotRecord, error) {
	result := make(map[string]QuotaSnapshotRecord)
	if r == nil || r.SQL() == nil || len(authIndexes) == 0 {
		return result, nil
	}

	validIndexes := make([]string, 0, len(authIndexes))
	for _, authIndex := range authIndexes {
		trimmed := strings.TrimSpace(authIndex)
		if trimmed != "" {
			validIndexes = append(validIndexes, trimmed)
		}
	}
	if len(validIndexes) == 0 {
		return result, nil
	}

	placeholders := strings.Repeat("?,", len(validIndexes))
	placeholders = placeholders[:len(placeholders)-1]

	args := make([]any, len(validIndexes))
	for i, authIndex := range validIndexes {
		args[i] = authIndex
	}

	query := fmt.Sprintf(`
		SELECT id, auth_index, provider, status, plan_type, plan_tier,
		       windows_json, reset_credits_json, plan_json, observed_at_ms, created_at_ms
		FROM (
			SELECT *, ROW_NUMBER() OVER(PARTITION BY auth_index ORDER BY observed_at_ms DESC) as rn
			FROM quota_snapshots
			WHERE auth_index IN (%s)
		)
		WHERE rn = 1
	`, placeholders)

	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return result, fmt.Errorf("query latest snapshots: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		record, scanErr := scanQuotaSnapshot(rows)
		if scanErr != nil {
			return result, scanErr
		}
		result[record.AuthIndex] = record
	}

	return result, rows.Err()
}

func scanQuotaSnapshot(rows *sql.Rows) (QuotaSnapshotRecord, error) {
	var record QuotaSnapshotRecord
	var resetCredits, planJSON sql.NullString
	if err := rows.Scan(
		&record.ID,
		&record.AuthIndex,
		&record.Provider,
		&record.Status,
		&record.PlanType,
		&record.PlanTier,
		&record.WindowsJSON,
		&resetCredits,
		&planJSON,
		&record.ObservedAtMS,
		&record.CreatedAtMS,
	); err != nil {
		return record, fmt.Errorf("scan quota snapshot: %w", err)
	}
	if resetCredits.Valid {
		record.ResetCreditsJSON = resetCredits.String
	}
	if planJSON.Valid {
		record.PlanJSON = planJSON.String
	}
	return record, nil
}

// GetQuotaSnapshotHistory retrieves historical snapshots for a specific auth index.
func (r *Repository) GetQuotaSnapshotHistory(ctx context.Context, authIndex string, limit int) ([]QuotaSnapshotRecord, error) {
	var records []QuotaSnapshotRecord
	if r == nil || r.SQL() == nil {
		return records, errors.New("repository is not initialized")
	}
	if limit <= 0 || limit > 100 {
		limit = 30
	}

	query := `
		SELECT id, auth_index, provider, status, plan_type, plan_tier,
		       windows_json, reset_credits_json, plan_json, observed_at_ms, created_at_ms
		FROM quota_snapshots
		WHERE auth_index = ?
		ORDER BY observed_at_ms DESC
		LIMIT ?
	`
	rows, err := r.SQL().QueryContext(ctx, query, strings.TrimSpace(authIndex), limit)
	if err != nil {
		return records, fmt.Errorf("query snapshot history: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		record, scanErr := scanQuotaSnapshot(rows)
		if scanErr != nil {
			return records, scanErr
		}
		records = append(records, record)
	}

	return records, rows.Err()
}

// ClearCooldownEvidence durably resets local quota_exceeded flags in error_events when cooldown is cleared.
func (r *Repository) ClearCooldownEvidence(ctx context.Context, authIndex string) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	query := `
		UPDATE error_events
		SET quota_exceeded = 0, next_recover_at_ms = NULL, next_retry_after_ms = NULL
		WHERE auth_index = ? AND quota_exceeded = 1
	`
	_, err := r.SQL().ExecContext(ctx, query, strings.TrimSpace(authIndex))
	return err
}

// BatchCorrelatedCooldowns efficiently batches correlated error events for auth indexes and derives active cooldown status.
func (r *Repository) BatchCorrelatedCooldowns(ctx context.Context, authIndexes []string, nowMS int64) (map[string]ActiveCooldownRecord, error) {
	result := make(map[string]ActiveCooldownRecord)
	if r == nil || r.SQL() == nil || len(authIndexes) == 0 {
		return result, nil
	}

	validIndexes := make([]string, 0, len(authIndexes))
	for _, authIndex := range authIndexes {
		trimmed := strings.TrimSpace(authIndex)
		if trimmed != "" {
			validIndexes = append(validIndexes, trimmed)
		}
	}
	if len(validIndexes) == 0 {
		return result, nil
	}

	placeholders := strings.Repeat("?,", len(validIndexes))
	placeholders = placeholders[:len(placeholders)-1]

	// Look back 6 hours for recent errors, or any future recovery time
	recentThresholdMS := nowMS - 6*60*60*1000
	args := make([]any, 0, len(validIndexes)+3)
	args = append(args, nowMS, nowMS, recentThresholdMS)
	for _, authIndex := range validIndexes {
		args = append(args, authIndex)
	}

	query := fmt.Sprintf(`
		SELECT auth_index, quota_reason, next_retry_after_ms, next_recover_at_ms, timestamp_ms
		FROM error_events
		WHERE quota_exceeded = 1 AND (next_recover_at_ms > ? OR next_retry_after_ms > ? OR timestamp_ms >= ?) AND auth_index IN (%s)
		ORDER BY timestamp_ms DESC
	`, placeholders)

	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return result, fmt.Errorf("query batch cooldowns: %w", err)
	}
	defer rows.Close()

	seen := make(map[string]bool)
	for rows.Next() {
		var authIndex string
		var reason sql.NullString
		var retryAfterMS sql.NullInt64
		var recoverAtMS sql.NullInt64
		var timestampMS int64

		if err := rows.Scan(&authIndex, &reason, &retryAfterMS, &recoverAtMS, &timestampMS); err != nil {
			return result, fmt.Errorf("scan batch cooldown: %w", err)
		}

		if seen[authIndex] {
			continue // Most recent error already evaluated
		}
		seen[authIndex] = true

		isActive := false
		var recoverAt *int64
		var retryAfterSeconds *int64

		if recoverAtMS.Valid && recoverAtMS.Int64 > 0 {
			recoverAt = &recoverAtMS.Int64
			if recoverAtMS.Int64 > nowMS {
				isActive = true
			}
		}

		if retryAfterMS.Valid && retryAfterMS.Int64 > 0 {
			if retryAfterMS.Int64 > nowMS {
				remainingMS := retryAfterMS.Int64 - nowMS
				sec := remainingMS / 1000
				if remainingMS%1000 != 0 {
					sec++
				}
				retryAfterSeconds = &sec
				isActive = true
			}
		}

		// If no explicit recover/retry time, grace window of 5 minutes from error event
		if recoverAt == nil && retryAfterSeconds == nil {
			if (nowMS - timestampMS) < 5*60*1000 {
				isActive = true
			}
		}

		reasonText := ""
		if reason.Valid {
			reasonText = reason.String
		}

		result[authIndex] = ActiveCooldownRecord{
			AuthIndex:         authIndex,
			IsActive:          isActive,
			Reason:            reasonText,
			RecoverAtMS:       recoverAt,
			RetryAfterSeconds: retryAfterSeconds,
			CorrelatedAtMS:    &timestampMS,
		}
	}

	return result, rows.Err()
}
