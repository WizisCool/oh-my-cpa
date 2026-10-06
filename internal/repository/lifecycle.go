package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"time"
)

// LifecycleKind says how long a table's rows live.
type LifecycleKind string

const (
	// LifecyclePermanent rows are never deleted by age. They are history other
	// rows are explained by, or they grow with configuration rather than traffic.
	LifecyclePermanent LifecycleKind = "permanent"
	// LifecycleRolling rows are deleted by RunLifecycle once they pass their
	// policy's horizon.
	LifecycleRolling LifecycleKind = "rolling"
	// LifecycleOwnerBounded rows are kept bounded by the code that writes them, in
	// the same transaction as the write, because their bound is a count or an
	// invariant of that write rather than an age.
	LifecycleOwnerBounded LifecycleKind = "owner_bounded"
	// LifecycleReplaced rows are current state: rewritten in place or replaced
	// whole, so the table does not grow with time.
	LifecycleReplaced LifecycleKind = "replaced"
)

// Rolling policy names. A policy is the retention setting a rule follows; several
// tables can follow one policy and are then deleted to the same horizon.
const (
	// LifecycleUsageInbox rolls captured payloads once they have been decoded.
	LifecycleUsageInbox = "usage_inbox"
)

// LifecycleRule deletes one kind of row from a rolling table.
type LifecycleRule struct {
	// Policy names the horizon the rule deletes to.
	Policy string
	// Expired is a SQL predicate over the table with one `?` for the horizon in
	// epoch milliseconds. A row is deleted when it holds.
	Expired string
	// IsGatedByUsageFacts keeps a request record until the usage facts have
	// absorbed it. The facts are the only thing left once the record is gone, so
	// deleting first would lose its usage for good.
	IsGatedByUsageFacts bool
}

// TableLifecycle is one table's declared lifetime.
type TableLifecycle struct {
	Kind LifecycleKind
	// Reason records why, for whoever adds the next table or questions this one.
	Reason string
	// Rules are the deletions RunLifecycle performs; only a rolling table has any.
	Rules []LifecycleRule
}

