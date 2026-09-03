package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage/ingest"
)

// maxDashboardWindow bounds a custom range.
const maxDashboardWindow = 365 * 24 * time.Hour

// dashboardTargetBuckets is the sparkline resolution the UI expects; the actual
// bucket width is snapped to a human-friendly step.
const dashboardTargetBuckets = 48

// dashboardPresets maps the UI range picker to a window length.
//
// "15m" is what the picker labels 实时: one minute per bucket over fifteen, so
// the newest bucket visibly grows instead of waiting an hour to appear.
var dashboardPresets = map[string]time.Duration{
	"15m": 15 * time.Minute,
	"1h":  time.Hour,
	"6h":  6 * time.Hour,
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
	"30d": 30 * 24 * time.Hour,
	"90d": 90 * 24 * time.Hour,
}

// dashboardSeriesBucket are the allowed sparkline widths.
var dashboardSeriesBucket = []time.Duration{
	time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 15 * time.Minute,
	30 * time.Minute, time.Hour, 2 * time.Hour, 3 * time.Hour, 6 * time.Hour,
	12 * time.Hour, 24 * time.Hour, 2 * 24 * time.Hour, 3 * 24 * time.Hour,
	6 * 24 * time.Hour, 7 * 24 * time.Hour,
}

type dashboardResponse struct {
	Window   dashboardWindow   `json:"window"`
	Requests dashboardRequests `json:"requests"`
	Tokens   dashboardTokens   `json:"tokens"`
	Metrics  dashboardMetrics  `json:"metrics"`
	Coverage dashboardCoverage `json:"coverage"`
	Errors   []string          `json:"partial_errors"`
}

type dashboardWindow struct {
	Preset   string `json:"preset,omitempty"`
	FromMS   int64  `json:"from"`
	ToMS     int64  `json:"to"`
	BucketMS int64  `json:"bucket_ms"`
	Minutes  int    `json:"minutes"`
	Complete bool   `json:"complete"`
	// OpenEnd marks a range whose end tracks the current time ("至今"). The
	// client polls those the same way it polls a relative preset.
	OpenEnd bool `json:"open_end"`
}

type dashboardRequests struct {
	Total       int64                  `json:"total"`
	Success     int64                  `json:"success"`
	Failed      int64                  `json:"failed"`
	SuccessRate *float64               `json:"success_rate"`
	Series      []dashboardSeriesPoint `json:"series"`
}

type dashboardTokens struct {
	Total         int64                  `json:"total"`
	Input         int64                  `json:"input"`
	Output        int64                  `json:"output"`
	Reasoning     int64                  `json:"reasoning"`
	Cached        int64                  `json:"cached"`
	CacheRead     int64                  `json:"cache_read"`
	CacheCreation int64                  `json:"cache_creation"`
	Series        []dashboardSeriesPoint `json:"series"`
}

type dashboardSeriesPoint struct {
	TimeMS   int64 `json:"t"`
	Requests int64 `json:"v"`
	Failures int64 `json:"f"`
	Tokens   int64 `json:"tokens"`
}

type dashboardMetrics struct {
	RPM          *float64 `json:"rpm"`
	TPM          *float64 `json:"tpm"`
	CacheRate    *float64 `json:"cache_rate"`
	Cost         float64  `json:"cost"`
	CostSource   string   `json:"cost_source"`
	CostNote     string   `json:"cost_note"`
	AvgLatencyMS *float64 `json:"avg_latency_ms"`
	AvgTTFTMS    *float64 `json:"avg_ttft_ms"`
}

type dashboardCoverage struct {
	FromRollup   int64 `json:"rollup_requests"`
	FromDetails  int64 `json:"detail_requests"`
	PendingInbox int64 `json:"pending_inbox"`
	Events       int64 `json:"stored_events"`
}

// dashboardTailResponse is the live-poll shape. It carries the same window
// numbers as dashboardResponse but a trimmed series, and it deliberately has no
// coverage block: a poll that answers with zero-valued coverage would let the
// UI paint "0 stored events" while the collector is quietly healthy.
type dashboardTailResponse struct {
	Window   dashboardWindow   `json:"window"`
	Requests dashboardRequests `json:"requests"`
	Tokens   dashboardTokens   `json:"tokens"`
	Metrics  dashboardMetrics  `json:"metrics"`
	Live     dashboardLive     `json:"live"`
	Errors   []string          `json:"partial_errors"`
}

