package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// Inbox lifecycle states.
const (
	// InboxPending is captured but not yet decoded, or retried after a failure.
	InboxPending = "pending"
	// InboxProcessed produced a usage event.
	InboxProcessed = "processed"
	// InboxDiscarded exhausted its retries; the raw payload is kept for review.
	InboxDiscarded = "discarded"
)

// Aggregation checkpoint names.
const (
	CheckpointHourly = "hourly"
	CheckpointDaily  = "daily"
)

// maxInboxAttempts bounds retries before a poison message is parked out of the
// working set. The raw payload stays on disk for inspection.
const maxInboxAttempts = 12

// UsageInbox is one captured CPA payload.
type UsageInbox struct {
	ID           int64
	InstanceID   string
	SourceMode   string
	MessageHash  string
	RawMessage   string
	Status       string
	AttemptCount int
	LastError    string
	EventKey     string
	PoppedAtMS   int64
}

// AppendUsageInbox persists freshly popped payloads in one transaction.
//
// This is the durability boundary: CPA's queue is destructive, so a payload
// that is not stored here is gone for good. Keep it a single fast write and do
// not decode inside this critical path.
func (r *Repository) AppendUsageInbox(ctx context.Context, instanceID, sourceMode string, payloads []string, poppedAt time.Time) (int, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	if len(payloads) == 0 {
		return 0, nil
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin usage inbox append: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	statement, err := tx.PrepareContext(ctx, `
		INSERT INTO usage_inboxes (
			instance_id, source_mode, message_hash, raw_message,
			raw_message_ciphertext, raw_message_nonce, status, popped_at
		) VALUES (?, ?, ?, ?, ?, ?, '`+InboxPending+`', ?)`)
	if err != nil {
		return 0, fmt.Errorf("prepare usage inbox insert: %w", err)
	}
	defer statement.Close()

	poppedMS := poppedAt.UnixMilli()
	written := 0
	for _, payload := range payloads {
		if strings.TrimSpace(payload) == "" || strings.TrimSpace(payload) == "null" {
			continue
		}
		projection := security.RedactPayload(payload)
		var ciphertext, nonce []byte
		if r.db.cipher != nil {
			ciphertext, nonce, err = r.db.cipher.Encrypt([]byte(payload))
			if err != nil {
				return written, fmt.Errorf("encrypt usage inbox row: %w", err)
			}
		}
		if _, errExec := statement.ExecContext(ctx, instanceID, sourceMode, usage.Hash(projection), projection, ciphertext, nonce, poppedMS); errExec != nil {
			return written, fmt.Errorf("insert usage inbox row: %w", errExec)
		}
		written++
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit usage inbox append: %w", err)
	}
	return written, nil
}

// ClaimUsageInboxBatch loads pending rows oldest-first for decoding.
func (r *Repository) ClaimUsageInboxBatch(ctx context.Context, limit int) ([]UsageInbox, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	if limit <= 0 {
		limit = 200
	}
	rows, err := r.SQL().QueryContext(ctx, `
		SELECT id, instance_id, source_mode, message_hash, raw_message,
		       raw_message_ciphertext, raw_message_nonce, status, attempt_count,
		       COALESCE(last_error, ''), popped_at
		FROM usage_inboxes
		WHERE status = '`+InboxPending+`'
		ORDER BY id ASC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("claim usage inbox batch: %w", err)
	}
	defer rows.Close()

	var items []UsageInbox
	for rows.Next() {
		var item UsageInbox
		var ciphertext, nonce []byte
		if errScan := rows.Scan(&item.ID, &item.InstanceID, &item.SourceMode, &item.MessageHash,
			&item.RawMessage, &ciphertext, &nonce, &item.Status, &item.AttemptCount,
			&item.LastError, &item.PoppedAtMS); errScan != nil {
			return nil, fmt.Errorf("scan usage inbox row: %w", errScan)
		}
		if len(ciphertext) > 0 {
			if r.db.cipher == nil {
				return nil, errors.New("usage inbox encryption key is unavailable")
			}
			plaintext, errDecrypt := r.db.cipher.Decrypt(ciphertext, nonce)
			if errDecrypt != nil {
				return nil, fmt.Errorf("decrypt usage inbox row: %w", errDecrypt)
			}
			item.RawMessage = string(plaintext)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate usage inbox rows: %w", err)
	}
	return items, nil
}

// UsageDecoded pairs an inbox row with the event decoded from it.
type UsageDecoded struct {
	InboxID int64
	Event   usage.Event
}

// CommitUsageDecoded inserts events and marks their inbox rows processed in one
// transaction.
//
// Doing this in two steps would leave a crash window where a payload is stored
// but flagged pending, and replaying it would double count the request.
func (r *Repository) CommitUsageDecoded(ctx context.Context, decoded []UsageDecoded) (int, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	if len(decoded) == 0 {
		return 0, nil
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin usage commit: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	insert, err := tx.PrepareContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, api_group_label, provider, endpoint, auth_type, request_id,
			client_ip, x_forwarded_for, user_agent, model, model_alias, reasoning_effort,
			service_tier, response_service_tier, executor_type, timestamp_ms, source, auth_index,
			failed, generate, latency_ms, ttft_ms,
			input_tokens, output_tokens, reasoning_tokens, cached_tokens,
			cache_read_tokens, cache_creation_tokens, total_tokens, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, fmt.Errorf("prepare usage event insert: %w", err)
	}
	defer insert.Close()

	mark, err := tx.PrepareContext(ctx, `
		UPDATE usage_inboxes
		SET status = '`+InboxProcessed+`', event_key = ?, processed_at = ?, last_error = NULL
		WHERE id = ?`)
	if err != nil {
		return 0, fmt.Errorf("prepare usage inbox update: %w", err)
	}
	defer mark.Close()

	createdMS := time.Now().UnixMilli()
	committed := 0
	for _, item := range decoded {
		event := r.sanitizeUsageEvent(item.Event)
		if _, errExec := insert.ExecContext(ctx,
			event.InstanceID, event.EventKey, event.APIGroupKey, event.APIGroupLabel, event.Provider, event.Endpoint,
			event.AuthType, event.RequestID, event.ClientIP, event.XForwardedFor, event.UserAgent,
			event.Model, event.ModelAlias, event.ReasoningEffort, event.ServiceTier,
			event.ResponseServiceTier, event.ExecutorType, event.TimestampMS, event.Source,
			event.AuthIndex, boolInt(event.Failed), boolInt(event.Generate), event.LatencyMS,
			event.TTFTMS, event.InputTokens, event.OutputTokens, event.ReasoningTokens,
			event.CachedTokens, event.CacheReadTokens, event.CacheCreationTokens,
			event.TotalTokens, createdMS); errExec != nil {
			return 0, fmt.Errorf("insert usage event %s: %w", event.EventKey, errExec)
		}
		if _, errExec := mark.ExecContext(ctx, event.EventKey, createdMS, item.InboxID); errExec != nil {
			return 0, fmt.Errorf("mark usage inbox %d: %w", item.InboxID, errExec)
		}
		committed++
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit usage events: %w", err)
	}
	return committed, nil
}

// MarkUsageUndecodable records a failed decode attempt for a batch of rows and
// returns how many were updated.
func (r *Repository) MarkUsageUndecodable(ctx context.Context, ids []int64, reason string) (int, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	marked := 0
	for _, id := range ids {
		if err := r.MarkUsageInboxFailure(ctx, id, reason); err != nil {
			return marked, err
		}
		marked++
	}
	return marked, nil
}

// MarkUsageInboxProcessed links a captured payload to the event it produced.
func (r *Repository) MarkUsageInboxProcessed(ctx context.Context, id int64, eventKey string) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	if _, err := r.SQL().ExecContext(ctx, `
		UPDATE usage_inboxes
		SET status = ?, event_key = ?, processed_at = ?, last_error = NULL
		WHERE id = ?`,
		InboxProcessed, eventKey, time.Now().UnixMilli(), id); err != nil {
		return fmt.Errorf("mark usage inbox processed: %w", err)
	}
	return nil
}

// MarkUsageInboxFailure records a decode attempt and parks poison payloads as
// discarded so a single bad message cannot stall the pipeline forever.
func (r *Repository) MarkUsageInboxFailure(ctx context.Context, id int64, reason string) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	// One statement is enough: on the right-hand side attempt_count still holds
	// the pre-update value, so the threshold is evaluated against the new count.
	if _, err := r.SQL().ExecContext(ctx, `
		UPDATE usage_inboxes
		SET attempt_count = attempt_count + 1,
		    last_error = ?,
		    status = CASE WHEN attempt_count + 1 >= ? THEN ? ELSE ? END
		WHERE id = ?`,
		security.RedactText(truncate(reason, 500)), maxInboxAttempts, InboxDiscarded, InboxPending, id); err != nil {
		return fmt.Errorf("mark usage inbox failure: %w", err)
	}
	return nil
}

// UsagePipelineStats summarises what the pipeline has stored so far.
type UsagePipelineStats struct {
	Events           int64
	ErrorEvents      int64
	Pending          int64
	Processed        int64
	Discarded        int64
	FirstEventMS     *int64
	LastEventMS      *int64
	CheckpointHourly int64
	CheckpointDaily  int64
}

// StatsUsagePipeline reports pipeline fill state for the status endpoint.
func (r *Repository) StatsUsagePipeline(ctx context.Context) (UsagePipelineStats, error) {
	var stats UsagePipelineStats
	if r == nil || r.SQL() == nil {
		return stats, errors.New("repository is not initialized")
	}
	var firstMS, lastMS int64
	err := r.SQL().QueryRowContext(ctx, `
		SELECT COUNT(1), COALESCE(MIN(timestamp_ms), 0), COALESCE(MAX(timestamp_ms), 0)
		FROM usage_events`).Scan(&stats.Events, &firstMS, &lastMS)
	if err != nil {
		return stats, fmt.Errorf("read usage event stats: %w", err)
	}
	// An empty table has no span to report, so the bounds stay null and the UI
	// can distinguish "no data yet" from "data at epoch zero".
	if stats.Events > 0 {
		stats.FirstEventMS = &firstMS
		stats.LastEventMS = &lastMS
	}
	if err := r.SQL().QueryRowContext(ctx, `SELECT COUNT(1) FROM error_events`).Scan(&stats.ErrorEvents); err != nil {
		return stats, fmt.Errorf("read error event stats: %w", err)
	}
	if err := r.SQL().QueryRowContext(ctx, `
		SELECT
			COALESCE(SUM(CASE WHEN status = '`+InboxPending+`' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status = '`+InboxProcessed+`' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status = '`+InboxDiscarded+`' THEN 1 ELSE 0 END), 0)
		FROM usage_inboxes`).Scan(&stats.Pending, &stats.Processed, &stats.Discarded); err != nil {
		return stats, fmt.Errorf("read usage inbox stats: %w", err)
	}
	if stats.CheckpointHourly, err = r.UsageCheckpoint(ctx, CheckpointHourly); err != nil {
		return stats, err
	}
	if stats.CheckpointDaily, err = r.UsageCheckpoint(ctx, CheckpointDaily); err != nil {
		return stats, err
	}
	return stats, nil
}

// CaptureErrorEvent decodes and stores one CPA errors-channel payload.
//
// Error notifications never enter the usage inbox: they have no request_id, so
// replaying them through the usage decoder would burn retries and then discard
// perfectly good data.
func (r *Repository) CaptureErrorEvent(ctx context.Context, instanceID, raw string, observedAt time.Time) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	event, err := usage.DecodeErrorEventWithFingerprinter(raw, instanceID, observedAt, r.db.Cipher())
	if err != nil {
		return err
	}
	return r.InsertErrorEvent(ctx, event)
}

// PendingUsageInboxCount reports backlog for the ingest status endpoint.
func (r *Repository) PendingUsageInboxCount(ctx context.Context) (int64, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	var count int64
	err := r.SQL().QueryRowContext(ctx, `
		SELECT COUNT(1) FROM usage_inboxes WHERE status = ?`, InboxPending).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count pending usage inboxes: %w", err)
	}
	return count, nil
}

// InsertUsageEvents stores decoded events and returns the highest row id, which
// the aggregation checkpoint uses as its watermark.
func (r *Repository) InsertUsageEvents(ctx context.Context, events []usage.Event) (int64, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	if len(events) == 0 {
		return 0, nil
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin usage event insert: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	statement, err := tx.PrepareContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, api_group_label, provider, endpoint, auth_type, request_id,
			client_ip, x_forwarded_for, user_agent, model, model_alias, reasoning_effort,
			service_tier, response_service_tier, executor_type, timestamp_ms, source, auth_index,
			failed, generate, latency_ms, ttft_ms,
			input_tokens, output_tokens, reasoning_tokens, cached_tokens,
			cache_read_tokens, cache_creation_tokens, total_tokens, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, fmt.Errorf("prepare usage event insert: %w", err)
	}
	defer statement.Close()

	createdMS := time.Now().UnixMilli()
	var lastID int64
	for _, event := range events {
		event = r.sanitizeUsageEvent(event)
		result, errExec := statement.ExecContext(ctx,
			event.InstanceID, event.EventKey, event.APIGroupKey, event.APIGroupLabel, event.Provider, event.Endpoint,
			event.AuthType, event.RequestID, event.ClientIP, event.XForwardedFor, event.UserAgent,
			event.Model, event.ModelAlias, event.ReasoningEffort, event.ServiceTier,
			event.ResponseServiceTier, event.ExecutorType, event.TimestampMS, event.Source,
			event.AuthIndex, boolInt(event.Failed), boolInt(event.Generate), event.LatencyMS,
			event.TTFTMS, event.InputTokens, event.OutputTokens, event.ReasoningTokens,
			event.CachedTokens, event.CacheReadTokens, event.CacheCreationTokens,
			event.TotalTokens, createdMS)
		if errExec != nil {
			return lastID, fmt.Errorf("insert usage event: %w", errExec)
		}
		if id, errLast := result.LastInsertId(); errLast == nil && id > lastID {
			lastID = id
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit usage event insert: %w", err)
	}
	return lastID, nil
}

// InsertErrorEvent stores one credential error notification.
func (r *Repository) InsertErrorEvent(ctx context.Context, event usage.ErrorEvent) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	_, err := r.SQL().ExecContext(ctx, `
		INSERT INTO error_events (
			instance_id, event_key, request_id, provider, model, auth_id, auth_index,
			status_code, code, body, retryable, auth_status, auth_disabled, auth_unavailable,
			quota_exceeded, quota_reason, next_retry_after_ms, next_recover_at_ms,
			backoff_level, timestamp_ms, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(event_key) DO NOTHING`,
		security.RedactText(truncate(event.InstanceID, 256)),
		security.RedactText(truncate(event.EventKey, 256)),
		security.RedactText(truncate(event.RequestID, 256)),
		security.RedactText(truncate(event.Provider, 256)),
		security.RedactText(truncate(event.Model, 256)),
		security.FingerprintOrRedacted(r.db.Cipher(), "error-auth-id", event.AuthID),
		security.RedactText(truncate(event.AuthIndex, 256)), event.StatusCode,
		security.RedactText(truncate(event.Code, 256)), security.RedactText(truncate(event.Body, 4000)),
		boolInt(event.Retryable), security.RedactText(truncate(event.AuthStatus, 512)),
		boolInt(event.AuthDisabled), boolInt(event.AuthUnavailable), boolInt(event.QuotaExceeded),
		security.RedactText(truncate(event.QuotaReason, 512)), event.NextRetryAfterMS,
		event.NextRecoverAtMS, event.BackoffLevel, event.TimestampMS, time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("insert error event: %w", err)
	}
	return nil
}

// UsageCheckpoint reads the last folded event id for a grain.
func (r *Repository) UsageCheckpoint(ctx context.Context, name string) (int64, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	var lastID int64
	err := r.SQL().QueryRowContext(ctx, `
		SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = ?`, name).Scan(&lastID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read usage checkpoint %s: %w", name, err)
	}
	return lastID, nil
}

// SetUsageCheckpoint advances a grain's watermark. It only ever moves forward so
// a racing aggregation pass cannot rewind progress.
func (r *Repository) SetUsageCheckpoint(ctx context.Context, name string, lastEventID int64) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	if lastEventID <= 0 {
		return nil
	}
	nowMS := time.Now().UnixMilli()
	_, err := r.SQL().ExecContext(ctx, `
		INSERT INTO usage_aggregation_checkpoints (name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			last_usage_event_id = CASE WHEN excluded.last_usage_event_id > usage_aggregation_checkpoints.last_usage_event_id
				THEN excluded.last_usage_event_id ELSE usage_aggregation_checkpoints.last_usage_event_id END,
			stats_updated_at_ms = excluded.stats_updated_at_ms,
			updated_at_ms = excluded.updated_at_ms`,
		name, lastEventID, nowMS, nowMS, nowMS)
	if err != nil {
		return fmt.Errorf("advance usage checkpoint %s: %w", name, err)
	}
	return nil
}

// OldestUnaggregatedEventMS returns the earliest event time still outside a
// grain's rollup, or nil when every stored event has been folded in.
//
// Dashboard queries use it as the boundary between "trust the rollup" and
// "read the detail table", which is what makes the hybrid free of double
// counting even though CPA event times can arrive slightly out of order.
func (r *Repository) OldestUnaggregatedEventMS(ctx context.Context, checkpoint string) (*int64, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	lastID, err := r.UsageCheckpoint(ctx, checkpoint)
	if err != nil {
		return nil, err
	}
	var value *int64
	err = r.SQL().QueryRowContext(ctx, `
		SELECT MIN(timestamp_ms) FROM usage_events WHERE id > ?`, lastID).Scan(&value)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("read oldest unaggregated event: %w", err)
	}
	return value, nil
}

// PurgeUsageOlderThan deletes detail and rollup rows before cutoffMS and reports
// how many events were removed. Retention must never delete data the rollups
// have not yet absorbed, so the aggregation checkpoints gate the cutoff.
func (r *Repository) PurgeUsageOlderThan(ctx context.Context, cutoffMS int64) (int64, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	if cutoffMS <= 0 {
		return 0, nil
	}
	// Only purge below what both grains have already aggregated.
	hourly, err := r.OldestUnaggregatedEventMS(ctx, CheckpointHourly)
	if err != nil {
		return 0, err
	}
	daily, err := r.OldestUnaggregatedEventMS(ctx, CheckpointDaily)
	if err != nil {
		return 0, err
	}
	safeCutoff := cutoffMS
	for _, watermark := range []*int64{hourly, daily} {
		if watermark != nil && *watermark < safeCutoff {
			safeCutoff = *watermark
		}
	}

	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin usage purge: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.ExecContext(ctx, `DELETE FROM usage_events WHERE timestamp_ms < ?`, safeCutoff)
	if err != nil {
		return 0, fmt.Errorf("purge usage events: %w", err)
	}
	deleted, _ := result.RowsAffected()
	if _, err := tx.ExecContext(ctx, `DELETE FROM error_events WHERE timestamp_ms < ?`, safeCutoff); err != nil {
		return 0, fmt.Errorf("purge error events: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM usage_overview_hourly_stats WHERE bucket_start_ms < ?`, safeCutoff); err != nil {
		return 0, fmt.Errorf("purge hourly stats: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM usage_overview_daily_stats WHERE bucket_start_ms < ?`, safeCutoff); err != nil {
		return 0, fmt.Errorf("purge daily stats: %w", err)
	}
	// Captured payloads are only useful for replay, so they follow the same
	// horizon once processed. Failed rows stay until an operator looks.
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM usage_inboxes WHERE status = ? AND popped_at < ?`,
		InboxProcessed, safeCutoff); err != nil {
		return 0, fmt.Errorf("purge usage inboxes: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit usage purge: %w", err)
	}
	return deleted, nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// sanitizeUsageEvent enforces the same projection at the persistence boundary
// as the decoder does at the ingest boundary. This protects callers that build
// usage.Event values directly and keeps a future decoder change from widening
// the database contract accidentally.
func (r *Repository) sanitizeUsageEvent(event usage.Event) usage.Event {
	event.InstanceID = persistedText(event.InstanceID, 256)
	event.EventKey = persistedText(event.EventKey, 256)
	event.RequestID = persistedText(event.RequestID, 256)
	event.Provider = persistedText(event.Provider, 256)
	event.Endpoint = security.PublicEndpoint(event.Endpoint)
	event.AuthType = persistedText(event.AuthType, 128)
	event.AuthIndex = persistedText(event.AuthIndex, 256)
	event.Model = persistedText(event.Model, 256)
	event.ModelAlias = persistedPointer(event.ModelAlias, 256)
	event.ReasoningEffort = persistedText(event.ReasoningEffort, 128)
	event.ServiceTier = persistedText(event.ServiceTier, 128)
	event.ResponseServiceTier = persistedText(event.ResponseServiceTier, 128)
	event.ExecutorType = persistedText(event.ExecutorType, 128)
	event.Source = r.persistedFingerprint("usage-source", event.Source)
	event.APIGroupKey, event.APIGroupLabel = r.persistedAPIGroup(event.APIGroupKey, event.APIGroupLabel, event.Provider, event.Endpoint)
	event.ClientIP = persistedPointerWith(event.ClientIP, security.MaskIP)
	event.XForwardedFor = persistedPointerWith(event.XForwardedFor, security.MaskForwardedFor)
	event.UserAgent = security.MinimizeUserAgent(pointerValue(event.UserAgent))
	event.LatencyMS = nonNegative(event.LatencyMS)
	event.TTFTMS = nonNegativePointer(event.TTFTMS)
	event.InputTokens = nonNegative(event.InputTokens)
	event.OutputTokens = nonNegative(event.OutputTokens)
	event.ReasoningTokens = nonNegative(event.ReasoningTokens)
	event.CachedTokens = nonNegative(event.CachedTokens)
	event.CacheReadTokens = nonNegative(event.CacheReadTokens)
	event.CacheCreationTokens = nonNegative(event.CacheCreationTokens)
	event.TotalTokens = nonNegative(event.TotalTokens)
	return event
}

func (r *Repository) persistedAPIGroup(value, label, provider, endpoint string) (string, string) {
	value = strings.TrimSpace(value)
	switch strings.ToLower(strings.TrimSpace(label)) {
	case "api_key", "apikey":
		return r.persistedFingerprint("usage-api-key", value), "api_key"
	case "provider":
		value = persistedText(value, 256)
		if value == "" {
			return "unknown", "unknown"
		}
		return value, "provider"
	case "endpoint":
		if safe := security.PublicEndpoint(value); safe != "" {
			return safe, "endpoint"
		}
		return "unknown", "unknown"
	case "unknown":
		if value == "" {
			return "unknown", "unknown"
		}
	}
	if value == "" {
		return "unknown", "unknown"
	}
	if strings.HasPrefix(value, "hmac:") || value == security.RedactedValue {
		return value, "api_key"
	}
	if safe := security.PublicEndpoint(value); safe != "" {
		return safe, "endpoint"
	}
	if strings.TrimSpace(provider) != "" && strings.TrimSpace(provider) == value {
		return persistedText(provider, 256), "provider"
	}
	if strings.TrimSpace(endpoint) != "" && strings.TrimSpace(endpoint) == value {
		if safe := security.PublicEndpoint(endpoint); safe != "" {
			return safe, "endpoint"
		}
	}
	return r.persistedFingerprint("usage-api-key", value), "api_key"
}

func (r *Repository) persistedFingerprint(purpose, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "hmac:") || value == security.RedactedValue {
		return value
	}
	return security.FingerprintOrRedacted(r.db.Cipher(), purpose, value)
}

func persistedText(value string, limit int) string {
	value = security.RedactText(strings.TrimSpace(value))
	if limit > 0 && len([]rune(value)) > limit {
		return string([]rune(value)[:limit])
	}
	return value
}

func persistedPointer(value *string, limit int) *string {
	if value == nil {
		return nil
	}
	cleaned := persistedText(*value, limit)
	if cleaned == "" {
		return nil
	}
	return &cleaned
}

func persistedPointerWith(value *string, mask func(string) *string) *string {
	if value == nil {
		return nil
	}
	return mask(*value)
}

func pointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nonNegative(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

func nonNegativePointer(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cleaned := nonNegative(*value)
	return &cleaned
}

func truncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
