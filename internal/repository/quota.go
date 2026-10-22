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
	WarmupJSON       string `json:"warmup_json,omitempty"`
	ID               string `json:"id"`
	AuthIndex        string `json:"auth_index"`
	Provider         string `json:"provider"`
	Status           string `json:"status"`
	PlanType         string `json:"plan_type"`
	PlanTier         string `json:"plan_tier"`
	PlanJSON         string `json:"plan_json,omitempty"`
	WindowsJSON      string `json:"windows_json"`
	ResetCreditsJSON string `json:"reset_credits_json,omitempty"`
	ResetGrantsJSON  string `json:"reset_grants_json,omitempty"`
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
			windows_json, reset_credits_json, reset_grants_json, warmup_json, observed_at_ms, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
		snapshot.ResetGrantsJSON,
		snapshot.WarmupJSON,
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
			ORDER BY observed_at_ms DESC, created_at_ms DESC, rowid DESC
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
		       windows_json, reset_credits_json, reset_grants_json, plan_json, warmup_json, observed_at_ms, created_at_ms
		FROM (
			SELECT *, ROW_NUMBER() OVER(PARTITION BY auth_index ORDER BY observed_at_ms DESC, created_at_ms DESC, rowid DESC) as rn
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
	var resetCredits, resetGrants, planJSON, warmupJSON sql.NullString
	if err := rows.Scan(
		&record.ID,
		&record.AuthIndex,
		&record.Provider,
		&record.Status,
		&record.PlanType,
		&record.PlanTier,
		&record.WindowsJSON,
		&resetCredits,
		&resetGrants,
		&planJSON,
		&warmupJSON,
		&record.ObservedAtMS,
		&record.CreatedAtMS,
	); err != nil {
		return record, fmt.Errorf("scan quota snapshot: %w", err)
	}
	if resetCredits.Valid {
		record.ResetCreditsJSON = resetCredits.String
	}
	if resetGrants.Valid {
		record.ResetGrantsJSON = resetGrants.String
	}
	if planJSON.Valid {
		record.PlanJSON = planJSON.String
	}
	record.WarmupJSON = warmupJSON.String
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
		       windows_json, reset_credits_json, reset_grants_json, plan_json, warmup_json, observed_at_ms, created_at_ms
		FROM quota_snapshots
		WHERE auth_index = ?
		ORDER BY observed_at_ms DESC, created_at_ms DESC, rowid DESC
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

// Quota refresh attempt outcomes. A stored outcome is what the console reads to decide
// whether a credential's last try produced a reading; only these two exist, because a try
// either answered the question or did not.
const (
	QuotaRefreshAttemptSucceeded = "succeeded"
	QuotaRefreshAttemptFailed    = "failed"
)

// QuotaRefreshAttemptRecord is the latest attempt to read one credential's quota.
//
// It is kept apart from QuotaSnapshotRecord because the two answer different questions: a
// snapshot records a reading, so a failed read must not become one; an attempt records that
// somebody tried, so a failure has a place to live after its toast is gone. The reason is
// stored here rather than on the snapshot because a snapshot has no error column and no
// business carrying a failure it does not describe.
type QuotaRefreshAttemptRecord struct {
	AuthIndex     string `json:"auth_index"`
	AttemptedAtMS int64  `json:"attempted_at_ms"`
	Outcome       string `json:"outcome"`
	Error         string `json:"error,omitempty"`
}

// SaveQuotaRefreshAttempt upserts one credential's latest attempt.
//
// An attempt older than the stored one is refused rather than applied: batch reads run
// concurrently, so a slow credential can finish after a newer manual read of the same one,
// and the console must report the read that happened last, not the one that landed last.
func (r *Repository) SaveQuotaRefreshAttempt(ctx context.Context, attempt QuotaRefreshAttemptRecord) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	authIndex := strings.TrimSpace(attempt.AuthIndex)
	if authIndex == "" {
		return errors.New("auth_index is required")
	}
	if attempt.Outcome != QuotaRefreshAttemptSucceeded && attempt.Outcome != QuotaRefreshAttemptFailed {
		return fmt.Errorf("invalid quota refresh outcome %q", attempt.Outcome)
	}
	query := `
		INSERT INTO quota_refresh_attempts (auth_index, attempted_at_ms, outcome, error)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(auth_index) DO UPDATE SET
			attempted_at_ms = excluded.attempted_at_ms,
			outcome = excluded.outcome,
			error = excluded.error
		WHERE excluded.attempted_at_ms >= quota_refresh_attempts.attempted_at_ms
	`
	if _, err := r.SQL().ExecContext(ctx, query, authIndex, attempt.AttemptedAtMS, attempt.Outcome, attempt.Error); err != nil {
		return fmt.Errorf("save quota refresh attempt: %w", err)
	}
	return nil
}