// TABLE_LIFECYCLES declares how long the rows of every table live.
//
// Tables are opt-in the same way QUERY_READABLE_TABLES is: a table a migration
// adds has no lifetime until it is declared here, and
// TestEveryTableDeclaresItsLifecycle fails until that decision is made. A feature
// whose rows should roll declares a rule and is deleted by the same batched,
// horizon-publishing engine as everything else; it does not write its own loop.
var TABLE_LIFECYCLES = map[string]TableLifecycle{
	"usage_events": {Kind: LifecycleRolling, Reason: "request records; their usage survives in the facts",
		Rules: []LifecycleRule{{Policy: LifecycleUsageDetail, Expired: `timestamp_ms < ?`, IsGatedByUsageFacts: true}}},
	"error_events": {Kind: LifecycleRolling, Reason: "error detail shown beside request records",
		Rules: []LifecycleRule{{Policy: LifecycleUsageDetail, Expired: `timestamp_ms < ?`}}},
	"ingest_gaps": {Kind: LifecycleRolling, Reason: "coverage notes about request records of the same age",
		Rules: []LifecycleRule{{Policy: LifecycleUsageDetail, Expired: `ended_at_ms < ?`}}},
	"usage_inboxes": {Kind: LifecycleRolling, Reason: "captured payloads, only needed to decode or replay a record",
		Rules: []LifecycleRule{
			{Policy: LifecycleUsageInbox, Expired: `status = '` + InboxProcessed + `' AND processed_at < ?`},
			// A payload that could not be decoded is evidence of a decoder gap, so
			// it is kept as long as the records around it rather than a few days.
			{Policy: LifecycleUsageDetail, Expired: `status = '` + InboxDiscarded + `' AND popped_at < ?`},
		}},

	"usage_facts_15m":               {Kind: LifecyclePermanent, Reason: "the dashboard's history; about one row per active dimension tuple per quarter hour"},
	"usage_facts_daily":             {Kind: LifecyclePermanent, Reason: "the dashboard's history at the daily grain"},
	"audit_events":                  {Kind: LifecyclePermanent, Reason: "the audit trail grows with operator actions, not traffic"},
	"model_price_versions":          {Kind: LifecyclePermanent, Reason: "every stored request cost references the version it was locked against"},
	"pricing_channel_versions":      {Kind: LifecyclePermanent, Reason: "every stored request cost references the multiplier it was locked against"},
	"schema_migrations":             {Kind: LifecyclePermanent, Reason: "the record of applied migrations"},
	"client_key_aliases":            {Kind: LifecyclePermanent, Reason: "requests keep their client key fingerprint, so its name must stay resolvable"},
	"connections":                   {Kind: LifecyclePermanent, Reason: "operator-owned identity"},
	"cpa_bindings":                  {Kind: LifecyclePermanent, Reason: "operator-owned identity; upstream removal marks a binding missing"},
	"cpa_instances":                 {Kind: LifecyclePermanent, Reason: "configured gateways"},
	"discovered_resources":          {Kind: LifecyclePermanent, Reason: "one row per upstream resource ever seen"},
	"resource_overrides":            {Kind: LifecyclePermanent, Reason: "operator-owned naming"},
	"custom_icons":                  {Kind: LifecyclePermanent, Reason: "operator uploads, removed only by the operator"},
	"model_prices":                  {Kind: LifecyclePermanent, Reason: "the price book"},
	"pricing_channels":              {Kind: LifecyclePermanent, Reason: "the channel multipliers"},
	"pricing_model_links":           {Kind: LifecyclePermanent, Reason: "operator-owned price links"},
	"pricing_match_reviews":         {Kind: LifecyclePermanent, Reason: "operator answers, one per priced model"},
	"quota_snapshots":               {Kind: LifecycleOwnerBounded, Reason: "trimmed to the newest observations per credential on every write"},
	"cpa_config_backups":            {Kind: LifecycleOwnerBounded, Reason: "trimmed to the operator's retention in the transaction that stores a copy"},
	"agent_documents":               {Kind: LifecycleOwnerBounded, Reason: "sessions are capped by turns; terminal operations expire lazily on agent requests"},
	"cpa_config_backup_settings":    {Kind: LifecycleReplaced, Reason: "one settings row"},
	"data_lifecycle_state":          {Kind: LifecycleReplaced, Reason: "one row per rolling policy"},
	"pricing_catalog_state":         {Kind: LifecycleReplaced, Reason: "current catalog state"},
	"pricing_model_catalog":         {Kind: LifecycleReplaced, Reason: "replaced whole on reconciliation"},
	"pricing_sync_state":            {Kind: LifecycleReplaced, Reason: "current sync state"},
	"pricing_upstream_catalog":      {Kind: LifecycleReplaced, Reason: "replaced whole on every successful sync"},
	"release_check_state":           {Kind: LifecycleReplaced, Reason: "current release-check state"},
	"release_index":                 {Kind: LifecycleReplaced, Reason: "replaced per product on every check"},
	"ui_preferences":                {Kind: LifecycleReplaced, Reason: "one row per preference key"},
	"usage_aggregation_checkpoints": {Kind: LifecycleReplaced, Reason: "one watermark row"},
}

// lifecycleBatchRows bounds one delete transaction. The pool has a single
// connection, so a delete holds every other statement back for as long as it
// runs; a few thousand rows keeps that to milliseconds, and the engine returns
// the connection between batches.
const lifecycleBatchRows = 2000

// LifecycleReport is what one RunLifecycle pass did.
type LifecycleReport struct {
	// Deleted counts rows removed per table.
	Deleted map[string]int64
	// IsComplete is false when the pass stopped at its batch budget with expired
	// rows still present; the next pass continues where it stopped.
	IsComplete bool
}

// Total sums the rows the pass removed.
func (report LifecycleReport) Total() int64 {
	var total int64
	for _, deleted := range report.Deleted {
		total += deleted
	}
	return total
}

