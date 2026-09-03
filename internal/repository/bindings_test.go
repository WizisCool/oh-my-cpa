package repository

import (
	"context"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func TestCPABindingsSyncAndHistoricalUsagePreservation(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC()

	// 1. Discover resource A and B
	resList, err := repo.UpsertDiscoveredResources(ctx, "default", []domain.DiscoveredResource{
		{
			ResourceKey:     "auth-index:codex-api-key:idx-alpha",
			CPAResourceType: "codex-api-key",
			CPAAuthIndex:    "idx-alpha",
			CPADriver:       "codex",
			ProtocolDriver:  "openai_responses",
			ProtocolDisplay: "OpenAI Responses",
			Status:          domain.ResourceStatusClaimed,
		},
		{
			ResourceKey:     "auth-index:codex-api-key:idx-beta",
			CPAResourceType: "codex-api-key",
			CPAAuthIndex:    "idx-beta",
			CPADriver:       "codex",
			ProtocolDriver:  "openai_responses",
			ProtocolDisplay: "OpenAI Responses",
			Status:          domain.ResourceStatusUnclaimed,
		},
	}, now, true)
	if err != nil {
		t.Fatal(err)
	}

	// 2. Verify cpa_bindings are created and synced
	bindings, err := repo.ListCPABindings(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if len(bindings) != 2 {
		t.Fatalf("expected 2 cpa_bindings, got %d", len(bindings))
	}
	for _, b := range bindings {
		if b.Status != "active" || b.MissingAtMS != nil {
			t.Fatalf("expected active binding without missing timestamp: %#v", b)
		}
	}

	// 3. Insert usage events for idx-alpha
	eventID, err := repo.InsertUsageEvents(ctx, []usage.Event{{
		InstanceID:  "default",
		EventKey:    "req-binding-hist",
		AuthIndex:   "idx-alpha",
		TimestampMS: now.UnixMilli(),
		Model:       "claude-3-5-sonnet",
	}})
	if err != nil {
		t.Fatal(err)
	}

	// Read event: should be bound to resource A
	row, err := repo.GetUsageEvent(ctx, eventID)
	if err != nil {
		t.Fatal(err)
	}
	if row.ResourceID == nil || *row.ResourceID != resList[0].ID {
		t.Fatalf("usage event expected resource ID %s, got %v", resList[0].ID, row.ResourceID)
	}

	// 4. Resource A is removed in next discovery sweep (marked missing!)
	later := now.Add(10 * time.Minute)
	_, err = repo.UpsertDiscoveredResources(ctx, "default", []domain.DiscoveredResource{
		{
			ResourceKey:     "auth-index:codex-api-key:idx-beta",
			CPAResourceType: "codex-api-key",
			CPAAuthIndex:    "idx-beta",
			CPADriver:       "codex",
			ProtocolDriver:  "openai_responses",
			ProtocolDisplay: "OpenAI Responses",
			Status:          domain.ResourceStatusUnclaimed,
		},
	}, later, true) // markMissing = true
	if err != nil {
		t.Fatal(err)
	}

	// Verify cpa_bindings for idx-alpha is now marked missing
	bindingsAfterMissing, err := repo.ListCPABindings(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	var alphaBinding *CPABinding
	for i := range bindingsAfterMissing {
		if bindingsAfterMissing[i].CPAAuthIndex == "idx-alpha" {
			alphaBinding = &bindingsAfterMissing[i]
			break
		}
	}
	if alphaBinding == nil || alphaBinding.Status != "missing" || alphaBinding.MissingAtMS == nil {
		t.Fatalf("expected idx-alpha binding to be marked missing, got %#v", alphaBinding)
	}

	// 5. Historical usage for idx-alpha remains completely readable!
	rowAfterMissing, err := repo.GetUsageEvent(ctx, eventID)
	if err != nil {
		t.Fatalf("historical usage event must remain readable: %v", err)
	}
	if rowAfterMissing.EventKey != "req-binding-hist" {
		t.Fatalf("unexpected event key: %s", rowAfterMissing.EventKey)
	}
}
