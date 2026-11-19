package api

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/http"
	"slices"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type TrendsTelemetrySummaryDTO struct {
	TotalRequests    int64    `json:"total_requests"`
	SuccessRequests  int64    `json:"success_requests"`
	FailedRequests   int64    `json:"failed_requests"`
	RateLimited429   int64    `json:"rate_limited_429"`
	Upstream5xx      int64    `json:"upstream_5xx"`
	StreamTruncated  int64    `json:"stream_truncated"`
	ForceCooldown    int64    `json:"force_cooldown"`
	OtherFailures    int64    `json:"other_failures"`
	ModelSubstituted int64    `json:"model_substituted"`
	TPSMean          *float64 `json:"tps_mean"`
	TPSP50           *float64 `json:"tps_p50"`
	TPSSamples       int      `json:"tps_samples"`
	TTFTP50MS        *float64 `json:"ttft_p50_ms"`
	TTFTP95MS        *float64 `json:"ttft_p95_ms"`
	TTFTSamples      int      `json:"ttft_samples"`
	LatencyP50MS     *float64 `json:"latency_p50_ms"`
	LatencyP95MS     *float64 `json:"latency_p95_ms"`
	LatencySamples   int      `json:"latency_samples"`
}

type TrendsTelemetryBucketDTO struct {
	StartMS int64 `json:"start_ms"`
	TrendsTelemetrySummaryDTO
}

type TrendsTelemetryGroupSeriesDTO struct {
	trendsGroupName
	TrendsTelemetrySummaryDTO
	Buckets []TrendsTelemetryBucketDTO `json:"buckets"`
}

type TrendsTelemetryScatterPointDTO struct {
	TimestampMS      int64    `json:"timestamp_ms"`
	GroupID          string   `json:"group_id"`
	Model            string   `json:"model"`
	Provider         string   `json:"provider"`
	TTFTMS           *int64   `json:"ttft_ms"`
	LatencyMS        *int64   `json:"latency_ms"`
	TPS              *float64 `json:"tps"`
	OutputTokens     int64    `json:"output_tokens"`
	Failed           bool     `json:"failed"`
	ModelSubstituted bool     `json:"model_substituted"`
}

type TrendsSubstitutionPairDTO struct {
	RequestedModel string `json:"requested_model"`
	ServedModel    string `json:"served_model"`
	Provider       string `json:"provider"`
	RequestedID    string `json:"requested_id,omitempty"`
	ServedID       string `json:"served_id,omitempty"`
	ProviderID     string `json:"provider_id,omitempty"`
	DrillDisabled  bool   `json:"drill_disabled,omitempty"`
	Count          int64  `json:"count"`
}

type TrendsStatusCountDTO struct {
	Code  int   `json:"code"`
	Count int64 `json:"count"`
}

type TrendsFailureGroupDTO struct {
	Model                   string                 `json:"model"`
	ModelID                 string                 `json:"model_id,omitempty"`
	Provider                string                 `json:"provider"`
	ProviderID              string                 `json:"provider_id,omitempty"`
	AuthIndex               string                 `json:"auth_index,omitempty"`
	AuthIndexID             string                 `json:"auth_index_id,omitempty"`
	DrillDisabled           bool                   `json:"drill_disabled,omitempty"`
	TotalRequests           int64                  `json:"total_requests"`
	ModelTotalRequests      int64                  `json:"model_total_requests"`
	ProviderTotalRequests   int64                  `json:"provider_total_requests"`
	CredentialTotalRequests int64                  `json:"credential_total_requests,omitempty"`
	FailedRequests          int64                  `json:"failed_requests"`
	RateLimited429          int64                  `json:"rate_limited_429"`
	Upstream5xx             int64                  `json:"upstream_5xx"`
	StreamTruncated         int64                  `json:"stream_truncated"`
	ForceCooldown           int64                  `json:"force_cooldown"`
	OtherFailures           int64                  `json:"other_failures"`
	StatusCodes             []TrendsStatusCountDTO `json:"status_codes,omitempty"`
	LastFailedAtMS          int64                  `json:"last_failed_at_ms,omitempty"`
}

type TrendsTelemetryCoverageDTO struct {
	FactRequests           int64  `json:"fact_requests"`
	RetainedRequests       int64  `json:"retained_requests"`
	RetentionStartMS       *int64 `json:"retention_start_ms,omitempty"`
	IsTruncatedByRetention bool   `json:"is_truncated_by_retention"`
}

