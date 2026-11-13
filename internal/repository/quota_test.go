package repository

import (
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"

	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestModelCooldownCaptureAndCorrelation(t *testing.T) {
	ctx := context.Background()
	repo, _ := testRepository(t)
	_, err := repo.SQL().ExecContext(ctx, `INSERT INTO cpa_instances (id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at) VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317', x'00', x'00', 'unknown', 0, 0)`)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	payload := func(model string, retry time.Time, level int) string {
		return fmt.Sprintf(`{"timestamp":%q,"auth_index":"auth-model","model":%q,"status_code":429,"auth_status":{"quota":{"exceeded":true,"reason":"quota","next_recover_at":%q,"backoff_level":%d},"model":{"name":%q,"next_retry_after":%q,"quota":{"exceeded":true,"reason":"quota","next_recover_at":%q,"backoff_level":%d}}}}`, now.Format(time.RFC3339), model, retry.Format(time.RFC3339), level, model, retry.Format(time.RFC3339), retry.Format(time.RFC3339), level)
	}
	for _, raw := range []string{payload("model-a", now.Add(time.Hour), 6), payload("model-b", now.Add(2*time.Hour), 2)} {
		if err := repo.CaptureErrorEvent(ctx, "default", raw, now); err != nil {
			t.Fatal(err)
		}
	}
	_, err = repo.SQL().ExecContext(ctx, `INSERT INTO error_events (instance_id,event_key,auth_index,quota_exceeded,next_retry_after_ms,timestamp_ms,created_at_ms) VALUES ('default','expired-retry','auth-retry',1,?,?,?)`, now.Add(-time.Second).UnixMilli(), now.Add(-time.Minute).UnixMilli(), now.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	retry, err := repo.BatchCorrelatedCooldowns(ctx, []string{"auth-retry"}, now.UnixMilli())
	if err != nil || retry["auth-retry"].IsActive {
		t.Fatalf("expired retry received a grace period: %+v, %v", retry, err)
	}
	credential, err := repo.BatchCorrelatedCooldowns(ctx, []string{"auth-model"}, now.UnixMilli())
	if err != nil || credential["auth-model"].IsActive {
		t.Fatalf("model cooldown must not block credential: %+v %v", credential, err)
	}
	models, err := repo.BatchModelCooldowns(ctx, []string{"auth-model"}, now.UnixMilli(), nil)
	if err != nil || len(models["auth-model"]) != 2 {
		t.Fatalf("model cooldowns = %+v, %v", models, err)
	}
	byModel := map[string]ActiveCooldownRecord{}
	for _, record := range models["auth-model"] {
		byModel[record.Model] = record
	}
	if got := byModel["model-a"]; !got.IsActive || got.BackoffLevel != 6 || got.RecoverAtMS == nil || *got.RecoverAtMS != now.Add(time.Hour).UnixMilli() || got.RetryAtMS == nil || *got.RetryAtMS != now.Add(time.Hour).UnixMilli() {
		t.Fatalf("model-a = %+v", got)
	}
	models, err = repo.BatchModelCooldowns(ctx, []string{"auth-model"}, now.Add(90*time.Minute).UnixMilli(), nil)
	if err != nil || len(models["auth-model"]) != 1 || models["auth-model"][0].Model != "model-b" {
		t.Fatalf("independent expiry = %+v, %v", models, err)
	}
	// An event can carry both scopes; neither one may overwrite the other.
	both := fmt.Sprintf(`{"timestamp":%q,"auth_index":"auth-both","model":"request-model","auth_status":{"quota":{"exceeded":true,"reason":"global","next_recover_at":%q,"backoff_level":3},"model":{"name":"actual-model","quota":{"exceeded":true,"reason":"model","next_recover_at":%q,"backoff_level":6}}}}`, now.Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339), now.Add(2*time.Hour).Format(time.RFC3339))
	if err := repo.CaptureErrorEvent(ctx, "default", both, now); err != nil {
		t.Fatal(err)
	}
	global, err := repo.BatchCorrelatedCooldowns(ctx, []string{"auth-both"}, now.UnixMilli())
	if err != nil || !global["auth-both"].IsActive || global["auth-both"].BackoffLevel != 3 || *global["auth-both"].RecoverAtMS != now.Add(time.Hour).UnixMilli() {
		t.Fatalf("global cooldown = %+v, %v", global, err)
	}
	modelScope, err := repo.BatchModelCooldowns(ctx, []string{"auth-both"}, now.UnixMilli(), nil)
	if err != nil || len(modelScope["auth-both"]) != 1 || modelScope["auth-both"][0].Model != "actual-model" || modelScope["auth-both"][0].BackoffLevel != 6 {
		t.Fatalf("model scope = %+v, %v", modelScope, err)
	}
	// CPA also mirrors a credential quota onto the reporting model; that mirror
	// must not be presented as an independently model-scoped limit.
	inherited := fmt.Sprintf(`{"timestamp":%q,"auth_index":"auth-global","auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":4},"model":{"name":"model-a","next_retry_after":%q,"quota":{"exceeded":true,"reason":"quota","next_recover_at":%q,"backoff_level":4}}}}`, now.Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339))
	if err := repo.CaptureErrorEvent(ctx, "default", inherited, now); err != nil {
		t.Fatal(err)
	}
	global, err = repo.BatchCorrelatedCooldowns(ctx, []string{"auth-global"}, now.UnixMilli())
	if err != nil || !global["auth-global"].IsActive || global["auth-global"].BackoffLevel != 4 {
		t.Fatalf("credential quota = %+v, %v", global, err)
	}
	modelScope, err = repo.BatchModelCooldowns(ctx, []string{"auth-global"}, now.UnixMilli(), nil)
	if err != nil || len(modelScope["auth-global"]) != 0 {
		t.Fatalf("inherited model should not appear independent: %+v, %v", modelScope, err)
	}
	if active, err := repo.HasActiveModelCooldownEvidence(ctx, "auth-global", now.UnixMilli()); err != nil || !active {
		t.Fatalf("reset safety evidence = %v, %v", active, err)
	}
	if err := repo.ClearCooldownEvidence(ctx, "auth-model"); err != nil {
		t.Fatal(err)
	}
	models, err = repo.BatchModelCooldowns(ctx, []string{"auth-model"}, now.UnixMilli(), nil)
	if err != nil || len(models["auth-model"]) != 0 {
		t.Fatalf("clear model evidence = %+v, %v", models, err)
	}
}

