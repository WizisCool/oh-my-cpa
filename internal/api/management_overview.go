package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

const (
	managementOverviewBucketCount   = 20
	managementOverviewBucketMinutes = 10
)

// managementOverviewResponse is deliberately a projection rather than a
// wrapper around any CPA response. In particular, it never contains the raw
// config, auth-file metadata, API-key usage map, or an upstream error body.
type managementOverviewResponse struct {
	Status        string                        `json:"status"`
	CPAConnected  bool                          `json:"cpa_connected"`
	CPABaseURL    string                        `json:"cpa_base_url,omitempty"`
	CPAInstanceID string                        `json:"cpa_instance_id,omitempty"`
	CPAInstance   string                        `json:"cpa_instance_name,omitempty"`
	OMCVersion    string                        `json:"omc_version,omitempty"`
	CPAVersion    string                        `json:"cpa_version,omitempty"`
	CPABuildDate  string                        `json:"cpa_build_date,omitempty"`
	Counts        managementOverviewCounts      `json:"counts"`
	Traffic       *managementOverviewTraffic    `json:"traffic"`
	Providers     []managementOverviewProvider  `json:"providers"`
	Credentials   *managementOverviewCredential `json:"credentials"`
	PartialErrors []string                      `json:"partial_errors"`
}

type managementOverviewCounts struct {
	ManagementKeys *int `json:"management_keys"`
	ProviderKeys   *int `json:"provider_keys"`
	Credentials    *int `json:"credentials"`
	Models         *int `json:"models"`
}

type managementOverviewBucket struct {
	Time    string `json:"time,omitempty"`
	Success int64  `json:"success"`
	Failed  int64  `json:"failed"`
}

type managementOverviewTraffic struct {
	BucketMinutes int                        `json:"bucket_minutes"`
	WindowMinutes int                        `json:"window_minutes"`
	Buckets       []managementOverviewBucket `json:"buckets"`
	TotalSuccess  int64                      `json:"total_success"`
	TotalFailure  int64                      `json:"total_failure"`
	Total         int64                      `json:"total"`
	SuccessRate   *float64                   `json:"success_rate"`
}

type managementOverviewProvider struct {
	ID          string                     `json:"id"`
	Credentials int                        `json:"credentials"`
	Success     int64                      `json:"success"`
	Failure     int64                      `json:"failure"`
	Total       int64                      `json:"total"`
	SuccessRate *float64                   `json:"success_rate"`
	Buckets     []managementOverviewBucket `json:"buckets"`
}

type managementOverviewCredential struct {
	Total       int                           `json:"total"`
	Active      int                           `json:"active"`
	Disabled    int                           `json:"disabled"`
	Unavailable int                           `json:"unavailable"`
	ByType      []managementOverviewTypeCount `json:"by_type"`
}

type managementOverviewTypeCount struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
	// Disabled is how many of Count the gateway currently reports disabled. A
	// surface needs it to tell a channel switched off wholesale from one whose
	// remaining credentials still serve, which the total alone cannot say.
	Disabled int `json:"disabled"`
}