type TrendsTelemetryResponseDTO struct {
	Window            insightsWindow                   `json:"window"`
	TPSMode           string                           `json:"tps_mode"`
	GroupBy           string                           `json:"group_by"`
	Summary           TrendsTelemetrySummaryDTO        `json:"summary"`
	Buckets           []TrendsTelemetryBucketDTO       `json:"buckets"`
	Groups            []trendsGroupName                `json:"groups,omitempty"`
	Series            []TrendsTelemetryGroupSeriesDTO  `json:"series"`
	Scatter           []TrendsTelemetryScatterPointDTO `json:"scatter"`
	SubstitutionPairs []TrendsSubstitutionPairDTO      `json:"substitution_pairs"`
	FailureGroups     []TrendsFailureGroupDTO          `json:"failure_groups"`
	Coverage          TrendsTelemetryCoverageDTO       `json:"coverage"`
}

// maxTelemetryPercentileSamples bounds overall sample storage used for
// P50/P95 estimation so high-volume telemetry queries do not buffer unbounded
// floats. Up to this limit percentiles are exact; beyond it a deterministic
// reservoir approximation is used while counters and means stay exact.
const maxTelemetryPercentileSamples = 2048
const maxTelemetryBucketPercentileSamples = 512
const maxTelemetryFailureGroups = 64
const maxTelemetryFailureStatusCodes = 6

type trendsTelemetrySampleReservoir struct {
	count   int
	samples []float64
}

func (r *trendsTelemetrySampleReservoir) addWithLimit(value float64, limit int, rng *rand.Rand) {
	if limit <= 0 {
		limit = maxTelemetryPercentileSamples
	}
	r.count++
	if len(r.samples) < limit {
		r.samples = append(r.samples, value)
		return
	}
	if rng != nil {
		if idx := rng.IntN(r.count); idx < limit {
			r.samples[idx] = value
		}
	}
}

type trendsTelemetryStats struct {
	TrendsTelemetrySummaryDTO
	tps, ttft, latency trendsTelemetrySampleReservoir
	tpsSum             float64
}

func (stats *trendsTelemetryStats) add(sample repository.UsageTelemetrySample, rng *rand.Rand) {
	stats.addWithLimit(sample, maxTelemetryPercentileSamples, rng)
}

type telemetryFailureFlags struct {
	isRateLimited   bool
	isUpstreamError bool
	isTruncated     bool
	isCooldown      bool
	isOther         bool
}

func classifyTelemetryFailure(sample repository.UsageTelemetrySample) telemetryFailureFlags {
	isRateLimited := sample.IsFailed && sample.FailStatusCode == http.StatusTooManyRequests
	isUpstreamError := sample.IsFailed && sample.FailStatusCode >= 500 && sample.FailStatusCode < 600
	isTruncated := sample.FailCode == "stream_truncated"
	isCooldown := sample.FailCode == "force_cooldown"
	isOther := sample.IsFailed && !isRateLimited && !isUpstreamError && !isTruncated && !isCooldown
	return telemetryFailureFlags{
		isRateLimited:   isRateLimited,
		isUpstreamError: isUpstreamError,
		isTruncated:     isTruncated,
		isCooldown:      isCooldown,
		isOther:         isOther,
	}
}

type trendsFailureAccumulator struct {
	failedRequests  int64
	rateLimited429  int64
	upstream5xx     int64
	streamTruncated int64
	forceCooldown   int64
	otherFailures   int64
	statusCodes     map[int]int64
	lastFailedAtMS  int64
}

func (stats *trendsTelemetryStats) addWithLimit(sample repository.UsageTelemetrySample, limit int, rng *rand.Rand) {
	stats.TotalRequests++
	if sample.IsFailed {
		stats.FailedRequests++
	} else {
		stats.SuccessRequests++
	}
	flags := classifyTelemetryFailure(sample)
	if flags.isRateLimited {
		stats.RateLimited429++
	}
	if flags.isUpstreamError {
		stats.Upstream5xx++
	}
	if flags.isTruncated {
		stats.StreamTruncated++
	}
	if flags.isCooldown {
		stats.ForceCooldown++
	}
	if flags.isOther {
		stats.OtherFailures++
	}
	if sample.IsModelSubstituted {
		stats.ModelSubstituted++
	}
	if sample.TPS != nil {
		stats.tps.addWithLimit(*sample.TPS, limit, rng)
		stats.tpsSum += *sample.TPS
	}
	if sample.TTFTMS != nil {
		stats.ttft.addWithLimit(float64(*sample.TTFTMS), limit, rng)
	}
	if sample.LatencyMS > 0 {
		stats.latency.addWithLimit(float64(sample.LatencyMS), limit, rng)
	}
}