// One upstream model can be stored under several spellings: CPA compared model cooldown keys
// case-insensitively only after the events were written, and an alias recorded before the
// mapping existed kept the name the operator typed. Each one must read as one resting model.
func TestModelCooldownSpellingsCollapse(t *testing.T) {
	ctx := context.Background()
	repo, _ := testRepository(t)
	if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO cpa_instances (id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at) VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 9, 4, 52, 0, 0, time.UTC)
	insert := func(eventKey, authIndex, model string, recordedAt, recoveringAt time.Time) {
		t.Helper()
		if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO error_events (instance_id,event_key,auth_index,cooldown_model,model_quota_exceeded,model_next_retry_after_ms,model_next_recover_at_ms,model_backoff_level,timestamp_ms,created_at_ms) VALUES ('default',?,?,?,1,?,?,6,?,?)`,
			eventKey, authIndex, model, recoveringAt.UnixMilli(), recoveringAt.UnixMilli(), recordedAt.UnixMilli(), now.UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	one := func(authIndex string, resolve ModelCooldownKeyResolver) []ActiveCooldownRecord {
		t.Helper()
		records, err := repo.BatchModelCooldowns(ctx, []string{authIndex}, now.UnixMilli(), resolve)
		if err != nil {
			t.Fatal(err)
		}
		return records[authIndex]
	}

	// A mixed-case spelling is the same model, and the newer row may recover sooner than the
	// older one: the countdown must not end early.
	insert("case-old", "auth-case", "DeepSeek-V4.1-flash-sg", now.Add(-10*time.Minute), now.Add(2*time.Hour))
	insert("case-new", "auth-case", "deepseek-v4.1-flash-sg", now, now.Add(10*time.Minute))
	collapsed := one("auth-case", nil)
	if len(collapsed) != 1 {
		t.Fatalf("mixed-case spellings = %+v", collapsed)
	}
	if collapsed[0].Model != "deepseek-v4.1-flash-sg" || !collapsed[0].IsActive || collapsed[0].RecoverAtMS == nil || *collapsed[0].RecoverAtMS != now.Add(2*time.Hour).UnixMilli() || collapsed[0].BackoffLevel != 6 {
		t.Fatalf("merged cooldown = %+v", collapsed[0])
	}

	// The newest spelling may already have recovered while the older one is still resting.
	insert("expired-new", "auth-expired", "model-x", now.Add(-time.Minute), now.Add(-time.Minute))
	insert("resting-old", "auth-expired", "MODEL-X", now.Add(-20*time.Minute), now.Add(time.Hour))
	resting := one("auth-expired", nil)
	if len(resting) != 1 || resting[0].Model != "model-x" || !resting[0].IsActive || resting[0].RecoverAtMS == nil || *resting[0].RecoverAtMS != now.Add(time.Hour).UnixMilli() {
		t.Fatalf("recovered newest spelling = %+v", resting)
	}

	// An alias recorded before CPA resolved it is the upstream model it reaches; without the
	// alias table the two spellings stay apart rather than merging on a guess.
	insert("alias-old", "auth-alias", "DeepSeek V4.1 flash", now.Add(-30*time.Minute), now.Add(time.Hour))
	insert("alias-new", "auth-alias", "deepseek-v4.1-flash-sg", now.Add(-20*time.Minute), now.Add(2*time.Hour))
	if unfolded := one("auth-alias", nil); len(unfolded) != 2 {
		t.Fatalf("alias without rules = %+v", unfolded)
	}
	resolved := one("auth-alias", func(_ string, model string) string {
		if model == "DeepSeek V4.1 flash" {
			return "deepseek-v4.1-flash-sg"
		}
		return model
	})
	if len(resolved) != 1 || resolved[0].Model != "deepseek-v4.1-flash-sg" || resolved[0].RecoverAtMS == nil || *resolved[0].RecoverAtMS != now.Add(2*time.Hour).UnixMilli() {
		t.Fatalf("alias resolved = %+v", resolved)
	}
}

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

	t.Run("retention trims readings but calibration outlives them", func(t *testing.T) {
		for index := range 70 {
			resetAtMS := nowMS + 3600000
			observedAtMS := nowMS + int64(index)
			if err := repo.SaveQuotaSnapshot(ctx, QuotaSnapshotRecord{
				ID: fmt.Sprintf("anchor-%d", index), AuthIndex: "auth-anchors", Provider: "codex", Status: "healthy",
				WindowsJSON:  fmt.Sprintf(`[{"id":"five_hour","scope":"standard","used_percent":%d,"reset_at_ms":%d,"period_hours":5,"reset_accuracy":"exact"}]`, index+1, resetAtMS),
				ObservedAtMS: observedAtMS,
			}); err != nil {
				t.Fatal(err)
			}
		}
		records, err := repo.GetQuotaSnapshotHistory(ctx, "auth-anchors", 100)
		if err != nil {
			t.Fatal(err)
		}
		if len(records) != 50 {
			t.Fatalf("retained %d readings, want the recent 50", len(records))
		}
		cycles, err := repo.LoadCapacityCycles(ctx, "auth-anchors")
		points := cycles["codex|five_hour|standard|"]
		if err != nil || len(points) != 1 || len(points[0].Points) != 70 || points[0].Points[0].UsedPercent != 1 {
			t.Fatalf("calibration lost the climb: %+v err %v", cycles, err)
		}
	})
}

func TestQuotaSnapshotsUseInsertionOrderForTimestampTies(t *testing.T) {
	ctx := context.Background()
	repo, _ := testRepository(t)
	observedAt := time.Now().UnixMilli()

	for _, status := range []string{"first", "second", "third"} {
		if err := repo.SaveQuotaSnapshot(ctx, QuotaSnapshotRecord{
			AuthIndex:    "auth-tie",
			Provider:     "codex",
			Status:       status,
			WindowsJSON:  "[]",
			ObservedAtMS: observedAt,
			// Pinned as well as the observation time: the writer would otherwise take
			// created_at_ms from the clock, and a millisecond boundary between the
			// three inserts would let created_at_ms decide the order on its own - the
			// test would then pass even with the rowid tie-breaker removed.
			CreatedAtMS: observedAt,
		}); err != nil {
			t.Fatal(err)
		}
	}

	latest, err := repo.GetLatestQuotaSnapshots(ctx, []string{"auth-tie"})
	if err != nil {
		t.Fatal(err)
	}
	if latest["auth-tie"].Status != "third" {
		t.Fatalf("latest tied snapshot = %q, want third", latest["auth-tie"].Status)
	}

	tx, err := repo.SQL().BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := trimQuotaSnapshots(ctx, tx, "auth-tie", 1); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var kept string
	if err := repo.SQL().QueryRowContext(ctx, `SELECT status FROM quota_snapshots WHERE auth_index = ?`, "auth-tie").Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept != "third" {
		t.Fatalf("trim kept %q, want the newest tied row", kept)
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

	_, err = repo.SQL().ExecContext(ctx, `
		INSERT INTO error_events (
			instance_id, event_key, provider, model, auth_index, status_code, body,
			retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
			quota_reason, next_recover_at_ms, timestamp_ms, created_at_ms
		) VALUES (
			'default', 'err-5', 'openai', 'gpt-4o', 'auth-older-active', 429, 'Rate limit reached',
			1, 'active', 0, 0, 1, 'newest expired', ?, ?, ?
		)
	`, nowMS-10000, nowMS-10*60*1000, nowMS-10*60*1000)
	if err != nil {
		t.Fatalf("insert newest inactive error failed: %v", err)
	}
	_, err = repo.SQL().ExecContext(ctx, `
		INSERT INTO error_events (
			instance_id, event_key, provider, model, auth_index, status_code, body,
			retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
			quota_reason, next_recover_at_ms, timestamp_ms, created_at_ms
		) VALUES (
			'default', 'err-6', 'openai', 'gpt-4o', 'auth-older-active', 429, 'Rate limit reached',
			1, 'active', 0, 0, 1, 'older still active', ?, ?, ?
		)
	`, nowMS+30000, nowMS-20*60*1000, nowMS-20*60*1000)
	if err != nil {
		t.Fatalf("insert older active error failed: %v", err)
	}

	// Batch query cooldowns
	cooldowns, err := repo.BatchCorrelatedCooldowns(ctx, []string{"auth-cooldown", "auth-expired", "auth-retry", "auth-retry-expired", "auth-older-active", "auth-healthy"}, nowMS)
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

	cdOlderActive, existsOlderActive := cooldowns["auth-older-active"]
	if !existsOlderActive || !cdOlderActive.IsActive || cdOlderActive.Reason != "older still active" {
		t.Errorf("expected an older active recovery row to win over a newer inactive row: %+v", cdOlderActive)
	}

	_, exists3 := cooldowns["auth-healthy"]
	if exists3 {
		t.Errorf("expected auth-healthy to have no cooldown record")
	}
}

// Two active rows for one auth_index can share a timestamp_ms. Ordering by that
// non-unique value alone leaves the winner to SQLite's row order, so the same
// stored data could report a different reason or recovery time between reads.
// The query must add a unique tie-breaker.
func TestBatchCorrelatedCooldownsBreaksTimestampTiesDeterministically(t *testing.T) {
	ctx := context.Background()
	repo, _ := testRepository(t)

	_, err := repo.SQL().ExecContext(ctx, `
		INSERT INTO cpa_instances (id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317', x'00', x'00', 'unknown', 0, 0)
	`)
	if err != nil {
		t.Fatalf("insert instance failed: %v", err)
	}

	nowMS := time.Now().UnixMilli()
	tiedTimestamp := nowMS - 60*1000

	// Both rows are active and carry the same timestamp; only the inserted order
	// distinguishes them, and the later row is the one that must win.
	for index, reason := range []string{"earlier tied reason", "later tied reason"} {
		_, err = repo.SQL().ExecContext(ctx, `
			INSERT INTO error_events (
				instance_id, event_key, provider, model, auth_index, status_code, body,
				retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
				quota_reason, next_recover_at_ms, timestamp_ms, created_at_ms
			) VALUES (
				'default', ?, 'openai', 'gpt-4o', 'auth-tied', 429, 'Rate limit reached',
				1, 'active', 0, 0, 1, ?, ?, ?, ?
			)
		`, fmt.Sprintf("tied-%d", index), reason, nowMS+int64(index+1)*60000, tiedTimestamp, tiedTimestamp)
		if err != nil {
			t.Fatalf("insert tied error %d failed: %v", index, err)
		}
	}

	// Repeated reads must agree: the ordering cannot depend on which row SQLite
	// happens to return first.
	for attempt := 0; attempt < 5; attempt++ {
		cooldowns, err := repo.BatchCorrelatedCooldowns(ctx, []string{"auth-tied"}, nowMS)
		if err != nil {
			t.Fatalf("BatchCorrelatedCooldowns failed: %v", err)
		}
		record, ok := cooldowns["auth-tied"]
		if !ok {
			t.Fatalf("attempt %d: no cooldown recorded for auth-tied", attempt)
		}
		if record.Reason != "later tied reason" {
			t.Fatalf("attempt %d: reason = %q, want the most recently inserted tied row", attempt, record.Reason)
		}
	}
}

func TestQueryCapacityUsage(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()

	insert := func(key, authIndex string, timestampMS, latencyMS, tokens int64, costNanos any) {
		t.Helper()
		if _, err := r.SQL().ExecContext(ctx,
			`INSERT INTO usage_events (instance_id, event_key, api_group_key, auth_index, timestamp_ms, created_at_ms, latency_ms, total_tokens, cost_nanos)
			 VALUES ('default', ?, 'group', ?, ?, ?, ?, ?, ?)`,
			key, authIndex, timestampMS, timestampMS, latencyMS, tokens, costNanos,
		); err != nil {
			t.Fatal(err)
		}
	}
	insert("before", "auth-1", 999, 0, 1, int64(1))
	insert("at-start", "auth-1", 1000, 0, 100, int64(2_000))
	insert("unpriced", "auth-1", 1500, 0, 50, nil)
	insert("failed", "auth-1", 1500, 0, 0, nil)
	insert("finishes-after", "auth-1", 1900, 200, 9, int64(9))
	insert("other-credential", "auth-2", 1500, 0, 7, int64(7))
	insert("at-end", "auth-1", 2000, 0, 1, int64(1))

	// The range is half-open by finish time: the event at its start counts, one
	// finishing at or after its end belongs to whatever follows the reading, and
	// a request that produced no tokens consumed nothing.
	window := quota.QuotaWindow{ID: "five_hour", Scope: "standard"}
	usage, reason, err := r.QueryCapacityUsage(ctx, "auth-1", window, 1000, 2000)
	if err != nil || reason != "" {
		t.Fatalf("QueryCapacityUsage failed: %v %q", err, reason)
	}
	want := quota.WindowUsage{
		FromMS: 1000, ToMS: 2000, Requests: 2, PricedRequests: 1,
		Tokens: 150, PricedTokens: 100, CostNanos: 2_000,
	}
	if usage != want {
		t.Fatalf("usage = %+v, want %+v", usage, want)
	}

	insert("crosses-start", "auth-1", 990, 20, 10, int64(100))
	crossing, _, _, err := queryCapacityUsageSince(ctx, r.SQL(), "auth-1", window, 900, 1000, 2000)
	if err != nil || crossing.Requests != 3 || crossing.Tokens != 160 {
		t.Fatalf("cross-boundary completion = %+v, %v", crossing, err)
	}
	ending, _, _, err := queryCapacityUsageSince(ctx, r.SQL(), "auth-1", window, 900, 2000, 2200)
	if err != nil || ending.Requests != 2 || ending.Tokens != 10 {
		t.Fatalf("next interval completions = %+v, %v", ending, err)
	}

	// Independent-cache dialect with validated canonical v2 token_accounting
	// (1,000 uncached input + 200 cache_read + 300 output = 1,500 total, where
	// cache_read <= input_tokens) uses the canonical 1,200 prompt denominator
	// (200 / 1,200 = 16.7%) rather than raw 1,000 (20.0%).
	canonicalJSON := `{"version":2,"status":"complete","raw_tokens":{"input_tokens":1000,"output_tokens":300,"cache_read_tokens":200,"total_tokens":1500},"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":1500,"input":{"total_tokens":1200,"uncached_tokens":1000,"cache_read_tokens":200,"cache_write_tokens":0},"output":{"total_tokens":300,"non_reasoning_tokens":300,"reasoning_tokens":0},"unclassified_tokens":0}}`
	if _, err := r.SQL().ExecContext(ctx,
		`INSERT INTO usage_events (instance_id, event_key, api_group_key, auth_index, model, timestamp_ms, created_at_ms, input_tokens, output_tokens, cache_read_tokens, total_tokens, cost_nanos, token_accounting)
		 VALUES ('default', 'canonical-indep', 'group', 'auth-canon', 'claude-sonnet-4-6', 1200, 1200, 1000, 300, 200, 1500, 5000, ?)`,
		canonicalJSON,
	); err != nil {
		t.Fatal(err)
	}
	canonUsage, canonReason, err := r.QueryCapacityUsage(ctx, "auth-canon", window, 1000, 2000)
	if err != nil || canonReason != "" {
		t.Fatalf("canonical QueryCapacityUsage failed: %v %q", err, canonReason)
	}
	if canonUsage.PromptTokens != 1200 || canonUsage.CachedTokens != 200 || !canonUsage.HasInputBounds || canonUsage.MinInputTokens != 1200 || canonUsage.MaxInputTokens != 1200 || canonUsage.CacheRate == nil || *canonUsage.CacheRate != 16.7 {
		t.Fatalf("canonical independent-cache usage = %+v, want PromptTokens=1200 Min/MaxInput=1200 CachedTokens=200 CacheRate=16.7", canonUsage)
	}
	empty, _, err := r.QueryCapacityUsage(ctx, "auth-none", window, 1000, 2000)
	if err != nil || empty != (quota.WindowUsage{FromMS: 1000, ToMS: 2000}) {
		t.Fatalf("empty usage = %+v %v, want zero", empty, err)
	}
	for _, repo := range []*Repository{nil, {}} {
		if _, _, err := repo.QueryCapacityUsage(ctx, "auth-1", window, 1, 2); err == nil {
			t.Fatal("uninitialized repository accepted")
		}
	}
}

func TestQueryCapacityUsagePrefersServedIdentity(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	for _, row := range []struct {
		key, requested, served string
		atMS                   int64
	}{
		{"alias", "fast", "claude-sonnet-4-5", 1000},
		{"substitution", "claude-sonnet-4-5", "claude-opus-4-1", 1500},
		{"unknown-alias", "fast", "", 1500},
		{"outside", "fast", "claude-sonnet-4-5", 2000},
	} {
		if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO usage_events(instance_id,event_key,api_group_key,auth_index,timestamp_ms,created_at_ms,model,response_model,total_tokens,cost_nanos) VALUES('default',?,'group','auth-1',?,?,?, ?,100,1000)`, row.key, row.atMS, row.atMS, row.requested, row.served); err != nil {
			t.Fatal(err)
		}
	}
	window := quota.QuotaWindow{ID: "seven_day_sonnet", Scope: "model", Model: "claude-sonnet-4-5"}
	usage, reason, err := repo.QueryCapacityUsage(ctx, "auth-1", window, 1000, 2000)
	if err != nil || reason != "" || usage.Requests != 1 || usage.Tokens != 100 || usage.UnmatchedRequests != 1 {
		t.Fatalf("scoped usage = %+v %q %v, want the served Sonnet request and one unknown alias", usage, reason, err)
	}
}