// GetQuotaRefreshAttempts reads the latest attempt of each requested credential in one query.
func (r *Repository) GetQuotaRefreshAttempts(ctx context.Context, authIndexes []string) (map[string]QuotaRefreshAttemptRecord, error) {
	result := make(map[string]QuotaRefreshAttemptRecord)
	if r == nil || r.SQL() == nil {
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
		SELECT auth_index, attempted_at_ms, outcome, error
		FROM quota_refresh_attempts
		WHERE auth_index IN (%s)
	`, placeholders)
	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return result, fmt.Errorf("query quota refresh attempts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var record QuotaRefreshAttemptRecord
		if err := rows.Scan(&record.AuthIndex, &record.AttemptedAtMS, &record.Outcome, &record.Error); err != nil {
			return result, fmt.Errorf("scan quota refresh attempt: %w", err)
		}
		result[record.AuthIndex] = record
	}
	return result, rows.Err()
}

// HasCooldownEvidence reports whether an auth index still has stored quota_exceeded evidence.
func (r *Repository) HasCooldownEvidence(ctx context.Context, authIndex string) (bool, error) {
	if r == nil || r.SQL() == nil {
		return false, errors.New("repository is not initialized")
	}
	var exists bool
	err := r.SQL().QueryRowContext(ctx, `
		SELECT EXISTS (SELECT 1 FROM error_events WHERE auth_index = ? AND quota_exceeded = 1)
	`, strings.TrimSpace(authIndex)).Scan(&exists)
	return exists, err
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
		-- timestamp_ms is not unique, so tied rows would otherwise be returned in
		-- whatever order the storage engine chose and report a different reason or
		-- recovery time for identical data. rowid makes the newest inserted row win.
		ORDER BY timestamp_ms DESC, rowid DESC
	`, placeholders)

	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return result, fmt.Errorf("query batch cooldowns: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var authIndex string
		var reason sql.NullString
		var retryAfterMS sql.NullInt64
		var recoverAtMS sql.NullInt64
		var timestampMS int64

		if err := rows.Scan(&authIndex, &reason, &retryAfterMS, &recoverAtMS, &timestampMS); err != nil {
			return result, fmt.Errorf("scan batch cooldown: %w", err)
		}

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

		candidate := ActiveCooldownRecord{
			AuthIndex:         authIndex,
			IsActive:          isActive,
			Reason:            reasonText,
			RecoverAtMS:       recoverAt,
			RetryAfterSeconds: retryAfterSeconds,
			CorrelatedAtMS:    &timestampMS,
		}
		// Prefer an active row over an inactive newer one. If two rows are both
		// active, the query order already gives the newest timestamp priority.
		if existing, exists := result[authIndex]; !exists || (candidate.IsActive && !existing.IsActive) {
			result[authIndex] = candidate
		}
	}

	return result, rows.Err()
}

// CredentialWindowUsage is the traffic recorded for one credential in a range.
type CredentialWindowUsage struct {
	Requests       int64
	PricedRequests int64
	Tokens         int64
	CostNanos      int64
}

