package repository

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestIngestGapsRecordingAndRetention(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()

	now := time.Now().UTC()
	oldTime := now.Add(-48 * time.Hour).UnixMilli()

	// Record an old gap
	gapID1, err := repo.RecordIngestGap(ctx, IngestGap{
		InstanceID:     "default",
		SourceMode:     "http_pull",
		StartedAtMS:    oldTime,
		EndedAtMS:      oldTime + 1000,
		EstimatedCount: 5,
		ReasonCode:     "append_failure",
		Summary:        "database locked",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Record a fresh gap
	gapID2, err := repo.RecordIngestGap(ctx, IngestGap{
		InstanceID:     "default",
		SourceMode:     "subscribe",
		StartedAtMS:    now.UnixMilli(),
		EndedAtMS:      now.UnixMilli() + 500,
		EstimatedCount: 2,
		ReasonCode:     "append_failure",
		Summary:        "disk full",
	})
	if err != nil {
		t.Fatal(err)
	}

	// List gaps
	gaps, err := repo.ListIngestGaps(ctx, "default", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(gaps) != 2 {
		t.Fatalf("expected 2 gaps, got %d", len(gaps))
	}
	if gaps[0].ID != gapID2 || gaps[1].ID != gapID1 {
		t.Fatalf("unexpected gap ordering: [%d, %d]", gaps[0].ID, gaps[1].ID)
	}

	// Acknowledge gap 1
	if err := repo.AcknowledgeIngestGap(ctx, gapID1); err != nil {
		t.Fatal(err)
	}
	if err := repo.AcknowledgeIngestGap(ctx, 999999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown gap acknowledgement error = %v, want ErrNotFound", err)
	}
	if err := repo.AcknowledgeIngestGap(ctx, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("zero gap acknowledgement error = %v, want ErrNotFound", err)
	}
	gapsAfterAck, _ := repo.ListIngestGaps(ctx, "default", 10)
	if gapsAfterAck[1].AcknowledgedAtMS == nil {
		t.Fatal("expected gap1 to have acknowledged timestamp")
	}

	// Insert discarded inbox row to test discarded retention pruning
	poppedOld := time.UnixMilli(oldTime)
	if _, err := repo.AppendUsageInbox(ctx, "default", "subscribe", []string{`{"bad":1}`}, poppedOld); err != nil {
		t.Fatal(err)
	}
	// Mark it discarded
	batch, _ := repo.ClaimUsageInboxBatch(ctx, 1)
	if len(batch) > 0 {
		for i := 0; i < maxInboxAttempts; i++ {
			_ = repo.MarkUsageInboxFailure(ctx, batch[0].ID, "poison")
		}
	}

	// Run retention purge older than 24 hours ago
	cutoff := now.Add(-24 * time.Hour).UnixMilli()
	if _, err := repo.PurgeUsageOlderThan(ctx, cutoff); err != nil {
		t.Fatalf("PurgeUsageOlderThan failed: %v", err)
	}

	// Gaps older than cutoff should be purged!
	gapsAfterPurge, _ := repo.ListIngestGaps(ctx, "default", 10)
	if len(gapsAfterPurge) != 1 || gapsAfterPurge[0].ID != gapID2 {
		t.Fatalf("expected only gap2 to remain after retention purge, got %#v", gapsAfterPurge)
	}

	// Discarded rows older than cutoff should be purged!
	var discardedCount int
	if err := repo.SQL().QueryRowContext(ctx, `SELECT COUNT(1) FROM usage_inboxes WHERE status = ?`, InboxDiscarded).Scan(&discardedCount); err != nil {
		t.Fatal(err)
	}
	if discardedCount != 0 {
		t.Fatalf("expected old discarded inboxes to be purged, got %d", discardedCount)
	}
}
