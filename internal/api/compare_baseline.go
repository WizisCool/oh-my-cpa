package api

import (
	"math"
	"slices"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// compareBucketSpec picks a sub-bucket granularity for the previous period so the
// outlier-robust baseline has representative intra-period samples without splitting
// below the fact grain unnecessarily.
func compareBucketSpec(fromMS, toMS int64, zone *time.Location) (bucketMS int64, calendar *repository.UsageCalendar, bucket insightsBucket) {
	span := time.Duration(max(1, toMS-fromMS+1)) * time.Millisecond
	switch {
	case span <= 2*time.Hour:
		return (5 * time.Minute).Milliseconds(), nil, ""
	case span <= 12*time.Hour:
		return (15 * time.Minute).Milliseconds(), nil, ""
	case span <= 3*24*time.Hour:
		return 0, &repository.UsageCalendar{Location: zone, Unit: repository.UsageCalendarHour}, insightsBucketHour
	case span <= 92*24*time.Hour:
		return 0, &repository.UsageCalendar{Location: zone, Unit: repository.UsageCalendarDay}, insightsBucketDay
	default:
		return 0, &repository.UsageCalendar{Location: zone, Unit: repository.UsageCalendarWeek}, insightsBucketWeek
	}
}

func sortedQuantile(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if n == 1 {
		return sorted[0]
	}
	pos := p * float64(n-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	frac := pos - float64(lo)
	return sorted[lo] + frac*(sorted[hi]-sorted[lo])
}

// robustBucketSum computes an outlier-resistant total across equal-width sub-buckets
// of the previous period. Zero buckets remain zero (preserving the active duty cycle),
// while extreme upper-tail spikes above both the Tukey 3*IQR fence and the log-space
// 3*MAD fence (with a 2.5*median floor) are Winsorized when at least 4 active buckets exist.
func robustBucketSum(values []float64) float64 {
	active := make([]float64, 0, len(values))
	rawSum := 0.0
	for _, v := range values {
		if v > 0 {
			active = append(active, v)
			rawSum += v
		}
	}
	k := len(active)
	if k == 0 {
		return 0
	}
	if k < 4 {
		return rawSum
	}
	slices.Sort(active)
	med := sortedQuantile(active, 0.50)
	fence := 2.5 * med
	// For k >= 5, Q3 does not blend the maximum element, so Tukey's 3*IQR fence
	// stays independent of a single extreme spike; at k == 4, Q3 interpolates into
	// active[3], so only log-MAD and the 2.5*median floor govern the cap.
	if k >= 5 {
		q1 := sortedQuantile(active, 0.25)
		q3 := sortedQuantile(active, 0.75)
		iqr := q3 - q1
		fence = max(q3+3.0*iqr, fence)
	}

	logs := make([]float64, k)
	for i, v := range active {
		logs[i] = math.Log(v)
	}
	medLog := sortedQuantile(logs, 0.50)
	devs := make([]float64, k)
	for i, lv := range logs {
		devs[i] = math.Abs(lv - medLog)
	}
	slices.Sort(devs)
	madLog := sortedQuantile(devs, 0.50)
	sigmaLog := 1.4826 * madLog
	fenceLog := math.Exp(medLog + 3.0*sigmaLog)
	if !math.IsNaN(fenceLog) && !math.IsInf(fenceLog, 0) && fenceLog > fence {
		fence = fenceLog
	}

	sum := 0.0
	for _, v := range active {
		if v > fence {
			sum += fence
		} else {
			sum += v
		}
	}
	return sum
}

type dashboardBaselineResult struct {
	rawRequests            int64
	rawTokens              int64
	rawCostNanos           int64
	rawCostedRequests      int64
	baselineRequests       float64
	baselineTokens         float64
	baselineCostNanos      float64
	baselineCostedRequests float64
}

func computeDashboardBaseline(rows []repository.UsageFactRow, currentSpanMS, prevSpanMS int64) dashboardBaselineResult {
	var out dashboardBaselineResult
	if len(rows) == 0 {
		return out
	}
	type bucketTotals struct {
		requests       float64
		tokens         float64
		costNanos      float64
		costedRequests float64
	}
	byBucket := make(map[int64]*bucketTotals, len(rows))
	for _, row := range rows {
		out.rawRequests += row.Requests
		out.rawTokens += row.TotalTokens
		out.rawCostNanos += row.CostNanos
		out.rawCostedRequests += row.CostedRequests

		entry := byBucket[row.StartMS]
		if entry == nil {
			entry = &bucketTotals{}
			byBucket[row.StartMS] = entry
		}
		entry.requests += float64(row.Requests)
		entry.tokens += float64(row.TotalTokens)
		entry.costNanos += float64(row.CostNanos)
		entry.costedRequests += float64(row.CostedRequests)
	}

	reqs := make([]float64, 0, len(byBucket))
	toks := make([]float64, 0, len(byBucket))
	costs := make([]float64, 0, len(byBucket))
	costeds := make([]float64, 0, len(byBucket))
	for _, entry := range byBucket {
		reqs = append(reqs, entry.requests)
		toks = append(toks, entry.tokens)
		costs = append(costs, entry.costNanos)
		costeds = append(costeds, entry.costedRequests)
	}

	scale := float64(max(1, currentSpanMS)) / float64(max(1, prevSpanMS))
	out.baselineRequests = robustBucketSum(reqs) * scale
	out.baselineTokens = robustBucketSum(toks) * scale
	out.baselineCostNanos = robustBucketSum(costs) * scale
	out.baselineCostedRequests = robustBucketSum(costeds) * scale
	return out
}