func TestRepositoryQuotaRefreshAttempts(t *testing.T) {
	ctx := context.Background()
	repo, _ := testRepository(t)

	nowMS := time.Now().UnixMilli()
	failed := QuotaRefreshAttemptRecord{
		AuthIndex:     "auth-attempt",
		AttemptedAtMS: nowMS,
		Outcome:       QuotaRefreshAttemptFailed,
		Error:         "HTTP 401: unauthorized",
	}
	if err := repo.SaveQuotaRefreshAttempt(ctx, failed); err != nil {
		t.Fatalf("SaveQuotaRefreshAttempt failed: %v", err)
	}

	attempts, err := repo.GetQuotaRefreshAttempts(ctx, []string{"auth-attempt", "auth-absent", " "})
	if err != nil {
		t.Fatalf("GetQuotaRefreshAttempts failed: %v", err)
	}
	if got := attempts["auth-attempt"]; got.Outcome != QuotaRefreshAttemptFailed || got.Error != failed.Error || got.AttemptedAtMS != nowMS {
		t.Fatalf("attempt = %+v, want the failed read", got)
	}
	if _, ok := attempts["auth-absent"]; ok {
		t.Fatal("a credential nobody tried must not report an attempt")
	}

	// A newer success replaces the failure it followed: the console asks what the last try was.
	if err := repo.SaveQuotaRefreshAttempt(ctx, QuotaRefreshAttemptRecord{
		AuthIndex:     "auth-attempt",
		AttemptedAtMS: nowMS + 1000,
		Outcome:       QuotaRefreshAttemptSucceeded,
	}); err != nil {
		t.Fatalf("SaveQuotaRefreshAttempt (success) failed: %v", err)
	}
	attempts, _ = repo.GetQuotaRefreshAttempts(ctx, []string{"auth-attempt"})
	if got := attempts["auth-attempt"]; got.Outcome != QuotaRefreshAttemptSucceeded || got.Error != "" {
		t.Fatalf("attempt = %+v, want the later success with no reason left over", got)
	}

	// A slow read that finishes after a newer one must not resurrect its own outcome.
	if err := repo.SaveQuotaRefreshAttempt(ctx, QuotaRefreshAttemptRecord{
		AuthIndex:     "auth-attempt",
		AttemptedAtMS: nowMS,
		Outcome:       QuotaRefreshAttemptFailed,
		Error:         "HTTP 500: late arrival",
	}); err != nil {
		t.Fatalf("SaveQuotaRefreshAttempt (late) failed: %v", err)
	}
	attempts, _ = repo.GetQuotaRefreshAttempts(ctx, []string{"auth-attempt"})
	if got := attempts["auth-attempt"]; got.Outcome != QuotaRefreshAttemptSucceeded {
		t.Fatalf("attempt = %+v, want the later success to survive an older write", got)
	}

	if err := repo.SaveQuotaRefreshAttempt(ctx, QuotaRefreshAttemptRecord{AuthIndex: " ", AttemptedAtMS: nowMS, Outcome: QuotaRefreshAttemptFailed}); err == nil {
		t.Fatal("an attempt with no credential must be refused")
	}
	if err := repo.SaveQuotaRefreshAttempt(ctx, QuotaRefreshAttemptRecord{AuthIndex: "auth-attempt", AttemptedAtMS: nowMS, Outcome: "maybe"}); err == nil {
		t.Fatal("an unknown outcome must be refused")
	}
}