// RunLifecycle deletes the rows every rolling policy has let expire.
//
// cutoffs maps a policy to the instant before which its rows should go; a policy
// that is absent or not positive keeps everything. maxBatches bounds the full
// delete batches of the pass so
// a long-overdue deletion (a retention that was just shortened) is spread over
// several passes instead of holding the database for one long transaction.
//
// Deletion is two-phase per policy. A pass deletes below the horizon an earlier
// pass published, then publishes this pass's cutoff as the new horizon. A read
// that planned itself against the old horizon moments ago therefore still finds
// every row it expected: nothing above that horizon is deleted until the next
// pass, by which time the read is long finished.
func (r *Repository) RunLifecycle(ctx context.Context, cutoffs map[string]int64, maxBatches int) (LifecycleReport, error) {
	report := LifecycleReport{Deleted: map[string]int64{}, IsComplete: true}
	if r == nil || r.SQL() == nil {
		return report, errors.New("repository is not initialized")
	}
	if maxBatches <= 0 {
		maxBatches = 1
	}
	tables := make([]string, 0, len(TABLE_LIFECYCLES))
	for table, lifecycle := range TABLE_LIFECYCLES {
		if lifecycle.Kind == LifecycleRolling {
			tables = append(tables, table)
		}
	}
	// A fixed order keeps a pass deterministic, which is what lets its tests say
	// exactly what one batch removes.
	sort.Strings(tables)

	batches := 0
	deletedByPolicy := map[string]int64{}
	for _, table := range tables {
		for _, rule := range TABLE_LIFECYCLES[table].Rules {
			horizonMS, err := r.LifecycleHorizonMS(ctx, rule.Policy)
			if err != nil {
				return report, err
			}
			if horizonMS <= 0 {
				continue
			}
			for {
				if batches >= maxBatches {
					report.IsComplete = false
					break
				}
				if err := ctx.Err(); err != nil {
					return report, err
				}
				deleted, err := r.deleteExpiredBatch(ctx, table, rule, horizonMS)
				if err != nil {
					return report, err
				}
				report.Deleted[table] += deleted
				deletedByPolicy[rule.Policy] += deleted
				if deleted < lifecycleBatchRows {
					break
				}
				// Only a full batch spends the budget: finding nothing to delete
				// is an index probe, and charging for it would let the tables that
				// sort first starve the ones behind them.
				batches++
			}
		}
	}

	// A policy with no cutoff this pass still records what was deleted under the
	// horizon it published earlier.
	published := map[string]int64{}
	for policy := range deletedByPolicy {
		published[policy] = 0
	}
	for policy, cutoffMS := range cutoffs {
		published[policy] = max(cutoffMS, 0)
	}
	nowMS := time.Now().UnixMilli()
	for policy, cutoffMS := range published {
		if cutoffMS == 0 && deletedByPolicy[policy] == 0 {
			continue
		}
		// The horizon only ever advances: rows below it are already gone, so a
		// retention that was lengthened cannot bring it back.
		if _, err := r.SQL().ExecContext(ctx, `
			INSERT INTO data_lifecycle_state (policy, horizon_ms, deleted_rows, last_run_at_ms)
			VALUES (?1, ?2, ?3, ?4)
			ON CONFLICT(policy) DO UPDATE SET
				horizon_ms = MAX(horizon_ms, excluded.horizon_ms),
				deleted_rows = deleted_rows + excluded.deleted_rows,
				last_run_at_ms = excluded.last_run_at_ms`,
			policy, cutoffMS, deletedByPolicy[policy], nowMS); err != nil {
			return report, fmt.Errorf("publish lifecycle horizon %s: %w", policy, err)
		}
	}
	return report, nil
}

// deleteExpiredBatch removes at most one batch of a rule's expired rows.
func (r *Repository) deleteExpiredBatch(ctx context.Context, table string, rule LifecycleRule, horizonMS int64) (int64, error) {
	predicate := rule.Expired
	if rule.IsGatedByUsageFacts {
		predicate += ` AND id <= (SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = '` + CheckpointFacts + `')`
	}
	result, err := r.SQL().ExecContext(ctx, `
		DELETE FROM `+table+` WHERE rowid IN (
			SELECT rowid FROM `+table+` WHERE `+predicate+` LIMIT ?)`,
		horizonMS, lifecycleBatchRows)
	if err != nil {
		return 0, fmt.Errorf("delete expired %s rows: %w", table, err)
	}
	deleted, _ := result.RowsAffected()
	return deleted, nil
}

// LifecycleState is what a rolling policy has removed so far.
type LifecycleState struct {
	Policy      string
	HorizonMS   int64
	DeletedRows int64
	LastRunAtMS *int64
}

// ListLifecycleStates reports every rolling policy that has run.
func (r *Repository) ListLifecycleStates(ctx context.Context) ([]LifecycleState, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	rows, err := r.SQL().QueryContext(ctx, `
		SELECT policy, horizon_ms, deleted_rows, last_run_at_ms FROM data_lifecycle_state ORDER BY policy ASC`)
	if err != nil {
		return nil, fmt.Errorf("list lifecycle states: %w", err)
	}
	defer rows.Close()
	states := []LifecycleState{}
	for rows.Next() {
		var state LifecycleState
		var lastRun sql.NullInt64
		if err := rows.Scan(&state.Policy, &state.HorizonMS, &state.DeletedRows, &lastRun); err != nil {
			return nil, fmt.Errorf("scan lifecycle state: %w", err)
		}
		if lastRun.Valid {
			state.LastRunAtMS = &lastRun.Int64
		}
		states = append(states, state)
	}
	return states, rows.Err()
}