// dashboardLive tells the client where the returned tail sits so it can splice
// it onto the series it cached from the full response.
type dashboardLive struct {
	// AsOfMS is the instant the window was evaluated; the next poll should
	// expect at least this much drift.
	AsOfMS int64 `json:"as_of_ms"`
	// BucketMS is the grid step, so the UI can pace itself to the resolution it
	// is actually being served.
	BucketMS int64 `json:"bucket_ms"`
	// SeriesStartMS is the first bucket of the full grid. Anything the client
	// holds before it has slid out of the window.
	SeriesStartMS int64 `json:"series_start_ms"`
	// TailFromMS is the first bucket this response carries.
	TailFromMS int64 `json:"tail_from_ms"`
}

// dashboardTailBuckets is how many trailing buckets a live poll re-ships. The
// newest bucket is always the one still filling, so two would already cover a
// tick; four leaves room for the aggregation watermark to land late without the
// client seeing a hole it has to refetch around.
const dashboardTailBuckets = 4

// usagePipeline lets the handler report the background collector state. Wired by
// app.New; nil when ingestion is disabled.
type usagePipeline interface {
	Status(ctx context.Context) (ingest.PipelineStatus, error)
}

// SetUsagePipeline attaches the collector for the status endpoint.
func (h *Handler) SetUsagePipeline(pipeline usagePipeline) {
	if pipeline == nil {
		return
	}
	h.usage = pipeline
}

// dashboard answers purely from Oh My CPA's own database.
//
// This is deliberate: CPA's usage queue is destructive and short-lived, so the
// history the UI promises can only come from records we captured ourselves. It
// also means the dashboard keeps working while CPA is offline.
func (h *Handler) dashboard(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")

	now := time.Now().UTC()
	window, windowErr := dashboardWindowFromRequest(request, now)
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

	response := newDashboardResponse(window)
	facts, err := h.queryDashboard(ctx, window)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(writer, http.StatusOK, response)
			return
		}
		writeInternalError(writer, fmt.Errorf("query usage analytics: %w", err))
		return
	}

	response.Requests = facts.requests
	response.Tokens = facts.tokens
	response.Metrics = facts.metrics
	response.Coverage.FromRollup = facts.rollup
	response.Coverage.FromDetails = facts.details
	// Collector stats are the one block a live poll skips: they describe the
	// pipeline, not the window, and they move far slower than the numbers
	// printed next to them.
	if stats, statsErr := h.repo.StatsUsagePipeline(ctx); statsErr == nil {
		response.Coverage.PendingInbox = stats.Pending
		response.Coverage.Events = stats.Events
	} else {
		response.Errors = append(response.Errors, "pipeline stats unavailable")
	}
	writeJSON(writer, http.StatusOK, response)
}

// dashboardTail is the live-poll sibling of dashboard.
//
// A sliding relative window has no cheap "nothing changed" answer: its totals
// move on every tick even when no request arrived, because the left edge keeps
// dropping old events. So this endpoint recomputes the whole window's numbers —
// exactly the ones the KPI tiles print — and only trims what the browser
// already holds: the two series ship their last buckets instead of the full
// grid, and the collector stats are left out.
func (h *Handler) dashboardTail(writer http.ResponseWriter, request *http.Request) {
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

	response := dashboardTailResponse{
		Window:   window,
		Requests: dashboardRequests{Series: []dashboardSeriesPoint{}},
		Tokens:   dashboardTokens{Series: []dashboardSeriesPoint{}},
		Metrics:  placeholderDashboardMetrics(),
		Live: dashboardLive{
			AsOfMS:   window.ToMS,
			BucketMS: window.BucketMS,
		},
		Errors: []string{},
	}

	facts, err := h.queryDashboard(ctx, window)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(writer, http.StatusOK, response)
			return
		}
		writeInternalError(writer, fmt.Errorf("query usage analytics: %w", err))
		return
	}

	response.Requests = facts.requests
	response.Requests.Series = tailBuckets(facts.requests.Series, dashboardTailBuckets)
	response.Tokens = facts.tokens
	response.Tokens.Series = tailBuckets(facts.tokens.Series, dashboardTailBuckets)
	response.Metrics = facts.metrics
	// Both series come off the same zero-filled grid, so one pair of markers
	// describes where the tail sits for both of them.
	response.Live.SeriesStartMS = firstBucketMS(facts.requests.Series)
	response.Live.TailFromMS = firstBucketMS(response.Requests.Series)
	writeJSON(writer, http.StatusOK, response)
}

