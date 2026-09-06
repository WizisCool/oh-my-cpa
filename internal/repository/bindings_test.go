package repository

import (
	"context"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// A rename keeps the resource identity (id) stable while the displayed name
// follows the current metadata: usage rows bind to the resource, not to the
// string that happened to be its name when the request happened.
func TestCPARenameKeepsBindingAndFollowsCurrentName(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC()

	resList, err := repo.UpsertDiscoveredResources(ctx, "default", []domain.DiscoveredResource{
		{
			ResourceKey:     "auth-index:codex-api-key:idx-rename",
			CPAResourceType: "codex-api-key",
			CPAAuthIndex:    "idx-rename",
			CPAResourceName: "original-name.json",
			CPADriver:       "codex",
		},
	}, now, false)
	if err != nil {
		t.Fatal(err)
	}
	resourceID := resList[0].ID

	eventID, err := repo.InsertUsageEvents(ctx, []usage.Event{{
		InstanceID:  "default",
		EventKey:    "req-rename",
		AuthIndex:   "idx-rename",
		TimestampMS: now.UnixMilli(),
		Model:       "gpt-5",
	}})
	if err != nil {
		t.Fatal(err)
	}
	row, err := repo.GetUsageEvent(ctx, eventID)
	if err != nil {
		t.Fatal(err)
	}
	if row.ResourceID == nil || *row.ResourceID != resourceID || row.ResourceName == nil || *row.ResourceName != "original-name.json" {
		t.Fatalf("initial binding wrong: id=%v name=%v", row.ResourceID, row.ResourceName)
	}

	// The next discovery sweep renames the resource in place.
	later := now.Add(5 * time.Minute)
	if _, err = repo.UpsertDiscoveredResources(ctx, "default", []domain.DiscoveredResource{
		{
			ResourceKey:     "auth-index:codex-api-key:idx-rename",
			CPAResourceType: "codex-api-key",
			CPAAuthIndex:    "idx-rename",
			CPAResourceName: "renamed-team.json",
			CPADriver:       "codex",
		},
	}, later, true);	err != nil {
		t.Fatal(err)
	}

	rowAfter, err := repo.GetUsageEvent(ctx, eventID)
	if err != nil {
		t.Fatal(err)
	}
	if rowAfter.ResourceID == nil || *rowAfter.ResourceID != resourceID {
		t.Fatalf("rename must keep the resource identity: %v", rowAfter.ResourceID)
	}
	if rowAfter.ResourceName == nil || *rowAfter.ResourceName != "renamed-team.json" {
		t.Fatalf("displayed name must follow current metadata, got %v", rowAfter.ResourceName)
	}

	// Listing follows the same join, so stream and detail cannot disagree.
	page, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID: "default",
		FromMS:     now.Add(-time.Minute).UnixMilli(),
		ToMS:       now.Add(time.Minute).UnixMilli(),
	})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("listing after rename failed: %v %#v", err, page.Items)
	}
	if page.Items[0].ResourceName == nil || *page.Items[0].ResourceName != "renamed-team.json" {
		t.Fatalf("list binding disagrees with detail: %v", page.Items[0].ResourceName)
	}
}

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
