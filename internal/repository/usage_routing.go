package repository

import (
	"context"
	"errors"
	"fmt"
)

// MAX_ROUTING_RECORDS bounds the attempts one routing read returns. The live
// routing panel keeps a rolling minute of attempts in the browser and reads only
// what arrived since its last read, so a read is normally a handful of rows; the
// bound is what a first read of a very busy minute costs at most.
const MAX_ROUTING_RECORDS = 300

// routingLatencyLookback bounds how long before the window an attempt may have
// started and still belong to it. An attempt belongs to the window it finished
// in, and CPA's slowest streamed responses run for minutes; the bound keeps the
// read on the timestamp index instead of scanning the table.
const routingLatencyLookback = 15 * 60 * 1000

// UsageRoutingQuery selects the attempts of one rolling window.
type UsageRoutingQuery struct {
	InstanceID string
	// FromMS is the window's start: an attempt that finished at or after it
	// belongs to the window, whenever it started.
	FromMS int64
	// AfterID, when positive, returns only attempts recorded after that record,
	// which is how a live reader extends the window it already holds.
	AfterID int64
	// NowMS decides which cooldowns are still running.
	NowMS int64
	Limit int
}

// UsageRoutingCooldown is a credential CPA reported as resting.
type UsageRoutingCooldown struct {
	AuthIndex     string
	Provider      string
	StatusCode    int
	QuotaExceeded bool
	UntilMS       int64
}

// UsageRouting is one read of the rolling routing window.
type UsageRouting struct {
	// Records are attempts, newest first: CPA writes one record per attempt, so
	// several records sharing a request id are one request CPA rerouted.
	Records []UsageEventRow
	// HasMore reports that the window held more attempts than the limit; the
	// oldest were left out.
	HasMore   bool
	Cooldowns []UsageRoutingCooldown
}

// usageRoutingRecordsQuery reads a window's attempts, newest by arrival rather
// than by start time: a long request that started early and finished just now is
// the newest thing a live reader has to show.
//
// It names the time index. Left to itself the planner takes the (instance, id)
// index because it already yields the order, and then filters the window row by
// row; in a quiet minute it finds fewer than the limit and walks every retained
// record before it stops. The time index bounds the read to the window and sorts
// what is, by MAX_ROUTING_RECORDS and the lookback, a short list.
var usageRoutingRecordsQuery = usageEventListSelect("usage_events e INDEXED BY idx_usage_events_instance_time") + `
		WHERE e.instance_id = ? AND e.id > ?
		  AND e.timestamp_ms >= ? AND e.timestamp_ms + MAX(e.latency_ms, 0) >= ?
		ORDER BY e.id DESC LIMIT ?`

// QueryUsageRouting reads the attempts that finished in the window (or, with
// AfterID, the ones recorded since) and the credentials currently resting.
func (r *Repository) QueryUsageRouting(ctx context.Context, query UsageRoutingQuery) (UsageRouting, error) {
	result := UsageRouting{Records: []UsageEventRow{}, Cooldowns: []UsageRoutingCooldown{}}
	if r == nil || r.SQL() == nil {
		return result, errors.New("repository is not initialized")
	}
	if query.NowMS <= query.FromMS {
		return result, errors.New("routing window is empty")
	}
	limit := query.Limit
	if limit <= 0 || limit > MAX_ROUTING_RECORDS {
		limit = MAX_ROUTING_RECORDS
	}
	records, err := r.queryUsageEventRows(ctx, usageRoutingRecordsQuery,
		query.InstanceID, query.AfterID, query.FromMS-routingLatencyLookback, query.FromMS, limit+1)
	if err != nil {
		return result, fmt.Errorf("read routing records: %w", err)
	}
	if len(records) > limit {
		records, result.HasMore = records[:limit], true
	}
	result.Records = records

	result.Cooldowns, err = r.activeRoutingCooldowns(ctx, query.InstanceID, query.NowMS)
	if err != nil {
		return result, err
	}
	return result, nil
}

// routingCooldownLookback bounds how far back a resting credential is looked
// for. CPA's longest backoffs are quota resets, which it reports with the error
// that caused them; a day covers a daily reset without scanning the whole table.
const routingCooldownLookback = 24 * 60 * 60 * 1000

// activeRoutingCooldowns reports, per credential, the newest error whose
// retry or recovery time is still ahead. Only the newest error per credential
// counts: a later success-after-error is followed by an error without a future
// time, or by none, and an older cooldown must not outlive a newer verdict.
func (r *Repository) activeRoutingCooldowns(ctx context.Context, instanceID string, nowMS int64) ([]UsageRoutingCooldown, error) {
	rows, err := r.SQL().QueryContext(ctx, `
		SELECT x.auth_index, x.provider, x.status_code, x.quota_exceeded,
		       MAX(COALESCE(x.next_retry_after_ms, 0), COALESCE(x.next_recover_at_ms, 0))
		FROM error_events x
		JOIN (
			SELECT auth_index, MAX(id) AS id FROM error_events
			WHERE instance_id = ? AND auth_index <> '' AND timestamp_ms >= ?
			GROUP BY auth_index
		) newest ON newest.id = x.id`, instanceID, nowMS-routingCooldownLookback)
	if err != nil {
		return nil, fmt.Errorf("read routing cooldowns: %w", err)
	}
	defer rows.Close()
	cooldowns := []UsageRoutingCooldown{}
	for rows.Next() {
		var cooldown UsageRoutingCooldown
		var quota int
		if errScan := rows.Scan(&cooldown.AuthIndex, &cooldown.Provider, &cooldown.StatusCode, &quota, &cooldown.UntilMS); errScan != nil {
			return nil, fmt.Errorf("scan routing cooldown: %w", errScan)
		}
		if cooldown.UntilMS <= nowMS {
			continue
		}
		cooldown.QuotaExceeded = quota == 1
		cooldowns = append(cooldowns, cooldown)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate routing cooldowns: %w", err)
	}
	return cooldowns, nil
}