// managementOverview returns a safe, read-only aggregation of the CPA
// management endpoints used by the dashboard. It is registered below the
// existing /api/v1 authentication middleware.
func (h *Handler) managementOverview(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	response := managementOverviewResponse{
		Status:        "unconfigured",
		OMCVersion:    h.cfg.Version,
		Providers:     []managementOverviewProvider{},
		PartialErrors: []string{},
	}

	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), sql.ErrNoRows.Error()) {
			response.PartialErrors = append(response.PartialErrors, "instance: default CPA instance is not configured")
			writeJSON(writer, http.StatusOK, response)
			return
		}
		writeInternalError(writer, err)
		return
	}

	response.CPAInstanceID = instance.ID
	response.CPAInstance = instance.Name
	response.CPABaseURL = safeCPAURL(instance.BaseURL)

	client, err := h.clientForInstance(request.Context(), instance)
	if err != nil {
		response.Status = "disconnected"
		response.PartialErrors = append(response.PartialErrors, "connection: CPA is unavailable")
		writeJSON(writer, http.StatusOK, response)
		return
	}

	// Keep the aggregation bounded even if a caller disconnects or a CPA
	// endpoint stalls. Client-level timeouts remain the final safety net.
	timeout := h.cfg.RequestTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(request.Context(), timeout)
	defer cancel()

	var (
		rawConfig  map[string]any
		configMeta management.ResponseMeta
		configErr  error
		authFiles  management.AuthFilesResponse
		authMeta   management.ResponseMeta
		authErr    error
		usage      management.APIKeyUsageResponse
		usageMeta  management.ResponseMeta
		usageErr   error
	)
	var group sync.WaitGroup
	group.Add(3)
	go func() {
		defer group.Done()
		rawConfig, configMeta, configErr = client.Config(ctx)
	}()
	go func() {
		defer group.Done()
		authFiles, authMeta, authErr = client.AuthFilesWithMeta(ctx)
	}()
	go func() {
		defer group.Done()
		usage, usageMeta, usageErr = client.APIKeyUsage(ctx)
	}()
	group.Wait()

	configOK := configErr == nil
	authOK := authErr == nil
	usageOK := usageErr == nil
	successfulEndpoints := 0
	if configOK {
		successfulEndpoints++
		managementKeys, providerKeys := countConfiguredKeys(rawConfig)
		response.Counts.ManagementKeys = intPointer(managementKeys)
		response.Counts.ProviderKeys = intPointer(providerKeys)
		// The management API does not provide a reliable global model count.
		// Keep this null instead of inferring one from aliases or credentials.
	}
	if authOK {
		successfulEndpoints++
		response.Counts.Credentials = intPointer(len(authFiles.Files))
		response.Credentials = buildCredentialHealth(authFiles.Files)
	}
	if usageOK {
		successfulEndpoints++
	}

	if !configOK {
		response.PartialErrors = append(response.PartialErrors, overviewError("config", configErr))
	}
	if !authOK {
		response.PartialErrors = append(response.PartialErrors, overviewError("auth-files", authErr))
	}
	if !usageOK {
		response.PartialErrors = append(response.PartialErrors, overviewError("api-key-usage", usageErr))
	}

	if metaValue := safeVersionHeader(configMeta.Header); metaValue != "" {
		response.CPAVersion = metaValue
	} else if metaValue := safeVersionHeader(authMeta.Header); metaValue != "" {
		response.CPAVersion = metaValue
	} else if metaValue := safeVersionHeader(usageMeta.Header); metaValue != "" {
		response.CPAVersion = metaValue
	}
	if metaValue := safeBuildDateHeader(configMeta.Header); metaValue != "" {
		response.CPABuildDate = metaValue
	} else if metaValue := safeBuildDateHeader(authMeta.Header); metaValue != "" {
		response.CPABuildDate = metaValue
	} else if metaValue := safeBuildDateHeader(usageMeta.Header); metaValue != "" {
		response.CPABuildDate = metaValue
	}

	if successfulEndpoints == 0 {
		response.Status = "disconnected"
	} else if successfulEndpoints == 3 {
		response.Status = "connected"
	} else {
		response.Status = "degraded"
	}
	response.CPAConnected = successfulEndpoints > 0

	if authOK || usageOK {
		response.Traffic, response.Providers = buildTrafficOverview(authOK, authFiles.Files, usageOK, usage)
	}
	writeJSON(writer, http.StatusOK, response)
}

func intPointer(value int) *int { return &value }

func safeCPAURL(raw string) string {
	parsed, err := http.NewRequest(http.MethodGet, strings.TrimSpace(raw), nil)
	if err != nil || parsed.URL == nil || parsed.URL.Scheme == "" || parsed.URL.Host == "" {
		return ""
	}
	parsed.URL.User = nil
	parsed.URL.RawQuery = ""
	parsed.URL.ForceQuery = false
	parsed.URL.Fragment = ""
	return strings.TrimRight(parsed.URL.String(), "/")
}

func overviewError(endpoint string, err error) string {
	var httpErr *management.HTTPError
	if errors.As(err, &httpErr) {
		if httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusMethodNotAllowed {
			return fmt.Sprintf("%s: unsupported by CPA (HTTP %d)", endpoint, httpErr.StatusCode)
		}
		return fmt.Sprintf("%s: CPA returned HTTP %d", endpoint, httpErr.StatusCode)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return endpoint + ": CPA request timed out"
	}
	return endpoint + ": CPA unavailable"
}

func safeVersionHeader(headers http.Header) string {
	for _, name := range []string{
		"X-CPA-Version",
		"X-Server-Version",
	} {
		if value := strings.TrimSpace(headers.Get(name)); value != "" {
			return value
		}
	}
	return ""
}

