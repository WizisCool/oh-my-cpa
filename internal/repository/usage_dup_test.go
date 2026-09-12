package repository

import (
	"context"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func TestAmbiguousAuthIndexDoesNotDuplicateEvents(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC()

	// Insert TWO discovered resources with the SAME cpa_auth_index: "dup-auth-idx"
	if _, err := repo.UpsertDiscoveredResources(ctx, "default", []domain.DiscoveredResource{
		{
			ResourceKey:     "res-family-1",
			CPAResourceType: "auth-file",
			CPAAuthIndex:    "dup-auth-idx",
			CPADriver:       "codex",
			ProtocolDriver:  "openai_responses",
			ProtocolDisplay: "OpenAI Responses",
			Status:          domain.ResourceStatusClaimed,
		},
		{
			ResourceKey:     "res-family-2",
			CPAResourceType: "codex-api-key",
			CPAAuthIndex:    "dup-auth-idx",
			CPADriver:       "codex",
			ProtocolDriver:  "openai_responses",
			ProtocolDisplay: "OpenAI Responses",
			Status:          domain.ResourceStatusUnclaimed,
		},
	}, now, true); err != nil {
		t.Fatal(err)
	}

	// Insert 1 usage event with that auth_index
	eventID, err := repo.InsertUsageEvents(ctx, []usage.Event{{
		InstanceID:  "default",
		EventKey:    "event-unique-1",
		AuthIndex:   "dup-auth-idx",
		TimestampMS: now.UnixMilli(),
		Model:       "gpt-4",
	}})
	if err != nil {
		t.Fatal(err)
	}

	// 1. ListUsageEvents must return exactly 1 item (no fanout duplication!)
	page, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID:  "default",
		AuthIndexes: []string{"dup-auth-idx"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("expected exactly 1 item from ListUsageEvents, got %d (non-unique join duplicated row)", len(page.Items))
	}
	if page.Items[0].ResourceID != nil {
		t.Fatalf("ambiguous auth_index should remain unbound (nil), got %v", *page.Items[0].ResourceID)
	}

	// 2. GetUsageEvent must return the single event with unbound resource
	row, err := repo.GetUsageEvent(ctx, eventID)
	if err != nil {
		t.Fatal(err)
	}
	if row.ResourceID != nil {
		t.Fatalf("ambiguous auth_index in GetUsageEvent should remain unbound (nil), got %v", *row.ResourceID)
	}
}
