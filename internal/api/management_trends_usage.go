package api

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"net/http"
	"slices"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type TrendsUsageGroupMeasuresDTO struct {
	Requests    int64 `json:"requests"`
	NetTokens   int64 `json:"net_tokens"`
	TotalTokens int64 `json:"total_tokens"`
	CostNanos   int64 `json:"cost_nanos"`
}

type TrendsUsageTotalsDTO struct {
	TrendsUsageGroupMeasuresDTO
	Failures            int64    `json:"failures"`
	PromptTokens        int64    `json:"prompt_tokens"`
	CompletionTokens    int64    `json:"completion_tokens"`
	ReasoningTokens     int64    `json:"reasoning_tokens"`
	CacheReadTokens     int64    `json:"cache_read_tokens"`
	CacheCreationTokens int64    `json:"cache_creation_tokens"`
	CacheRate           *float64 `json:"cache_rate"`
	ReasoningShare      *float64 `json:"reasoning_share"`
	PricedRequests      int64    `json:"priced_requests"`
	CostedRequests      int64    `json:"costed_requests"`
}

type TrendsUsageCompareTotalsDTO struct {
	TrendsUsageGroupMeasuresDTO
	BaselineRequests    int64 `json:"baseline_requests"`
	BaselineNetTokens   int64 `json:"baseline_net_tokens"`
	BaselineTotalTokens int64 `json:"baseline_total_tokens"`
	BaselineCostNanos   int64 `json:"baseline_cost_nanos"`
}

type TrendsUsageBucketDTO struct {
	StartMS int64 `json:"start_ms"`
	TrendsUsageGroupMeasuresDTO
	CumNetTokens          int64    `json:"cum_net_tokens"`
	CumTotalTokens        int64    `json:"cum_total_tokens"`
	CumRequests           int64    `json:"cum_requests"`
	CumCostNanos          int64    `json:"cum_cost_nanos"`
	CompareNetTokens      *int64   `json:"compare_net_tokens,omitempty"`
	CompareCumNetTokens   *int64   `json:"compare_cum_net_tokens,omitempty"`
	CompareTotalTokens    *int64   `json:"compare_total_tokens,omitempty"`
	CompareCumTotalTokens *int64   `json:"compare_cum_total_tokens,omitempty"`
	CompareRequests       *int64   `json:"compare_requests,omitempty"`
	CompareCumRequests    *int64   `json:"compare_cum_requests,omitempty"`
	CacheRate             *float64 `json:"cache_rate,omitempty"`
	ReasoningShare        *float64 `json:"reasoning_share,omitempty"`
	PromptTokens          int64    `json:"prompt_tokens"`
	CompletionTokens      int64    `json:"completion_tokens"`
	ReasoningTokens       int64    `json:"reasoning_tokens"`
	CacheReadTokens       int64    `json:"cache_read_tokens"`
}

type TrendsUsageGroupBucketDTO struct {
	StartMS int64 `json:"start_ms"`
	TrendsUsageGroupMeasuresDTO
}

type TrendsUsageGroupSeriesDTO struct {
	trendsGroupName
	TrendsUsageGroupMeasuresDTO
	Folded  bool                        `json:"folded"`
	Buckets []TrendsUsageGroupBucketDTO `json:"buckets"`
}

type TrendsMoverItemDTO struct {
	trendsGroupName
	NetTokens         int64    `json:"net_tokens"`
	Requests          int64    `json:"requests"`
	BaselineNetTokens int64    `json:"baseline_net_tokens"`
	BaselineRequests  int64    `json:"baseline_requests"`
	DeltaNetTokens    int64    `json:"delta_net_tokens"`
	DeltaRequests     int64    `json:"delta_requests"`
	DeltaPercent      *float64 `json:"delta_percent,omitempty"`
	ZScore            float64  `json:"z_score"`
	Status            string   `json:"status"`
}

type TrendsMoversDTO struct {
	Metric  string               `json:"metric"`
	Risers  []TrendsMoverItemDTO `json:"risers"`
	Fallers []TrendsMoverItemDTO `json:"fallers"`
}

type TrendsUsageGroupOptionDTO struct {
	trendsGroupName
	Requests int64 `json:"requests"`
}