func safeBuildDateHeader(headers http.Header) string {
	for _, name := range []string{
		"X-CPA-Build-Date",
		"X-Server-Build-Date",
	} {
		if value := strings.TrimSpace(headers.Get(name)); value != "" {
			return value
		}
	}
	return ""
}

func countConfiguredKeys(raw map[string]any) (managementKeys, providerKeys int) {
	managementKeys = arrayLength(raw["api-keys"])
	for _, section := range []string{
		"gemini-api-key",
		"interactions-api-key",
		"codex-api-key",
		"xai-api-key",
		"claude-api-key",
		"vertex-api-key",
		"meta-api-key",
	} {
		providerKeys += arrayLength(raw[section])
	}
	// CPAMC presents each openai-compatibility object as one provider. Its
	// nested API-key entries are credentials within that provider, not another
	// provider row in the top-level count.
	providerKeys += arrayLength(raw["openai-compatibility"])
	return managementKeys, providerKeys
}

func arrayLength(value any) int {
	switch values := value.(type) {
	case []any:
		return len(values)
	case []string:
		return len(values)
	default:
		return 0
	}
}

func buildCredentialHealth(files []management.AuthFile) *managementOverviewCredential {
	result := &managementOverviewCredential{
		ByType: []managementOverviewTypeCount{},
	}
	counts := make(map[string]int)
	disabledCounts := make(map[string]int)
	for _, file := range files {
		provider := overviewProviderID(file.Type, file.Provider)
		// The per-type tally counts every file, disabled ones included, so it
		// stays the same number the channel's credential count has always been.
		counts[provider]++
		switch {
		case file.Disabled:
			result.Disabled++
			disabledCounts[provider]++
		case file.Unavailable:
			result.Unavailable++
		}
	}
	result.Total = len(files)
	result.Active = result.Total - result.Disabled - result.Unavailable
	if result.Active < 0 {
		result.Active = 0
	}
	for provider, count := range counts {
		result.ByType = append(result.ByType, managementOverviewTypeCount{
			Type:     provider,
			Count:    count,
			Disabled: disabledCounts[provider],
		})
	}
	sort.Slice(result.ByType, func(i, j int) bool {
		if result.ByType[i].Count != result.ByType[j].Count {
			return result.ByType[i].Count > result.ByType[j].Count
		}
		return result.ByType[i].Type < result.ByType[j].Type
	})
	return result
}

func overviewProviderID(values ...string) string {
	for _, value := range values {
		if normalized := strings.ToLower(strings.TrimSpace(value)); normalized != "" && normalized != "empty" {
			if strings.HasPrefix(normalized, "openai-compatible-") {
				return strings.TrimPrefix(normalized, "openai-compatible-")
			}
			return normalized
		}
	}
	return "unknown"
}

type overviewTrafficAccumulator struct {
	credentials int
	success     int64
	failure     int64
	groups      [][]management.RecentRequest
}

