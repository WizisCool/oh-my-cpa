package api

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type dashboardProvidersResponse struct {
	Window    dashboardWindow            `json:"window"`
	Providers []dashboardProviderTraffic `json:"providers"`
	Errors    []string                   `json:"partial_errors"`
}

type dashboardProviderTraffic struct {
	ID          string                     `json:"id"`
	Total       int64                      `json:"total"`
	Success     int64                      `json:"success"`
	Failure     int64                      `json:"failure"`
	SuccessRate *float64                   `json:"success_rate"`
	Buckets     []managementOverviewBucket `json:"buckets"`
}

// dashboardProviders answers provider-level request traffic and activity sparklines
// aggregated over the dashboard window selected by the range picker.
func (h *Handler) dashboardProviders(writer http.ResponseWriter, request *http.Request) {
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

	response := dashboardProvidersResponse{
		Window:    window,
		Providers: []dashboardProviderTraffic{},
		Errors:    []string{},
	}

	rows, err := h.repo.QueryUsageProviderBuckets(ctx, defaultInstanceID(), window.FromMS, window.ToMS, window.BucketMS)
	if err != nil {
		response.Errors = append(response.Errors, fmt.Sprintf("provider_buckets: %v", err))
		writeJSON(writer, http.StatusOK, response)
		return
	}

	response.Providers = foldProviderBuckets(rows, window.FromMS, window.ToMS, window.BucketMS)
	writeJSON(writer, http.StatusOK, response)
}

func foldProviderBuckets(rows []repository.UsageProviderBucketRow, fromMS, toMS, bucketMS int64) []dashboardProviderTraffic {
	if bucketMS <= 0 {
		bucketMS = time.Minute.Milliseconds()
	}

	bucketCount := int((toMS - fromMS) / bucketMS)
	if bucketCount <= 0 {
		bucketCount = 1
	}

	type providerAccumulator struct {
		id       string
		total    int64
		failure  int64
		byBucket map[int64]repository.UsageProviderBucketRow
	}
	groups := make(map[string]*providerAccumulator)

	for _, row := range rows {
		normID := overviewProviderID(row.Provider)
		acc, ok := groups[normID]
		if !ok {
			acc = &providerAccumulator{
				id:       normID,
				byBucket: make(map[int64]repository.UsageProviderBucketRow),
			}
			groups[normID] = acc
		}
		acc.total += row.Requests
		acc.failure += row.Failures

		existing := acc.byBucket[row.StartMS]
		existing.Requests += row.Requests
		existing.Failures += row.Failures
		acc.byBucket[row.StartMS] = existing
	}

	providers := make([]dashboardProviderTraffic, 0, len(groups))
	for id, acc := range groups {
		buckets := make([]managementOverviewBucket, bucketCount)
		for i := 0; i < bucketCount; i++ {
			slotTimeMS := fromMS + int64(i)*bucketMS
			bRow := acc.byBucket[slotTimeMS]
			success := bRow.Requests - bRow.Failures
			if success < 0 {
				success = 0
			}
			buckets[i] = managementOverviewBucket{
				Time:    time.UnixMilli(slotTimeMS).UTC().Format(time.RFC3339),
				Success: success,
				Failed:  bRow.Failures,
			}
		}

		success := acc.total - acc.failure
		if success < 0 {
			success = 0
		}
		item := dashboardProviderTraffic{
			ID:      id,
			Total:   acc.total,
			Success: success,
			Failure: acc.failure,
			Buckets: buckets,
		}
		if acc.total > 0 {
			rate := float64(success) / float64(acc.total) * 100
			item.SuccessRate = &rate
		}
		providers = append(providers, item)
	}

	sort.Slice(providers, func(i, j int) bool {
		if providers[i].Total != providers[j].Total {
			return providers[i].Total > providers[j].Total
		}
		return providers[i].ID < providers[j].ID
	})

	return providers
}