// placeholderDashboardMetrics is the cost block a window reports before any
// row has been read: an explicit placeholder, never a silent zero.
func placeholderDashboardMetrics() dashboardMetrics {
	return dashboardMetrics{
		CostSource: "placeholder",
		CostNote:   "model pricing is not configured yet",
	}
}

// newDashboardResponse builds the empty shell both endpoints start from, so a
// query that finds nothing still answers with a complete, renderable window.
func newDashboardResponse(window dashboardWindow) dashboardResponse {
	return dashboardResponse{
		Window:   window,
		Requests: dashboardRequests{Series: []dashboardSeriesPoint{}},
		Tokens:   dashboardTokens{Series: []dashboardSeriesPoint{}},
		Metrics:  placeholderDashboardMetrics(),
		Errors:   []string{},
	}
}

// tailBuckets keeps the last n points of an ordered series without copying the
// whole slice when nothing needs trimming.
func tailBuckets(points []dashboardSeriesPoint, n int) []dashboardSeriesPoint {
	if len(points) <= n {
		return points
	}
	return points[len(points)-n:]
}

func firstBucketMS(points []dashboardSeriesPoint) int64 {
	if len(points) == 0 {
		return 0
	}
	return points[0].TimeMS
}

// dashboardFacts is everything both endpoints derive from one analytics query.
// Keeping the mapping in one place is what lets the tail answer claim the same
// totals as the full response without a second implementation to drift.
type dashboardFacts struct {
	requests dashboardRequests
	tokens   dashboardTokens
	metrics  dashboardMetrics
	rollup   int64
	details  int64
}

// queryDashboard aggregates the window into response bodies.
func (h *Handler) queryDashboard(ctx context.Context, window dashboardWindow) (dashboardFacts, error) {
	facts := dashboardFacts{
		requests: dashboardRequests{Series: []dashboardSeriesPoint{}},
		tokens:   dashboardTokens{Series: []dashboardSeriesPoint{}},
		metrics:  placeholderDashboardMetrics(),
	}
	analytics, err := h.repo.QueryUsageAnalytics(ctx, defaultInstanceID(),
		window.FromMS, window.ToMS, window.BucketMS)
	if err != nil {
		return facts, err
	}

	totals := analytics.Totals
	success := totals.Requests - totals.Failures
	if success < 0 {
		success = 0
	}
	facts.requests.Total = totals.Requests
	facts.requests.Success = success
	facts.requests.Failed = totals.Failures
	if totals.Requests > 0 {
		rate := roundPercent(float64(success) / float64(totals.Requests))
		facts.requests.SuccessRate = &rate
	}
	facts.tokens.Total = totals.TotalTokens
	facts.tokens.Input = totals.InputTokens
	facts.tokens.Output = totals.OutputTokens
	facts.tokens.Reasoning = totals.ReasoningTokens
	facts.tokens.Cached = totals.CachedTokens
	facts.tokens.CacheRead = totals.CacheReadTokens
	facts.tokens.CacheCreation = totals.CacheCreationTokens

	minutes := float64(window.ToMS-window.FromMS) / float64(time.Minute/time.Millisecond)
	if minutes < 1 {
		minutes = 1
	}
	if totals.Requests > 0 {
		rpm := roundRate(float64(totals.Requests) / minutes)
		facts.metrics.RPM = &rpm
	}
	if totals.TotalTokens > 0 {
		tpm := roundRate(float64(totals.TotalTokens) / minutes)
		facts.metrics.TPM = &tpm
	}
	// Cache rate is cache reads over prompt tokens.
	//
	// Two traps make this exceed 100% if written naively. CPA's canonical
	// accounting keeps Input.Total = uncached + cacheRead + cacheWrite, so the
	// denominator must be input tokens, not total (which also carries output).
	// And cached_tokens overlaps cache_read_tokens for the same event, so they
	// are alternatives, never a sum.
	if numerator, denominator := cacheRateParts(totals); denominator > 0 {
		rate := roundPercent(float64(numerator) / float64(denominator))
		facts.metrics.CacheRate = &rate
	}
	if totals.Requests > 0 {
		latency := roundTwo(float64(totals.LatencySumMS) / float64(totals.Requests))
		facts.metrics.AvgLatencyMS = &latency
	}
	if totals.TTFTCount > 0 {
		ttft := roundTwo(float64(totals.TTFTSumMS) / float64(totals.TTFTCount))
		facts.metrics.AvgTTFTMS = &ttft
	}
	// Cost stays a documented zero until a pricing model exists.
	facts.metrics.Cost = 0

	// Zero-fill every bucket in the window. A GROUP BY over sparse data returns
	// only the buckets that have rows, and because the window slides with
	// "now", a refresh can silently merge two populated buckets into one and
	// collapse the sparkline. A fixed grid keeps the series stable.
	series := fillDashboardBuckets(window.FromMS, window.ToMS, window.BucketMS, analytics.Buckets)
	for _, point := range series {
		facts.requests.Series = append(facts.requests.Series, point)
		facts.tokens.Series = append(facts.tokens.Series, dashboardSeriesPoint{
			TimeMS: point.TimeMS, Tokens: point.Tokens,
		})
	}

	facts.rollup = analytics.FromRollup
	facts.details = analytics.FromEvents
	return facts, nil
}

