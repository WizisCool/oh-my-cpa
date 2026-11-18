package api

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

const (
	trendsQuotaNormal           = "normal"
	trendsQuotaLimitReached     = "limit_reached"
	trendsQuotaProjectedExhaust = "projected_exhaust"
	trendsQuotaUnderutilized    = "underutilized"
)

type TrendsQuotaSummaryDTO struct {
	ActiveCredentials       int  `json:"active_credentials"`
	IsMembershipUnknown     bool `json:"is_membership_unknown,omitempty"`
	ObservableWindows       int  `json:"observable_windows"`
	HealthyWindows          int  `json:"healthy_windows"`
	LimitReachedWindows     int  `json:"limit_reached_windows"`
	ProjectedExhaustWindows int  `json:"projected_exhaust_windows"`
	UnderutilizedWindows    int  `json:"underutilized_windows"`
}

type TrendsQuotaBucketDTO struct {
	StartMS      int64   `json:"start_ms"`
	EndMS        int64   `json:"end_ms"`
	UsedPercent  float64 `json:"used_percent"`
	DeltaPercent float64 `json:"delta_percent"`
	Requests     int64   `json:"requests"`
	NetTokens    int64   `json:"net_tokens"`
	TotalTokens  int64   `json:"total_tokens"`
	IsForecast   bool    `json:"is_forecast"`
}

type TrendsQuotaCycleHistoryDTO struct {
	CycleStartMS      int64   `json:"cycle_start_ms"`
	CycleResetMS      int64   `json:"cycle_reset_ms"`
	IsCurrent         bool    `json:"is_current"`
	UsedPercent       float64 `json:"used_percent"`
	ActualRequests    int64   `json:"actual_requests"`
	ActualNetTokens   int64   `json:"actual_net_tokens"`
	ActualTotalTokens int64   `json:"actual_total_tokens"`
	FullRequests      *int64  `json:"full_requests,omitempty"`
	FullNetTokens     *int64  `json:"full_net_tokens,omitempty"`
	FullTotalTokens   *int64  `json:"full_total_tokens,omitempty"`
	FullCostNanos     *int64  `json:"full_cost_nanos,omitempty"`
	IsApproximate     bool    `json:"is_approximate,omitempty"`
}

type TrendsQuotaWindowUsageDTO struct {
	FromMS         int64    `json:"from_ms"`
	ToMS           int64    `json:"to_ms"`
	Requests       int64    `json:"requests"`
	PricedRequests int64    `json:"priced_requests"`
	Tokens         int64    `json:"tokens"`
	PromptTokens   int64    `json:"prompt_tokens,omitempty"`
	CachedTokens   int64    `json:"cached_tokens,omitempty"`
	CacheRate      *float64 `json:"cache_rate,omitempty"`
	CostNanos      int64    `json:"cost_nanos"`
}

type TrendsQuotaWindowCapacityDTO struct {
	Basis                string   `json:"basis"`
	SampleRequests       int64    `json:"sample_requests"`
	SamplePricedRequests int64    `json:"sample_priced_requests,omitempty"`
	Requests             int64    `json:"requests"`
	Tokens               int64    `json:"tokens"`
	CostNanos            *int64   `json:"cost_nanos,omitempty"`
	CacheRate            *float64 `json:"cache_rate,omitempty"`
}

func trendsQuotaWindowUsageDTO(usage quota.WindowUsage) *TrendsQuotaWindowUsageDTO {
	return &TrendsQuotaWindowUsageDTO{
		FromMS:         usage.FromMS,
		ToMS:           usage.ToMS,
		Requests:       usage.Requests,
		PricedRequests: usage.PricedRequests,
		Tokens:         usage.Tokens,
		PromptTokens:   usage.PromptTokens,
		CachedTokens:   usage.CachedTokens,
		CacheRate:      usage.CacheRate,
		CostNanos:      usage.CostNanos,
	}
}

func trendsQuotaWindowCapacityDTO(capacity *quota.WindowCapacity) *TrendsQuotaWindowCapacityDTO {
	if capacity == nil {
		return nil
	}
	return &TrendsQuotaWindowCapacityDTO{
		Basis:                capacity.Basis,
		SampleRequests:       capacity.SampleRequests,
		SamplePricedRequests: capacity.SamplePricedRequests,
		Requests:             capacity.Requests,
		Tokens:               capacity.Tokens,
		CostNanos:            capacity.CostNanos,
		CacheRate:            capacity.CacheRate,
	}
}

type TrendsQuotaWindowDTO struct {
	WindowID              string                        `json:"window_id"`
	Label                 string                        `json:"label,omitempty"`
	Kind                  string                        `json:"kind,omitempty"`
	Scope                 string                        `json:"scope,omitempty"`
	Model                 string                        `json:"model,omitempty"`
	PeriodHours           *float64                      `json:"period_hours"`
	CycleStartMS          int64                         `json:"cycle_start_ms"`
	CycleResetMS          int64                         `json:"cycle_reset_ms"`
	UsedPercent           float64                       `json:"used_percent"`
	RemainingPercent      float64                       `json:"remaining_percent"`
	Status                string                        `json:"status" enums:"normal,limit_reached,projected_exhaust,underutilized"`
	ExhaustedAtMS         *int64                        `json:"exhausted_at_ms,omitempty"`
	ProjectedExhaustAtMS  *int64                        `json:"projected_exhaust_at_ms,omitempty"`
	ProjectedEndPercent   *float64                      `json:"projected_end_percent,omitempty"`
	BurnRatePerHour       *float64                      `json:"burn_rate_per_hour,omitempty"`
	CurrentRequests       int64                         `json:"current_requests"`
	CurrentNetTokens      int64                         `json:"current_net_tokens"`
	CurrentTotalTokens    int64                         `json:"current_total_tokens"`
	CurrentCostNanos      int64                         `json:"current_cost_nanos"`
	IsApproximate         bool                          `json:"is_approximate,omitempty"`
	IsPhysicalUnavailable bool                          `json:"is_physical_unavailable,omitempty"`
	CurrentUsage          *TrendsQuotaWindowUsageDTO    `json:"current_usage,omitempty"`
	Capacity              *TrendsQuotaWindowCapacityDTO `json:"capacity,omitempty"`
	CapacityUnavailable   string                        `json:"capacity_unavailable,omitempty"`
	Buckets               []TrendsQuotaBucketDTO        `json:"buckets"`
	Cycles                []TrendsQuotaCycleHistoryDTO  `json:"cycles"`
}

