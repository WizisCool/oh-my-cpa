package repository

import (
	"context"
	"fmt"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
	"testing"
	"time"
)

func TestAgentAggregateBoundedGroupsPreserveTotals(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	anchor := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	events := []usage.Event{}
	for index := 0; index < 60; index++ {
		event := usageEventAt("default", fmt.Sprintf("group-%d", index), anchor.Add(time.Duration(index)*time.Second), usage.TokenStats{TotalTokens: 10, InputTokens: 7, OutputTokens: 3}, index%2 == 0)
		event.Provider = fmt.Sprintf("provider-%d", index)
		events = append(events, event)
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	result, err := repo.AggregateUsage(ctx, UsageEventFilter{InstanceID: "default", FromMS: anchor.UnixMilli(), ToMS: anchor.Add(time.Minute).UnixMilli() - 1}, "provider", 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.Total.Requests != 60 || result.Total.Failures != 30 || result.Total.Tokens != 600 || len(result.Groups) != 50 || !result.HasMore || result.Other == nil || result.Other.Requests != 10 {
		t.Fatalf("aggregate: %+v", result)
	}
	filtered, err := repo.AggregateUsage(ctx, UsageEventFilter{InstanceID: "default", FromMS: anchor.UnixMilli(), ToMS: anchor.Add(time.Minute).UnixMilli() - 1, Result: ResultFailed}, "all", 0)
	if err != nil || filtered.Total.Requests != 30 {
		t.Fatalf("filtered: %+v %v", filtered, err)
	}
	if _, err = repo.AggregateUsage(ctx, UsageEventFilter{}, "model; DROP TABLE usage_events", 0); err == nil {
		t.Fatal("SQL identifier accepted")
	}
}