type TrendsUsageResponseDTO struct {
	Window        insightsWindow               `json:"window"`
	CompareWindow *insightsCompareWindow       `json:"compare_window"`
	GroupBy       string                       `json:"group_by"`
	Totals        TrendsUsageTotalsDTO         `json:"totals"`
	CompareTotals *TrendsUsageCompareTotalsDTO `json:"compare_totals,omitempty"`
	Buckets       []TrendsUsageBucketDTO       `json:"buckets"`
	Groups        []TrendsUsageGroupOptionDTO  `json:"groups,omitempty"`
	Series        []TrendsUsageGroupSeriesDTO  `json:"series"`
	Movers        TrendsMoversDTO              `json:"movers"`
	Coverage      insightsCoverage             `json:"coverage"`
}

func (measures *TrendsUsageGroupMeasuresDTO) add(other TrendsUsageGroupMeasuresDTO) {
	measures.Requests += other.Requests
	measures.NetTokens += other.NetTokens
	measures.TotalTokens += other.TotalTokens
	measures.CostNanos += other.CostNanos
}

func (totals *TrendsUsageTotalsDTO) add(other TrendsUsageTotalsDTO) {
	totals.TrendsUsageGroupMeasuresDTO.add(other.TrendsUsageGroupMeasuresDTO)
	totals.Failures += other.Failures
	totals.PromptTokens += other.PromptTokens
	totals.CompletionTokens += other.CompletionTokens
	totals.ReasoningTokens += other.ReasoningTokens
	totals.CacheReadTokens += other.CacheReadTokens
	totals.CacheCreationTokens += other.CacheCreationTokens
	totals.PricedRequests += other.PricedRequests
	totals.CostedRequests += other.CostedRequests
}

func (totals *TrendsUsageTotalsDTO) fillRates() {
	if totals.PromptTokens > 0 {
		totals.CacheRate = computeCacheRate(repository.UsageTotals{InputTokens: totals.PromptTokens, CacheReadTokens: totals.CacheReadTokens})
	}
	if totals.CompletionTokens > 0 {
		rate := float64(totals.ReasoningTokens) / float64(totals.CompletionTokens) * 100
		totals.ReasoningShare = &rate
	}
}

func trendsUsageMeasures(measures repository.UsageMeasures) TrendsUsageTotalsDTO {
	physical, net := projectInsightsFactMeasures(measures)
	return TrendsUsageTotalsDTO{
		TrendsUsageGroupMeasuresDTO: TrendsUsageGroupMeasuresDTO{Requests: physical.Requests, NetTokens: net, TotalTokens: physical.TotalTokens, CostNanos: physical.CostNanos},
		Failures:                    physical.Failures, PromptTokens: physical.InputTokens, CompletionTokens: physical.OutputTokens,
		ReasoningTokens: physical.ReasoningTokens, CacheReadTokens: physical.CacheReadTokens, CacheCreationTokens: physical.CacheCreationTokens,
		PricedRequests: physical.PricedRequests, CostedRequests: physical.CostedRequests,
	}
}

type trendsUsageGroup struct {
	measures TrendsUsageGroupMeasuresDTO
	buckets  map[int64]TrendsUsageGroupMeasuresDTO
}

func (group *trendsUsageGroup) add(start int64, other TrendsUsageGroupMeasuresDTO) {
	group.measures.add(other)
	bucket := group.buckets[start]
	bucket.add(other)
	group.buckets[start] = bucket
}

type trendsUsageFold struct {
	totals  TrendsUsageTotalsDTO
	buckets map[int64]TrendsUsageTotalsDTO
	groups  map[string]*trendsUsageGroup
}

func foldTrendsUsage(rows []repository.UsageFactRow, bucket insightsBucket, zone *time.Location) trendsUsageFold {
	fold := trendsUsageFold{buckets: map[int64]TrendsUsageTotalsDTO{}, groups: map[string]*trendsUsageGroup{}}
	for _, row := range rows {
		start := trendsBucketStart(bucket, row.StartMS, zone)
		measures := trendsUsageMeasures(row.UsageMeasures)
		fold.totals.add(measures)
		bucket := fold.buckets[start]
		bucket.add(measures)
		fold.buckets[start] = bucket
		id := row.Keys[0]
		group := fold.groups[id]
		if group == nil {
			group = &trendsUsageGroup{buckets: map[int64]TrendsUsageGroupMeasuresDTO{}}
			fold.groups[id] = group
		}
		group.add(start, measures.TrendsUsageGroupMeasuresDTO)
	}
	fold.totals.fillRates()
	return fold
}

