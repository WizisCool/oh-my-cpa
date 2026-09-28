package repository

import (
	"context"
	"fmt"
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

func TestQueryAuditEventsFiltersFoldsAndPages(t *testing.T) {
	repo, _ := testRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC).UnixMilli()
	rows := []AuditEvent{
		{Action: "auth.login", TargetType: "auth", TargetID: "operator", Result: "success", RequestID: "r1"},
		{Action: "provider.update", TargetType: "provider", TargetID: "anthropic", Result: "attempt", RequestID: "r2"},
		{Action: "provider.update", TargetType: "provider", TargetID: "anthropic", Result: "success", RequestID: "r2"},
		{Action: "provider.delete", TargetType: "provider", TargetID: "gemini", Result: "attempt", RequestID: "r3"},
		{Action: "api_key.create", TargetType: "client_api_key", TargetID: "list", Result: "failure", RequestID: "r4"},
		// `apixkey` must not match the `api_key` category: `_` is literal.
		{Action: "apixkey.create", TargetType: "other", TargetID: "x", Result: "success", RequestID: "r5"},
		// A pre-fix pair: the attempt and its outcome carry different request ids.
		{Action: "quota.clear_cooldown", TargetType: "quota", TargetID: "q1", Result: "attempt", RequestID: "r6a"},
		{Action: "quota.clear_cooldown", TargetType: "quota", TargetID: "q1", Result: "success", RequestID: "r6b"},
	}
	for i, row := range rows {
		row.OccurredAtMS = base + int64(i)*1000
		if _, err := repo.RecordAuditEvent(ctx, row); err != nil {
			t.Fatalf("record %d: %v", i, err)
		}
	}

	actions := func(query AuditQuery) []string {
		t.Helper()
		page, err := repo.QueryAuditEvents(ctx, query)
		if err != nil {
			t.Fatalf("query %#v: %v", query, err)
		}
		out := make([]string, 0, len(page.Events))
		for _, event := range page.Events {
			out = append(out, event.Action+":"+event.Result)
		}
		return out
	}
	expect := func(name string, got []string, want ...string) {
		t.Helper()
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("%s = %v, want %v", name, got, want)
		}
	}

	expect("folded", actions(AuditQuery{FoldAttempts: true}),
		"quota.clear_cooldown:success", "apixkey.create:success", "api_key.create:failure", "provider.delete:attempt", "provider.update:success", "auth.login:success")
	expect("category", actions(AuditQuery{Categories: []string{"api_key", "auth"}}),
		"api_key.create:failure", "auth.login:success")
	expect("failed", actions(AuditQuery{Outcome: AuditOutcomeFailed}), "api_key.create:failure")
	expect("search", actions(AuditQuery{Search: "GEMINI"}), "provider.delete:attempt")
	expect("unfinished", actions(AuditQuery{FoldAttempts: true, Outcome: AuditOutcomeUnfinished}), "provider.delete:attempt")

	// The summary counts what the folded timeline shows, whatever category, outcome or
	// cursor the query carries, and classes each result the way the outcome filter does.
	buckets, err := repo.SummarizeAuditEvents(ctx, AuditQuery{
		FoldAttempts: true, Categories: []string{"auth"}, Outcome: AuditOutcomeFailed, Before: AuditCursor{OccurredAtMS: base, ID: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	summary := make([]string, 0, len(buckets))
	for _, bucket := range buckets {
		summary = append(summary, fmt.Sprintf("%s/%s=%d", bucket.Prefix, bucket.Outcome, bucket.Count))
	}
	expect("summary", summary,
		"api_key/failed=1", "apixkey/succeeded=1", "auth/succeeded=1", "provider/succeeded=1", "provider/unfinished=1", "quota/succeeded=1")
	windowed, err := repo.SummarizeAuditEvents(ctx, AuditQuery{FoldAttempts: true, SinceMS: base + 4000, Search: "create"})
	if err != nil {
		t.Fatal(err)
	}
	if len(windowed) != 2 || windowed[0].Prefix != "api_key" || windowed[1].Prefix != "apixkey" {
		t.Fatalf("windowed summary = %#v, want api_key and apixkey only", windowed)
	}

	first, err := repo.QueryAuditEvents(ctx, AuditQuery{Limit: 4, Categories: []string{"auth", "provider", "api_key", "apixkey"}})
	if err != nil || len(first.Events) != 4 || first.Next == nil {
		t.Fatalf("first page = %#v, %v; want four rows and a cursor", first, err)
	}
	second, err := repo.QueryAuditEvents(ctx, AuditQuery{Limit: 4, Before: *first.Next, Categories: []string{"auth", "provider", "api_key", "apixkey"}})
	if err != nil || len(second.Events) != 2 || second.Next != nil {
		t.Fatalf("second page = %#v, %v; want the last two rows and no cursor", second, err)
	}
	if second.Events[0].Action != "provider.update" || second.Events[1].Action != "auth.login" {
		t.Fatalf("second page continues at %s, want provider.update then auth.login", second.Events[0].Action)
	}

	// After the upgrade the window no longer pairs rows: an attempt whose request
	// recorded no outcome stays visible even when the same target succeeded again.
	later := time.Now().Add(time.Hour).UnixMilli()
	for i, row := range []AuditEvent{
		{Action: "provider.toggle_status", TargetType: "provider", TargetID: "p1", Result: "attempt", RequestID: "r7"},
		{Action: "provider.toggle_status", TargetType: "provider", TargetID: "p1", Result: "success", RequestID: "r8"},
	} {
		row.OccurredAtMS = later + int64(i)*1000
		if _, err := repo.RecordAuditEvent(ctx, row); err != nil {
			t.Fatalf("record later %d: %v", i, err)
		}
	}
	expect("after the upgrade", actions(AuditQuery{FoldAttempts: true, Categories: []string{"provider"}}),
		"provider.toggle_status:success", "provider.toggle_status:attempt", "provider.delete:attempt", "provider.update:success")
}
