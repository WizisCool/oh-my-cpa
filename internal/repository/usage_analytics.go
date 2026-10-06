package repository

import (
	"context"
	"errors"
	"fmt"
)

// Grain bucket widths in milliseconds.
const (
	HourBucketMS int64 = 60 * 60 * 1000
	DayBucketMS  int64 = 24 * 60 * 60 * 1000
)

// UsageTotals aggregates one window of CPA activity.
type UsageTotals struct {
	Requests            int64
	Failures            int64
	InputTokens         int64
	OutputTokens        int64
	ReasoningTokens     int64
	CachedTokens        int64
	CacheReadTokens     int64
	CacheCreationTokens int64
	TotalTokens         int64
	LatencySumMS        int64
	TTFTSumMS           int64
	TTFTCount           int64
}

func (t *UsageTotals) add(other UsageTotals) {
	t.Requests += other.Requests
	t.Failures += other.Failures
	t.InputTokens += other.InputTokens
	t.OutputTokens += other.OutputTokens
	t.ReasoningTokens += other.ReasoningTokens
	t.CachedTokens += other.CachedTokens
	t.CacheReadTokens += other.CacheReadTokens
	t.CacheCreationTokens += other.CacheCreationTokens
	t.TotalTokens += other.TotalTokens
	t.LatencySumMS += other.LatencySumMS
	t.TTFTSumMS += other.TTFTSumMS
	t.TTFTCount += other.TTFTCount
}

// UsageBucket is one sparkline point.
type UsageBucket struct {
	StartMS int64
	UsageMeasures
}

// UsageAnalytics answers a dashboard window.
type UsageAnalytics struct {
	Totals  UsageMeasures
	Buckets []UsageBucket
	// FromMS, ToMS and BucketMS are the window that was read; see UsageFactResult.
	FromMS   int64
	ToMS     int64
	BucketMS int64
	// FromRollup counts requests answered from the permanent facts; the rest
	// came from request records. Exposed so the UI can be honest about lag.
	FromRollup int64
	FromEvents int64
}

// QueryUsageAnalytics answers a window for the whole deployment.
func (r *Repository) QueryUsageAnalytics(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64) (UsageAnalytics, error) {
	return r.QueryUsageAnalyticsFiltered(ctx, instanceID, fromMS, toMS, bucketMS, "")
}

// QueryUsageAnalyticsFiltered answers a window, optionally narrowed to a single
// client API key fingerprint (api_group_key). Totals, the series and the cost
// come from one read, so they cannot disagree about what the window held.
func (r *Repository) QueryUsageAnalyticsFiltered(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64, apiKey string) (UsageAnalytics, error) {
	result := UsageAnalytics{Buckets: []UsageBucket{}}
	if toMS <= fromMS {
		return result, fmt.Errorf("analytics window must be positive")
	}
	if bucketMS <= 0 {
		return result, fmt.Errorf("invalid analytics bucket width %d", bucketMS)
	}
	facts, err := r.QueryUsageFacts(ctx, UsageFactQuery{
		InstanceID: instanceID, FromMS: fromMS, ToMS: toMS, BucketMS: bucketMS, APIGroupKey: apiKey,
	})
	if err != nil {
		return UsageAnalytics{}, err
	}
	result.FromMS, result.ToMS, result.BucketMS = facts.FromMS, facts.ToMS, facts.BucketMS
	result.FromRollup, result.FromEvents = facts.FactRequests, facts.DetailRequests
	for _, row := range facts.Rows {
		result.Totals.add(row.UsageMeasures)
		result.Buckets = append(result.Buckets, UsageBucket{StartMS: row.StartMS, UsageMeasures: row.UsageMeasures})
	}
	return result, nil
}

func scanTargets(totals *UsageTotals) []any {
	return []any{
		&totals.Requests, &totals.Failures, &totals.InputTokens, &totals.OutputTokens,
		&totals.ReasoningTokens, &totals.CachedTokens, &totals.CacheReadTokens,
		&totals.CacheCreationTokens, &totals.TotalTokens, &totals.LatencySumMS,
		&totals.TTFTSumMS, &totals.TTFTCount,
	}
}

