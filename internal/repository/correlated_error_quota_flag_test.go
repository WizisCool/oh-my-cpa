package repository

import (
	"context"
	"testing"
	"time"
)

func TestCorrelatedErrorQuotaFlag(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	instant := time.Now().UTC().UnixMilli()
	if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO error_events(instance_id,event_key,provider,model,auth_index,status_code,body,retryable,auth_disabled,auth_unavailable,quota_exceeded,timestamp_ms,created_at_ms) VALUES ('default','fixture-quota-event','codex','fixture-model','fixture-index',429,'rate limit',1,1,1,1,?,?)`, instant, instant); err != nil {
		t.Fatal(err)
	}
	records, err := repo.CorrelatedErrorEvents(ctx, "fixture-index", instant, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("expected1 correlated record got%d", len(records))
	}
	record := records[0]
	t.Logf("stored_quota_exceeded=true projected_quota_exceeded=%v retryable=%v disabled=%v unavailable=%v", record.QuotaExceeded, record.Retryable, record.AuthDisabled, record.AuthUnavailable)
	if !record.QuotaExceeded {
		t.Error("correlated error projection erases quota flag")
	}
}
