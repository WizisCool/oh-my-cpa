package repository

import (
	"context"
	"testing"
	"time"
)

func TestRepositoryQuotaSnapshots(t *testing.T) {
	ctx := context.Background()
	repo, _ := testRepository(t)

	nowMS := time.Now().UnixMilli()

	// 1. Save two snapshots for auth-1
	err := repo.SaveQuotaSnapshot(ctx, QuotaSnapshotRecord{
		AuthIndex:    "auth-1",
		Provider:     "codex",
		Status:       "healthy",
		PlanType:     "pro",
		PlanTier:     "elite",
		WindowsJSON:  `[{"id":"five_hour","used_percent":20}]`,
		ObservedAtMS: nowMS - 5000,
	})
	if err != nil {
		t.Fatalf("SaveQuotaSnapshot 1 failed: %v", err)
	}

	err = repo.SaveQuotaSnapshot(ctx, QuotaSnapshotRecord{
		AuthIndex:    "auth-1",
		Provider:     "codex",
		Status:       "warning",
		PlanType:     "pro",
		PlanTier:     "elite",
		WindowsJSON:  `[{"id":"five_hour","used_percent":85}]`,
		ObservedAtMS: nowMS,
	})
	if err != nil {
		t.Fatalf("SaveQuotaSnapshot 2 failed: %v", err)
	}

	// 2. Save snapshot for auth-2
	err = repo.SaveQuotaSnapshot(ctx, QuotaSnapshotRecord{
		AuthIndex:    "auth-2",
		Provider:     "claude",
		Status:       "healthy",
		PlanType:     "max",
		PlanTier:     "elite",
		WindowsJSON:  `[{"id":"five_hour","used_percent":10}]`,
		ObservedAtMS: nowMS,
	})
	if err != nil {
		t.Fatalf("SaveQuotaSnapshot auth-2 failed: %v", err)
	}

	// 3. Batch fetch latest
	latest, err := repo.GetLatestQuotaSnapshots(ctx, []string{"auth-1", "auth-2", "auth-nonexistent"})
	if err != nil {
		t.Fatalf("GetLatestQuotaSnapshots failed: %v", err)
	}

	if len(latest) != 2 {
		t.Fatalf("len(latest) = %d, want 2", len(latest))
	}

	snap1 := latest["auth-1"]
	if snap1.Status != "warning" || snap1.ObservedAtMS != nowMS {
		t.Errorf("snap1 = %+v, want status: warning at nowMS", snap1)
	}

	snap2 := latest["auth-2"]
	if snap2.Provider != "claude" || snap2.Status != "healthy" {
		t.Errorf("snap2 = %+v, want claude/healthy", snap2)
	}

	// 4. History
	hist, err := repo.GetQuotaSnapshotHistory(ctx, "auth-1", 10)
	if err != nil {
		t.Fatalf("GetQuotaSnapshotHistory failed: %v", err)
	}
	if len(hist) != 2 {
		t.Fatalf("len(hist) = %d, want 2", len(hist))
	}
	if hist[0].ObservedAtMS != nowMS || hist[1].ObservedAtMS != nowMS-5000 {
		t.Errorf("history order wrong: %+v", hist)
	}
}