func TestBatchExpiredCooldownsReportsOnlyFullyRecoveredEvidence(t *testing.T) {
	ctx := context.Background()
	repo, _ := testRepository(t)
	if _, err := repo.SQL().ExecContext(ctx, `
		INSERT INTO cpa_instances (id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317', x'00', x'00', 'unknown', 0, 0)
	`); err != nil {
		t.Fatalf("insert instance failed: %v", err)
	}
	nowMS := time.Now().UnixMilli()
	hour := time.Hour.Milliseconds()
	insertWithRetry := func(eventKey, authIndex string, quotaExceeded int, recoverAtMS, retryAtMS any) {
		t.Helper()
		if _, err := repo.SQL().ExecContext(ctx, `
			INSERT INTO error_events (
				instance_id, event_key, provider, model, auth_index, status_code, body,
				retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
				quota_reason, next_recover_at_ms, next_retry_after_ms, timestamp_ms, created_at_ms
			) VALUES (
				'default', ?, 'codex', 'gpt-5', ?, 429, 'usage limit reached',
				1, 'active', 0, 0, ?, 'usage_limit_reached', ?, ?, ?, ?
			)
		`, eventKey, authIndex, quotaExceeded, recoverAtMS, retryAtMS, nowMS-24*hour, nowMS-24*hour); err != nil {
			t.Fatalf("insert %s failed: %v", eventKey, err)
		}
	}
	insert := func(eventKey, authIndex string, quotaExceeded int, recoverAtMS any) {
		t.Helper()
		insertWithRetry(eventKey, authIndex, quotaExceeded, recoverAtMS, nil)
	}
	// Recovered long ago, well past the 6-hour lookback of BatchCorrelatedCooldowns.
	insert("old-1", "auth-old", 1, nowMS-20*hour)
	insert("old-2", "auth-old", 1, nowMS-7*hour)
	insert("cleared", "auth-cleared", 0, nowMS-7*hour)
	insert("future", "auth-future", 1, nowMS+hour)
	insert("mixed-past", "auth-mixed", 1, nowMS-7*hour)
	insert("mixed-future", "auth-mixed", 1, nowMS+hour)
	insert("no-recover", "auth-no-recover", 1, nil)
	insert("retry-recovered", "auth-retry", 1, nowMS-7*hour)
	insertWithRetry("retry-ahead", "auth-retry", 1, nil, nowMS+hour)

	expired, err := repo.BatchExpiredCooldowns(ctx, []string{"auth-old", "auth-cleared", "auth-future", "auth-mixed", "auth-no-recover", "auth-retry", " "}, nowMS)
	if err != nil {
		t.Fatal(err)
	}
	if len(expired) != 1 || expired["auth-old"] != nowMS-7*hour {
		t.Fatalf("expired = %v, want only auth-old with its latest recovery time %d", expired, nowMS-7*hour)
	}
}

