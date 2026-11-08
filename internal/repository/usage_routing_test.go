package repository

import (
	"context"
	"strings"
	"testing"
	"time"
)

// The routing read runs on every live signal, so it must stay bounded by the
// window: a plan that walks the (instance, id) index filters every retained
// record whenever the minute holds fewer attempts than the limit.
func TestUsageRoutingReadSeeksTheTimeWindow(t *testing.T) {
	repo, _ := testRepository(t)
	rows, err := repo.SQL().QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+usageRoutingRecordsQuery,
		"default", 0, int64(1), int64(2), MAX_ROUTING_RECORDS+1)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(plan, "\n")
	if !strings.Contains(joined, "SEARCH e USING INDEX idx_usage_events_instance_time (instance_id=? AND timestamp_ms>?)") {
		t.Fatalf("the routing read does not seek the time window:\n%s", joined)
	}
}

// A later aggregated row says one model is resting, not that the credential is,
// so it must not hide the credential cooldown recorded before it.
func TestRoutingCooldownOutlivesANewerAggregateRow(t *testing.T) {
	ctx := context.Background()
	repo, _ := testRepository(t)
	if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO cpa_instances (id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at) VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	nowMS := time.Now().UnixMilli()
	insert := func(key string, aggregate int, recoverAtMS, timestampMS int64) {
		t.Helper()
		if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO error_events (instance_id,event_key,provider,model,auth_index,status_code,quota_exceeded,next_recover_at_ms,auth_quota_aggregate,timestamp_ms,created_at_ms) VALUES ('default',?,'codex','gpt-5','auth-routing',429,1,?,?,?,?)`, key, recoverAtMS, aggregate, timestampMS, timestampMS); err != nil {
			t.Fatal(err)
		}
	}
	insert("credential-cooldown", 0, nowMS+time.Hour.Milliseconds(), nowMS-2*time.Minute.Milliseconds())
	insert("later-model-aggregate", 1, nowMS+2*time.Hour.Milliseconds(), nowMS-time.Minute.Milliseconds())
	cooldowns, err := repo.activeRoutingCooldowns(ctx, "default", nowMS)
	if err != nil {
		t.Fatal(err)
	}
	if len(cooldowns) != 1 || cooldowns[0].AuthIndex != "auth-routing" || cooldowns[0].UntilMS != nowMS+time.Hour.Milliseconds() {
		t.Fatalf("cooldowns = %+v, want the credential cooldown the aggregate row must not hide", cooldowns)
	}
}