func TestRepositoryBatchCorrelatedCooldowns(t *testing.T) {
	ctx := context.Background()
	repo, _ := testRepository(t)

	// Insert instance for foreign key
	_, err := repo.SQL().ExecContext(ctx, `
		INSERT INTO cpa_instances (id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317', x'00', x'00', 'unknown', 0, 0)
	`)
	if err != nil {
		t.Fatalf("insert instance failed: %v", err)
	}

	nowMS := time.Now().UnixMilli()

	// Insert an active error event with future recover time
	futureRecover := nowMS + 60000
	_, err = repo.SQL().ExecContext(ctx, `
		INSERT INTO error_events (
			instance_id, event_key, provider, model, auth_index, status_code, body,
			retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
			quota_reason, next_recover_at_ms, timestamp_ms, created_at_ms
		) VALUES (
			'default', 'err-1', 'openai', 'gpt-4o', 'auth-cooldown', 429, 'Rate limit reached',
			1, 'active', 0, 0, 1, 'Rate limit exceeded', ?, ?, ?
		)
	`, futureRecover, nowMS-1000, nowMS-1000)
	if err != nil {
		t.Fatalf("insert active error failed: %v", err)
	}

	// Insert an expired error event with past recover time
	pastRecover := nowMS - 10000
	_, err = repo.SQL().ExecContext(ctx, `
		INSERT INTO error_events (
			instance_id, event_key, provider, model, auth_index, status_code, body,
			retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
			quota_reason, next_recover_at_ms, timestamp_ms, created_at_ms
		) VALUES (
			'default', 'err-2', 'openai', 'gpt-4o', 'auth-expired', 429, 'Rate limit reached',
			1, 'active', 0, 0, 1, 'Rate limit exceeded', ?, ?, ?
		)
	`, pastRecover, nowMS-60000, nowMS-60000)
	if err != nil {
		t.Fatalf("insert expired error failed: %v", err)
	}

	// A future retry timestamp is absolute epoch milliseconds, not a duration.
	futureRetry := nowMS + 30000
	_, err = repo.SQL().ExecContext(ctx, `
		INSERT INTO error_events (
			instance_id, event_key, provider, model, auth_index, status_code, body,
			retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
			quota_reason, next_retry_after_ms, timestamp_ms, created_at_ms
		) VALUES (
			'default', 'err-3', 'openai', 'gpt-4o', 'auth-retry', 429, 'Rate limit reached',
			1, 'active', 0, 0, 1, 'Rate limit exceeded', ?, ?, ?
		)
	`, futureRetry, nowMS-10*60*1000, nowMS-10*60*1000)
	if err != nil {
		t.Fatalf("insert future retry error failed: %v", err)
	}

	_, err = repo.SQL().ExecContext(ctx, `
		INSERT INTO error_events (
			instance_id, event_key, provider, model, auth_index, status_code, body,
			retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
			quota_reason, next_retry_after_ms, timestamp_ms, created_at_ms
		) VALUES (
			'default', 'err-4', 'openai', 'gpt-4o', 'auth-retry-expired', 429, 'Rate limit reached',
			1, 'active', 0, 0, 1, 'Rate limit exceeded', ?, ?, ?
		)
	`, nowMS-30000, nowMS-10*60*1000, nowMS-10*60*1000)
	if err != nil {
		t.Fatalf("insert expired retry error failed: %v", err)
	}

	// Batch query cooldowns
	cooldowns, err := repo.BatchCorrelatedCooldowns(ctx, []string{"auth-cooldown", "auth-expired", "auth-retry", "auth-retry-expired", "auth-healthy"}, nowMS)
	if err != nil {
		t.Fatalf("BatchCorrelatedCooldowns failed: %v", err)
	}

	cd1, exists1 := cooldowns["auth-cooldown"]
	if !exists1 || !cd1.IsActive {
		t.Errorf("expected auth-cooldown to be active: %+v", cd1)
	}

	cd2, exists2 := cooldowns["auth-expired"]
	if !exists2 || cd2.IsActive {
		t.Errorf("expected auth-expired to be inactive: %+v", cd2)
	}

	cdRetry, existsRetry := cooldowns["auth-retry"]
	if !existsRetry || !cdRetry.IsActive || cdRetry.RetryAfterSeconds == nil || *cdRetry.RetryAfterSeconds != 30 {
		t.Errorf("expected auth-retry to be active for 30 seconds: %+v", cdRetry)
	}

	cdRetryExpired, existsRetryExpired := cooldowns["auth-retry-expired"]
	if !existsRetryExpired || cdRetryExpired.IsActive || cdRetryExpired.RetryAfterSeconds != nil {
		t.Errorf("expected expired retry to be inactive: %+v", cdRetryExpired)
	}

	_, exists3 := cooldowns["auth-healthy"]
	if exists3 {
		t.Errorf("expected auth-healthy to have no cooldown record")
	}
}