func buildTrafficOverview(authOK bool, files []management.AuthFile, usageOK bool, usage management.APIKeyUsageResponse) (*managementOverviewTraffic, []managementOverviewProvider) {
	accumulators := make(map[string]*overviewTrafficAccumulator)
	allGroups := make([][]management.RecentRequest, 0)
	apiKeysFromUsage := make(map[string]struct{})

	accumulatorFor := func(provider string) *overviewTrafficAccumulator {
		if existing := accumulators[provider]; existing != nil {
			return existing
		}
		created := &overviewTrafficAccumulator{}
		accumulators[provider] = created
		return created
	}
	add := func(provider string, credentials int, success, failure int64, recent []management.RecentRequest) {
		accumulator := accumulatorFor(provider)
		accumulator.credentials += credentials
		accumulator.success += success
		accumulator.failure += failure
		if len(recent) > 0 {
			accumulator.groups = append(accumulator.groups, recent)
			allGroups = append(allGroups, recent)
		}
	}

	if usageOK {
		for provider, entries := range usage {
			providerID := overviewProviderID(provider)
			for compositeKey, entry := range entries {
				if apiKey := apiKeyFromCompositeKey(compositeKey); apiKey != "" {
					apiKeysFromUsage[apiKey] = struct{}{}
				}
				add(providerID, 1, entry.Success, entry.Failed, entry.RecentRequests)
			}
		}
	}
	if authOK {
		for _, file := range files {
			accountType := strings.ToLower(strings.TrimSpace(file.AccountType))
			account := strings.TrimSpace(file.Account)
			if accountType == "api_key" && account != "" {
				if _, exists := apiKeysFromUsage[account]; exists {
					continue
				}
			}
			add(overviewProviderID(file.Type, file.Provider), 1, file.Success, file.Failed, file.RecentRequests)
		}
	}

	providers := make([]managementOverviewProvider, 0, len(accumulators))
	for id, accumulator := range accumulators {
		buckets := mergeOverviewRequestGroups(accumulator.groups)
		row := managementOverviewProvider{
			ID:          id,
			Credentials: accumulator.credentials,
			Success:     accumulator.success,
			Failure:     accumulator.failure,
			Total:       accumulator.success + accumulator.failure,
			Buckets:     convertOverviewBuckets(buckets),
		}
		if row.Total > 0 {
			rate := float64(row.Success) / float64(row.Total) * 100
			row.SuccessRate = &rate
		}
		providers = append(providers, row)
	}
	sort.Slice(providers, func(i, j int) bool {
		if providers[i].Total != providers[j].Total {
			return providers[i].Total > providers[j].Total
		}
		if providers[i].Credentials != providers[j].Credentials {
			return providers[i].Credentials > providers[j].Credentials
		}
		return providers[i].ID < providers[j].ID
	})

	trafficBuckets := mergeOverviewRequestGroups(allGroups)
	trafficSuccess, trafficFailure := sumOverviewRequestBuckets(trafficBuckets)
	traffic := &managementOverviewTraffic{
		BucketMinutes: managementOverviewBucketMinutes,
		WindowMinutes: managementOverviewBucketCount * managementOverviewBucketMinutes,
		Buckets:       convertOverviewBuckets(trafficBuckets),
		TotalSuccess:  trafficSuccess,
		TotalFailure:  trafficFailure,
	}
	traffic.Total = traffic.TotalSuccess + traffic.TotalFailure
	if traffic.Total > 0 {
		rate := float64(traffic.TotalSuccess) / float64(traffic.Total) * 100
		traffic.SuccessRate = &rate
	}
	return traffic, providers
}

func sumOverviewRequestBuckets(buckets []management.RecentRequest) (success, failure int64) {
	for _, bucket := range buckets {
		success += bucket.Success
		failure += bucket.Failed
	}
	return success, failure
}

func apiKeyFromCompositeKey(value string) string {
	separator := strings.IndexByte(value, '|')
	if separator < 0 || separator+1 >= len(value) {
		return ""
	}
	return strings.TrimSpace(value[separator+1:])
}

func mergeOverviewRequestGroups(groups [][]management.RecentRequest) []management.RecentRequest {
	if len(groups) == 0 {
		return make([]management.RecentRequest, managementOverviewBucketCount)
	}
	maxLength := 0
	for _, group := range groups {
		if len(group) > maxLength {
			maxLength = len(group)
		}
	}
	if maxLength > managementOverviewBucketCount {
		maxLength = managementOverviewBucketCount
	}
	merged := make([]management.RecentRequest, maxLength)
	for _, group := range groups {
		if len(group) > managementOverviewBucketCount {
			group = group[len(group)-managementOverviewBucketCount:]
		}
		tail := group
		if len(tail) > maxLength {
			tail = tail[len(tail)-maxLength:]
		}
		offset := maxLength - len(tail)
		for index, bucket := range tail {
			target := &merged[offset+index]
			target.Success += bucket.Success
			target.Failed += bucket.Failed
			if target.Time == "" {
				target.Time = bucket.Time
			}
		}
	}
	if len(merged) < managementOverviewBucketCount {
		padded := make([]management.RecentRequest, managementOverviewBucketCount)
		copy(padded[managementOverviewBucketCount-len(merged):], merged)
		return padded
	}
	return merged
}

func convertOverviewBuckets(input []management.RecentRequest) []managementOverviewBucket {
	result := make([]managementOverviewBucket, 0, len(input))
	for _, bucket := range input {
		result = append(result, managementOverviewBucket{
			Time:    bucket.Time,
			Success: bucket.Success,
			Failed:  bucket.Failed,
		})
	}
	return result
}