func TestQuotaCapacityCycleEvidence(t *testing.T) {
	ctx := context.Background()
	repo := usageTestRepository(t)
	const hour = int64(3600 * 1000)
	resetAtMS := time.Now().UnixMilli() + hour
	cycleStart := resetAtMS - 5*hour
	key := "codex|five_hour|standard|"

	save := func(observedAtMS int64, percent int, reset int64) {
		t.Helper()
		if err := repo.SaveQuotaSnapshot(ctx, QuotaSnapshotRecord{
			AuthIndex: "auth-1", Provider: "codex", Status: "healthy",
			WindowsJSON:  fmt.Sprintf(`[{"id":"five_hour","scope":"standard","used_percent":%d,"reset_at_ms":%d,"period_hours":5,"reset_accuracy":"exact"}]`, percent, reset),
			ObservedAtMS: observedAtMS,
		}); err != nil {
			t.Fatal(err)
		}
	}
	insert := func(name string, atMS int64) {
		t.Helper()
		if _, err := repo.SQL().ExecContext(ctx,
			`INSERT INTO usage_events (instance_id, event_key, api_group_key, auth_index, model, timestamp_ms, created_at_ms, total_tokens, cost_nanos)
			 VALUES ('default', ?, 'group', 'auth-1', 'gpt-6.1-sol', ?, ?, 100, 1000)`, name, atMS, atMS); err != nil {
			t.Fatal(err)
		}
	}
	points := func() []quota.CalibrationPoint {
		t.Helper()
		cycles, err := repo.LoadCapacityCycles(ctx, "auth-1")
		if err != nil || len(cycles[key]) == 0 {
			t.Fatalf("cycles = %+v err %v", cycles, err)
		}
		return cycles[key][0].Points
	}

	insert("first", cycleStart+1000)
	save(cycleStart+hour, 20, resetAtMS)
	save(cycleStart+2*hour, 20, resetAtMS)
	// A record that reaches the store after its reading is caught by the next point.
	insert("late", cycleStart+hour-1000)
	insert("second", cycleStart+2*hour)
	save(cycleStart+3*hour, 40, resetAtMS)
	// Records retention removed since the last point are carried by the running sum.
	if _, err := repo.SQL().ExecContext(ctx, `DELETE FROM usage_events WHERE event_key IN ('first', 'late')`); err != nil {
		t.Fatal(err)
	}
	insert("third", cycleStart+3*hour)
	save(cycleStart+4*hour, 60, resetAtMS)
	got := points()
	if len(got) != 3 || got[0].Requests != 1 || got[1].Requests != 3 || got[2].Requests != 4 || got[2].Tokens != 400 {
		t.Fatalf("points = %+v, want 1, 3 and 4 recorded requests", got)
	}

	if len(got[1].IntervalModels) != 1 || got[1].IntervalModels[0].Model != "gpt-6.1-sol" || got[1].IntervalModels[0].Requests != 1 || got[2].IntervalModels[0].Requests != 1 {
		t.Fatalf("completed interval models were not frozen: %+v", got)
	}

	// Later cycles keep the evidence of the last three.
	for index := range 3 {
		next := resetAtMS + int64(index+1)*5*hour
		save(next-hour, 10, next)
	}
	cycles, err := repo.LoadCapacityCycles(ctx, "auth-1")
	if err != nil || len(cycles[key]) != 3 || cycles[key][0].CycleResetAtMS != resetAtMS+15*hour || cycles[key][2].CycleResetAtMS != resetAtMS+5*hour {
		t.Fatalf("cycle retention = %+v err %v", cycles, err)
	}
}

