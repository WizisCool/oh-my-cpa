package api

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// dashboardModelTopN is how many named models the panels carry before the remainder is
// folded into one group.
//
// Five is a reading constraint, not a technical one. The trend mark draws one line per
// group on a grid the dashboard already keeps near 48 buckets, and the donut's legend is a
// text list beside the ring: past about six entries the legend stops being scannable and
// the lines stop being separable by colour. Model count on a real deployment routinely runs
// into the dozens (aliases, dated revisions, per-provider variants), which is exactly why
// the list cannot simply be everything that appears in the window.
const dashboardModelTopN = 5

type dashboardModelsResponse struct {
	Window dashboardWindow `json:"window"`
	// TokenTotal is the window's own total, summed from the same rows the groups were
	// built from. It is deliberately not copied from the KPI tiles' response: the two
	// panels read on different cadences, so they can legitimately describe slightly
	// different instants, and borrowing the tiles' number would let the donut's centre
	// disagree with the slices around it.
	TokenTotal int64 `json:"total_tokens"`
	// Models is ranked by token volume, descending, with the folded group last.
	Models []dashboardModelUsage `json:"models"`
	// Errors reports what could not be read, so a panel can say its numbers are partial
	// rather than presenting a short list as the whole picture.
	Errors []string `json:"partial_errors"`
}

type dashboardModelUsage struct {
	// Model is the upstream model name, meaningful only when Folded is false.
	Model string `json:"model"`
	// Folded marks the aggregate group holding every model outside the top N. It is a
	// separate discriminator rather than a reserved display name: a deployment may
	// legitimately serve a model whose name collides with whatever label the group would
	// use, and a name-based test would then silently merge real traffic into the
	// remainder or split the remainder in two.
	Folded   bool  `json:"folded"`
	Tokens   int64 `json:"tokens"`
	Requests int64 `json:"requests"`
	// Series is the group's own token volume on the window's bucket grid, zero-filled so
	// every group spans the whole window. Without that a model that went quiet halfway
	// through would draw a line that stops, which reads as a gap in the data rather than
	// as a model that stopped being used.
	Series []dashboardModelPoint `json:"series"`
}

type dashboardModelPoint struct {
	TimeMS int64 `json:"t"`
	Tokens int64 `json:"tokens"`
}

// dashboardModels answers the dashboard's two model-level panels.
//
// It is a separate endpoint rather than a block on the dashboard response for the reasons
// ADR 0005 recorded for the token heatmap, and they still hold here. Its aggregation walks
// the detail rows instead of the rollup, which is far more expensive than the KPI tiles'
// read; attaching it to `/management/dashboard` would pay that cost on every live tail poll,
// which fires as often as every five seconds. It answers for the window the picker selected
// but on its own cadence, and it is allowed to fail alone: an unavailable read leaves the six
// tiles and the activity grid beside it readable.
//
// The window is resolved by the same `dashboardWindowFromRequest` the tiles use, so the two
// surfaces cannot disagree about what "last 24 hours" means.
func (h *Handler) dashboardModels(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")

	window, windowErr := dashboardWindowFromRequest(request, time.Now().UTC())
	if windowErr != "" {
		writeError(writer, http.StatusBadRequest, windowErr)
		return
	}
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()

	response := dashboardModelsResponse{Window: window, Models: []dashboardModelUsage{}, Errors: []string{}}
	rows, err := h.repo.QueryUsageModelBuckets(ctx, defaultInstanceID(), window.FromMS, window.ToMS, window.BucketMS)
	if err != nil {
		writeInternalError(writer, fmt.Errorf("query usage model buckets: %w", err))
		return
	}

	models := buildModelUsage(window, rows)
	response.TokenTotal = models.total
	response.Models = models.groups
	writeJSON(writer, http.StatusOK, response)
}

// modelUsage is the ranked, grid-filled form of the repository's rows.
type modelUsage struct {
	total  int64
	groups []dashboardModelUsage
}

