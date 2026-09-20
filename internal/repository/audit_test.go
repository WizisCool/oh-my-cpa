package repository

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

func TestAuditEventAppendOnlyAndSanitization(t *testing.T) {
	repo, _ := testRepository(t)
	ctx := context.Background()

	// 1. Record an audit event with sensitive data in target_id and details
	id, err := repo.RecordAuditEvent(ctx, AuditEvent{
		Action:        "auth_file.delete",
		TargetType:    "auth_file",
		TargetID:      "auth-file.json?token=" + "sensitive-val-123456",
		Result:        "success",
		RequestID:     "req-audit-1",
		SourceSummary: "ip=10.20.30.0/24 ua=browser/1.0",
		Details: map[string]any{
			"api" + "_key": "mock-" + "secret-token-value",
			"count":        1,
		},
	})
	if err != nil {
		t.Fatalf("RecordAuditEvent failed: %v", err)
	}
	if id <= 0 {
		t.Fatalf("expected positive audit id, got %d", id)
	}

	// 2. Record a second event
	time.Sleep(2 * time.Millisecond)
	id2, err := repo.RecordAuditEvent(ctx, AuditEvent{
		Action:        "logs.clear",
		TargetType:    "logs",
		TargetID:      "management_logs",
		Result:        "success",
		RequestID:     "req-audit-2",
		SourceSummary: "ip=127.0.0.1/24",
	})
	if err != nil {
		t.Fatal(err)
	}
	if id2 <= id {
		t.Fatalf("expected id2 > id (%d > %d)", id2, id)
	}

	// 3. Query audit events
	events, err := repo.ListAuditEvents(ctx, 10)
	if err != nil {
		t.Fatalf("ListAuditEvents failed: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 audit events, got %d", len(events))
	}
	// Ordered descending: newest first
	if events[0].ID != id2 || events[1].ID != id {
		t.Fatalf("unexpected order: ids = [%d, %d]", events[0].ID, events[1].ID)
	}

	first := events[1]
	// Verify target_id was sanitized and contains no secret
	if strings.Contains(first.TargetID, "sensitive-val-123456") {
		t.Fatalf("target_id contains unredacted secret: %q", first.TargetID)
	}
	if !strings.Contains(first.TargetID, security.RedactedValue) {
		t.Fatalf("target_id missing redacted marker: %q", first.TargetID)
	}

	// Verify details_json was sanitized and contains no secret
	if detailsKey, ok := first.Details["api_key"].(string); !ok || detailsKey != security.RedactedValue {
		t.Fatalf("details api_key = %v, want %q", first.Details["api_key"], security.RedactedValue)
	}

	// 4. Verify failure when action or target_type is missing
	if _, err := repo.RecordAuditEvent(ctx, AuditEvent{TargetType: "test"}); err == nil {
		t.Fatal("expected error on empty action, got nil")
	}
	if _, err := repo.RecordAuditEvent(ctx, AuditEvent{Action: "test"}); err == nil {
		t.Fatal("expected error on empty target_type, got nil")
	}
}

func TestListAuditEventsReturnsEmptySlice(t *testing.T) {
	repo, _ := testRepository(t)
	events, err := repo.ListAuditEvents(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if events == nil || len(events) != 0 {
		t.Fatalf("empty audit history = %#v, want non-nil empty slice", events)
	}
}