func TestQuotaCapacityLateUsageInvalidatesModelSample(t *testing.T) {
	ctx := context.Background()
	repo := usageTestRepository(t)
	const hour = int64(3600 * 1000)
	reset := time.Now().UnixMilli() + hour
	start := reset - 5*hour
	key := "codex|five_hour|standard|"
	window := quota.QuotaWindow{ID: "five_hour", Scope: "standard", ResetAtMS: &reset, PeriodHours: new(float64(5)), ResetAccuracy: "exact"}
	save := func(atMS int64, percent float64) {
		t.Helper()
		window.UsedPercent = &percent
		raw, err := json.Marshal([]quota.QuotaWindow{window})
		if err != nil {
			t.Fatal(err)
		}
		if err := repo.SaveQuotaSnapshot(ctx, QuotaSnapshotRecord{AuthIndex: "auth-late", Provider: "codex", Status: "healthy", WindowsJSON: string(raw), ObservedAtMS: atMS}); err != nil {
			t.Fatal(err)
		}
	}
	insert := func(prefix, model string, atMS int64) {
		t.Helper()
		for index := range 5 {
			if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO usage_events (instance_id, event_key, api_group_key, auth_index, model, timestamp_ms, created_at_ms, total_tokens)
				VALUES ('default', ?, 'group', 'auth-late', ?, ?, ?, 100)`, fmt.Sprintf("%s-%d", prefix, index), model, atMS+int64(index), atMS); err != nil {
				t.Fatal(err)
			}
		}
	}
	forecasts := func(atMS int64) []quota.ModelQuotaForecast {
		t.Helper()
		cycles, err := repo.LoadCapacityCycles(ctx, "auth-late")
		if err != nil {
			t.Fatal(err)
		}
		result, _ := quota.BuildModelForecasts(window, nil, atMS, cycles[key])
		return result
	}
	save(start+hour, 0)
	insert("observed", "gpt-6.1-sol", start+hour+1000)
	save(start+2*hour, 10)
	if got := forecasts(start + 2*hour); len(got) != 1 {
		t.Fatalf("initial model sample = %+v", got)
	}
	// Late traffic shows the earlier quota climb was shared by two models.
	insert("late", "gpt-6.1-terra", start+hour+2000)
	save(start+3*hour, 20)
	if got := forecasts(start + 3*hour); len(got) != 0 {
		t.Fatalf("late mixed-model traffic retained an incomplete sample: %+v", got)
	}
	insert("fresh", "gpt-6.1-sol", start+3*hour+1000)
	save(start+4*hour, 30)
	if got := forecasts(start + 4*hour); len(got) != 1 || got[0].SampleRequests != 5 || got[0].FromMS != start+3*hour {
		t.Fatalf("fresh interval did not establish a new sample: %+v", got)
	}
}

func TestQuotaCapacityCycleReplacesPlanMetadata(t *testing.T) {
	ctx := context.Background()
	repo := usageTestRepository(t)
	const hour = int64(3600 * 1000)
	reset := time.Now().UnixMilli() + hour
	start := reset - 5*hour
	for index, reading := range []struct {
		plan, tier string
		used       int
	}{{"free", "basic", 0}, {"pro", "elite", 0}, {"pro", "elite", 10}, {"pro", "elite", 20}} {
		if err := repo.SaveQuotaSnapshot(ctx, QuotaSnapshotRecord{
			AuthIndex: "auth-plan", Provider: "codex", Status: "healthy", PlanType: reading.plan, PlanTier: reading.tier,
			WindowsJSON:  fmt.Sprintf(`[{"id":"five_hour","scope":"standard","used_percent":%d,"reset_at_ms":%d,"period_hours":5,"reset_accuracy":"exact"}]`, reading.used, reset),
			ObservedAtMS: start + int64(index+1)*hour,
		}); err != nil {
			t.Fatal(err)
		}
	}
	cycles, err := repo.LoadCapacityCycles(ctx, "auth-plan")
	if err != nil {
		t.Fatal(err)
	}
	stored := cycles["codex|five_hour|standard|"]
	if len(stored) != 1 || stored[0].PlanType != "pro" || stored[0].PlanTier != "elite" || len(stored[0].Points) != 3 || stored[0].Points[2].UsedPercent != 20 {
		t.Fatalf("same-reset plan replacement lost metadata or points: %+v", stored)
	}
}

func TestQuotaCapacityLateUsageSurvivesFlatReadingsAndRetention(t *testing.T) {
	for _, scenario := range []struct {
		name         string
		isFlat       bool
		hasRetention bool
	}{{"flat", true, false}, {"retention", false, true}, {"flat with retention", true, true}} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := context.Background()
			repo := usageTestRepository(t)
			const hour = int64(3600 * 1000)
			reset := time.Now().UnixMilli() + hour
			start := reset - 5*hour
			window := quota.QuotaWindow{ID: "five_hour", Scope: "standard", ResetAtMS: &reset, PeriodHours: new(float64(5)), ResetAccuracy: "exact"}
			save := func(atMS int64, percent float64) {
				t.Helper()
				window.UsedPercent = &percent
				raw, err := json.Marshal([]quota.QuotaWindow{window})
				if err != nil {
					t.Fatal(err)
				}
				if err := repo.SaveQuotaSnapshot(ctx, QuotaSnapshotRecord{AuthIndex: "auth-late", Provider: "codex", Status: "healthy", WindowsJSON: string(raw), ObservedAtMS: atMS}); err != nil {
					t.Fatal(err)
				}
			}
			insert := func(prefix, model string, count int, atMS int64) {
				t.Helper()
				for index := range count {
					if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO usage_events (instance_id, event_key, api_group_key, auth_index, model, timestamp_ms, created_at_ms, total_tokens)
						VALUES ('default', ?, 'group', 'auth-late', ?, ?, ?, 100)`, fmt.Sprintf("%s-%d", prefix, index), model, atMS+int64(index), atMS); err != nil {
						t.Fatal(err)
					}
				}
			}
			save(start+hour, 0)
			insert("observed", "gpt-6.1-sol", 10, start+hour+1000)
			save(start+2*hour, 10)
			if scenario.hasRetention {
				if _, err := repo.SQL().ExecContext(ctx, `DELETE FROM usage_events WHERE event_key IN ('observed-0','observed-1','observed-2','observed-3','observed-4')`); err != nil {
					t.Fatal(err)
				}
				insert("current", "gpt-6.1-sol", 5, start+2*hour+1000)
			}
			insert("late", "gpt-6.1-terra", 5, start+hour+2000)
			used := 13.0
			if scenario.isFlat {
				used = 10
			}
			save(start+3*hour, used)
			cycles, err := repo.LoadCapacityCycles(ctx, "auth-late")
			if err != nil {
				t.Fatal(err)
			}
			stored := cycles["codex|five_hour|standard|"]
			if got, _ := quota.BuildModelForecasts(window, nil, start+3*hour, stored); len(got) != 0 {
				t.Fatalf("incomplete attribution survived %s: %+v", scenario.name, got)
			}
			if scenario.isFlat && len(stored[0].Points) != 2 {
				t.Fatalf("flat reading added evidence: %+v", stored[0].Points)
			}
			if !scenario.isFlat {
				insert("clean", "gpt-6.1-sol", 5, start+3*hour+1000)
				save(start+4*hour, 16)
				cycles, err = repo.LoadCapacityCycles(ctx, "auth-late")
				if err != nil {
					t.Fatal(err)
				}
				window.UsedPercent = new(float64(16))
				if got, reason := quota.BuildModelForecasts(window, nil, start+4*hour, cycles["codex|five_hour|standard|"]); reason != "" || len(got) != 1 || got[0].SampleRequests != 10 || got[0].SampleUsedPercent != 6 {
					t.Fatalf("post-gap clean intervals = %+v, %q", got, reason)
				}
			}
		})
	}
}
