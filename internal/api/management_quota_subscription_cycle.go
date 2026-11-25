package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type subscriptionCyclePeriodDTO struct {
	FromMS         int64    `json:"from_ms"`
	ToMS           int64    `json:"to_ms"`
	MeasuredAtMS   *int64   `json:"measured_at_ms,omitempty"`
	ElapsedPercent *float64 `json:"elapsed_percent,omitempty"`
	// Widened reports that request records behind the retention horizon could not
	// split an edge bucket, so usage was read across whole 15-minute fact buckets
	// named by usage.from_ms and usage.to_ms.
	Widened bool               `json:"widened,omitempty"`
	Usage   *quota.WindowUsage `json:"usage,omitempty"`
}

// QuotaSubscriptionCycleResponseDTO returns current and previous subscription
// billing-cycle consumption alongside a pace-based full-cycle projection.
type QuotaSubscriptionCycleResponseDTO struct {
	Source                string                      `json:"source"`
	PlanLabel             string                      `json:"plan_label,omitempty"`
	Current               *subscriptionCyclePeriodDTO `json:"current"`
	Previous              *subscriptionCyclePeriodDTO `json:"previous"`
	Projection            *quota.WindowCapacity       `json:"projection,omitempty"`
	ProjectionUnavailable string                      `json:"projection_unavailable,omitempty"`
}

func windowUsageFromFactMeasures(fromMS, toMS int64, raw repository.UsageMeasures) quota.WindowUsage {
	measures, _ := projectInsightsFactMeasures(raw)
	priced := min(measures.CostedRequests, measures.Requests)
	return quota.WindowUsage{
		FromMS:         fromMS,
		ToMS:           toMS,
		Requests:       measures.Requests,
		PricedRequests: priced,
		Tokens:         measures.TotalTokens,
		PromptTokens:   measures.InputTokens,
		CachedTokens:   measures.CacheReadTokens,
		CacheRate:      quota.ComputeCacheRate(measures.CacheReadTokens, measures.InputTokens),
		CostNanos:      measures.CostNanos,
	}
}

// getQuotaSubscriptionCycle returns recorded usage across the credential's
// current and previous subscription billing cycles using permanent usage facts,
// together with a pace-based full-cycle projection.
//
// @Summary Get credential subscription-cycle usage
// @Description Return recorded usage across the current and previous subscription billing periods plus a pace-based full-cycle projection.
// @Tags Quota
// @Produce json
// @Security CookieAuth
// @Param authIndex path string true "Credential runtime auth_index"
// @Success 200 {object} QuotaSubscriptionCycleResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/quota/{authIndex}/subscription-cycle [get]
func (h *Handler) getQuotaSubscriptionCycle(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	authIndex := strings.TrimSpace(chi.URLParam(request, "authIndex"))
	if authIndex == "" {
		writeError(writer, http.StatusBadRequest, "auth_index is required")
		return
	}
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository is not initialized")
		return
	}

	ctx := request.Context()
	snapshots, err := h.repo.GetLatestQuotaSnapshots(ctx, []string{authIndex})
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "quota reading could not be read")
		return
	}
	snapshot, ok := snapshots[authIndex]
	if !ok {
		writeError(writer, http.StatusNotFound, "credential has no quota snapshot")
		return
	}

	plan := planFromSnapshot(snapshot)
	nowMS := h.now().UnixMilli()
	resolved, hasPeriod := quota.ResolveSubscriptionCycle(plan, nowMS)
	if !hasPeriod {
		writeError(writer, http.StatusNotFound, "credential has no active subscription period")
		return
	}
	measuredAtMS := min(max(nowMS, resolved.Current.FromMS), resolved.Current.ToMS)

	var (
		currentTotals, previousTotals repository.UsageMeasures
		currentUsageFromMS            = resolved.Current.FromMS
		currentUsageToMS              = measuredAtMS
		currentWidened                bool
		previousUsageFromMS           = resolved.Previous.FromMS
		previousUsageToMS             = resolved.Previous.ToMS
		previousWidened               bool
	)
	filters := map[repository.UsageDimension][]string{
		repository.UsageDimensionCredential: {authIndex},
	}
	if err := h.repo.QueryUsageFactsSnapshot(ctx, func(queryFacts func(repository.UsageFactQuery) (repository.UsageFactResult, error)) error {
		if measuredAtMS > resolved.Current.FromMS {
			requestedToMS := measuredAtMS - 1
			currentResult, errCurrent := queryFacts(repository.UsageFactQuery{
				InstanceID: defaultInstanceID(),
				FromMS:     resolved.Current.FromMS,
				ToMS:       requestedToMS,
				Filters:    filters,
			})
			if errCurrent != nil {
				return errCurrent
			}
			currentTotals = currentResult.Totals()
			currentUsageFromMS = currentResult.FromMS
			currentUsageToMS = currentResult.ToMS + 1
			currentWidened = currentResult.FromMS != resolved.Current.FromMS || currentResult.ToMS != requestedToMS
		}
		// Align the previous period's upper bound below the effective current start so
		// a rolled-up 15-minute boundary bucket is never counted in both periods.
		previousRequestedToMS := min(resolved.Previous.ToMS-1, currentUsageFromMS-1)
		if previousRequestedToMS >= resolved.Previous.FromMS {
			previousResult, errPrevious := queryFacts(repository.UsageFactQuery{
				InstanceID: defaultInstanceID(),
				FromMS:     resolved.Previous.FromMS,
				ToMS:       previousRequestedToMS,
				Filters:    filters,
			})
			if errPrevious != nil {
				return errPrevious
			}
			previousTotals = previousResult.Totals()
			previousUsageFromMS = previousResult.FromMS
			previousUsageToMS = previousResult.ToMS + 1
			previousWidened = previousResult.FromMS != resolved.Previous.FromMS || previousResult.ToMS != resolved.Previous.ToMS-1
		}
		return nil
	}); err != nil {
		writeError(writer, http.StatusInternalServerError, "subscription cycle usage could not be read")
		return
	}

	currentUsage := windowUsageFromFactMeasures(currentUsageFromMS, currentUsageToMS, currentTotals)
	elapsedPercent, projection, projectionUnavailable := quota.ProjectSubscriptionCycle(
		resolved.Current.FromMS,
		resolved.Current.ToMS,
		measuredAtMS,
		currentUsage,
	)

	response := QuotaSubscriptionCycleResponseDTO{
		Source: resolved.Source,
		Current: &subscriptionCyclePeriodDTO{
			FromMS:         resolved.Current.FromMS,
			ToMS:           resolved.Current.ToMS,
			MeasuredAtMS:   &measuredAtMS,
			ElapsedPercent: &elapsedPercent,
			Widened:        currentWidened,
			Usage:          &currentUsage,
		},
		Projection:            projection,
		ProjectionUnavailable: projectionUnavailable,
	}
	if plan != nil {
		response.PlanLabel = plan.PlanLabel
	}
	if previousTotals.Requests > 0 || previousTotals.TotalTokens > 0 {
		previousUsage := windowUsageFromFactMeasures(previousUsageFromMS, previousUsageToMS, previousTotals)
		response.Previous = &subscriptionCyclePeriodDTO{
			FromMS:  resolved.Previous.FromMS,
			ToMS:    resolved.Previous.ToMS,
			Widened: previousWidened,
			Usage:   &previousUsage,
		}
	}

	writeJSON(writer, http.StatusOK, response)
}