func trendsPercentiles(samples []float64) (*float64, *float64) {
	if len(samples) == 0 {
		return nil, nil
	}
	slices.Sort(samples)
	p50, p95 := sortedQuantile(samples, 0.50), sortedQuantile(samples, 0.95)
	return &p50, &p95
}

func (stats *trendsTelemetryStats) summary() TrendsTelemetrySummaryDTO {
	result := stats.TrendsTelemetrySummaryDTO
	result.TPSSamples, result.TTFTSamples, result.LatencySamples = stats.tps.count, stats.ttft.count, stats.latency.count
	if result.TPSSamples > 0 {
		mean := stats.tpsSum / float64(result.TPSSamples)
		result.TPSMean = &mean
		result.TPSP50, _ = trendsPercentiles(stats.tps.samples)
	}
	result.TTFTP50MS, result.TTFTP95MS = trendsPercentiles(stats.ttft.samples)
	result.LatencyP50MS, result.LatencyP95MS = trendsPercentiles(stats.latency.samples)
	return result
}

type trendsTelemetryGroup struct {
	stats   trendsTelemetryStats
	buckets map[int64]*trendsTelemetryStats
}

func trendsTelemetryAdd(buckets map[int64]*trendsTelemetryStats, sample repository.UsageTelemetrySample, limit int, rng *rand.Rand) {
	stats := buckets[sample.StartMS]
	if stats == nil {
		stats = &trendsTelemetryStats{}
		buckets[sample.StartMS] = stats
	}
	stats.addWithLimit(sample, limit, rng)
}

func trendsTelemetryBuckets(buckets map[int64]*trendsTelemetryStats, grid []int64) []TrendsTelemetryBucketDTO {
	result := make([]TrendsTelemetryBucketDTO, 0, len(grid))
	for _, start := range grid {
		bucket := TrendsTelemetryBucketDTO{StartMS: start}
		if stats := buckets[start]; stats != nil {
			bucket.TrendsTelemetrySummaryDTO = stats.summary()
		}
		result = append(result, bucket)
	}
	return result
}

