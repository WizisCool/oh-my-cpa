package api

import (
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// The ranking and the fold are pure functions of the rows and the window, so they are tested
// as such. Every case here is one where a plausible implementation reads correctly on a
// glance at the panels and is wrong: a tie that reshuffles between polls, a fold boundary
// that drops a model, a bucket outside the grid that vanishes from a series while still
// counting in the total.

func modelWindow(fromMS, toMS, bucketMS int64) dashboardWindow {
	return dashboardWindow{FromMS: fromMS, ToMS: toMS, BucketMS: bucketMS}
}

// One hour at one-minute buckets, starting on a bucket boundary.
const (
	modelTestFrom = int64(1_700_000_000_000) - (int64(1_700_000_000_000) % 60_000)
	modelTestTo   = modelTestFrom + 59*60_000
	modelTestMS   = int64(60_000)
)

func modelRow(model string, bucket int, tokens int64) repository.UsageModelBucketRow {
	return repository.UsageModelBucketRow{
		Model:    model,
		StartMS:  modelTestFrom + int64(bucket)*modelTestMS,
		Tokens:   tokens,
		Requests: 1,
	}
}

// seriesSum adds a group's own series, which is what the containment checks compare.
func seriesSum(group dashboardModelUsage) int64 {
	var total int64
	for _, point := range group.Series {
		total += point.Tokens
	}
	return total
}

func TestBuildModelUsageRanksByTokensAndFoldsTheRemainder(t *testing.T) {
	rows := []repository.UsageModelBucketRow{
		modelRow("a", 0, 100), modelRow("b", 0, 200), modelRow("c", 0, 300),
		modelRow("d", 0, 400), modelRow("e", 0, 500), modelRow("f", 0, 600), modelRow("g", 0, 700),
	}
	usage := buildModelUsage(modelWindow(modelTestFrom, modelTestTo, modelTestMS), rows)

	if usage.total != 2800 {
		t.Fatalf("window total = %d, want 2800", usage.total)
	}
	// Five named models plus one folded group: the panel's whole reason for existing is that
	// a deployment's model count is unbounded, so the group count must be too.
	if len(usage.groups) != dashboardModelTopN+1 {
		t.Fatalf("got %d groups, want %d", len(usage.groups), dashboardModelTopN+1)
	}
	// Descending, with the folded group last rather than sorted into the ranking.
	wantOrder := []string{"g", "f", "e", "d", "c"}
	for index, want := range wantOrder {
		if usage.groups[index].Model != want {
			t.Fatalf("group %d = %q, want %q", index, usage.groups[index].Model, want)
		}
	}
	folded := usage.groups[dashboardModelTopN]
	if !folded.Folded {
		t.Fatal("the last group must be marked folded")
	}
	// The two models outside the top five are 100 + 200.
	if folded.Tokens != 300 {
		t.Fatalf("folded group = %d tokens, want 300", folded.Tokens)
	}

	// Containment: every group's series must sum to that group's own total, and the groups
	// together must account for the window exactly. This is the one check a reader performs
	// against the donut, so a fold that dropped a bucket would be visible as a slice that
	// disagrees with its own line.
	var summed int64
	for _, group := range usage.groups {
		if got := seriesSum(group); got != group.Tokens {
			t.Fatalf("group %q series sums to %d but reports %d tokens", group.Model, got, group.Tokens)
		}
		summed += group.Tokens
	}
	if summed != usage.total {
		t.Fatalf("groups sum to %d, window reports %d", summed, usage.total)
	}
}

func TestBuildModelUsageTieBreaksByModelName(t *testing.T) {
	// Equal volumes are ordinary - two aliases of one model, or a window where one request
	// hit each - and without a total order the ranking would follow map iteration, so the
	// legend would reshuffle under the operator on every poll while describing the same data.
	for attempt := 0; attempt < 20; attempt++ {
		usage := buildModelUsage(modelWindow(modelTestFrom, modelTestTo, modelTestMS), []repository.UsageModelBucketRow{
			modelRow("zulu", 0, 50), modelRow("alpha", 0, 50), modelRow("mike", 0, 50),
		})
		for index, want := range []string{"alpha", "mike", "zulu"} {
			if usage.groups[index].Model != want {
				t.Fatalf("attempt %d: group %d = %q, want %q", attempt, index, usage.groups[index].Model, want)
			}
		}
	}
}

func TestBuildModelUsageDoesNotFoldWhenTheTopNIsNotExceeded(t *testing.T) {
	// Exactly five models is not "more than five": an empty folded group would draw a
	// zero-angle slice and a legend row naming nothing.
	usage := buildModelUsage(modelWindow(modelTestFrom, modelTestTo, modelTestMS), []repository.UsageModelBucketRow{
		modelRow("a", 0, 10), modelRow("b", 0, 20), modelRow("c", 0, 30),
		modelRow("d", 0, 40), modelRow("e", 0, 50),
	})
	if len(usage.groups) != 5 {
		t.Fatalf("got %d groups, want 5 with no folded remainder", len(usage.groups))
	}
	for _, group := range usage.groups {
		if group.Folded {
			t.Fatalf("group %q must not be folded", group.Model)
		}
	}
}

// TestBuildModelUsageKeepsAFoldedNameDistinctFromARealModel pins the reason the folded group is
// a discriminator rather than a reserved display name.
//
// The display label is the frontend's, translated, so the API has no way to know which name
// would be reserved - and a deployment may legitimately serve a model whose name collides with
// whatever that label is. A name-based test would merge real traffic into the remainder.
func TestBuildModelUsageKeepsAFoldedNameDistinctFromARealModel(t *testing.T) {
	rows := []repository.UsageModelBucketRow{modelRow("其他模型", 0, 9_000)}
	for index := 0; index < dashboardModelTopN; index++ {
		rows = append(rows, modelRow("model-"+string(rune('a'+index)), 0, int64(1000-index)))
	}
	usage := buildModelUsage(modelWindow(modelTestFrom, modelTestTo, modelTestMS), rows)

	var named, folded int
	for _, group := range usage.groups {
		if group.Folded {
			folded++
			continue
		}
		named++
		if group.Model == "其他模型" && group.Tokens != 9_000 {
			t.Fatalf("the real model's traffic was altered: %d tokens, want 9000", group.Tokens)
		}
	}
	if named != dashboardModelTopN {
		t.Fatalf("got %d named groups, want %d", named, dashboardModelTopN)
	}
	if folded != 1 {
		t.Fatalf("got %d folded groups, want 1", folded)
	}
	// The highest-volume model is the one whose name collides with the label, so it must rank
	// first rather than being mistaken for the remainder.
	if usage.groups[0].Folded || usage.groups[0].Model != "其他模型" {
		t.Fatalf("first group = %#v, want the real model ranked first", usage.groups[0])
	}
}

func TestBuildModelUsageZeroFillsEveryGroupAcrossTheWindow(t *testing.T) {
	// A model that went quiet halfway through must draw a line down to the axis, not a line
	// that stops: a series with missing buckets reads as absent data rather than as a model
	// that stopped being used.
	usage := buildModelUsage(modelWindow(modelTestFrom, modelTestTo, modelTestMS), []repository.UsageModelBucketRow{
		modelRow("busy", 0, 5),
		modelRow("quiet", 59, 5),
	})
	for _, group := range usage.groups {
		if len(group.Series) != 60 {
			t.Fatalf("group %q has %d buckets, want 60", group.Model, len(group.Series))
		}
		for index, point := range group.Series {
			if point.TimeMS != modelTestFrom+int64(index)*modelTestMS {
				t.Fatalf("group %q bucket %d is at %d, want %d", group.Model, index, point.TimeMS, modelTestFrom+int64(index)*modelTestMS)
			}
		}
	}
	if usage.groups[0].Model != "busy" || usage.groups[0].Series[0].Tokens != 5 || usage.groups[0].Series[59].Tokens != 0 {
		t.Fatalf("busy series = %#v", usage.groups[0].Series)
	}
}

func TestBuildModelUsageGridCoversTheWindowsOpeningBucket(t *testing.T) {
	// A custom window's start is not bucket-aligned, so the alignment matters: the grid is
	// floored to the bucket *containing* the window start rather than to the first boundary at
	// or after it. Starting at the next boundary would leave the window's opening minutes with
	// no bucket of their own, so traffic arriving in them would have to be pushed up to a full
	// bucket to the right of where it happened.
	window := modelWindow(modelTestFrom+30_000, modelTestTo, modelTestMS)
	usage := buildModelUsage(window, []repository.UsageModelBucketRow{
		{Model: "edge", StartMS: modelTestFrom, Tokens: 7, Requests: 1},
		modelRow("edge", 1, 3),
	})
	if len(usage.groups) != 1 {
		t.Fatalf("got %d groups, want 1", len(usage.groups))
	}
	group := usage.groups[0]
	if group.Tokens != 10 {
		t.Fatalf("group total = %d, want 10", group.Tokens)
	}
	if got := seriesSum(group); got != 10 {
		t.Fatalf("series sums to %d, want 10 - the partial edge bucket was dropped", got)
	}
	// The grid's first point is the start of the bucket containing the window start, so the
	// other event in that same bucket is drawn where it happened.
	if group.Series[0].TimeMS != modelTestFrom || group.Series[0].Tokens != 7 {
		t.Fatalf("grid bucket 0 = %#v, want the window's opening bucket carrying 7", group.Series[0])
	}
	if group.Series[1].Tokens != 3 {
		t.Fatalf("grid bucket 1 = %d tokens, want 3", group.Series[1].Tokens)
	}
}

func TestNearestModelBucketKeepsAnOutOfGridBucketOnTheSeries(t *testing.T) {
	// The fallback itself, exercised directly: floor alignment means the query's buckets and the
	// grid normally coincide, and a resolution that *panicked* or returned a position outside the
	// series on the rare disagreement would take the whole dashboard down rather than misplace one
	// point. Traffic is still counted either way, which is what the containment check asserts.
	grid, index := modelUsageGrid(modelWindow(modelTestFrom, modelTestTo, modelTestMS))
	if position := nearestModelBucket(index, grid, modelTestFrom); position != 0 {
		t.Fatalf("the window's first bucket resolved to %d, want 0", position)
	}
	if position := nearestModelBucket(index, grid, modelTestFrom-3*modelTestMS); position != 0 {
		t.Fatalf("a bucket before the grid resolved to %d, want 0", position)
	}
	if position := nearestModelBucket(index, grid, modelTestTo+3*modelTestMS); position != len(grid)-1 {
		t.Fatalf("a bucket after the grid resolved to %d, want %d", position, len(grid)-1)
	}
}

func TestBuildModelUsageHandlesAnEmptyWindow(t *testing.T) {
	// No traffic at all: the response must be an empty list rather than a single zero slice,
	// which the donut would draw as a ring with no angle and the legend as a category the
	// window does not have.
	usage := buildModelUsage(modelWindow(modelTestFrom, modelTestTo, modelTestMS), nil)
	if usage.total != 0 {
		t.Fatalf("total = %d, want 0", usage.total)
	}
	if len(usage.groups) != 0 {
		t.Fatalf("got %d groups, want none", len(usage.groups))
	}
}

func TestBuildModelUsageHandlesAWindowShorterThanOneBucket(t *testing.T) {
	// A custom range can be arbitrarily short. The grid then holds a single bucket, and the
	// fold and the containment checks must still hold.
	window := modelWindow(modelTestFrom+1_000, modelTestFrom+2_000, modelTestMS)
	usage := buildModelUsage(window, []repository.UsageModelBucketRow{modelRow("brief", 0, 4)})
	if len(usage.groups) != 1 {
		t.Fatalf("got %d groups, want 1", len(usage.groups))
	}
	if len(usage.groups[0].Series) != 1 {
		t.Fatalf("got %d buckets, want 1", len(usage.groups[0].Series))
	}
	if got := seriesSum(usage.groups[0]); got != usage.groups[0].Tokens {
		t.Fatalf("series sums to %d, group reports %d", got, usage.groups[0].Tokens)
	}
}