// buildModelUsage ranks the window's models and lays their buckets onto the response grid.
//
// It is a pure function of the rows and the window, which is what makes the parts that are
// easy to get quietly wrong - the tie-break, the fold boundary, and the handling of a bucket
// that falls outside the grid - testable without a database or a request.
func buildModelUsage(window dashboardWindow, rows []repository.UsageModelBucketRow) modelUsage {
	// The grid is built once and shared by every group, so all groups are the same length
	// and bucket i means the same instant in each of them. The trend mark and the donut
	// then describe one grid rather than six independent ones.
	grid, index := modelUsageGrid(window)

	// One pass per model: the rows arrive grouped by model, so the totals and the series
	// are accumulated together and cannot disagree with each other.
	type accumulator struct {
		model    string
		tokens   int64
		requests int64
		series   []dashboardModelPoint
	}
	accumulators := []*accumulator{}
	byModel := map[string]*accumulator{}
	for _, row := range rows {
		entry, exists := byModel[row.Model]
		if !exists {
			entry = &accumulator{model: row.Model, series: cloneModelGrid(grid)}
			byModel[row.Model] = entry
			accumulators = append(accumulators, entry)
		}
		entry.tokens += row.Tokens
		entry.requests += row.Requests
		// A bucket outside the visible grid - a partial edge bucket, because the query truncates
		// timestamps to the bucket width while a custom window's own bounds are arbitrary - is
		// folded into the nearest point rather than dropped. Dropping it would make the series
		// disagree with the group's own total, which is the one internal check a reader can
		// perform against the donut. Floor-aligning the grid means the query's buckets and this
		// grid normally agree exactly, so this is a guard rather than a path a preset takes.
		entry.series[nearestModelBucket(index, grid, row.StartMS)].Tokens += row.Tokens
	}

	// Ranked by token volume, ties broken by model name.
	//
	// The tie-break is not cosmetic. Equal volumes are common - two aliases of one model
	// behind the same credential, or a window where exactly one request hit each model - and
	// without a total order their order would come from the map iteration above, so the same
	// window could rank differently between two reads and the legend would reshuffle under
	// the operator on every poll.
	sort.SliceStable(accumulators, func(left, right int) bool {
		if accumulators[left].tokens != accumulators[right].tokens {
			return accumulators[left].tokens > accumulators[right].tokens
		}
		return accumulators[left].model < accumulators[right].model
	})

	result := modelUsage{groups: make([]dashboardModelUsage, 0, len(accumulators))}
	folded := &accumulator{series: cloneModelGrid(grid)}
	for position, entry := range accumulators {
		result.total += entry.tokens
		if position < dashboardModelTopN {
			result.groups = append(result.groups, dashboardModelUsage{
				Model:    entry.model,
				Tokens:   entry.tokens,
				Requests: entry.requests,
				Series:   entry.series,
			})
			continue
		}
		folded.tokens += entry.tokens
		folded.requests += entry.requests
		for bucket := range folded.series {
			folded.series[bucket].Tokens += entry.series[bucket].Tokens
		}
	}
	// The folded group is appended only when it holds something. An empty remainder would
	// draw a zero-height legend row and, on the donut, a slice with no angle at all - which
	// is a category the window does not actually have.
	if len(result.groups) < len(accumulators) {
		result.groups = append(result.groups, dashboardModelUsage{
			Folded:   true,
			Tokens:   folded.tokens,
			Requests: folded.requests,
			Series:   folded.series,
		})
	}
	return result
}

// modelUsageGrid builds the bucket grid and the position of each bucket in it.
//
// The grid is floored to the bucket containing the window start, so the first point covers the
// part of that bucket the window includes and the last covers the part it includes of its own.
// This is deliberately not the alignment `fillDashboardBuckets` uses for the KPI series, which
// starts at the first boundary *at or after* the window start: that grid has no bucket covering
// the window's opening minutes, so it has to fold a leading partial bucket into its first point
// and place those events up to a full bucket to the right of where they happened. Reading the
// containing bucket instead keeps every event in the bucket it belongs to, and it is what makes
// a window shorter than one bucket a one-point grid rather than an empty one.
//
// The two grids therefore differ by at most one leading bucket, which is why these panels take
// their own window and their own total rather than borrowing the tiles'.
func modelUsageGrid(window dashboardWindow) ([]dashboardModelPoint, map[int64]int) {
	if window.BucketMS <= 0 || window.ToMS < window.FromMS {
		return nil, map[int64]int{}
	}
	start := window.FromMS - (window.FromMS % window.BucketMS)
	if start > window.FromMS {
		start -= window.BucketMS
	}
	grid := []dashboardModelPoint{}
	for at := start; at <= window.ToMS; at += window.BucketMS {
		grid = append(grid, dashboardModelPoint{TimeMS: at})
	}
	index := make(map[int64]int, len(grid))
	for position, point := range grid {
		index[point.TimeMS] = position
	}
	return grid, index
}

// nearestModelBucket resolves an aggregated bucket start to a grid position.
//
// The query aligns buckets by truncating the timestamp, so its buckets and this grid share
// the same origin and in practice agree exactly. The fallback exists for the boundary case:
// a bucket that starts outside the grid - possible when the window's own start is not
// bucket-aligned - is folded into the nearest end so no captured traffic vanishes from a
// series while still being counted in the group's total.
func nearestModelBucket(index map[int64]int, grid []dashboardModelPoint, startMS int64) int {
	if position, exists := index[startMS]; exists {
		return position
	}
	if len(grid) == 0 {
		return 0
	}
	if startMS < grid[0].TimeMS {
		return 0
	}
	return len(grid) - 1
}

func cloneModelGrid(grid []dashboardModelPoint) []dashboardModelPoint {
	cloned := make([]dashboardModelPoint, len(grid))
	copy(cloned, grid)
	return cloned
}