// @Summary Query request telemetry trends
// @Description Return retained TPS and latency samples, stability, and model substitutions on the deployment's time grid.
// @Tags Trends
// @Produce json
// @Security CookieAuth
// @Param preset query string false "Insights time preset"
// @Param from query integer false "Custom start timestamp in Unix milliseconds"
// @Param to query integer false "Inclusive end timestamp in Unix milliseconds"
// @Param bucket query string false "Time grid" Enums(auto,hour,day,week,month)
// @Param group_by query string false "Grouping dimension" Enums(call_point,model,provider,credential) default(model)
// @Param top query integer false "Maximum group series (1–8)" default(5) minimum(1) maximum(8)
// @Param api_key query []string false "Client key filter" collectionFormat(multi)
// @Param model query []string false "Model filter" collectionFormat(multi)
// @Param model_alias query []string false "Call point filter" collectionFormat(multi)
// @Param provider query []string false "Provider filter" collectionFormat(multi)
// @Param auth_index query []string false "Credential filter" collectionFormat(multi)
// @Param client_agent query []string false "Client program filter" collectionFormat(multi)
// @Success 200 {object} TrendsTelemetryResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/trends/telemetry [get]
func (h *Handler) trendsTelemetry(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	group, top, message := trendsQueryOptions(request, 8, repository.UsageDimensionModel, repository.UsageDimensionCallPoint, repository.UsageDimensionProvider, repository.UsageDimensionCredential)
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()
	resolved, message, err := h.insightsRangeFromRequest(ctx, request)
	if err != nil {
		writeInternalError(writer, fmt.Errorf("resolve telemetry window: %w", err))
		return
	}
	if message != "" {
		writeInsightsRangeError(writer, message)
		return
	}
	result, err := h.readTrendsTelemetry(ctx, request, resolved.window, group, top)
	if err != nil {
		writeInternalError(writer, fmt.Errorf("read telemetry trends: %w", err))
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (h *Handler) readTrendsTelemetry(ctx context.Context, request *http.Request, window insightsWindow, group repository.UsageDimension, top int) (TrendsTelemetryResponseDTO, error) {
	const scatterLimit = 240
	result := TrendsTelemetryResponseDTO{
		Window: window, GroupBy: string(group), Series: []TrendsTelemetryGroupSeriesDTO{},
		Scatter: []TrendsTelemetryScatterPointDTO{}, SubstitutionPairs: []TrendsSubstitutionPairDTO{},
		FailureGroups: []TrendsFailureGroupDTO{},
	}
	zone := h.insightsZone()
	query, err := h.trendsFactQuery(ctx, request, window, nil, zone)
	if err != nil {
		return result, err
	}
	mode, err := h.repo.ReadTpsCalculationMode(ctx)
	if err != nil {
		return result, err
	}
	result.TPSMode = string(mode)

	var overall trendsTelemetryStats
	buckets := map[int64]*trendsTelemetryStats{}
	groups := map[string]*trendsTelemetryGroup{}
	pairs := map[[3]string]int64{}
	modelTotals := map[string]int64{}
	providerTotals := map[string]int64{}
	credentialTotals := map[string]int64{}
	comboTotals := map[[3]string]int64{}
	failureAcc := map[[3]string]*trendsFailureAccumulator{}
	// A deterministic reservoir samples the entire range, not the first burst.
	random := rand.New(rand.NewPCG(0, 1))
	const maxListedGroups = 50
	// Read horizon, pre-horizon permanent facts, top group IDs, and retained telemetry
	// inside a single SQLite read snapshot so lifecycle cannot advance between them and
	// high-cardinality queries only allocate per-bucket reservoirs for the top `top` groups.
	// Permanent facts recover missing request counts when no client_agent filter
	// is active (client facts omit non-generating failures); when client_agent
	// is filtered, both FactRequests and RetainedRequests report the retained population.
	includeFacts := len(query.ClientAgents) == 0
	horizon, facts, listedIDs, err := h.repo.ReadTrendsTelemetrySnapshot(ctx, query, group, mode, includeFacts, top, maxListedGroups, func(sample repository.UsageTelemetrySample) {
		sample.StartMS = trendsBucketStart(window.Bucket, sample.StartMS, zone)
		overall.add(sample, random)
		trendsTelemetryAdd(buckets, sample, maxTelemetryBucketPercentileSamples, random)
		modelTotals[sample.Model]++
		providerTotals[sample.Provider]++
		if sample.AuthIndex != "" {
			credentialTotals[sample.AuthIndex]++
		}
		comboKey := [3]string{sample.Model, sample.Provider, sample.AuthIndex}
		comboTotals[comboKey]++
		flags := classifyTelemetryFailure(sample)
		if sample.IsFailed || flags.isTruncated || flags.isCooldown {
			acc := failureAcc[comboKey]
			if acc == nil {
				acc = &trendsFailureAccumulator{}
				failureAcc[comboKey] = acc
			}
			if sample.IsFailed {
				acc.failedRequests++
			}
			if flags.isRateLimited {
				acc.rateLimited429++
			}
			if flags.isUpstreamError {
				acc.upstream5xx++
			}
			if flags.isTruncated {
				acc.streamTruncated++
			}
			if flags.isCooldown {
				acc.forceCooldown++
			}
			if flags.isOther {
				acc.otherFailures++
			}
			if sample.FailStatusCode > 0 {
				if acc.statusCodes == nil {
					acc.statusCodes = map[int]int64{}
				}
				acc.statusCodes[sample.FailStatusCode]++
			}
			if sample.TimestampMS > acc.lastFailedAtMS {
				acc.lastFailedAtMS = sample.TimestampMS
			}
		}
		if sample.IsTopSeries {
			entry := groups[sample.GroupID]
			if entry == nil {
				entry = &trendsTelemetryGroup{buckets: map[int64]*trendsTelemetryStats{}}
				groups[sample.GroupID] = entry
			}
			entry.stats.addWithLimit(sample, maxTelemetryBucketPercentileSamples, random)
			trendsTelemetryAdd(entry.buckets, sample, maxTelemetryBucketPercentileSamples, random)
		}
		if sample.IsModelSubstituted && sample.ResponseModel != "" {
			pairs[[3]string{sample.Model, sample.ResponseModel, sample.Provider}]++
		}
		position := len(result.Scatter)
		if position == scatterLimit {
			position = int(random.Int64N(overall.TotalRequests))
		}
		if position >= scatterLimit {
			return
		}
		groupID, _ := h.trendsGroupIdentity(group, sample.GroupID)
		_, scatterModel := h.trendsGroupIdentity(repository.UsageDimensionModel, sample.Model)
		_, scatterProvider := h.trendsGroupIdentity(repository.UsageDimensionProvider, sample.Provider)
		point := TrendsTelemetryScatterPointDTO{
			TimestampMS: sample.TimestampMS, GroupID: groupID,
			Model:    scatterModel,
			Provider: scatterProvider,
			TTFTMS:   sample.TTFTMS, TPS: sample.TPS, OutputTokens: sample.OutputTokens,
			Failed: sample.IsFailed, ModelSubstituted: sample.IsModelSubstituted,
		}
		if sample.LatencyMS > 0 {
			point.LatencyMS = &sample.LatencyMS
		}
		if position == len(result.Scatter) {
			result.Scatter = append(result.Scatter, point)
		} else {
			result.Scatter[position] = point
		}
	})
	if err != nil {
		return result, err
	}
	if horizon > 0 {
		result.Coverage.RetentionStartMS = &horizon
		result.Coverage.IsTruncatedByRetention = window.FromMS < horizon
	}
	grid := window.Bucket.bucketStarts(window.FromMS, window.ToMS, zone)
	result.Summary = overall.summary()
	result.Coverage.RetainedRequests = overall.TotalRequests
	if includeFacts && result.Coverage.IsTruncatedByRetention {
		result.Coverage.FactRequests = facts.FactRequests + facts.DetailRequests
		result.Window.Widened = facts.FromMS != query.FromMS || facts.ToMS != query.ToMS
	} else {
		result.Coverage.FactRequests = overall.TotalRequests
	}
	result.Buckets = trendsTelemetryBuckets(buckets, grid)
	names, err := h.trendsGroupNames(ctx, group, listedIDs)
	if err != nil {
		return result, err
	}
	if len(listedIDs) > 0 {
		result.Groups = make([]trendsGroupName, 0, len(listedIDs))
		for _, id := range listedIDs {
			result.Groups = append(result.Groups, names[id])
		}
	}
	seriesIDs := listedIDs[:min(top, len(listedIDs))]
	for _, id := range seriesIDs {
		entry := groups[id]
		if entry == nil {
			continue
		}
		result.Series = append(result.Series, TrendsTelemetryGroupSeriesDTO{
			trendsGroupName: names[id], TrendsTelemetrySummaryDTO: entry.stats.summary(), Buckets: trendsTelemetryBuckets(entry.buckets, grid),
		})
	}
	slices.SortStableFunc(result.Scatter, func(left, right TrendsTelemetryScatterPointDTO) int {
		if left.TimestampMS < right.TimestampMS {
			return -1
		}
		if left.TimestampMS > right.TimestampMS {
			return 1
		}
		return 0
	})
	for pair, count := range pairs {
		reqID, reqLabel := h.trendsGroupIdentity(repository.UsageDimensionModel, pair[0])
		servedID, servedLabel := h.trendsGroupIdentity(repository.UsageDimensionResponseModel, pair[1])
		provID, provLabel := h.trendsGroupIdentity(repository.UsageDimensionProvider, pair[2])
		dto := TrendsSubstitutionPairDTO{
			RequestedModel: reqLabel,
			ServedModel:    servedLabel,
			Provider:       provLabel,
			Count:          count,
		}
		if reqID != pair[0] {
			if strings.HasPrefix(reqID, repository.TrendsRedactedPrefix) {
				dto.RequestedID = reqID
			} else {
				dto.DrillDisabled = true
			}
		}
		if servedID != pair[1] {
			if strings.HasPrefix(servedID, repository.TrendsRedactedPrefix) {
				dto.ServedID = servedID
			} else {
				dto.DrillDisabled = true
			}
		}
		if provID != pair[2] {
			if strings.HasPrefix(provID, repository.TrendsRedactedPrefix) {
				dto.ProviderID = provID
			} else {
				dto.DrillDisabled = true
			}
		}
		result.SubstitutionPairs = append(result.SubstitutionPairs, dto)
	}
	slices.SortFunc(result.SubstitutionPairs, func(left, right TrendsSubstitutionPairDTO) int {
		switch {
		case left.Count > right.Count:
			return -1
		case left.Count < right.Count:
			return 1
		case left.RequestedModel != right.RequestedModel:
			return strings.Compare(left.RequestedModel, right.RequestedModel)
		case left.ServedModel != right.ServedModel:
			return strings.Compare(left.ServedModel, right.ServedModel)
		default:
			return strings.Compare(left.Provider, right.Provider)
		}
	})
	for key, acc := range failureAcc {
		dto := TrendsFailureGroupDTO{
			TotalRequests:         comboTotals[key],
			ModelTotalRequests:    modelTotals[key[0]],
			ProviderTotalRequests: providerTotals[key[1]],
			FailedRequests:        acc.failedRequests,
			RateLimited429:        acc.rateLimited429,
			Upstream5xx:           acc.upstream5xx,
			StreamTruncated:       acc.streamTruncated,
			ForceCooldown:         acc.forceCooldown,
			OtherFailures:         acc.otherFailures,
			LastFailedAtMS:        acc.lastFailedAtMS,
		}
		if key[0] != "" {
			modelProj := h.trendsGroupProjection(repository.UsageDimensionModel, key[0])
			dto.Model = modelProj.Label
			if modelProj.ID != key[0] {
				if strings.HasPrefix(modelProj.ID, repository.TrendsRedactedPrefix) {
					dto.ModelID = modelProj.ID
				} else {
					dto.DrillDisabled = true
				}
			}
		}
		if key[1] != "" {
			provProj := h.trendsGroupProjection(repository.UsageDimensionProvider, key[1])
			dto.Provider = provProj.Label
			if provProj.ID != key[1] {
				if strings.HasPrefix(provProj.ID, repository.TrendsRedactedPrefix) {
					dto.ProviderID = provProj.ID
				} else {
					dto.DrillDisabled = true
				}
			}
		}
		if key[2] != "" {
			credProj := h.trendsGroupProjection(repository.UsageDimensionCredential, key[2])
			dto.AuthIndex = credProj.Label
			dto.CredentialTotalRequests = credentialTotals[key[2]]
			if credProj.ID != key[2] {
				if strings.HasPrefix(credProj.ID, repository.TrendsRedactedPrefix) {
					dto.AuthIndexID = credProj.ID
				} else {
					dto.DrillDisabled = true
				}
			}
		}
		if len(acc.statusCodes) > 0 {
			codes := make([]TrendsStatusCountDTO, 0, len(acc.statusCodes))
			for code, count := range acc.statusCodes {
				codes = append(codes, TrendsStatusCountDTO{Code: code, Count: count})
			}
			slices.SortFunc(codes, func(left, right TrendsStatusCountDTO) int {
				if left.Count != right.Count {
					if left.Count > right.Count {
						return -1
					}
					return 1
				}
				return left.Code - right.Code
			})
			if len(codes) > maxTelemetryFailureStatusCodes {
				codes = codes[:maxTelemetryFailureStatusCodes]
			}
			dto.StatusCodes = codes
		}
		result.FailureGroups = append(result.FailureGroups, dto)
	}
	slices.SortFunc(result.FailureGroups, func(left, right TrendsFailureGroupDTO) int {
		switch {
		case left.FailedRequests != right.FailedRequests:
			if left.FailedRequests > right.FailedRequests {
				return -1
			}
			return 1
		case left.LastFailedAtMS != right.LastFailedAtMS:
			if left.LastFailedAtMS > right.LastFailedAtMS {
				return -1
			}
			return 1
		case left.Model != right.Model:
			return strings.Compare(left.Model, right.Model)
		case left.Provider != right.Provider:
			return strings.Compare(left.Provider, right.Provider)
		default:
			return strings.Compare(left.AuthIndex, right.AuthIndex)
		}
	})
	if len(result.FailureGroups) > maxTelemetryFailureGroups {
		result.FailureGroups = result.FailureGroups[:maxTelemetryFailureGroups]
	}
	return result, nil
}