// dashboardIngestStatus reports the capture/decode/maintenance loops.
func (h *Handler) dashboardIngestStatus(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.usage == nil {
		writeJSON(writer, http.StatusOK, map[string]any{
			"enabled": false,
			"note":    "usage ingestion is disabled for this deployment",
		})
		return
	}
	status, err := h.usage.Status(request.Context())
	if err != nil {
		writeInternalError(writer, fmt.Errorf("read usage pipeline status: %w", err))
		return
	}
	writeJSON(writer, http.StatusOK, status)
}

func dashboardWindowFromRequest(request *http.Request, now time.Time) (dashboardWindow, string) {
	query := request.URL.Query()
	preset := strings.ToLower(strings.TrimSpace(query.Get("preset")))
	rawFrom := strings.TrimSpace(query.Get("from"))
	rawTo := strings.TrimSpace(query.Get("to"))

	nowMS := now.UnixMilli()
	fromMS := int64(0)
	toMS := nowMS
	openEnd := false

	switch {
	case rawFrom != "" || rawTo != "":
		if rawFrom == "" {
			return dashboardWindow{}, "from is required when to is set"
		}
		parsedFrom, errFrom := parseMilli(rawFrom)
		if errFrom != nil {
			return dashboardWindow{}, "from and to must be epoch milliseconds"
		}
		parsedTo := nowMS
		// A range with no end is "至今": the end keeps following the current
		// time, which is what makes it worth polling.
		if rawTo != "" {
			var errTo error
			if parsedTo, errTo = parseMilli(rawTo); errTo != nil {
				return dashboardWindow{}, "from and to must be epoch milliseconds"
			}
		} else {
			openEnd = true
		}
		if parsedTo > nowMS {
			parsedTo = nowMS
		}
		if parsedFrom >= parsedTo {
			return dashboardWindow{}, "from must be earlier than to"
		}
		// Bound the window: an unbounded custom range should be an export job,
		// not an interactive query. A "至今" range is unbounded by definition,
		// so it is bounded by the same cap measured back from now.
		if parsedTo-parsedFrom > maxDashboardWindow.Milliseconds() {
			return dashboardWindow{}, fmt.Sprintf("custom range must not exceed %s", maxDashboardWindow)
		}
		fromMS, toMS = parsedFrom, parsedTo
		preset = "custom"
	case preset == "":
		preset = "24h"
		fallthrough
	default:
		span, known := dashboardPresets[preset]
		if !known {
			return dashboardWindow{}, "preset must be one of 15m, 1h, 6h, 24h, 7d, 30d, 90d"
		}
		fromMS, toMS = nowMS-span.Milliseconds(), nowMS
	}

	bucket := dashboardBucketWidth(time.Duration(toMS-fromMS) * time.Millisecond)
	return dashboardWindow{
		Preset:   preset,
		FromMS:   fromMS,
		ToMS:     toMS,
		BucketMS: bucket.Milliseconds(),
		Minutes:  int((toMS - fromMS) / 60000),
		Complete: true,
		OpenEnd:  openEnd,
	}, ""
}