// QueryCredentialWindowUsage sums the requests a credential served in
// [fromMS, toMS). It spans every instance, as quota observations do: both are
// keyed by the credential's auth index alone.
func (r *Repository) QueryCredentialWindowUsage(ctx context.Context, authIndex string, fromMS, toMS int64) (CredentialWindowUsage, error) {
	var usage CredentialWindowUsage
	if r == nil || r.SQL() == nil {
		return usage, errors.New("repository is not initialized")
	}
	err := r.SQL().QueryRowContext(ctx, `
		SELECT COUNT(1), COALESCE(SUM(cost_nanos IS NOT NULL), 0),
		       COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_nanos), 0)
		FROM usage_events
		WHERE auth_index = ? AND timestamp_ms >= ? AND timestamp_ms < ?
	`, strings.TrimSpace(authIndex), fromMS, toMS).Scan(&usage.Requests, &usage.PricedRequests, &usage.Tokens, &usage.CostNanos)
	if err != nil {
		return usage, fmt.Errorf("query credential window usage: %w", err)
	}
	return usage, nil
}

// CredentialModelWindowUsage uses the served identity when CPA published it;
// otherwise the scope resolver must decide whether the requested id is usable.
type CredentialModelWindowUsage struct {
	Model string
	CredentialWindowUsage
}

func (r *Repository) QueryCredentialModelWindowUsage(ctx context.Context, authIndex string, fromMS, toMS int64) ([]CredentialModelWindowUsage, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	rows, err := r.SQL().QueryContext(ctx, `SELECT COALESCE(NULLIF(response_model, ''), model), COUNT(1), COALESCE(SUM(cost_nanos IS NOT NULL),0), COALESCE(SUM(total_tokens),0), COALESCE(SUM(cost_nanos),0) FROM usage_events WHERE auth_index = ? AND timestamp_ms >= ? AND timestamp_ms < ? GROUP BY COALESCE(NULLIF(response_model, ''), model) ORDER BY 1`, strings.TrimSpace(authIndex), fromMS, toMS)
	if err != nil {
		return nil, fmt.Errorf("query credential model window usage: %w", err)
	}
	defer rows.Close()
	result := []CredentialModelWindowUsage{}
	for rows.Next() {
		var group CredentialModelWindowUsage
		if err := rows.Scan(&group.Model, &group.Requests, &group.PricedRequests, &group.Tokens, &group.CostNanos); err != nil {
			return nil, fmt.Errorf("scan credential model window usage: %w", err)
		}
		result = append(result, group)
	}
	return result, rows.Err()
}

// BatchExpiredCooldowns returns, per auth index, the latest recovery time of its stored
// quota_exceeded evidence, but only when every such recovery time and retry time has already
// passed. It has no lookback window, so a cooldown that expired days ago and was never cleared is
// still reported. Rows already cleared (quota_exceeded = 0) are never returned.
func (r *Repository) BatchExpiredCooldowns(ctx context.Context, authIndexes []string, nowMS int64) (map[string]int64, error) {
	result := make(map[string]int64)
	if r == nil || r.SQL() == nil || len(authIndexes) == 0 {
		return result, nil
	}
	validIndexes := make([]string, 0, len(authIndexes))
	for _, authIndex := range authIndexes {
		if trimmed := strings.TrimSpace(authIndex); trimmed != "" {
			validIndexes = append(validIndexes, trimmed)
		}
	}
	if len(validIndexes) == 0 {
		return result, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(validIndexes)), ",")
	args := make([]any, 0, len(validIndexes)+1)
	for _, authIndex := range validIndexes {
		args = append(args, authIndex)
	}
	args = append(args, nowMS, nowMS)
	// A newer cooldown that has not recovered yet keeps the credential blocked, even when an
	// older one has already passed; so does a retry time still ahead.
	query := fmt.Sprintf(`
		SELECT auth_index, MAX(next_recover_at_ms)
		FROM error_events
		WHERE quota_exceeded = 1
		  AND auth_index IN (%s)
		GROUP BY auth_index
		HAVING MAX(COALESCE(next_recover_at_ms, 0)) > 0
		  AND MAX(COALESCE(next_recover_at_ms, 0)) <= ?
		  AND MAX(COALESCE(next_retry_after_ms, 0)) <= ?
	`, placeholders)
	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return result, fmt.Errorf("query expired cooldowns: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var authIndex string
		var recoverAtMS int64
		if err := rows.Scan(&authIndex, &recoverAtMS); err != nil {
			return result, fmt.Errorf("scan expired cooldown: %w", err)
		}
		result[authIndex] = recoverAtMS
	}
	return result, rows.Err()
}