// UsageDayWindow is one local calendar day, expressed as the exact instant range it
// covers on the viewer's calendar.
//
// The window carries its own bounds rather than leaving the caller to recompute them
// because the two must not be derived twice: the day a request is attributed to and
// the day a drill-down opens are the same interval, and a second derivation is a
// second chance to disagree.
type UsageDayWindow struct {
	Day string
	// FromMS and ToMS are inclusive. ToMS of the final day is the read instant
	// rather than the end of that day, so records timestamped in the future cannot
	// contribute to today's total.
	FromMS int64
	ToMS   int64
}

// UsageDayTotals is one local day's token volume.
//
// It is deliberately not a `UsageBucket`: a day and a sparkline bucket are different
// concepts that happen to share a shape, and one shared type would invite a daily
// series into a trend line.
type UsageDayTotals struct {
	Day        string
	FromMS     int64
	ToMS       int64
	Tokens     int64
	Requests   int64
	Failures   int64
	Input      int64
	Output     int64
	Reasoning  int64
	CacheRead  int64
	CacheWrite int64
}

// QueryDailyTokenTotals aggregates usage per local day.
//
// Days are supplied by the caller as exact instant ranges, built from the
// deployment's IANA zone. Every civil UTC offset in use is a multiple of fifteen
// minutes, so a local day is a whole number of fine fact buckets: the span is read
// once on the quarter-hour grid and folded into days here. That keeps the calendar
// exact across fractional offsets (India's :30, Nepal's :45) and daylight-saving
// transitions, which grouping by an offset-shifted hour could not, and it keeps
// days readable after their request records have rolled out of retention.
//
// The final day may stop at the read instant instead of at midnight; the read
// handles that edge from request records, so a record timestamped in the future
// cannot inflate today's total.
func (r *Repository) QueryDailyTokenTotals(ctx context.Context, instanceID string, days []UsageDayWindow) ([]UsageDayTotals, error) {
	result := make([]UsageDayTotals, 0, len(days))
	for _, window := range days {
		result = append(result, UsageDayTotals{Day: window.Day, FromMS: window.FromMS, ToMS: window.ToMS})
	}
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	if len(days) == 0 {
		return result, nil
	}
	isOnFactGrid := true
	for index, window := range days {
		if window.ToMS < window.FromMS {
			return nil, fmt.Errorf("day window %s is negative", window.Day)
		}
		if window.FromMS%QuarterHourBucketMS != 0 {
			isOnFactGrid = false
		}
		if index > 0 && window.FromMS != days[index-1].ToMS+1 {
			isOnFactGrid = false
		}
	}
	assign := func(index int, measures UsageMeasures) {
		result[index].Requests += measures.Requests
		result[index].Failures += measures.Failures
		result[index].Input += measures.InputTokens
		result[index].Output += measures.OutputTokens
		result[index].Reasoning += measures.ReasoningTokens
		result[index].CacheRead += measures.CacheReadTokens
		result[index].CacheWrite += measures.CacheCreationTokens
		result[index].Tokens += measures.TotalTokens
	}

	// Ranges that are not contiguous whole buckets cannot share one grid, so each
	// is read as its own window. No deployment timezone produces such days; the
	// path keeps an arbitrary caller exact rather than approximately right.
	if !isOnFactGrid {
		for index, window := range days {
			facts, err := r.QueryUsageFacts(ctx, UsageFactQuery{InstanceID: instanceID, FromMS: window.FromMS, ToMS: window.ToMS})
			if err != nil {
				return nil, fmt.Errorf("read daily token totals: %w", err)
			}
			assign(index, facts.Totals())
		}
		return result, nil
	}

	facts, err := r.QueryUsageFacts(ctx, UsageFactQuery{
		InstanceID: instanceID, FromMS: days[0].FromMS, ToMS: days[len(days)-1].ToMS, BucketMS: QuarterHourBucketMS,
	})
	if err != nil {
		return nil, fmt.Errorf("read daily token totals: %w", err)
	}
	// Rows arrive in bucket order and days are contiguous, so one forward walk
	// places every bucket.
	index := 0
	for _, row := range facts.Rows {
		for index < len(days)-1 && row.StartMS > days[index].ToMS {
			index++
		}
		assign(index, row.UsageMeasures)
	}
	return result, nil
}