type TrendsQuotaCredentialDTO struct {
	AuthIndex     string                 `json:"auth_index"`
	Provider      string                 `json:"provider"`
	OAuthProvider string                 `json:"oauth_provider,omitempty"`
	DisplayName   string                 `json:"display_name,omitempty"`
	AccountLabel  string                 `json:"account_label"`
	Status        string                 `json:"status"`
	PlanType      string                 `json:"plan_type,omitempty"`
	PlanTier      string                 `json:"plan_tier,omitempty"`
	ObservedAtMS  int64                  `json:"observed_at_ms"`
	Windows       []TrendsQuotaWindowDTO `json:"windows"`
}

type TrendsQuotaResponseDTO struct {
	AsOfMS  int64                      `json:"as_of_ms"`
	Summary TrendsQuotaSummaryDTO      `json:"summary"`
	Items   []TrendsQuotaCredentialDTO `json:"items"`
}

// @Summary Query credential quota trends
// @Description Return observed quota cycles, physical consumption and bounded forecasts for enabled OAuth credentials.
// @Tags Trends
// @Produce json
// @Security CookieAuth
// @Param provider query []string false "Provider filter" collectionFormat(multi)
// @Param auth_index query []string false "Credential filter" collectionFormat(multi)
// @Success 200 {object} TrendsQuotaResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/trends/quota [get]
func (h *Handler) trendsQuota(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	query := request.URL.Query()
	if len(query["provider"]) > repository.MaxUsageEventFilterValues || len(query["auth_index"]) > repository.MaxUsageEventFilterValues {
		writeError(writer, http.StatusBadRequest, "too many quota filter values")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()
	result, err := h.readTrendsQuota(ctx, query["provider"], query["auth_index"], h.now().UnixMilli())
	if err != nil {
		writeInternalError(writer, fmt.Errorf("read quota trends: %w", err))
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (h *Handler) trendsOAuthFiles(ctx context.Context) (map[string]management.AuthFile, bool) {
	if h.cipher == nil {
		return nil, false
	}
	// Leave enough of the handler's deadline to read snapshots if CPA is offline.
	liveCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	instance, err := h.repo.GetInstance(liveCtx, defaultInstanceID())
	if err != nil {
		return nil, false
	}
	client, err := h.clientForInstance(liveCtx, instance)
	if err != nil {
		return nil, false
	}
	response, err := client.AuthFiles(liveCtx)
	if err != nil {
		return nil, false
	}
	files := make(map[string]management.AuthFile, len(response.Files))
	for _, file := range response.Files {
		index := strings.TrimSpace(file.AuthIndex)
		if index == "" || file.Disabled || isAPIKeyAuthFile(file) {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(file.AccountType), "oauth") || file.OAuthProvider != "" || quota.CapabilitiesForFile(file).RefreshSupported {
			files[index] = file
		}
	}
	return files, true
}

func trendsMatches(values []string, value string) bool {
	hasFilter := false
	for _, filter := range values {
		filter = strings.TrimSpace(filter)
		if filter == "" {
			continue
		}
		hasFilter = true
		if filter == value {
			return true
		}
	}
	return !hasFilter
}

func trendsQuotaStatus(status string, isUnavailable bool) string {
	if isUnavailable {
		return "unavailable"
	}
	switch status = strings.ToLower(strings.TrimSpace(status)); status {
	case "ok", "active", "healthy", "ready", "error", "unavailable", "stale", "warning", "cooldown", "disabled", "exhausted", "unsupported":
		return status
	default:
		return "unknown"
	}
}

func trendsQuotaLabel(value string, file management.AuthFile) string {
	// Both the gateway's file identifier and its basename are private.
	if file.Name != "" {
		base := path.Base(strings.ReplaceAll(file.Name, `\`, "/"))
		if strings.EqualFold(value, file.Name) || (strings.Contains(base, ".") && strings.Contains(strings.ToLower(value), strings.ToLower(base))) {
			return ""
		}
	}
	if strings.ContainsAny(value, `/\`) && strings.Contains(strings.ToLower(value), ".json") {
		return ""
	}
	value = security.MaskAccountIn(value, file.Email)
	value = security.MaskAccountIn(value, file.ProjectID)
	if strings.Contains(file.Account, "@") {
		value = security.MaskAccountIn(value, file.Account)
	} else {
		value = security.RedactText(value, file.Account)
	}
	return security.MaskEmailAddresses(security.RedactText(value))
}

func trendsQuotaAccount(file management.AuthFile, archived repository.ArchivedCredential) string {
	var accountEmail string
	if strings.Contains(file.Account, "@") {
		accountEmail = file.Account
	}
	for _, value := range []string{file.Email, accountEmail, file.ProjectID, archived.MaskedAccount} {
		if value == "" || strings.ContainsAny(value, "/\\ \t\r\n") || strings.EqualFold(value, file.Name) || strings.HasSuffix(strings.ToLower(value), ".json") {
			continue
		}
		if safe := security.RedactText(value); safe != value {
			continue
		}
		return security.MaskEmailAddresses(security.MaskAccount(value))
	}
	return ""
}

func (h *Handler) readTrendsQuota(ctx context.Context, providers, indexes []string, nowMS int64) (TrendsQuotaResponseDTO, error) {
	result := TrendsQuotaResponseDTO{AsOfMS: nowMS, Items: []TrendsQuotaCredentialDTO{}}
	files, isLive := h.trendsOAuthFiles(ctx)
	var authIndexes []string
	if isLive {
		for index := range files {
			authIndexes = append(authIndexes, index)
		}
	} else {
		var err error
		authIndexes, err = h.repo.ListQuotaSnapshotAuthIndexes(ctx)
		if err != nil {
			return result, err
		}
	}
	authIndexes = slices.DeleteFunc(authIndexes, func(index string) bool { return !trendsMatches(indexes, index) })
	slices.Sort(authIndexes)
	if len(authIndexes) == 0 {
		return result, nil
	}
	latest, err := h.repo.GetLatestQuotaSnapshots(ctx, authIndexes)
	if err != nil {
		return result, err
	}
	lastAttempts := h.lastQuotaAttempts(ctx, authIndexes)
	var activeCooldowns map[string]repository.ActiveCooldownRecord
	if cooldowns, cdErr := h.repo.BatchCorrelatedCooldowns(ctx, authIndexes, nowMS); cdErr == nil {
		activeCooldowns = cooldowns
	}
	names, err := h.repo.ListCredentialDisplayNames(ctx, defaultInstanceID())
	if err != nil {
		return result, err
	}
	archived, _, err := h.repo.ListIdentityArchive(ctx, defaultInstanceID())
	if err != nil {
		return result, err
	}
	archive := make(map[string]repository.ArchivedCredential, len(archived))
	for _, entry := range archived {
		archive[entry.AuthIndex] = entry
	}
	for _, index := range authIndexes {
		file, previous := files[index], archive[index]
		if !isLive && previous.Kind == "apikey" {
			continue
		}
		snapshot, hasStoredReading := latest[index]
		provider := quota.DetectProvider(file.Type, file.Provider)
		if snapshot.Provider != "" {
			provider = snapshot.Provider
		}
		if !trendsMatches(providers, provider) {
			continue
		}
		if previous.Kind != "oauth" || previous.IsAmbiguous {
			previous = repository.ArchivedCredential{}
		}
		// Archived file names are identifiers for the display-name lookup, never labels.
		if file.Name == "" {
			file.Name = previous.FileName
		}
		name := names[file.Name].DisplayName
		if name == "" {
			name = previous.DisplayName
		}
		oauthProvider := file.OAuthProvider
		if oauthProvider == "" {
			oauthProvider = previous.OAuthProvider
		}
		healthCheck := normalizedQuotaFromSnapshot(index, snapshot)
		healthCheck.Disabled = file.Disabled
		if cooldown, ok := activeCooldowns[index]; ok && cooldown.IsActive {
			healthCheck.ActiveCooldown = &quota.ActiveCooldown{
				IsActive:          true,
				Reason:            cooldown.Reason,
				RecoverAtMS:       cooldown.RecoverAtMS,
				RetryAfterSeconds: cooldown.RetryAfterSeconds,
				CorrelatedAtMS:    cooldown.CorrelatedAtMS,
				RetryAtMS:         cooldown.RetryAtMS,
				BackoffLevel:      cooldown.BackoffLevel,
			}
		}
		quota.EvaluateStatusAndRecommendation(healthCheck, nowMS)
		attempt := quotaAttemptOf(lastAttempts[index])
		quota.ApplyReadingHealth(healthCheck, attempt, hasStoredReading, nowMS)
		isTrustworthyReading := isLive && !file.Unavailable && !file.Disabled && !healthCheck.HasFailedRead && healthCheck.Status != "stale" && healthCheck.Status != "error"

		status := snapshot.Status
		if healthCheck.Status == "error" || healthCheck.Status == "stale" {
			status = healthCheck.Status
		} else if !isLive {
			// When CPA is unavailable, archived credentials cannot be verified as enabled;
			// preserve the historical reading while reporting membership and risk as unknown.
			status = "unknown"
		} else if healthCheck.Status == "cooldown" {
			status = healthCheck.Status
		} else if file.Status != "" {
			status = file.Status
		}
		item := TrendsQuotaCredentialDTO{
			AuthIndex: trendsQuotaLabel(index, file), Provider: trendsQuotaLabel(provider, file), OAuthProvider: trendsQuotaLabel(oauthProvider, file),
			DisplayName: trendsQuotaLabel(name, file), AccountLabel: trendsQuotaAccount(file, previous),
			Status: trendsQuotaStatus(status, file.Unavailable), ObservedAtMS: snapshot.ObservedAtMS,
			Windows: []TrendsQuotaWindowDTO{},
		}
		if plan := planFromSnapshot(snapshot); plan != nil {
			item.PlanType, item.PlanTier = trendsQuotaLabel(plan.PlanType, file), trendsQuotaLabel(plan.Tier, file)
		}
		if snapshot.ObservedAtMS > 0 {
			windows, err := h.readTrendsQuotaWindows(ctx, index, file, snapshot, nowMS, isTrustworthyReading)
			if err != nil {
				return result, err
			}
			item.Windows = windows
		}
		for _, window := range item.Windows {
			result.Summary.ObservableWindows++
			if !isTrustworthyReading || window.CycleResetMS <= nowMS {
				continue
			}
			switch window.Status {
			case trendsQuotaLimitReached:
				result.Summary.LimitReachedWindows++
			case trendsQuotaProjectedExhaust:
				result.Summary.ProjectedExhaustWindows++
			case trendsQuotaUnderutilized:
				result.Summary.UnderutilizedWindows++
			default:
				result.Summary.HealthyWindows++
			}
		}
		result.Items = append(result.Items, item)
	}
	if isLive {
		result.Summary.ActiveCredentials = len(result.Items)
	} else {
		result.Summary.IsMembershipUnknown = true
	}
	return result, nil
}

type trendsQuotaRetainedEntry struct {
	StartedMS   int64
	CompletedMS int64
	Model       string
	Measures    repository.UsageMeasures
}

func isTrendsQuotaFeatureWindow(window quota.QuotaWindow) bool {
	if window.ID == "seven_day_oauth_apps" || window.ID == "seven_day_cowork" || strings.HasPrefix(window.ID, "code_review") {
		return true
	}
	if window.Scope == "model" || window.Scope == "group" || window.Scope == "standard" {
		return false
	}
	return window.Scope != ""
}

type trendsQuotaPhysicalSnapshot struct {
	horizon  int64
	facts    []repository.UsageFactRow
	retained []trendsQuotaRetainedEntry
}

func (h *Handler) readTrendsQuotaWindows(ctx context.Context, index string, file management.AuthFile, snapshot repository.QuotaSnapshotRecord, nowMS int64, isTrustworthyReading bool) ([]TrendsQuotaWindowDTO, error) {
	result := []TrendsQuotaWindowDTO{}
	observation := normalizedQuotaFromSnapshot(index, snapshot)
	if len(observation.Windows) == 0 {
		return result, nil
	}
	history, err := h.repo.GetQuotaSnapshotHistory(ctx, index, 50)
	if err != nil {
		return nil, err
	}
	cycles, err := h.repo.LoadCapacityCycles(ctx, index)
	if err != nil {
		return nil, err
	}
	reads := make(map[string][]trendsQuotaReading)
	for _, record := range slices.Backward(history) {
		var windows []quota.QuotaWindow
		if json.Unmarshal([]byte(record.WindowsJSON), &windows) != nil {
			continue
		}
		for _, window := range windows {
			if used, ok := quota.WindowUsedPercent(window); ok && window.ResetAtMS != nil {
				key := quota.CapacityWindowKey(record.Provider, window)
				reads[key] = append(reads[key], trendsQuotaReading{at: record.ObservedAtMS, used: used, reset: *window.ResetAtMS, planType: record.PlanType, planTier: record.PlanTier})
			}
		}
	}

	type preparedQuotaWindow struct {
		source     quota.QuotaWindow
		start, at  int64
		used       float64
		reconciled []quota.CycleCalibration
	}
	prepared := make([]preparedQuotaWindow, 0, len(observation.Windows))
	var minFromMS, maxToMS int64
	hasSpan := false
	expandSpan := func(fromMS, toMS int64) {
		if toMS <= fromMS {
			return
		}
		if !hasSpan {
			minFromMS, maxToMS, hasSpan = fromMS, toMS, true
			return
		}
		minFromMS = min(minFromMS, fromMS)
		maxToMS = max(maxToMS, toMS)
	}
	for _, window := range observation.Windows {
		start, at, reason := quota.WindowCycleRange(window, snapshot.ObservedAtMS, snapshot.ObservedAtMS)
		used, ok := quota.WindowUsedPercent(window)
		if reason != "" || !ok {
			continue
		}
		key := quota.CapacityWindowKey(snapshot.Provider, window)
		reconciled := h.repo.ReconcileLiveCycleForRead(ctx, index, window, observation.Plan, snapshot.ObservedAtMS, cycles[key])
		live := quota.LiveCycleIndex(window, observation.ObservedAtMS, reconciled)
		prepared = append(prepared, preparedQuotaWindow{source: window, start: start, at: at, used: used, reconciled: reconciled})

		endUpper := min(max(at, nowMS), *window.ResetAtMS)
		if !isTrendsQuotaFeatureWindow(window) {
			expandSpan(start, endUpper)
			for idx, cycle := range reconciled {
				if idx == live || cycle.CycleResetAtMS > start || len(cycle.Points) == 0 {
					continue
				}
				last := trendsQuotaCycleMeasurement(cycle.Points)
				expandSpan(cycle.CycleStartMS(), min(last.ObservedAtMS, cycle.CycleResetAtMS))
			}
		}
	}
	if len(prepared) == 0 {
		return result, nil
	}
	var physicalData trendsQuotaPhysicalSnapshot
	if hasSpan {
		snapHorizon, facts, retained, err := h.repo.ReadQuotaTrendPhysical(ctx, defaultInstanceID(), index, minFromMS, maxToMS)
		if err != nil {
			return nil, err
		}
		physicalData.horizon = snapHorizon
		physicalData.facts = facts.Rows
		if len(retained) > 0 {
			physicalData.retained = make([]trendsQuotaRetainedEntry, len(retained))
			for i, entry := range retained {
				physicalData.retained[i] = trendsQuotaRetainedEntry{
					StartedMS:   entry.StartedMS,
					CompletedMS: entry.CompletedMS,
					Model:       entry.Model,
					Measures:    entry.Measures,
				}
			}
		}
	}
	for _, item := range prepared {
		key := quota.CapacityWindowKey(snapshot.Provider, item.source)
		built, err := h.readTrendsQuotaWindow(ctx, index, item.source, observation, file, item.start, item.at, nowMS, item.used, reads[key], item.reconciled, &physicalData, isTrustworthyReading)
		if err != nil {
			return nil, err
		}
		result = append(result, built)
	}
	return result, nil
}

type trendsQuotaReading struct {
	at, reset          int64
	used               float64
	planType, planTier string
}

type trendsQuotaPoint struct {
	at   int64
	used float64
}

func trendsQuotaPoints(window TrendsQuotaWindowDTO, source quota.QuotaWindow, observation *quota.NormalizedQuota, reads []trendsQuotaReading, cycles []quota.CycleCalibration, live int) []trendsQuotaPoint {
	pointsByTime := map[int64]float64{}
	if live >= 0 && quota.SameCalibrationPlan(cycles[live], observation.Plan) {
		for _, point := range cycles[live].Points {
			if point.ObservedAtMS >= window.CycleStartMS && point.ObservedAtMS <= observation.ObservedAtMS {
				pointsByTime[point.ObservedAtMS] = point.UsedPercent
			}
		}
	}
	for _, read := range reads {
		if read.at < window.CycleStartMS || read.at > observation.ObservedAtMS {
			continue
		}
		// Ordinary windows have stable resets; providers with approximate resets
		// are matched against the same tolerance as the stored cycle evidence.
		if read.reset != window.CycleResetMS {
			reset := read.reset
			candidate := source
			candidate.ResetAtMS = &reset
			if live < 0 || quota.LiveCycleIndex(candidate, read.at, cycles) != live {
				continue
			}
		}
		if observation.Plan != nil && (read.planType != observation.Plan.PlanType || read.planTier != observation.Plan.Tier) {
			continue
		}
		pointsByTime[read.at] = read.used
	}
	pointsByTime[observation.ObservedAtMS] = window.UsedPercent
	points := make([]trendsQuotaPoint, 0, len(pointsByTime))
	for at, used := range pointsByTime {
		points = append(points, trendsQuotaPoint{at: at, used: used})
	}
	slices.SortFunc(points, func(left, right trendsQuotaPoint) int { return cmp.Compare(left.at, right.at) })
	return points
}

func trendsQuotaActivePoints(points []trendsQuotaPoint) []trendsQuotaPoint {
	for index := len(points) - 1; index > 0; index-- {
		if points[index].used < points[index-1].used-1 {
			return points[index:]
		}
	}
	return points
}

func trendsQuotaBurnRate(points []trendsQuotaPoint) *float64 {
	const maxRecent = 10
	points = points[max(0, len(points)-maxRecent):]
	if len(points) < 2 {
		return nil
	}
	// The median pairwise slope (Theil–Sen) downweights a delayed batch or
	// one jump in the provider's rounded readings.
	slopes := make([]float64, 0, len(points)*(len(points)-1)/2)
	for i, left := range points {
		for _, right := range points[i+1:] {
			hours := float64(right.at-left.at) / float64(repository.HourBucketMS)
			if hours > 0 {
				slopes = append(slopes, max(right.used-left.used, 0)/hours)
			}
		}
	}
	median, _ := trendsPercentiles(slopes)
	return median
}

func (h *Handler) readTrendsQuotaWindow(ctx context.Context, index string, source quota.QuotaWindow, observation *quota.NormalizedQuota, file management.AuthFile, start, at, nowMS int64, used float64, reads []trendsQuotaReading, cycles []quota.CycleCalibration, physicalData *trendsQuotaPhysicalSnapshot, isTrustworthyReading bool) (TrendsQuotaWindowDTO, error) {
	result := TrendsQuotaWindowDTO{
		WindowID: trendsQuotaLabel(source.ID, file), Label: trendsQuotaLabel(source.Label, file), Kind: trendsQuotaLabel(source.Kind, file), Scope: trendsQuotaLabel(source.Scope, file),
		Model: trendsQuotaLabel(source.Model, file), PeriodHours: source.PeriodHours, CycleStartMS: start, CycleResetMS: *source.ResetAtMS, UsedPercent: used, RemainingPercent: 100 - used, Status: trendsQuotaNormal,
		Cycles: []TrendsQuotaCycleHistoryDTO{},
	}
	live := quota.LiveCycleIndex(source, observation.ObservedAtMS, cycles)
	points := trendsQuotaPoints(result, source, observation, reads, cycles, live)
	active := trendsQuotaActivePoints(points)
	actualEnd := min(at, result.CycleResetMS)
	capacityTo := min(at, result.CycleResetMS)
	emitForecast := isTrustworthyReading && nowMS < result.CycleResetMS
	if used >= 100 {
		cutoffAt := actualEnd
		if cutoff, _, ok := quota.ExhaustionCutoffPoint(source, observation.Plan, observation.ObservedAtMS, cycles); ok {
			cutoffAt = max(start, min(at, cutoff.ObservedAtMS))
		} else {
			for _, point := range active {
				if point.used >= 100 {
					cutoffAt = point.at
					break
				}
			}
		}
		capacityTo = cutoffAt
		result.ExhaustedAtMS = &cutoffAt
		if emitForecast {
			result.Status = trendsQuotaLimitReached
			actualEnd = cutoffAt
		} else if isTrustworthyReading {
			actualEnd = result.CycleResetMS
		}
	} else if emitForecast {
		// Measurements and projections track wall-clock time (`nowMS`), not the stale timestamp of the
		// last snapshot (`at`), so an unexhausted window's "Now" marker and exhaustion ETA never fall behind.
		actualEnd = max(at, min(nowMS, result.CycleResetMS))
		if rate := trendsQuotaBurnRate(active); rate != nil {
			result.BurnRatePerHour = rate
			remaining := float64(result.CycleResetMS-actualEnd) / float64(repository.HourBucketMS)
			projected := used + *rate*remaining
			result.ProjectedEndPercent = &projected
			if *rate > 0 {
				msToExhaustion := math.Ceil((100 - used) / *rate * float64(repository.HourBucketMS))
				if msToExhaustion <= float64(math.MaxInt64-actualEnd-1) {
					projectedMS := actualEnd + int64(msToExhaustion)
					result.ProjectedExhaustAtMS = &projectedMS
					if projectedMS < result.CycleResetMS {
						result.Status = trendsQuotaProjectedExhaust
					}
				}
			}
			if result.Status == trendsQuotaNormal && float64(max(nowMS, at)-start)/float64(result.CycleResetMS-start) > 0.60 && projected < 35 {
				result.Status = trendsQuotaUnderutilized
			}
		}
	} else if isTrustworthyReading {
		actualEnd = result.CycleResetMS
	}

	zone := h.insightsZone()
	buckets := trendsQuotaGrid(start, result.CycleResetMS, actualEnd, zone)
	if !isTrustworthyReading {
		buckets = slices.DeleteFunc(buckets, func(b TrendsQuotaBucketDTO) bool { return b.IsForecast })
	}
	displayedPhysical, snapshotPhysical, postPhysical, isApproximate := readTrendsQuotaPhysicalFromData(physicalData, source, start, capacityTo, actualEnd, buckets)
	result.Buckets = buckets
	fillTrendsQuotaBuckets(result.Buckets, points, result, actualEnd)
	supportsCapacity := quota.SupportsWindowCapacity(observation.Provider, source)
	reconciledFromCalibration := false
	if supportsCapacity {
		if !isTrustworthyReading {
			result.CapacityUnavailable = quota.CapacityReasonNoReading
		} else if nowMS >= result.CycleResetMS {
			result.CapacityUnavailable = quota.CapacityReasonExpired
		} else {
			usage, reason, err := h.resolveCurrentCycleUsage(ctx, index, source, observation.Plan, capacityTo, start, capacityTo, cycles)
			if err != nil {
				return result, err
			}
			result.CapacityUnavailable = reason
			if reason == "" {
				result.CurrentUsage = trendsQuotaWindowUsageDTO(usage)
				estimated, capReason := quota.EstimateWindowCapacity(source, observation.Plan, observation.ObservedAtMS, nowMS, &usage, cycles)
				result.Capacity, result.CapacityUnavailable = trendsQuotaWindowCapacityDTO(estimated), capReason
				if usage.Requests > snapshotPhysical.Requests && live >= 0 {
					var netApprox bool
					snapshotPhysical, netApprox = mergeTrendsQuotaUsage(snapshotPhysical, usage)
					isApproximate = isApproximate || netApprox
					reconciledFromCalibration = true
				}
			}
		}
	}
	physical := displayedPhysical
	if reconciledFromCalibration {
		reconciled := snapshotPhysical
		if actualEnd > capacityTo {
			reconciled.add(postPhysical)
		}
		if reconciled.Requests > physical.Requests {
			physical = reconciled
		}
	}
	result.CurrentRequests, result.CurrentNetTokens, result.CurrentTotalTokens, result.CurrentCostNanos = physical.Requests, physical.NetTokens, physical.TotalTokens, physical.CostNanos
	result.IsApproximate = isApproximate
	result.IsPhysicalUnavailable = isTrendsQuotaFeatureWindow(source)
	result.Cycles = append(result.Cycles, trendsQuotaCycle(start, result.CycleResetMS, used, physical, snapshotPhysical, true, isApproximate, supportsCapacity))
	for idx, cycle := range cycles {
		if idx == live || cycle.CycleResetAtMS > start || len(cycle.Points) == 0 {
			continue
		}
		last := trendsQuotaCycleMeasurement(cycle.Points)
		measuredTo := min(last.ObservedAtMS, cycle.CycleResetAtMS)
		prior, _, _, priorApproximate := readTrendsQuotaPhysicalFromData(physicalData, source, cycle.CycleStartMS(), measuredTo, measuredTo, nil)
		if last.Requests > prior.Requests {
			var netApprox bool
			prior, netApprox = mergeTrendsQuotaUsage(prior, quota.WindowUsage{Requests: last.Requests, Tokens: last.Tokens, PromptTokens: last.PromptTokens, CachedTokens: last.CachedTokens, PricedRequests: last.PricedRequests, CostNanos: last.CostNanos})
			priorApproximate = priorApproximate || netApprox
		}
		result.Cycles = append(result.Cycles, trendsQuotaCycle(cycle.CycleStartMS(), cycle.CycleResetAtMS, last.UsedPercent, prior, prior, false, priorApproximate, supportsCapacity))
	}
	return result, nil
}

func trendsQuotaCycleMeasurement(points []quota.CalibrationPoint) quota.CalibrationPoint {
	start := 0
	for i := 1; i < len(points); i++ {
		if points[i].UsedPercent < points[i-1].UsedPercent-1 {
			start = i
		}
	}
	for _, point := range points[start:] {
		if point.UsedPercent >= 100 {
			return point
		}
	}
	return points[len(points)-1]
}

// Calibration preserves a cycle's total and cached reads after request detail
// disappears. Prefer the normalized net ratio from the usage that survives,
// since the calibration does not carry cache writes; flag reconstructed net
// tokens as approximate whenever calibration scales beyond surviving physical facts.
func mergeTrendsQuotaUsage(physical TrendsUsageTotalsDTO, usage quota.WindowUsage) (TrendsUsageTotalsDTO, bool) {
	net := int64(0)
	isNetApproximate := false
	if physical.TotalTokens > 0 {
		net = min(usage.Tokens, int64(math.Round(float64(physical.NetTokens)/float64(physical.TotalTokens)*float64(usage.Tokens))))
		isNetApproximate = usage.Tokens != physical.TotalTokens
	} else if usage.PromptTokens > 0 || usage.CachedTokens > 0 {
		net = max(0, usage.Tokens-usage.CachedTokens)
		isNetApproximate = usage.Tokens > 0
	} else if usage.Tokens > 0 {
		isNetApproximate = true
	}
	return TrendsUsageTotalsDTO{
		TrendsUsageGroupMeasuresDTO: TrendsUsageGroupMeasuresDTO{Requests: usage.Requests, TotalTokens: usage.Tokens, NetTokens: net, CostNanos: usage.CostNanos},
		PromptTokens:                max(usage.PromptTokens, physical.PromptTokens), CompletionTokens: physical.CompletionTokens,
		CacheReadTokens: max(usage.CachedTokens, physical.CacheReadTokens), CostedRequests: usage.PricedRequests,
	}, isNetApproximate
}

func trendsQuotaCycle(start, reset int64, used float64, actualPhysical, snapshotPhysical TrendsUsageTotalsDTO, isCurrent, isApproximate, supportsCapacity bool) TrendsQuotaCycleHistoryDTO {
	result := TrendsQuotaCycleHistoryDTO{
		CycleStartMS: start, CycleResetMS: reset, IsCurrent: isCurrent, UsedPercent: used,
		ActualRequests: actualPhysical.Requests, ActualNetTokens: actualPhysical.NetTokens, ActualTotalTokens: actualPhysical.TotalTokens,
		IsApproximate: isApproximate,
	}
	if !supportsCapacity {
		return result
	}
	usage := quota.WindowUsage{Requests: snapshotPhysical.Requests, Tokens: snapshotPhysical.TotalTokens, CostNanos: snapshotPhysical.CostNanos, PricedRequests: snapshotPhysical.CostedRequests}
	if capacity := quota.ScaleWindowCapacity(quota.CapacityBasisCurrentWindow, used, usage); capacity != nil {
		result.FullRequests, result.FullTotalTokens, result.FullCostNanos = &capacity.Requests, &capacity.Tokens, capacity.CostNanos
		value := math.Round(float64(snapshotPhysical.NetTokens) * 100 / used)
		if value < float64(math.MaxInt64) && (snapshotPhysical.PromptTokens > 0 || snapshotPhysical.CompletionTokens > 0 || snapshotPhysical.CacheReadTokens > 0) {
			net := int64(value)
			result.FullNetTokens = &net
		}
	}
	return result
}

func trendsQuotaGrid(start, reset, measuredTo int64, zone *time.Location) []TrendsQuotaBucketDTO {
	const hour = repository.HourBucketMS
	span := reset - start
	var step int64
	switch {
	case span <= 6*hour:
		step = repository.QuarterHourBucketMS
	case span <= 48*hour:
		step = hour
	case span <= 12*repository.DayBucketMS:
		step = 6 * hour
	case span <= 21*repository.DayBucketMS:
		step = 12 * hour
	case span > 55*repository.DayBucketMS:
		step = (span + 54) / 55
	}
	buckets := make([]TrendsQuotaBucketDTO, 0, 56)
	for cursor := start; cursor < reset; {
		end := reset
		if step > 0 {
			end = min(end, start+((cursor-start)/step+1)*step)
		} else {
			at := time.UnixMilli(cursor)
			day := insightsBucketDay.bucketStart(at, zone)
			end = min(end, insightsBucketDay.next(day, zone).UnixMilli())
		}
		if cursor < measuredTo {
			end = min(end, measuredTo)
		}
		if end <= cursor {
			end = min(reset, cursor+repository.DayBucketMS)
		}
		buckets = append(buckets, TrendsQuotaBucketDTO{StartMS: cursor, EndMS: end, IsForecast: cursor >= measuredTo})
		cursor = end
	}
	return buckets
}

func readTrendsQuotaPhysicalFromData(data *trendsQuotaPhysicalSnapshot, window quota.QuotaWindow, fromMS, splitMS, toMS int64, buckets []TrendsQuotaBucketDTO) (displayed, beforeSplit, afterSplit TrendsUsageTotalsDTO, isApproximate bool) {
	if data == nil || toMS <= fromMS || isTrendsQuotaFeatureWindow(window) {
		return displayed, beforeSplit, afterSplit, false
	}
	if splitMS < fromMS {
		splitMS = fromMS
	}
	if splitMS > toMS {
		splitMS = toMS
	}
	isScoped := window.Scope == "model" || window.Scope == "group"
	findBucket := func(at int64) int {
		if len(buckets) == 0 {
			return -1
		}
		bucketIndex, _ := slices.BinarySearchFunc(buckets, at, func(bucket TrendsQuotaBucketDTO, at int64) int {
			if at >= bucket.EndMS {
				return -1
			}
			if at < bucket.StartMS {
				return 1
			}
			return 0
		})
		if bucketIndex < len(buckets) && at < buckets[bucketIndex].EndMS && at >= buckets[bucketIndex].StartMS {
			return bucketIndex
		}
		return -1
	}
	accumulate := func(at, endAt int64, model string, measures repository.UsageMeasures, addToBuckets bool) {
		if isScoped && !quota.IsModelInWindowScope(window, model) {
			return
		}
		physical := trendsUsageMeasures(measures)
		displayed.add(physical)
		if endAt <= splitMS {
			beforeSplit.add(physical)
		} else if at >= splitMS {
			afterSplit.add(physical)
		} else if splitMS < toMS {
			isApproximate = true
		}
		if addToBuckets {
			if bucketIndex := findBucket(at); bucketIndex >= 0 {
				bucket := &buckets[bucketIndex]
				bucket.Requests += physical.Requests
				bucket.NetTokens += physical.NetTokens
				bucket.TotalTokens += physical.TotalTokens
			}
		}
	}
	snapshotHorizon := data.horizon
	var coveredFactBuckets map[int64]struct{}
	if snapshotHorizon > fromMS {
		factEnd := min(toMS, snapshotHorizon)
		if isScoped {
			// Permanent 15m facts store requested model rather than serving model;
			// mark scoped history approximate instead of attributing requested-model rollups.
			for _, row := range data.facts {
				rowEnd := row.StartMS + repository.QuarterHourBucketMS
				if rowEnd > fromMS && row.StartMS < factEnd {
					isApproximate = true
					break
				}
			}
		} else {
			for _, row := range data.facts {
				rowEnd := row.StartMS + repository.QuarterHourBucketMS
				if rowEnd <= fromMS || row.StartMS >= factEnd {
					continue
				}
				if row.StartMS < fromMS || rowEnd > factEnd {
					isApproximate = true
					continue
				}
				// Permanent 15m facts bucket by request start time (`timestamp_ms`) rather
				// than completion time (`completed_at_ms`), and aggregate failures together with
				// zero-token rows, so any fact-backed span is conservatively marked approximate.
				isApproximate = true
				if coveredFactBuckets == nil {
					coveredFactBuckets = make(map[int64]struct{})
				}
				coveredFactBuckets[row.StartMS] = struct{}{}
				accumulate(row.StartMS, rowEnd, row.Keys[0], row.UsageMeasures, true)
			}
		}
	}
	for _, entry := range data.retained {
		if entry.CompletedMS < max(fromMS, snapshotHorizon) || entry.CompletedMS >= toMS {
			continue
		}
		if coveredFactBuckets != nil {
			bucketStart := (entry.StartedMS / repository.QuarterHourBucketMS) * repository.QuarterHourBucketMS
			if entry.StartedMS < 0 {
				bucketStart = ((entry.StartedMS - repository.QuarterHourBucketMS + 1) / repository.QuarterHourBucketMS) * repository.QuarterHourBucketMS
			}
			if _, alreadyCounted := coveredFactBuckets[bucketStart]; alreadyCounted {
				continue
			}
		}
		accumulate(entry.CompletedMS, entry.CompletedMS+1, entry.Model, entry.Measures, true)
	}
	return displayed, beforeSplit, afterSplit, isApproximate
}

func fillTrendsQuotaBuckets(buckets []TrendsQuotaBucketDTO, readings []trendsQuotaPoint, window TrendsQuotaWindowDTO, measuredEndMS int64) {
	points := make([]trendsQuotaPoint, 1, len(readings)+1)
	points[0] = trendsQuotaPoint{at: window.CycleStartMS}
	for _, point := range readings {
		previous := &points[len(points)-1]
		if point.at == previous.at {
			*previous = point
			continue
		}
		if point.used >= previous.used-1 && point.at != readings[len(readings)-1].at {
			point.used = max(point.used, previous.used)
		}
		points = append(points, point)
	}
	if len(points) < 2 {
		return
	}
	last := points[len(points)-1]
	forecastFrom := max(last.at, measuredEndMS)
	interpolate := func(at int64) float64 {
		if window.ExhaustedAtMS != nil && at >= *window.ExhaustedAtMS {
			return 100
		}
		if at >= last.at {
			if at <= forecastFrom || window.BurnRatePerHour == nil {
				return last.used
			}
			return min(100, last.used+*window.BurnRatePerHour*float64(at-forecastFrom)/float64(repository.HourBucketMS))
		}
		for idx := 1; idx < len(points); idx++ {
			right, left := points[idx], points[idx-1]
			if at > right.at {
				continue
			}
			if at == right.at {
				return right.used
			}
			if right.used < left.used {
				return left.used
			} // An observed reset is a step, not negative consumption.
			net, requests := trendsQuotaWeights(buckets, left.at, right.at)
			partialNet, partialRequests := trendsQuotaWeights(buckets, left.at, at)
			fraction := float64(at-left.at) / float64(right.at-left.at)
			if net > 0 {
				fraction = partialNet / net
			} else if requests > 0 {
				fraction = partialRequests / requests
			}
			return left.used + (right.used-left.used)*min(1, max(0, fraction))
		}
		return last.used
	}
	previous := points[0].used
	for index := range buckets {
		bucket := &buckets[index]
		bucket.UsedPercent = interpolate(bucket.EndMS)
		bucket.DeltaPercent = max(0, bucket.UsedPercent-previous)
		previous = bucket.UsedPercent
	}
}

func trendsQuotaWeights(buckets []TrendsQuotaBucketDTO, fromMS, toMS int64) (net, requests float64) {
	for _, bucket := range buckets {
		if bucket.IsForecast || bucket.StartMS >= toMS {
			break
		}
		overlap := min(toMS, bucket.EndMS) - max(fromMS, bucket.StartMS)
		if overlap <= 0 {
			continue
		}
		weight := float64(overlap) / float64(bucket.EndMS-bucket.StartMS)
		net += weight * float64(bucket.NetTokens)
		requests += weight * float64(bucket.Requests)
	}
	return net, requests
}
