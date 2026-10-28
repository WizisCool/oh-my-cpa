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
	Window dashboardWindow `json:"window"`
	// BucketMS is the activity grid every row's buckets sit on. It is coarser than the window's
	// chart grid: the list draws one block per bucket in a narrow column, and the chart grid's
	// forty-eight would leave each block a sliver.
	BucketMS int64 `json:"bucket_ms"`
	// Providers is the traffic of every record no API key answered, by the channel label CPA
	// wrote: OAuth channels, and records that name no credential.
	Providers []dashboardProviderTraffic `json:"providers"`
	// Credentials is the traffic API keys answered, by each key's runtime auth index. A configured
	// provider is credited from here, through the indexes of its own keys, and never from a label:
	// CPA labels every key of a family, and that family's OAuth channel, the same.
	Credentials []dashboardCredentialTraffic `json:"credentials"`
	Errors      []string                     `json:"partial_errors"`
}

// dashboardTrafficBucket is one bucket of a row's activity. Only buckets that served a request
// are sent; the client lays them on the grid the window and `bucket_ms` describe, and an absent
// bucket is an idle one.
type dashboardTrafficBucket struct {
	StartMS int64 `json:"start_ms"`
	Total   int64 `json:"total"`
	Failure int64 `json:"failure"`
}

type dashboardCredentialTraffic struct {
	AuthIndex string                   `json:"auth_index"`
	Total     int64                    `json:"total"`
	Failure   int64                    `json:"failure"`
	Buckets   []dashboardTrafficBucket `json:"buckets"`
}

type dashboardProviderTraffic struct {
	ID          string                   `json:"id"`
	Total       int64                    `json:"total"`
	Success     int64                    `json:"success"`
	Failure     int64                    `json:"failure"`
	SuccessRate *float64                 `json:"success_rate"`
	Buckets     []dashboardTrafficBucket `json:"buckets"`
}

// dashboardActivityBuckets is how many blocks a provider row's activity strip aims for.
const dashboardActivityBuckets = 24

// dashboardProviders answers provider-level request traffic over the dashboard window selected
// by the range picker: a window total and rate per row, and the same traffic per bucket.
//
// The buckets exist because a window rate averages the present into the past. A provider that
// served for twenty hours and has failed for the last two still reads green over a day; the
// per-bucket blocks show where in the window the failures sit.
func (h *Handler) dashboardProviders(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")

	window, windowErr, resolveErr := h.dashboardWindow(request, time.Now().UTC())
	if resolveErr != nil {
		writeInternalError(writer, fmt.Errorf("resolve dashboard window: %w", resolveErr))
		return
	}
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
		Window:      window,
		BucketMS:    dashboardBucketWidthFor(time.Duration(window.ToMS-window.FromMS)*time.Millisecond, dashboardActivityBuckets).Milliseconds(),
		Providers:   []dashboardProviderTraffic{},
		Credentials: []dashboardCredentialTraffic{},
		Errors:      []string{},
	}

	rows, bucketMS, err := h.repo.QueryUsageProviderBuckets(ctx, defaultInstanceID(), window.FromMS, window.ToMS, response.BucketMS)
	if err != nil {
		response.Errors = append(response.Errors, fmt.Sprintf("provider_buckets: %v", err))
		writeJSON(writer, http.StatusOK, response)
		return
	}

	response.BucketMS = bucketMS
	response.Providers, response.Credentials = foldProviderTraffic(rows)
	writeJSON(writer, http.StatusOK, response)
}

// foldProviderTraffic splits the window into API-key traffic, by auth index, and the rest, by
// canonical provider label, and derives each label row's success rate.
//
// Providers are grouped under the identity the console displays them by (`overviewProviderID`),
// not the raw label CPA wrote: one gateway name can appear in several spellings across a window,
// and a list that showed each spelling as its own row would report a provider twice. Blank labels
// are already folded into "unknown" by the query, so the two agree about that case too. Spellings
// that share a bucket share its block.
func foldProviderTraffic(rows []repository.UsageProviderBucketRow) ([]dashboardProviderTraffic, []dashboardCredentialTraffic) {
	type accumulator struct {
		total, failure int64
		buckets        map[int64]*dashboardTrafficBucket
	}
	add := func(acc *accumulator, row repository.UsageProviderBucketRow) {
		acc.total += row.Requests
		acc.failure += row.Failures
		bucket, ok := acc.buckets[row.StartMS]
		if !ok {
			bucket = &dashboardTrafficBucket{StartMS: row.StartMS}
			acc.buckets[row.StartMS] = bucket
		}
		bucket.Total += row.Requests
		bucket.Failure += row.Failures
	}
	groups := make(map[string]*accumulator)
	credentialGroups := make(map[string]*accumulator)
	for _, row := range rows {
		target, key := groups, overviewProviderID(row.Provider)
		if row.CredentialIndex != "" {
			target, key = credentialGroups, row.CredentialIndex
		}
		acc, ok := target[key]
		if !ok {
			acc = &accumulator{buckets: make(map[int64]*dashboardTrafficBucket)}
			target[key] = acc
		}
		add(acc, row)
	}
	sortedBuckets := func(acc *accumulator) []dashboardTrafficBucket {
		buckets := make([]dashboardTrafficBucket, 0, len(acc.buckets))
		for _, bucket := range acc.buckets {
			if bucket.Total > 0 {
				buckets = append(buckets, *bucket)
			}
		}
		sort.Slice(buckets, func(i, j int) bool { return buckets[i].StartMS < buckets[j].StartMS })
		return buckets
	}

	// Iterated in map order and sorted below, so the result does not depend on which order the
	// map happens to hand its keys over in.
	providers := make([]dashboardProviderTraffic, 0, len(groups))
	for id, acc := range groups {
		success := max(acc.total-acc.failure, 0)
		item := dashboardProviderTraffic{
			ID:      id,
			Total:   acc.total,
			Success: success,
			Failure: acc.failure,
			Buckets: sortedBuckets(acc),
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

	credentials := make([]dashboardCredentialTraffic, 0, len(credentialGroups))
	for authIndex, acc := range credentialGroups {
		credentials = append(credentials, dashboardCredentialTraffic{
			AuthIndex: authIndex, Total: acc.total, Failure: acc.failure, Buckets: sortedBuckets(acc),
		})
	}
	sort.Slice(credentials, func(i, j int) bool { return credentials[i].AuthIndex < credentials[j].AuthIndex })

	return providers, credentials
}
