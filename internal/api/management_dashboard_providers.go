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
	ID          string   `json:"id"`
	Total       int64    `json:"total"`
	Success     int64    `json:"success"`
	Failure     int64    `json:"failure"`
	SuccessRate *float64 `json:"success_rate"`
}

// dashboardProviders answers provider-level request traffic aggregated over the dashboard window
// selected by the range picker.
//
// A window total per provider, not a series: the provider list prints a request count and a rate,
// and colours the rate against the console's fixed bands. It carries no per-bucket grid, because
// nothing reads one - see `QueryUsageProviderTotals` for what that used to cost.
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

	rows, err := h.repo.QueryUsageProviderTotals(ctx, defaultInstanceID(), window.FromMS, window.ToMS)
	if err != nil {
		response.Errors = append(response.Errors, fmt.Sprintf("provider_totals: %v", err))
		writeJSON(writer, http.StatusOK, response)
		return
	}

	response.Providers = foldProviderTraffic(rows)
	writeJSON(writer, http.StatusOK, response)
}

// foldProviderTraffic canonicalises the provider labels and derives each row's success rate.
//
// Providers are grouped under the identity the console displays them by (`overviewProviderID`),
// not the raw label CPA wrote: one gateway name can appear in several spellings across a window,
// and a list that showed each spelling as its own row would report a provider twice. Blank labels
// are already folded into "unknown" by the query, so the two agree about that case too.
func foldProviderTraffic(rows []repository.UsageProviderTotalsRow) []dashboardProviderTraffic {
	type providerAccumulator struct {
		id      string
		total   int64
		failure int64
	}
	groups := make(map[string]*providerAccumulator)

	for _, row := range rows {
		normID := overviewProviderID(row.Provider)
		acc, ok := groups[normID]
		if !ok {
			acc = &providerAccumulator{id: normID}
			groups[normID] = acc
		}
		acc.total += row.Requests
		acc.failure += row.Failures
	}

	// Iterated in map order and sorted below, so the result does not depend on which order the
	// map happens to hand its keys over in.
	providers := make([]dashboardProviderTraffic, 0, len(groups))
	for _, acc := range groups {
		success := acc.total - acc.failure
		if success < 0 {
			success = 0
		}
		item := dashboardProviderTraffic{
			ID:      acc.id,
			Total:   acc.total,
			Success: success,
			Failure: acc.failure,
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
