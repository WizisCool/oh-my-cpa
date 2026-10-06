package repository

import (
	"context"
	"strings"
	"testing"
)

// A table with no declared lifetime grows until someone notices the disk. The
// declaration is forced at the moment the table is added, when its author still
// knows the answer.
func TestEveryTableDeclaresItsLifecycle(t *testing.T) {
	repo := usageTestRepository(t)
	rows, err := repo.SQL().Query(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	existing := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		existing[name] = true
		if _, declared := TABLE_LIFECYCLES[name]; !declared {
			t.Errorf("table %s has no entry in TABLE_LIFECYCLES: decide how long its rows live", name)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for name, lifecycle := range TABLE_LIFECYCLES {
		if !existing[name] {
			t.Errorf("TABLE_LIFECYCLES declares %s, which is not a table", name)
		}
		if strings.TrimSpace(lifecycle.Reason) == "" {
			t.Errorf("%s declares no reason for its lifecycle", name)
		}
		if isRolling := lifecycle.Kind == LifecycleRolling; isRolling != (len(lifecycle.Rules) > 0) {
			t.Errorf("%s is %s with %d rules: only a rolling table deletes, and it must say what", name, lifecycle.Kind, len(lifecycle.Rules))
		}
		for _, rule := range lifecycle.Rules {
			if strings.Count(rule.Expired, "?") != 1 || rule.Policy == "" {
				t.Errorf("%s rule %q must name a policy and take exactly the horizon", name, rule.Expired)
			}
			// Every rule must be executable against the real schema, so a renamed
			// column fails here instead of in the hourly pass.
			if !existing[name] {
				continue
			}
			if _, err := repo.SQL().Exec(`DELETE FROM `+name+` WHERE rowid IN (SELECT rowid FROM `+name+` WHERE `+rule.Expired+` LIMIT 0)`, 1); err != nil {
				t.Errorf("%s rule %q does not run: %v", name, rule.Expired, err)
			}
		}
	}
}

func TestLifecyclePassIsBoundedAndResumes(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	const total = 2*lifecycleBatchRows + 500
	if _, err := repo.SQL().Exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < ?)
		INSERT INTO usage_events (instance_id, event_key, api_group_key, timestamp_ms, created_at_ms)
		SELECT 'default', 'event-'||n, 'group', 1000 + n, 0 FROM seq`, total); err != nil {
		t.Fatal(err)
	}
	for {
		folded, err := repo.AggregateUsageFacts(ctx, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if folded == 0 {
			break
		}
	}
	cutoffs := map[string]int64{LifecycleUsageDetail: DayBucketMS}

	// The pass that publishes a horizon deletes nothing: a read planned against
	// the previous horizon must still find its rows.
	report, err := repo.RunLifecycle(ctx, cutoffs, 1)
	if err != nil || report.Total() != 0 || !report.IsComplete {
		t.Fatalf("publishing pass = %+v: %v", report, err)
	}
	report, err = repo.RunLifecycle(ctx, cutoffs, 1)
	if err != nil || report.Deleted["usage_events"] != lifecycleBatchRows || report.IsComplete {
		t.Fatalf("a one-batch pass must delete one batch and report unfinished work, got %+v: %v", report, err)
	}
	report, err = repo.RunLifecycle(ctx, cutoffs, 10)
	if err != nil || report.Deleted["usage_events"] != lifecycleBatchRows+500 || !report.IsComplete {
		t.Fatalf("the next pass must finish the backlog, got %+v: %v", report, err)
	}

	states, err := repo.ListLifecycleStates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var detail LifecycleState
	for _, state := range states {
		if state.Policy == LifecycleUsageDetail {
			detail = state
		}
	}
	if detail.HorizonMS != DayBucketMS || detail.DeletedRows != total || detail.LastRunAtMS == nil {
		t.Fatalf("lifecycle state = %+v, want horizon %d and %d deleted rows", detail, DayBucketMS, total)
	}

	// Lengthening retention cannot bring deleted rows back, so the horizon stays.
	if _, err := repo.RunLifecycle(ctx, map[string]int64{LifecycleUsageDetail: 5}, 1); err != nil {
		t.Fatal(err)
	}
	if horizon, _ := repo.LifecycleHorizonMS(ctx, LifecycleUsageDetail); horizon != DayBucketMS {
		t.Fatalf("horizon moved back to %d", horizon)
	}
}

func TestDecodedPayloadsRollOnTheirOwnPolicy(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	insert := func(status string, poppedAt, processedAt any) {
		t.Helper()
		if _, err := repo.SQL().Exec(`INSERT INTO usage_inboxes (instance_id, source_mode, message_hash, raw_message, status, popped_at, processed_at)
			VALUES ('default', 'subscribe', 'hash', '{}', ?, ?, ?)`, status, poppedAt, processedAt); err != nil {
			t.Fatal(err)
		}
	}
	insert(InboxProcessed, 100, 100)  // decoded long ago: goes
	insert(InboxProcessed, 100, 9000) // decoded recently: stays
	insert(InboxPending, 100, nil)    // not decoded: the only copy of a record, stays whatever its age
	insert(InboxDiscarded, 100, nil)  // undecodable: follows request records, not the short policy

	for pass := 0; pass < 2; pass++ {
		if _, err := repo.RunLifecycle(ctx, map[string]int64{LifecycleUsageInbox: 5000}, 10); err != nil {
			t.Fatal(err)
		}
	}
	var processed, pending, discarded int
	if err := repo.SQL().QueryRow(`SELECT SUM(status = 'processed'), SUM(status = 'pending'), SUM(status = 'discarded') FROM usage_inboxes`).
		Scan(&processed, &pending, &discarded); err != nil {
		t.Fatal(err)
	}
	if processed != 1 || pending != 1 || discarded != 1 {
		t.Fatalf("after the payload policy ran: processed %d, pending %d, discarded %d; want 1, 1, 1", processed, pending, discarded)
	}
}