// cacheRateParts picks the numerator and denominator for the cache hit ratio.
//
// Providers disagree about what `input_tokens` means and CPA's payload carries
// both conventions:
//
//   - OpenAI-style: input already contains the cached prefix, so cache_read is
//     at most input and the ratio is cache_read / input.
//   - Anthropic-style: input_tokens counts only *new* prompt tokens while
//     cache_read_input_tokens is reported separately, so cache_read can exceed
//     input and the prompt side is really input + cache_read.
//
// Comparing the two selects the right denominator for either convention and
// keeps the ratio bounded at 100%. cached_tokens overlaps cache_read_tokens, so
// it only serves as a fallback for older payloads without the read field.
func cacheRateParts(totals repository.UsageTotals) (int64, int64) {
	numerator := totals.CacheReadTokens
	if numerator == 0 {
		numerator = totals.CachedTokens
	}
	if numerator < 0 {
		numerator = 0
	}
	prompt := totals.InputTokens
	if prompt <= 0 {
		// No prompt breakdown: fall back to the prompt side of the total.
		prompt = totals.TotalTokens - totals.OutputTokens
	}
	if prompt < 0 {
		prompt = 0
	}
	denominator := prompt
	if numerator > prompt {
		denominator = prompt + numerator
	}
	return numerator, denominator
}

// fillDashboardBuckets lays aggregated buckets onto a fixed grid spanning the
// whole window, emitting zero-valued points where nothing was recorded.
func fillDashboardBuckets(fromMS, toMS, bucketMS int64, buckets []repository.UsageBucket) []dashboardSeriesPoint {
	if bucketMS <= 0 {
		return nil
	}
	// Align the first bucket to a multiple of bucketMS so the grid does not
	// shift as the window slides.
	start := fromMS - (fromMS % bucketMS)
	if start < fromMS {
		start += bucketMS
	}
	points := []dashboardSeriesPoint{}
	for at := start; at <= toMS; at += bucketMS {
		points = append(points, dashboardSeriesPoint{TimeMS: at})
	}
	if len(points) == 0 {
		return points
	}
	index := make(map[int64]int, len(points))
	for position, point := range points {
		index[point.TimeMS] = position
	}
	for _, bucket := range buckets {
		started := bucket.StartMS - (bucket.StartMS % bucketMS)
		if bucket.StartMS%bucketMS != 0 {
			started += bucketMS
		}
		position, exists := index[started]
		if !exists {
			// Bucket outside the visible grid (partial edge bucket); fold it into
			// the nearest point so no captured traffic is dropped.
			if started < points[0].TimeMS {
				position = 0
			} else {
				position = len(points) - 1
			}
		}
		points[position].Requests += bucket.Requests
		points[position].Failures += bucket.Failures
		points[position].Tokens += bucket.TotalTokens
	}
	return points
}

// dashboardBucketWidth snaps a window to the smallest friendly step that keeps
// the sparkline near the target point count.
func dashboardBucketWidth(span time.Duration) time.Duration {
	for _, candidate := range dashboardSeriesBucket {
		if span/candidate <= dashboardTargetBuckets {
			return candidate
		}
	}
	return dashboardSeriesBucket[len(dashboardSeriesBucket)-1]
}

func parseMilli(raw string) (int64, error) {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return 0, err
	}
	if value <= 0 {
		return 0, errors.New("timestamp must be positive")
	}
	return value, nil
}

func (h *Handler) queryTimeout() time.Duration {
	if h.cfg.RequestTimeout > 0 {
		return h.cfg.RequestTimeout
	}
	return 15 * time.Second
}

func roundPercent(ratio float64) float64 {
	return roundTwo(ratio * 100)
}

// roundRate keeps small rates readable: 20 requests over 90 days is a real
// signal, and rounding it to "0" would read as "no traffic".
func roundRate(value float64) float64 {
	if value > 0 && value < 1 {
		return float64(int64(value*10000+0.5)) / 10000
	}
	return roundTwo(value)
}

func roundTwo(value float64) float64 {
	return float64(int64(value*100+0.5)) / 100
}
