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
		result.Summary.IsMembershipUnknown = !isLive
		return result, nil
	}
	// One batched history read serves both the latest reading (entry 0) and the
	// 50-reading trajectory for every credential.
	historyByAuth, err := h.repo.GetQuotaSnapshotHistoryBatch(ctx, authIndexes, 50)
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

	preparedCreds := make([]*trendsQuotaPreparedCred, 0, len(authIndexes))
	credAuthsWithSnap := make([]string, 0, len(authIndexes))
	for _, index := range authIndexes {
		file, previous := files[index], archive[index]
		if !isLive && previous.Kind == "apikey" {
			continue
		}
		history := historyByAuth[index]
		var snapshot repository.QuotaSnapshotRecord
		hasStoredReading := len(history) > 0
		if hasStoredReading {
			snapshot = history[0]
		}
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
		cred := &trendsQuotaPreparedCred{
			index:                index,
			file:                 file,
			snapshot:             snapshot,
			history:              history,
			item:                 item,
			isTrustworthyReading: isTrustworthyReading,
		}
		preparedCreds = append(preparedCreds, cred)
		if snapshot.ObservedAtMS > 0 {
			credAuthsWithSnap = append(credAuthsWithSnap, index)
		}
	}

	var cyclesByAuth map[string]map[string][]quota.CycleCalibration
	if len(credAuthsWithSnap) > 0 {
		cyclesByAuth, err = h.repo.LoadCapacityCyclesBatch(ctx, credAuthsWithSnap)
		if err != nil {
			return result, err
		}
	}

	zone := h.insightsZone()
	credByAuth := make(map[string]*trendsQuotaPreparedCred, len(preparedCreds))
	spans := make([]repository.QuotaTrendCredentialSpan, 0, len(credAuthsWithSnap))
	for _, cred := range preparedCreds {
		if cred.snapshot.ObservedAtMS <= 0 {
			continue
		}
		prepareTrendsQuotaCredentialWindows(cred, cyclesByAuth[cred.index], nowMS, zone)
		if cred.hasSpan {
			credByAuth[cred.index] = cred
			spans = append(spans, repository.QuotaTrendCredentialSpan{
				AuthIndex:     cred.index,
				FromMS:        cred.minFromMS,
				ToMS:          cred.maxToMS,
				NeedModel:     cred.hasScopedWindow,
				NeedCapFromMS: cred.capMinFromMS,
				NeedCapToMS:   cred.capMaxToMS,
			})
		}
	}

	var dbWatermark int64
	if len(spans) > 0 {
		batchFacts, err := h.repo.ReadQuotaTrendBatch(
			ctx,
			defaultInstanceID(),
			spans,
			func(authIndex string, watermarkID int64, ev repository.QuotaTrendStreamEvent) {
				if cred := credByAuth[authIndex]; cred != nil {
					accumulateTrendsQuotaEvent(cred, ev, watermarkID)
				}
			},
		)
		if err != nil {
			return result, err
		}
		dbWatermark = batchFacts.WatermarkID
		for authIndex, cred := range credByAuth {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			applyTrendsQuotaDeletedFacts(cred, batchFacts.HorizonMS, batchFacts.FactsByAuth[authIndex])
		}
	}

	for _, cred := range preparedCreds {
		if len(cred.windows) > 0 {
			cred.item.Windows = finalizeTrendsQuotaWindows(cred, nowMS, dbWatermark)
		}
		for _, window := range cred.item.Windows {
			result.Summary.ObservableWindows++
			if !cred.isTrustworthyReading || window.CycleResetMS <= nowMS {
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
		result.Items = append(result.Items, cred.item)
	}
	if isLive {
		result.Summary.ActiveCredentials = len(result.Items)
	} else {
		result.Summary.IsMembershipUnknown = true
	}
	return result, nil
}

const (
	capScopeUnset uint8 = iota
	capScopeMatch
	capScopeUnmatched
	capScopeIgnored
)

type trendsQuotaPriorCycleAcc struct {
	cycleStartMS  int64
	cycleResetMS  int64
	measuredToMS  int64
	lastPoint     quota.CalibrationPoint
	physical      TrendsUsageTotalsDTO
	isApproximate bool
}

type trendsQuotaPreparedWindow struct {
	dto              TrendsQuotaWindowDTO
	source           quota.QuotaWindow
	observation      *quota.NormalizedQuota
	start            int64
	at               int64
	actualEnd        int64
	capacityTo       int64
	used             float64
	points           []trendsQuotaPoint
	cycles           []quota.CycleCalibration
	live             int
	isFeature        bool
	isScoped         bool
	supportsCapacity bool
	needsCapacity    bool
	scopeReason      string

	displayedPhysical TrendsUsageTotalsDTO
	snapshotPhysical  TrendsUsageTotalsDTO
	postPhysical      TrendsUsageTotalsDTO
	isApproximate     bool
	priorCycles       []trendsQuotaPriorCycleAcc

	canReconcileLive    bool
	isLegacyReconcile   bool
	liveCycleStartMS    int64
	liveStartLowerMS    int64
	liveLastObservedMS  int64
	liveLastWatermarkID int64
	legacyPointAcc      []quota.WindowUsage
	latePointDelta      []quota.WindowUsage

	capStartLowerMS       int64
	capLive               quota.WindowUsage
	hasLatestPoint        bool
	latestPointObservedMS int64
	capPostFromMS         int64
	capPost               quota.WindowUsage

	physicalScopeMemo map[string]bool
	capScopeMemo      map[string]uint8
}

type trendsQuotaPreparedCred struct {
	index                string
	file                 management.AuthFile
	snapshot             repository.QuotaSnapshotRecord
	history              []repository.QuotaSnapshotRecord
	item                 TrendsQuotaCredentialDTO
	isTrustworthyReading bool
	windows              []*trendsQuotaPreparedWindow
	minFromMS            int64
	maxToMS              int64
	hasSpan              bool
	capMinFromMS         int64
	capMaxToMS           int64
	hasCapSpan           bool
	hasScopedWindow      bool
}

func (c *trendsQuotaPreparedCred) expandSpan(fromMS, toMS int64) {
	if toMS <= fromMS {
		return
	}
	if !c.hasSpan {
		c.minFromMS, c.maxToMS, c.hasSpan = fromMS, toMS, true
		return
	}
	c.minFromMS = min(c.minFromMS, fromMS)
	c.maxToMS = max(c.maxToMS, toMS)
}

func (c *trendsQuotaPreparedCred) expandCapSpan(fromMS, toMS int64) {
	if toMS <= fromMS {
		return
	}
	if !c.hasCapSpan {
		c.capMinFromMS, c.capMaxToMS, c.hasCapSpan = fromMS, toMS, true
		return
	}
	c.capMinFromMS = min(c.capMinFromMS, fromMS)
	c.capMaxToMS = max(c.capMaxToMS, toMS)
}

func (w *trendsQuotaPreparedWindow) isModelInPhysicalScope(model string) bool {
	if !w.isScoped {
		return true
	}
	if w.physicalScopeMemo == nil {
		w.physicalScopeMemo = make(map[string]bool, 8)
	}
	if matched, ok := w.physicalScopeMemo[model]; ok {
		return matched
	}
	matched := quota.IsModelInWindowScope(w.source, model)
	w.physicalScopeMemo[model] = matched
	return matched
}

func (w *trendsQuotaPreparedWindow) classifyCapacityModel(model string) uint8 {
	if !w.isScoped {
		return capScopeMatch
	}
	if w.capScopeMemo == nil {
		w.capScopeMemo = make(map[string]uint8, 8)
	}
	if cls, ok := w.capScopeMemo[model]; ok {
		return cls
	}
	selected, reason := quota.SelectWindowUsage(w.source, []quota.ModelWindowUsage{{
		Model: model,
		Usage: quota.WindowUsage{Requests: 1},
	}})
	var cls uint8
	switch {
	case reason != "":
		cls = capScopeIgnored
	case selected.Requests > 0:
		cls = capScopeMatch
	case selected.UnmatchedRequests > 0:
		cls = capScopeUnmatched
	default:
		cls = capScopeIgnored
	}
	w.capScopeMemo[model] = cls
	return cls
}

func addCapacityUsageSample(dst *quota.WindowUsage, ev quota.WindowUsage, scopeClass uint8) {
	switch scopeClass {
	case capScopeMatch:
		dst.Requests += ev.Requests
		dst.PricedRequests += ev.PricedRequests
		dst.Tokens += ev.Tokens
		dst.PromptTokens += ev.PromptTokens
		dst.CachedTokens += ev.CachedTokens
		dst.CostNanos += ev.CostNanos
	case capScopeUnmatched:
		dst.UnmatchedRequests += ev.Requests
	}
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

func prepareTrendsQuotaCredentialWindows(cred *trendsQuotaPreparedCred, cyclesByKey map[string][]quota.CycleCalibration, nowMS int64, zone *time.Location) {
	observation := normalizedQuotaFromSnapshot(cred.index, cred.snapshot)
	if len(observation.Windows) == 0 {
		return
	}
	reads := make(map[string][]trendsQuotaReading)
	for _, record := range slices.Backward(cred.history) {
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

	cred.windows = make([]*trendsQuotaPreparedWindow, 0, len(observation.Windows))
	for _, source := range observation.Windows {
		start, at, reason := quota.WindowCycleRange(source, cred.snapshot.ObservedAtMS, cred.snapshot.ObservedAtMS)
		used, ok := quota.WindowUsedPercent(source)
		if reason != "" || !ok {
			continue
		}
		key := quota.CapacityWindowKey(cred.snapshot.Provider, source)
		rawCycles := cyclesByKey[key]
		cycles := slices.Clone(rawCycles)
		live := quota.LiveCycleIndex(source, observation.ObservedAtMS, cycles)
		if live >= 0 {
			cycles[live].Points = slices.Clone(cycles[live].Points)
		}

		dto := TrendsQuotaWindowDTO{
			WindowID: trendsQuotaLabel(source.ID, cred.file), Label: trendsQuotaLabel(source.Label, cred.file),
			Kind: trendsQuotaLabel(source.Kind, cred.file), Scope: trendsQuotaLabel(source.Scope, cred.file),
			Model: trendsQuotaLabel(source.Model, cred.file), PeriodHours: source.PeriodHours,
			CycleStartMS: start, CycleResetMS: *source.ResetAtMS, UsedPercent: used, RemainingPercent: 100 - used,
			Status: trendsQuotaNormal, Cycles: []TrendsQuotaCycleHistoryDTO{},
		}
		points := trendsQuotaPoints(dto, source, observation, reads[key], cycles, live)
		active := trendsQuotaActivePoints(points)
		actualEnd := min(at, dto.CycleResetMS)
		capacityTo := min(at, dto.CycleResetMS)
		emitForecast := cred.isTrustworthyReading && nowMS < dto.CycleResetMS
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
			dto.ExhaustedAtMS = &cutoffAt
			if emitForecast {
				dto.Status = trendsQuotaLimitReached
				actualEnd = cutoffAt
			} else if cred.isTrustworthyReading {
				actualEnd = dto.CycleResetMS
			}
		} else if emitForecast {
			// Measurements and projections track wall-clock time (`nowMS`), not the stale timestamp of the
			// last snapshot (`at`), so an unexhausted window's "Now" marker and exhaustion ETA never fall behind.
			actualEnd = max(at, min(nowMS, dto.CycleResetMS))
			if rate := trendsQuotaBurnRate(active); rate != nil {
				dto.BurnRatePerHour = rate
				remaining := float64(dto.CycleResetMS-actualEnd) / float64(repository.HourBucketMS)
				projected := used + *rate*remaining
				dto.ProjectedEndPercent = &projected
				if *rate > 0 {
					msToExhaustion := math.Ceil((100 - used) / *rate * float64(repository.HourBucketMS))
					if msToExhaustion <= float64(math.MaxInt64-actualEnd-1) {
						projectedMS := actualEnd + int64(msToExhaustion)
						dto.ProjectedExhaustAtMS = &projectedMS
						if projectedMS < dto.CycleResetMS {
							dto.Status = trendsQuotaProjectedExhaust
						}
					}
				}
				if dto.Status == trendsQuotaNormal && float64(max(nowMS, at)-start)/float64(dto.CycleResetMS-start) > 0.60 && projected < 35 {
					dto.Status = trendsQuotaUnderutilized
				}
			}
		} else if cred.isTrustworthyReading {
			actualEnd = dto.CycleResetMS
		}

		buckets := trendsQuotaGrid(start, dto.CycleResetMS, actualEnd, zone)
		if !cred.isTrustworthyReading {
			buckets = slices.DeleteFunc(buckets, func(b TrendsQuotaBucketDTO) bool { return b.IsForecast })
		}
		dto.Buckets = buckets

		isFeature := isTrendsQuotaFeatureWindow(source)
		isScoped := source.Scope == "model" || source.Scope == "group"
		scopeReason := ""
		if isScoped {
			_, scopeReason = quota.SelectWindowUsage(source, nil)
		}
		supportsCapacity := quota.SupportsWindowCapacity(observation.Provider, source)
		needsCapacity := supportsCapacity && cred.isTrustworthyReading && nowMS < dto.CycleResetMS

		w := &trendsQuotaPreparedWindow{
			dto:              dto,
			source:           source,
			observation:      observation,
			start:            start,
			at:               at,
			actualEnd:        actualEnd,
			capacityTo:       capacityTo,
			used:             used,
			points:           points,
			cycles:           cycles,
			live:             live,
			isFeature:        isFeature,
			isScoped:         isScoped,
			supportsCapacity: supportsCapacity,
			needsCapacity:    needsCapacity,
			scopeReason:      scopeReason,
			capStartLowerMS:  max(0, start-repository.CapacityLatencyLookbackMS),
		}

		if isScoped {
			cred.hasScopedWindow = true
		}
		if live >= 0 && quota.SameCalibrationPlan(cycles[live], observation.Plan) && len(cycles[live].Points) > 0 && scopeReason == "" {
			liveCycle := &cycles[live]
			lastPt := liveCycle.Points[len(liveCycle.Points)-1]
			w.canReconcileLive = true
			w.isLegacyReconcile = repository.CycleNeedsLegacyReconcile(liveCycle.Points)
			w.liveCycleStartMS = liveCycle.CycleStartMS()
			w.liveStartLowerMS = max(0, w.liveCycleStartMS-repository.CapacityLatencyLookbackMS)
			w.liveLastObservedMS = lastPt.ObservedAtMS
			w.liveLastWatermarkID = lastPt.UsageWatermarkID
			if w.isLegacyReconcile {
				w.legacyPointAcc = make([]quota.WindowUsage, len(liveCycle.Points))
			} else {
				w.latePointDelta = make([]quota.WindowUsage, len(liveCycle.Points))
			}
			cred.expandSpan(w.liveCycleStartMS, w.liveLastObservedMS)
			cred.expandCapSpan(w.liveCycleStartMS, w.liveLastObservedMS)
		}

		if needsCapacity && scopeReason == "" {
			cred.expandSpan(start, capacityTo)
			cred.expandCapSpan(start, capacityTo)
			if latest, ok := quota.LatestLiveCalibrationPoint(source, observation.Plan, capacityTo, cycles); ok {
				w.hasLatestPoint = true
				w.latestPointObservedMS = latest.ObservedAtMS
				w.capPostFromMS = max(start, latest.ObservedAtMS)
			}
		}

		if !isFeature {
			cred.expandSpan(start, actualEnd)
			for idx, cycle := range cycles {
				if idx == live || cycle.CycleResetAtMS > start || len(cycle.Points) == 0 {
					continue
				}
				last := trendsQuotaCycleMeasurement(cycle.Points)
				measuredTo := min(last.ObservedAtMS, cycle.CycleResetAtMS)
				w.priorCycles = append(w.priorCycles, trendsQuotaPriorCycleAcc{
					cycleStartMS: cycle.CycleStartMS(),
					cycleResetMS: cycle.CycleResetAtMS,
					measuredToMS: measuredTo,
					lastPoint:    last,
				})
				cred.expandSpan(cycle.CycleStartMS(), measuredTo)
			}
		}

		cred.windows = append(cred.windows, w)
	}
}

func findQuotaBucketIndex(buckets []TrendsQuotaBucketDTO, at int64) int {
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

func applyTrendsQuotaDeletedFacts(cred *trendsQuotaPreparedCred, horizonMS int64, factRows []repository.UsageFactRow) {
	if horizonMS <= 0 || len(factRows) == 0 {
		return
	}
	applySpan := func(
		isScoped bool,
		fromMS, splitMS, toMS int64,
		buckets []TrendsQuotaBucketDTO,
		displayed, beforeSplit, afterSplit *TrendsUsageTotalsDTO,
		isApprox *bool,
	) {
		if toMS <= fromMS || horizonMS <= fromMS {
			return
		}
		if splitMS < fromMS {
			splitMS = fromMS
		}
		if splitMS > toMS {
			splitMS = toMS
		}
		factEnd := min(toMS, horizonMS)
		if isScoped {
			// Permanent 15m facts store requested model rather than serving model;
			// mark scoped history approximate when deleted fact residuals remain.
			for _, row := range factRows {
				rowEnd := row.StartMS + repository.QuarterHourBucketMS
				if rowEnd > fromMS && row.StartMS < factEnd && row.Requests > 0 {
					*isApprox = true
					break
				}
			}
			return
		}
		for _, row := range factRows {
			rowEnd := row.StartMS + repository.QuarterHourBucketMS
			if rowEnd <= fromMS || row.StartMS >= factEnd || row.Requests <= 0 {
				continue
			}
			if row.StartMS < fromMS || rowEnd > factEnd {
				*isApprox = true
				continue
			}
			// Permanent 15m facts bucket by request start time (`timestamp_ms`) rather
			// than completion time (`completed_at_ms`), and aggregate failures together with
			// zero-token rows, so any deleted-detail fact span is marked approximate.
			*isApprox = true
			physical := trendsUsageMeasures(row.UsageMeasures)
			displayed.add(physical)
			if beforeSplit != nil {
				if rowEnd <= splitMS {
					beforeSplit.add(physical)
				} else if row.StartMS >= splitMS {
					afterSplit.add(physical)
				} else if splitMS < toMS {
					*isApprox = true
				}
			}
			if len(buckets) > 0 {
				if bucketIndex := findQuotaBucketIndex(buckets, row.StartMS); bucketIndex >= 0 {
					bucket := &buckets[bucketIndex]
					bucket.Requests += physical.Requests
					bucket.NetTokens += physical.NetTokens
					bucket.TotalTokens += physical.TotalTokens
				}
			}
		}
	}

	for _, w := range cred.windows {
		if w.isFeature {
			continue
		}
		applySpan(w.isScoped, w.start, w.capacityTo, w.actualEnd, w.dto.Buckets, &w.displayedPhysical, &w.snapshotPhysical, &w.postPhysical, &w.isApproximate)
		for i := range w.priorCycles {
			pc := &w.priorCycles[i]
			applySpan(w.isScoped, pc.cycleStartMS, pc.measuredToMS, pc.measuredToMS, nil, &pc.physical, nil, nil, &pc.isApproximate)
		}
	}
}

func accumulateTrendsQuotaEvent(cred *trendsQuotaPreparedCred, ev repository.QuotaTrendStreamEvent, dbWatermark int64) {
	physical := trendsUsageMeasures(ev.Measures)
	for _, w := range cred.windows {
		if !w.isFeature {
			if ev.CompletedMS >= w.start && ev.CompletedMS < w.actualEnd && w.isModelInPhysicalScope(ev.Model) {
				w.displayedPhysical.add(physical)
				splitMS := min(max(w.capacityTo, w.start), w.actualEnd)
				if ev.CompletedMS+1 <= splitMS {
					w.snapshotPhysical.add(physical)
				} else if ev.CompletedMS >= splitMS {
					w.postPhysical.add(physical)
				}
				if bucketIndex := findQuotaBucketIndex(w.dto.Buckets, ev.CompletedMS); bucketIndex >= 0 {
					bucket := &w.dto.Buckets[bucketIndex]
					bucket.Requests += physical.Requests
					bucket.NetTokens += physical.NetTokens
					bucket.TotalTokens += physical.TotalTokens
				}
			}
			for i := range w.priorCycles {
				pc := &w.priorCycles[i]
				if ev.CompletedMS >= pc.cycleStartMS && ev.CompletedMS < pc.measuredToMS && w.isModelInPhysicalScope(ev.Model) {
					pc.physical.add(physical)
				}
			}
		}

		if !ev.HasCapacityTokens || w.scopeReason != "" {
			continue
		}

		var capClass uint8
		resolveCapClass := func() uint8 {
			if capClass == capScopeUnset {
				capClass = w.classifyCapacityModel(ev.Model)
			}
			return capClass
		}

		if w.canReconcileLive && ev.StartedMS >= w.liveStartLowerMS && ev.CompletedMS >= w.liveCycleStartMS && ev.CompletedMS < w.liveLastObservedMS {
			effectiveWatermark := max(dbWatermark, w.liveLastWatermarkID)
			if ev.ID <= effectiveWatermark {
				if w.isLegacyReconcile {
					cls := resolveCapClass()
					if cls == capScopeMatch || cls == capScopeUnmatched {
						pts := w.cycles[w.live].Points
						for p := range pts {
							if ev.CompletedMS < pts[p].ObservedAtMS {
								addCapacityUsageSample(&w.legacyPointAcc[p], ev.CapacityUsage, cls)
							}
						}
					}
				} else if effectiveWatermark > w.liveLastWatermarkID && ev.ID > w.liveLastWatermarkID {
					cls := resolveCapClass()
					if cls == capScopeMatch || cls == capScopeUnmatched {
						pts := w.cycles[w.live].Points
						for p := range pts {
							if ev.CompletedMS < pts[p].ObservedAtMS {
								addCapacityUsageSample(&w.latePointDelta[p], ev.CapacityUsage, cls)
							}
						}
					}
				}
			}
		}

		if w.needsCapacity && ev.StartedMS >= w.capStartLowerMS && ev.CompletedMS < w.capacityTo {
			if ev.CompletedMS >= w.start {
				addCapacityUsageSample(&w.capLive, ev.CapacityUsage, resolveCapClass())
			}
			if w.hasLatestPoint && w.latestPointObservedMS < w.capacityTo && ev.CompletedMS >= w.capPostFromMS {
				addCapacityUsageSample(&w.capPost, ev.CapacityUsage, resolveCapClass())
			}
		}
	}
}

func finalizeTrendsQuotaWindows(cred *trendsQuotaPreparedCred, nowMS, dbWatermark int64) []TrendsQuotaWindowDTO {
	out := make([]TrendsQuotaWindowDTO, 0, len(cred.windows))
	for _, w := range cred.windows {
		if w.canReconcileLive {
			pts := w.cycles[w.live].Points
			effectiveWatermark := max(dbWatermark, w.liveLastWatermarkID)
			if w.isLegacyReconcile {
				for idx := range pts {
					point := &pts[idx]
					fresh := w.legacyPointAcc[idx]
					if fresh.Requests > point.Requests {
						point.Requests = fresh.Requests
						point.PricedRequests = fresh.PricedRequests
						point.Tokens = fresh.Tokens
						point.PromptTokens = fresh.PromptTokens
						point.CachedTokens = fresh.CachedTokens
						point.CostNanos = fresh.CostNanos
					}
					if fresh.UnmatchedRequests > point.UnmatchedRequests {
						point.UnmatchedRequests = fresh.UnmatchedRequests
					}
					if idx > 0 {
						prev := &pts[idx-1]
						if prev.Requests > point.Requests {
							point.Requests = prev.Requests
							point.PricedRequests = max(point.PricedRequests, prev.PricedRequests)
							point.Tokens = max(point.Tokens, prev.Tokens)
							point.PromptTokens = max(point.PromptTokens, prev.PromptTokens)
							point.CachedTokens = max(point.CachedTokens, prev.CachedTokens)
							point.CostNanos = max(point.CostNanos, prev.CostNanos)
						}
						if prev.UnmatchedRequests > point.UnmatchedRequests {
							point.UnmatchedRequests = prev.UnmatchedRequests
						}
					}
					point.HasUsageGap = false
				}
				pts[len(pts)-1].UsageWatermarkID = effectiveWatermark
			} else if effectiveWatermark > w.liveLastWatermarkID {
				for idx := range pts {
					delta := w.latePointDelta[idx]
					if delta.Requests == 0 && delta.UnmatchedRequests == 0 {
						continue
					}
					point := &pts[idx]
					point.Requests += delta.Requests
					point.PricedRequests += delta.PricedRequests
					point.Tokens += delta.Tokens
					point.PromptTokens += delta.PromptTokens
					point.CachedTokens += delta.CachedTokens
					point.CostNanos += delta.CostNanos
					point.UnmatchedRequests += delta.UnmatchedRequests
				}
				pts[len(pts)-1].UsageWatermarkID = effectiveWatermark
			}
		}

		fillTrendsQuotaBuckets(w.dto.Buckets, w.points, w.dto, w.actualEnd)
		isApproximate := w.isApproximate
		snapshotPhysical := w.snapshotPhysical
		reconciledFromCalibration := false
		if w.supportsCapacity {
			if !cred.isTrustworthyReading {
				w.dto.CapacityUnavailable = quota.CapacityReasonNoReading
			} else if nowMS >= w.dto.CycleResetMS {
				w.dto.CapacityUnavailable = quota.CapacityReasonExpired
			} else if w.scopeReason != "" {
				w.dto.CapacityUnavailable = w.scopeReason
			} else {
				liveUsage := w.capLive
				liveUsage.FromMS, liveUsage.ToMS = w.start, w.capacityTo
				liveUsage.CacheRate = quota.ComputeCacheRate(liveUsage.CachedTokens, liveUsage.PromptTokens)
				usage := quota.EffectiveWindowUsage(w.source, w.observation.Plan, w.capacityTo, liveUsage, w.cycles)
				if latest, ok := quota.LatestLiveCalibrationPoint(w.source, w.observation.Plan, w.capacityTo, w.cycles); ok {
					fromPoint := quota.WindowUsage{
						FromMS:            w.start,
						ToMS:              w.capacityTo,
						Requests:          latest.Requests,
						PricedRequests:    latest.PricedRequests,
						Tokens:            latest.Tokens,
						PromptTokens:      latest.PromptTokens,
						CachedTokens:      latest.CachedTokens,
						CacheRate:         quota.ComputeCacheRate(latest.CachedTokens, latest.PromptTokens),
						CostNanos:         latest.CostNanos,
						UnmatchedRequests: latest.UnmatchedRequests,
					}
					if latest.ObservedAtMS < w.capacityTo {
						postPoint := w.capPost
						postPoint.FromMS, postPoint.ToMS = w.capPostFromMS, w.capacityTo
						postPoint.CacheRate = quota.ComputeCacheRate(postPoint.CachedTokens, postPoint.PromptTokens)
						fromPoint = quota.AddWindowUsage(fromPoint, postPoint)
					}
					if fromPoint.Requests > usage.Requests {
						usage = fromPoint
					}
				}
				w.dto.CurrentUsage = trendsQuotaWindowUsageDTO(usage)
				estimated, capReason := quota.EstimateWindowCapacity(w.source, w.observation.Plan, w.observation.ObservedAtMS, nowMS, &usage, w.cycles)
				w.dto.Capacity, w.dto.CapacityUnavailable = trendsQuotaWindowCapacityDTO(estimated), capReason
				if usage.Requests > snapshotPhysical.Requests && w.live >= 0 {
					var netApprox bool
					snapshotPhysical, netApprox = mergeTrendsQuotaUsage(snapshotPhysical, usage)
					isApproximate = isApproximate || netApprox
					reconciledFromCalibration = true
				}
			}
		}

		physical := w.displayedPhysical
		if reconciledFromCalibration {
			reconciled := snapshotPhysical
			if w.actualEnd > w.capacityTo {
				reconciled.add(w.postPhysical)
			}
			if reconciled.Requests > physical.Requests {
				physical = reconciled
			}
		}
		w.dto.CurrentRequests, w.dto.CurrentNetTokens, w.dto.CurrentTotalTokens, w.dto.CurrentCostNanos = physical.Requests, physical.NetTokens, physical.TotalTokens, physical.CostNanos
		w.dto.IsApproximate = isApproximate
		w.dto.IsPhysicalUnavailable = w.isFeature
		w.dto.Cycles = append(w.dto.Cycles, trendsQuotaCycle(w.start, w.dto.CycleResetMS, w.used, physical, snapshotPhysical, true, isApproximate, w.supportsCapacity))
		for _, pc := range w.priorCycles {
			prior := pc.physical
			priorApproximate := pc.isApproximate
			if pc.lastPoint.Requests > prior.Requests {
				var netApprox bool
				prior, netApprox = mergeTrendsQuotaUsage(prior, quota.WindowUsage{
					Requests: pc.lastPoint.Requests, Tokens: pc.lastPoint.Tokens,
					PromptTokens: pc.lastPoint.PromptTokens, CachedTokens: pc.lastPoint.CachedTokens,
					PricedRequests: pc.lastPoint.PricedRequests, CostNanos: pc.lastPoint.CostNanos,
				})
				priorApproximate = priorApproximate || netApprox
			}
			w.dto.Cycles = append(w.dto.Cycles, trendsQuotaCycle(pc.cycleStartMS, pc.cycleResetMS, pc.lastPoint.UsedPercent, prior, prior, false, priorApproximate, w.supportsCapacity))
		}
		out = append(out, w.dto)
	}
	return out
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
