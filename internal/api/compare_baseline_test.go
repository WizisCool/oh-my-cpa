package api

import (
	"math"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func almostEqual(a, b, tol float64) bool {
	return math.Abs(a-b) <= tol
}

func TestRobustBucketSumHandlesSparseSeriesSkewAndOutliers(t *testing.T) {
	if got := robustBucketSum(nil); got != 0 {
		t.Fatalf("empty sum = %v, want 0", got)
	}
	if got := robustBucketSum([]float64{0, 0, 0}); got != 0 {
		t.Fatalf("all-zero sum = %v, want 0", got)
	}

	// Fewer than 4 active buckets keep exact raw sum without clipping.
	if got := robustBucketSum([]float64{0, 50, 0, 5000, 0, 10}); !almostEqual(got, 5060, 1e-9) {
		t.Fatalf("k<4 sum = %v, want 5060", got)
	}

	// Steady workday with idle night hours preserves exact total and duty cycle.
	workday := make([]float64, 24)
	for h := 9; h < 17; h++ {
		workday[h] = 100
	}
	if got := robustBucketSum(workday); !almostEqual(got, 800, 1e-9) {
		t.Fatalf("steady workday = %v, want 800", got)
	}

	// Naturally right-skewed diurnal curve is untouched.
	skewed := []float64{1, 2, 5, 10, 20, 50, 100, 200}
	if got := robustBucketSum(skewed); !almostEqual(got, 388, 1e-9) {
		t.Fatalf("skewed normal curve = %v, want 388", got)
	}

	// Extreme runaway spike in one bucket is Winsorized down to the upper fence,
	// including when exactly 4 active buckets exist.
	gotFour := robustBucketSum([]float64{20, 20, 20, 2000})
	// med=20, 2.5*med=50 -> 2000 capped at 50 -> 20+20+20+50 = 110
	if !almostEqual(gotFour, 110, 1e-6) {
		t.Fatalf("k=4 spike sum = %v, want 110", gotFour)
	}
	gotFourUnit := robustBucketSum([]float64{1, 1, 1, 1000})
	if !almostEqual(gotFourUnit, 2.5+3, 1e-6) {
		t.Fatalf("k=4 unit spike sum = %v, want 5.5", gotFourUnit)
	}

	withSpike := []float64{20, 22, 18, 25, 20, 21, 19, 2000}
	gotSpike := robustBucketSum(withSpike)
	// med=20.5, q1=19.5, q3=23.5 -> max(35.5, 51.25) -> 2000 capped at 51.25 -> 145 + 51.25 = 196.25
	if !almostEqual(gotSpike, 196.25, 1e-6) {
		t.Fatalf("spike-winsorized sum = %v, want 196.25", gotSpike)
	}

	// Identical baseline with one small variation (+50%) is not clipped by the 2.5*median floor.
	mildBump := []float64{100, 100, 100, 100, 100, 150}
	if got := robustBucketSum(mildBump); !almostEqual(got, 650, 1e-9) {
		t.Fatalf("mild bump = %v, want 650", got)
	}
}

func TestComputeDashboardBaselineScalesToElapsedProgress(t *testing.T) {
	var rows []repository.UsageFactRow
	// 8 active hours at 10 reqs / 1000 tokens / $1 per hour, plus 1 runaway hour at 500 reqs / 50k tokens / $50.
	for h := 0; h < 8; h++ {
		rows = append(rows, repository.UsageFactRow{
			StartMS: int64(h) * 3_600_000,
			UsageMeasures: repository.UsageMeasures{
				UsageTotals: repository.UsageTotals{
					Requests:    10,
					TotalTokens: 1000,
				},
				CostNanos:      1_000_000_000,
				CostedRequests: 10,
			},
		})
	}
	rows = append(rows, repository.UsageFactRow{
		StartMS: 8 * 3_600_000,
		UsageMeasures: repository.UsageMeasures{
			UsageTotals: repository.UsageTotals{
				Requests:    500,
				TotalTokens: 50_000,
			},
			CostNanos:      50_000_000_000,
			CostedRequests: 500,
		},
	})

	// Yesterday = 24h, Today elapsed = 12h -> scale = 0.5.
	// Active buckets = 8*10 + 1*25 (2.5*med=25 fence) = 105 -> * 0.5 = 52.5 requests.
	res := computeDashboardBaseline(rows, 12*3_600_000, 24*3_600_000)
	if res.rawRequests != 580 {
		t.Fatalf("rawRequests = %d, want 580", res.rawRequests)
	}
	if !almostEqual(res.baselineRequests, 52.5, 1e-6) {
		t.Fatalf("baselineRequests = %v, want 52.5", res.baselineRequests)
	}
	if !almostEqual(res.baselineTokens, 5250, 1e-4) {
		t.Fatalf("baselineTokens = %v, want 5250", res.baselineTokens)
	}
	if !almostEqual(res.baselineCostNanos, 5_250_000_000, 1e-2) {
		t.Fatalf("baselineCostNanos = %v, want 5.25e9", res.baselineCostNanos)
	}
}

func TestCompareBucketSpecGranularity(t *testing.T) {
	shanghai, _ := time.LoadLocation("Asia/Shanghai")
	if ms, cal, _ := compareBucketSpec(0, int64(time.Hour/time.Millisecond)-1, shanghai); ms != 5*60_000 || cal != nil {
		t.Fatalf("1h spec = (%d, %v), want 5m", ms, cal)
	}
	if ms, cal, _ := compareBucketSpec(0, int64(6*time.Hour/time.Millisecond)-1, shanghai); ms != 15*60_000 || cal != nil {
		t.Fatalf("6h spec = (%d, %v), want 15m", ms, cal)
	}
	if _, cal, bkt := compareBucketSpec(0, int64(24*time.Hour/time.Millisecond)-1, shanghai); cal == nil || cal.Unit != repository.UsageCalendarHour || bkt != insightsBucketHour {
		t.Fatalf("24h spec = (%v, %v), want hour", cal, bkt)
	}
	if _, cal, bkt := compareBucketSpec(0, int64(7*24*time.Hour/time.Millisecond)-1, shanghai); cal == nil || cal.Unit != repository.UsageCalendarDay || bkt != insightsBucketDay {
		t.Fatalf("7d spec = (%v, %v), want day", cal, bkt)
	}
	if _, cal, bkt := compareBucketSpec(0, int64(180*24*time.Hour/time.Millisecond)-1, shanghai); cal == nil || cal.Unit != repository.UsageCalendarWeek || bkt != insightsBucketWeek {
		t.Fatalf("180d spec = (%v, %v), want week", cal, bkt)
	}
}