// @Summary Query usage trends
// @Description Return cumulative and grouped usage, comparison overlays, and significant changes against a robust prior-period baseline.
// @Tags Trends
// @Produce json
// @Security CookieAuth
// @Param preset query string false "Insights time preset"
// @Param from query integer false "Custom start timestamp in Unix milliseconds"
// @Param to query integer false "Inclusive end timestamp in Unix milliseconds"
// @Param bucket query string false "Time grid" Enums(auto,hour,day,week,month)
// @Param group_by query string false "Grouping dimension" Enums(call_point,model,client_agent,key,provider,credential) default(model)
// @Param top query integer false "Maximum group series before folding (1–10)" default(5) minimum(1) maximum(10)
// @Param api_key query []string false "Client key filter" collectionFormat(multi)
// @Param model query []string false "Model filter" collectionFormat(multi)
// @Param model_alias query []string false "Call point filter" collectionFormat(multi)
// @Param provider query []string false "Provider filter" collectionFormat(multi)
// @Param auth_index query []string false "Credential filter" collectionFormat(multi)
// @Param client_agent query []string false "Client program filter" collectionFormat(multi)
// @Success 200 {object} TrendsUsageResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/trends/usage [get]
func (h *Handler) trendsUsage(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	group, top, message := trendsQueryOptions(request, 10, repository.UsageDimensionModel, repository.UsageDimensionCallPoint, repository.UsageDimensionClientAgent, repository.UsageDimensionKey, repository.UsageDimensionProvider, repository.UsageDimensionCredential)
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()
	resolved, message, err := h.insightsRangeFromRequest(ctx, request)
	if err != nil {
		writeInternalError(writer, fmt.Errorf("resolve usage trends window: %w", err))
		return
	}
	if message != "" {
		writeInsightsRangeError(writer, message)
		return
	}
	result, err := h.readTrendsUsage(ctx, request, resolved, group, top)
	if err != nil {
		writeInternalError(writer, fmt.Errorf("read usage trends: %w", err))
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func isRunningCalendarPreset(preset string) bool {
	return preset == "today" || preset == "this_week" || preset == "this_month"
}

func alignComparisonBucketIndex(grid []int64, windowFromMS, windowToMS, priorFromMS, priorStartMS int64) int {
	clippedStart := max(priorStartMS, priorFromMS)
	elapsed := max(int64(0), clippedStart-priorFromMS)
	targetAt := min(windowFromMS+elapsed, windowToMS)
	index, found := slices.BinarySearch(grid, targetAt)
	if found {
		return index
	}
	if index > 0 {
		return index - 1
	}
	return 0
}

func (h *Handler) readTrendsUsage(ctx context.Context, request *http.Request, resolved insightsRange, group repository.UsageDimension, top int) (TrendsUsageResponseDTO, error) {
	window, zone := resolved.window, h.insightsZone()
	result := TrendsUsageResponseDTO{
		GroupBy: string(group), Series: []TrendsUsageGroupSeriesDTO{},
		Movers: TrendsMoversDTO{Metric: "net_tokens", Risers: []TrendsMoverItemDTO{}, Fallers: []TrendsMoverItemDTO{}},
	}
	query, err := h.trendsFactQuery(ctx, request, window, resolved.compare, zone)
	if err != nil {
		return result, err
	}
	query.Dimensions = []repository.UsageDimension{group}
	var facts, prior, baselineFacts repository.UsageFactResult
	var hasPrior, hasBaselineFacts bool
	var priorSpanWindow insightsWindow
	err = h.repo.QueryUsageFactsSnapshot(ctx, func(queryFacts func(repository.UsageFactQuery) (repository.UsageFactResult, error)) error {
		var queryErr error
		facts, queryErr = queryFacts(query)
		if queryErr != nil {
			return queryErr
		}
		priorSpanWindow = window
		priorSpanWindow.Clipped = facts.Clipped
		priorSpanWindow.Widened = !facts.Clipped && (facts.FromMS != window.FromMS || facts.ToMS != window.ToMS)
		priorSpanWindow.FromMS, priorSpanWindow.ToMS = facts.FromMS, facts.ToMS
		if compare := resolved.compare; compare != nil {
			// Align the comparison end below the widened current start so a rolled-up
			// 15m boundary bucket is never counted in both windows. When the entire
			// comparison window collapses into current's widened edge, omit it.
			compareFrom, compareTo := compare.FromMS, min(compare.ToMS, priorSpanWindow.FromMS-1)
			if compareFrom <= compareTo {
				query.FromMS, query.ToMS = compareFrom, compareTo
				prior, queryErr = queryFacts(query)
				if queryErr != nil {
					return queryErr
				}
				if !prior.Clipped && prior.ToMS < priorSpanWindow.FromMS {
					hasPrior = true
					bucketMS, calendar, groupBucket := compareBucketSpec(prior.FromMS, prior.ToMS, zone)
					query.BucketMS, query.Calendar = bucketMS, calendar
					if groupBucket != window.Bucket {
						query.FromMS, query.ToMS = prior.FromMS, prior.ToMS
						baselineFacts, queryErr = queryFacts(query)
						if queryErr != nil {
							return queryErr
						}
						hasBaselineFacts = true
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	window = priorSpanWindow
	result.Window = window
	result.Coverage = insightsCoverage{FactRequests: facts.FactRequests, DetailRequests: facts.DetailRequests}
	current := foldTrendsUsage(facts.Rows, window.Bucket, zone)
	result.Totals = current.totals
	grid := window.Bucket.bucketStarts(window.FromMS, window.ToMS, zone)
	var previous, baseline trendsUsageFold
	var previousGrid []int64
	var baselineScale float64
	if hasPrior {
		result.CompareWindow = &insightsCompareWindow{FromMS: prior.FromMS, ToMS: prior.ToMS}
		previous = foldTrendsUsage(prior.Rows, window.Bucket, zone)
		previousGrid = window.Bucket.bucketStarts(prior.FromMS, prior.ToMS, zone)
		baseline = previous
		baselineScale = float64(window.ToMS-window.FromMS+1) / float64(prior.ToMS-prior.FromMS+1)
		if hasBaselineFacts {
			_, _, groupBucket := compareBucketSpec(prior.FromMS, prior.ToMS, zone)
			baseline = foldTrendsUsage(baselineFacts.Rows, groupBucket, zone)
		}
		robust := trendsUsageBaseline(baseline.buckets, baselineScale)
		result.CompareTotals = &TrendsUsageCompareTotalsDTO{
			TrendsUsageGroupMeasuresDTO: previous.totals.TrendsUsageGroupMeasuresDTO,
			BaselineRequests:            robust.Requests, BaselineNetTokens: robust.NetTokens,
			BaselineTotalTokens: robust.TotalTokens, BaselineCostNanos: robust.CostNanos,
		}
	}
	var compareByGrid []TrendsUsageGroupMeasuresDTO
	if len(previousGrid) > 0 && len(grid) > 0 {
		compareByGrid = make([]TrendsUsageGroupMeasuresDTO, len(grid))
		if len(previousGrid) > len(grid) && !isRunningCalendarPreset(window.Preset) {
			for _, priorStart := range previousGrid {
				targetIndex := alignComparisonBucketIndex(grid, window.FromMS, window.ToMS, prior.FromMS, priorStart)
				compareByGrid[targetIndex].add(previous.buckets[priorStart].TrendsUsageGroupMeasuresDTO)
			}
		} else {
			for index := 0; index < len(grid) && index < len(previousGrid); index++ {
				compareByGrid[index] = previous.buckets[previousGrid[index]].TrendsUsageGroupMeasuresDTO
			}
		}
	}
	result.Buckets = make([]TrendsUsageBucketDTO, 0, len(grid))
	var cumulative, compareCum TrendsUsageGroupMeasuresDTO
	for index, start := range grid {
		bucket := current.buckets[start]
		bucket.fillRates()
		cumulative.add(bucket.TrendsUsageGroupMeasuresDTO)
		point := TrendsUsageBucketDTO{
			StartMS: start, TrendsUsageGroupMeasuresDTO: bucket.TrendsUsageGroupMeasuresDTO,
			CumNetTokens: cumulative.NetTokens, CumTotalTokens: cumulative.TotalTokens, CumRequests: cumulative.Requests, CumCostNanos: cumulative.CostNanos,
			PromptTokens: bucket.PromptTokens, CompletionTokens: bucket.CompletionTokens, ReasoningTokens: bucket.ReasoningTokens,
			CacheReadTokens: bucket.CacheReadTokens, CacheRate: bucket.CacheRate, ReasoningShare: bucket.ReasoningShare,
		}
		if len(compareByGrid) > 0 && (index < len(previousGrid) || len(previousGrid) > len(grid)) {
			priorBucket := compareByGrid[index]
			compareCum.add(priorBucket)
			total := compareCum
			point.CompareNetTokens, point.CompareCumNetTokens = &priorBucket.NetTokens, &total.NetTokens
			point.CompareTotalTokens, point.CompareCumTotalTokens = &priorBucket.TotalTokens, &total.TotalTokens
			point.CompareRequests, point.CompareCumRequests = &priorBucket.Requests, &total.Requests
		}
		result.Buckets = append(result.Buckets, point)
	}
	currentIDs := make([]string, 0, len(current.groups))
	for id := range current.groups {
		currentIDs = append(currentIDs, id)
	}
	slices.SortFunc(currentIDs, func(left, right string) int {
		a, b := current.groups[left].measures, current.groups[right].measures
		if order := cmp.Compare(b.NetTokens, a.NetTokens); order != 0 {
			return order
		}
		if order := cmp.Compare(b.Requests, a.Requests); order != 0 {
			return order
		}
		return cmp.Compare(left, right)
	})
	rankedIDs := currentIDs[:min(top, len(currentIDs))]
	movers := []TrendsMoverItemDTO{}
	if result.CompareWindow != nil {
		if current.totals.NetTokens == 0 && previous.totals.NetTokens == 0 {
			result.Movers.Metric = "requests"
		}
		movers = trendsUsageMovers(current, baseline, result.Movers.Metric, baselineScale, top)
	}
	const maxListedGroups = 100
	listedIDs := currentIDs[:min(maxListedGroups, len(currentIDs))]
	nameIDs := slices.Clone(listedIDs)
	for _, item := range movers {
		if !slices.Contains(nameIDs, item.ID) {
			nameIDs = append(nameIDs, item.ID)
		}
	}
	names, err := h.trendsGroupNames(ctx, group, nameIDs)
	if err != nil {
		return result, err
	}
	if len(listedIDs) > 0 {
		result.Groups = make([]TrendsUsageGroupOptionDTO, 0, len(listedIDs))
		for _, id := range listedIDs {
			result.Groups = append(result.Groups, TrendsUsageGroupOptionDTO{
				trendsGroupName: names[id],
				Requests:        current.groups[id].measures.Requests,
			})
		}
	}
	for _, id := range rankedIDs {
		result.Series = append(result.Series, trendsUsageSeries(grid, names[id], current.groups[id], false))
	}
	if len(currentIDs) > top {
		folded := &trendsUsageGroup{buckets: map[int64]TrendsUsageGroupMeasuresDTO{}}
		for _, id := range currentIDs[top:] {
			for start, measures := range current.groups[id].buckets {
				folded.add(start, measures)
			}
		}
		result.Series = append(result.Series, trendsUsageSeries(grid, trendsGroupName{ID: "__others__", Label: "Other"}, folded, true))
	}
	for _, mover := range movers {
		mover.trendsGroupName = names[mover.ID]
		if mover.ZScore > 0 {
			result.Movers.Risers = append(result.Movers.Risers, mover)
		} else {
			result.Movers.Fallers = append(result.Movers.Fallers, mover)
		}
	}
	return result, nil
}

func trendsUsageSeries(grid []int64, name trendsGroupName, group *trendsUsageGroup, isFolded bool) TrendsUsageGroupSeriesDTO {
	result := TrendsUsageGroupSeriesDTO{trendsGroupName: name, TrendsUsageGroupMeasuresDTO: group.measures, Folded: isFolded, Buckets: make([]TrendsUsageGroupBucketDTO, 0, len(grid))}
	for _, start := range grid {
		result.Buckets = append(result.Buckets, TrendsUsageGroupBucketDTO{StartMS: start, TrendsUsageGroupMeasuresDTO: group.buckets[start]})
	}
	return result
}

func robustTrendsMeasures(measures []TrendsUsageGroupMeasuresDTO, scale float64) TrendsUsageGroupMeasuresDTO {
	requests := make([]float64, len(measures))
	net := make([]float64, len(measures))
	total := make([]float64, len(measures))
	cost := make([]float64, len(measures))
	for index, row := range measures {
		requests[index], net[index], total[index], cost[index] = float64(row.Requests), float64(row.NetTokens), float64(row.TotalTokens), float64(row.CostNanos)
	}
	scaled := func(values []float64) int64 {
		value := math.Round(robustBucketSum(values) * scale)
		if value >= float64(math.MaxInt64) {
			return math.MaxInt64
		}
		return int64(value)
	}
	return TrendsUsageGroupMeasuresDTO{Requests: scaled(requests), NetTokens: scaled(net), TotalTokens: scaled(total), CostNanos: scaled(cost)}
}

func trendsUsageBaseline(buckets map[int64]TrendsUsageTotalsDTO, scale float64) TrendsUsageGroupMeasuresDTO {
	values := make([]TrendsUsageGroupMeasuresDTO, 0, len(buckets))
	for _, row := range buckets {
		values = append(values, row.TrendsUsageGroupMeasuresDTO)
	}
	return robustTrendsMeasures(values, scale)
}

func trendsUsageMovers(current, baseline trendsUsageFold, metric string, baselineScale float64, top int) []TrendsMoverItemDTO {
	ids := make(map[string]struct{}, len(current.groups)+len(baseline.groups))
	for id := range current.groups {
		ids[id] = struct{}{}
	}
	for id := range baseline.groups {
		ids[id] = struct{}{}
	}
	risers, fallers := []TrendsMoverItemDTO{}, []TrendsMoverItemDTO{}
	for id := range ids {
		var now, prior TrendsUsageGroupMeasuresDTO
		if group := current.groups[id]; group != nil {
			now = group.measures
		}
		if group := baseline.groups[id]; group != nil {
			values := make([]TrendsUsageGroupMeasuresDTO, 0, len(group.buckets))
			for _, row := range group.buckets {
				values = append(values, row)
			}
			prior = robustTrendsMeasures(values, baselineScale)
		}
		curValue, baselineValue := now.NetTokens, prior.NetTokens
		if metric == "requests" {
			curValue, baselineValue = now.Requests, prior.Requests
		}
		delta := float64(curValue) - float64(baselineValue)
		z := delta / math.Sqrt(float64(max(baselineValue, 1))+float64(max(curValue, 0)))
		if math.Abs(z) < 2 {
			continue
		}
		item := TrendsMoverItemDTO{
			trendsGroupName: trendsGroupName{ID: id}, NetTokens: now.NetTokens, Requests: now.Requests,
			BaselineNetTokens: prior.NetTokens, BaselineRequests: prior.Requests, DeltaNetTokens: now.NetTokens - prior.NetTokens,
			DeltaRequests: now.Requests - prior.Requests, ZScore: z,
		}
		if baselineValue > 0 {
			rate := delta / float64(baselineValue) * 100
			item.DeltaPercent = &rate
		}
		if z > 0 {
			item.Status = "rising"
			if prior.Requests == 0 {
				item.Status = "new"
			}
			risers = append(risers, item)
		} else {
			item.Status = "falling"
			if now.Requests == 0 {
				item.Status = "quiet"
			}
			fallers = append(fallers, item)
		}
	}
	// Significance only admits a mover; the list ranks by how much moved, which is what a reader
	// weighs and what the panel draws to one scale.
	byMagnitude := func(left, right TrendsMoverItemDTO) int {
		leftDelta, rightDelta := left.DeltaNetTokens, right.DeltaNetTokens
		if metric == "requests" {
			leftDelta, rightDelta = left.DeltaRequests, right.DeltaRequests
		}
		if order := cmp.Compare(max(rightDelta, -rightDelta), max(leftDelta, -leftDelta)); order != 0 {
			return order
		}
		return cmp.Compare(left.ID, right.ID)
	}
	slices.SortFunc(risers, byMagnitude)
	slices.SortFunc(fallers, byMagnitude)
	return append(risers[:min(top, len(risers))], fallers[:min(top, len(fallers))]...)
}
