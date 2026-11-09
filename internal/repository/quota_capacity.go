package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

// capacityRetainedCycles is how many cycles of a window keep their evidence: the
// live one and earlier ones a reference can come from when the last cycle had no
// measurable climb.
const capacityRetainedCycles = 3

type capacityQuerier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// recordCapacityCycles folds a saved reading into each window's cycle evidence,
// in the transaction that stores the reading. Capacity evidence is kept apart
// from the snapshots so their retention cannot move an estimate.
func recordCapacityCycles(ctx context.Context, tx *sql.Tx, snapshot QuotaSnapshotRecord) error {
	if snapshot.Status == "error" || snapshot.Status == "stale" {
		return nil
	}
	var windows []quota.QuotaWindow
	if err := json.Unmarshal([]byte(snapshot.WindowsJSON), &windows); err != nil {
		return nil
	}
	plan := &quota.QuotaPlan{PlanType: snapshot.PlanType, Tier: snapshot.PlanTier}
	for _, window := range windows {
		key := quota.CapacityWindowKey(snapshot.Provider, window)
		stored, err := queryCapacityCycles(ctx, tx, snapshot.AuthIndex, key, 1)
		if err != nil {
			return err
		}
		var latest *quota.CycleCalibration
		if len(stored) > 0 {
			latest = &stored[0]
		}
		cycle, isEvidence := quota.NextCalibrationCycle(latest, snapshot.Provider, window, plan, snapshot.ObservedAtMS)
		if !isEvidence {
			continue
		}
		point, isMeasured, err := capacityPoint(ctx, tx, snapshot.AuthIndex, window, cycle, snapshot.ObservedAtMS)
		if err != nil {
			return err
		}
		if !isMeasured {
			continue
		}
		cycle.Points = append(cycle.Points, point)
		pointsJSON, err := json.Marshal(cycle.Points)
		if err != nil {
			return fmt.Errorf("encode capacity points: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO quota_capacity_cycles (
				auth_index, window_key, cycle_reset_at_ms, period_hours, plan_type, plan_tier, points_json, updated_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(auth_index, window_key, cycle_reset_at_ms) DO UPDATE SET
				points_json = excluded.points_json, updated_at_ms = excluded.updated_at_ms`,
			snapshot.AuthIndex, key, cycle.CycleResetAtMS, cycle.PeriodHours, cycle.PlanType, cycle.PlanTier,
			string(pointsJSON), time.Now().UnixMilli(),
		); err != nil {
			return fmt.Errorf("save capacity cycle: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM quota_capacity_cycles
			WHERE auth_index = ? AND window_key = ? AND cycle_reset_at_ms NOT IN (
				SELECT cycle_reset_at_ms FROM quota_capacity_cycles
				WHERE auth_index = ? AND window_key = ?
				ORDER BY cycle_reset_at_ms DESC LIMIT ?
			)`,
			snapshot.AuthIndex, key, snapshot.AuthIndex, key, capacityRetainedCycles,
		); err != nil {
			return fmt.Errorf("trim capacity cycles: %w", err)
		}
	}
	return nil
}

// capacityPoint pairs a reading with the usage recorded from the cycle start. A
// record that arrives after its reading is caught by the next point's fresh sum;
// the running sum covers records that retention removed since the last point.
func capacityPoint(ctx context.Context, q capacityQuerier, authIndex string, window quota.QuotaWindow, cycle quota.CycleCalibration, observedAtMS int64) (quota.CalibrationPoint, bool, error) {
	used, _ := quota.WindowUsedPercent(window)
	usage, scopeReason, err := queryCapacityUsage(ctx, q, authIndex, window, cycle.CycleStartMS(), observedAtMS)
	if err != nil || scopeReason != "" {
		return quota.CalibrationPoint{}, false, err
	}
	if len(cycle.Points) > 0 {
		last := cycle.Points[len(cycle.Points)-1]
		since, _, err := queryCapacityUsage(ctx, q, authIndex, window, last.ObservedAtMS, observedAtMS)
		if err != nil {
			return quota.CalibrationPoint{}, false, err
		}
		if last.Requests+since.Requests > usage.Requests {
			usage = quota.WindowUsage{
				Requests: last.Requests + since.Requests, PricedRequests: last.PricedRequests + since.PricedRequests,
				Tokens: last.Tokens + since.Tokens, CostNanos: last.CostNanos + since.CostNanos,
				UnmatchedRequests: last.UnmatchedRequests + since.UnmatchedRequests,
			}
		}
	}
	return quota.CalibrationPoint{
		ObservedAtMS: observedAtMS, UsedPercent: used,
		Requests: usage.Requests, PricedRequests: usage.PricedRequests, Tokens: usage.Tokens, CostNanos: usage.CostNanos,
		UnmatchedRequests: usage.UnmatchedRequests,
	}, true, nil
}

// LoadCapacityCycles returns a credential's retained cycle evidence by window
// key, newest cycle first.
func (r *Repository) LoadCapacityCycles(ctx context.Context, authIndex string) (map[string][]quota.CycleCalibration, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	cycles, err := queryCapacityCycles(ctx, r.SQL(), strings.TrimSpace(authIndex), "", -1)
	if err != nil {
		return nil, err
	}
	byKey := make(map[string][]quota.CycleCalibration)
	for _, cycle := range cycles {
		byKey[cycle.WindowKey] = append(byKey[cycle.WindowKey], cycle)
	}
	return byKey, nil
}

// queryCapacityCycles reads one window's cycles, or every window's when key is
// empty, newest first. Points that cannot be decoded leave their cycle empty, so
// the next reading starts it again instead of failing the save.
func queryCapacityCycles(ctx context.Context, q capacityQuerier, authIndex, key string, limit int) ([]quota.CycleCalibration, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT window_key, cycle_reset_at_ms, period_hours, plan_type, plan_tier, points_json
		FROM quota_capacity_cycles
		WHERE auth_index = ? AND (? = '' OR window_key = ?)
		ORDER BY window_key, cycle_reset_at_ms DESC LIMIT ?`,
		authIndex, key, key, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query capacity cycles: %w", err)
	}
	defer rows.Close()
	var cycles []quota.CycleCalibration
	for rows.Next() {
		var cycle quota.CycleCalibration
		var pointsJSON string
		if err := rows.Scan(&cycle.WindowKey, &cycle.CycleResetAtMS, &cycle.PeriodHours, &cycle.PlanType, &cycle.PlanTier, &pointsJSON); err != nil {
			return nil, fmt.Errorf("scan capacity cycle: %w", err)
		}
		if err := json.Unmarshal([]byte(pointsJSON), &cycle.Points); err != nil {
			cycle.Points = nil
		}
		cycles = append(cycles, cycle)
	}
	return cycles, rows.Err()
}

// QueryCapacityUsage sums the requests that consumed a credential's window in
// [fromMS, toMS). A request counts when it finishes, as upstream meters it then;
// one that produced no tokens consumed nothing. A scoped window counts only the
// models it meters, by served identity when CPA published one.
func (r *Repository) QueryCapacityUsage(ctx context.Context, authIndex string, window quota.QuotaWindow, fromMS, toMS int64) (quota.WindowUsage, string, error) {
	if r == nil || r.SQL() == nil {
		return quota.WindowUsage{}, "", errors.New("repository is not initialized")
	}
	return queryCapacityUsage(ctx, r.SQL(), strings.TrimSpace(authIndex), window, fromMS, toMS)
}

func queryCapacityUsage(ctx context.Context, q capacityQuerier, authIndex string, window quota.QuotaWindow, fromMS, toMS int64) (quota.WindowUsage, string, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(NULLIF(response_model, ''), model), COUNT(1), COALESCE(SUM(cost_nanos IS NOT NULL), 0),
		       COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_nanos), 0)
		FROM usage_events
		WHERE auth_index = ? AND timestamp_ms >= ? AND timestamp_ms < ?
		  AND timestamp_ms + MAX(latency_ms, 0) < ? AND total_tokens > 0
		GROUP BY 1`,
		authIndex, fromMS, toMS, toMS,
	)
	if err != nil {
		return quota.WindowUsage{}, "", fmt.Errorf("query capacity usage: %w", err)
	}
	defer rows.Close()
	var groups []quota.ModelWindowUsage
	for rows.Next() {
		var group quota.ModelWindowUsage
		if err := rows.Scan(&group.Model, &group.Usage.Requests, &group.Usage.PricedRequests, &group.Usage.Tokens, &group.Usage.CostNanos); err != nil {
			return quota.WindowUsage{}, "", fmt.Errorf("scan capacity usage: %w", err)
		}
		groups = append(groups, group)
	}
	if err := rows.Err(); err != nil {
		return quota.WindowUsage{}, "", fmt.Errorf("query capacity usage: %w", err)
	}
	var usage quota.WindowUsage
	reason := ""
	if window.Scope == "model" || window.Scope == "group" {
		usage, reason = quota.SelectWindowUsage(window, groups)
	} else {
		for _, group := range groups {
			usage.Requests += group.Usage.Requests
			usage.PricedRequests += group.Usage.PricedRequests
			usage.Tokens += group.Usage.Tokens
			usage.CostNanos += group.Usage.CostNanos
		}
	}
	usage.FromMS, usage.ToMS = fromMS, toMS
	return usage, reason, nil
}
