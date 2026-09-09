package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// usageEventResponse trims a stored row into what the browser needs.
//
// The detail table keeps client IP, forwarded-for and the full endpoint for
// operator diagnosis; list payloads still never carry those. The user agent is
// the one network field the list does expose: it is stored already reduced to a
// short redacted product label (security.MinimizeUserAgent on the persistence
// path), so it names the calling client without carrying the raw header.
type usageEventResponse struct {
	ID            int64  `json:"id"`
	EventKey      string `json:"event_key"`
	RequestID     string `json:"request_id,omitempty"`
	TimestampMS   int64  `json:"timestamp_ms"`
	Provider      string `json:"provider"`
	Endpoint      string `json:"endpoint,omitempty"`
	ExecutorType  string `json:"executor_type,omitempty"`
	AuthType      string `json:"auth_type,omitempty"`
	AuthIndex     string `json:"auth_index,omitempty"`
	APIGroupKey   string `json:"api_group_key,omitempty"`
	APIGroupLabel string `json:"api_group_label,omitempty"`
	// APIKeyMask is the display-only label for the caller key. The request
	// record keeps only a fingerprint, so records ingested before the mask
	// column existed omit it.
	APIKeyMask          string `json:"api_key_mask,omitempty"`
	Source              string `json:"source,omitempty"`
	UserAgent           string `json:"user_agent,omitempty"`
	Model               string `json:"model"`
	ModelAlias          string `json:"model_alias,omitempty"`
	ReasoningEffort     string `json:"reasoning_effort,omitempty"`
	ServiceTier         string `json:"service_tier,omitempty"`
	ResponseServiceTier string `json:"response_service_tier,omitempty"`
	Failed              bool   `json:"failed"`
	Generate            bool   `json:"generate"`
	LatencyMS           int64  `json:"latency_ms"`
	TTFTMS              *int64 `json:"ttft_ms,omitempty"`
	Tokens              struct {
		Input         int64 `json:"input"`
		Output        int64 `json:"output"`
		Reasoning     int64 `json:"reasoning"`
		Cached        int64 `json:"cached"`
		CacheRead     int64 `json:"cache_read"`
		CacheCreation int64 `json:"cache_creation"`
		Total         int64 `json:"total"`
	} `json:"tokens"`
	ResourceID    *string  `json:"resource_id,omitempty"`
	ResourceName  *string  `json:"resource_name,omitempty"`
	HasRequestLog bool     `json:"has_request_log"`
	CostUSD       *float64 `json:"cost_usd,omitempty"`
}

func projectUsageEvent(row repository.UsageEventRow) usageEventResponse {
	var item usageEventResponse
	item.ID = row.ID
	item.EventKey = row.EventKey
	item.RequestID = row.RequestID
	item.TimestampMS = row.TimestampMS
	item.Provider = row.Provider
	item.ExecutorType = row.ExecutorType
	item.AuthType = row.AuthType
	item.AuthIndex = row.AuthIndex
	item.APIGroupKey = row.APIGroupKey
	item.APIGroupLabel = row.APIGroupLabel
	// Legacy rows carry the old filler; the console only ever shows the current
	// one, so the conversion happens once, here, rather than in the UI.
	item.APIKeyMask = security.NormalizeMask(row.APIKeyMask)
	item.Source = row.Source
	if row.UserAgent != nil {
		item.UserAgent = *row.UserAgent
	}
	item.Model = row.Model
	item.ReasoningEffort = row.ReasoningEffort
	item.ServiceTier = row.ServiceTier
	item.ResponseServiceTier = row.ResponseServiceTier
	item.Failed = row.Failed
	item.Generate = row.Generate
	item.LatencyMS = row.LatencyMS
	item.TTFTMS = row.TTFTMS
	item.ResourceID = row.ResourceID
	item.ResourceName = row.ResourceName
	item.HasRequestLog = row.HasRequestLog
	item.CostUSD = row.CostUSD
	item.Tokens = usageEventTokens(row)
	if row.ModelAlias != nil {
		item.ModelAlias = *row.ModelAlias
	}
	// The endpoint can embed a base URL the operator considers private, so it is
	// only surfaced on the single-record view.
	return item
}

func usageEventTokens(row repository.UsageEventRow) (tokens struct {
	Input         int64 `json:"input"`
	Output        int64 `json:"output"`
	Reasoning     int64 `json:"reasoning"`
	Cached        int64 `json:"cached"`
	CacheRead     int64 `json:"cache_read"`
	CacheCreation int64 `json:"cache_creation"`
	Total         int64 `json:"total"`
}) {
	tokens.Input = row.Tokens.InputTokens
	tokens.Output = row.Tokens.OutputTokens
	tokens.Reasoning = row.Tokens.ReasoningTokens
	tokens.Cached = row.Tokens.CachedTokens
	tokens.CacheRead = row.Tokens.CacheReadTokens
	tokens.CacheCreation = row.Tokens.CacheCreationTokens
	tokens.Total = row.Tokens.TotalTokens
	return tokens
}

// listUsageEvents serves the shared request-record query used by the detail
// table, drill-downs and (later) ranking and export.
func (h *Handler) listUsageEvents(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	window, windowErr := dashboardWindowFromRequest(request, time.Now().UTC())
	if windowErr != "" {
		writeError(writer, http.StatusBadRequest, windowErr)
		return
	}
	query := request.URL.Query()
	filter := repository.UsageEventFilter{
		InstanceID:   defaultInstanceID(),
		FromMS:       window.FromMS,
		ToMS:         window.ToMS,
		Model:        query.Get("model"),
		ModelAlias:   query.Get("model_alias"),
		APIGroupKey:  query.Get("api_key"),
		AuthIndex:    query.Get("auth_index"),
		Provider:     query.Get("provider"),
		Source:       query.Get("source"),
		AuthType:     query.Get("auth_type"),
		ExecutorType: query.Get("executor"),
		Result:       strings.ToLower(strings.TrimSpace(query.Get("result"))),
		RequestID:    query.Get("request_id"),
		Cursor:       query.Get("cursor"),
		Limit:        0,
	}
	if rawLimit := strings.TrimSpace(query.Get("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			writeError(writer, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		filter.Limit = parsed
	}

	if !validEventResult(filter.Result) {
		writeError(writer, http.StatusBadRequest, "result must be one of all, success or failed")
		return
	}
	if err := repository.ValidUsageCursor(filter.Cursor); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	page, err := h.repo.ListUsageEvents(request.Context(), filter)
	if err != nil {
		h.writeUsageQueryError(writer, err)
		return
	}

	items := make([]usageEventResponse, 0, len(page.Items))
	for _, row := range page.Items {
		items = append(items, projectUsageEvent(row))
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"window":      window,
		"items":       items,
		"next_cursor": page.NextCursor,
		"has_more":    page.HasMore,
		"limit":       page.Limit,
	})
}

// getUsageEvent returns one record plus the credential errors that happened
// around it, which is what makes a failed request diagnosable in one call.
func (h *Handler) getUsageEvent(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id, err := parseEventID(request)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	row, err := h.repo.GetUsageEvent(request.Context(), id)
	if errors.Is(err, repository.ErrNotFound) {
		writeError(writer, http.StatusNotFound, "usage event not found")
		return
	}
	if err != nil {
		writeInternalError(writer, err)
		return
	}

	response := map[string]any{"event": projectUsageEventDetail(row)}
	if row.AuthIndex != "" {
		correlated, corrErr := h.repo.CorrelatedErrorEvents(request.Context(), row.AuthIndex, row.TimestampMS, 2*60*1000)
		if corrErr != nil {
			response["partial_errors"] = []string{"correlated errors unavailable"}
		} else {
			response["related_errors"] = correlated
		}
	}
	writeJSON(writer, http.StatusOK, response)
}

// projectUsageEventDetail is the single-record view: it may include the endpoint
// and client metadata the list view deliberately omits.
func projectUsageEventDetail(row repository.UsageEventRow) map[string]any {
	item := projectUsageEvent(row)
	detail := map[string]any{
		"id":                    item.ID,
		"event_key":             item.EventKey,
		"request_id":            item.RequestID,
		"timestamp_ms":          item.TimestampMS,
		"provider":              item.Provider,
		"endpoint":              row.Endpoint,
		"executor_type":         item.ExecutorType,
		"auth_type":             item.AuthType,
		"auth_index":            item.AuthIndex,
		"api_group_key":         item.APIGroupKey,
		"api_group_label":       item.APIGroupLabel,
		"api_key_mask":          item.APIKeyMask,
		"source":                item.Source,
		"model":                 item.Model,
		"model_alias":           item.ModelAlias,
		"reasoning_effort":      item.ReasoningEffort,
		"service_tier":          item.ServiceTier,
		"response_service_tier": item.ResponseServiceTier,
		"failed":                item.Failed,
		"generate":              item.Generate,
		"latency_ms":            item.LatencyMS,
		"ttft_ms":               item.TTFTMS,
		"tokens":                item.Tokens,
		"resource_id":           item.ResourceID,
		"resource_name":         item.ResourceName,
		"has_request_log":       item.HasRequestLog,
		"cost_usd":              row.CostUSD,
		"client_ip":             row.ClientIP,
		"x_forwarded_for":       row.XForwardedFor,
		"user_agent":            row.UserAgent,
	}
	return detail
}

// downloadUsageEventRequestLog proxies CPA's raw request log for one record.
//
// The browser never learns CPA's management key or the log endpoint: it asks us
// by event id, and we fetch it server-side. The id is validated, and the
// download is an explicit action rather than something a list view triggers.
func (h *Handler) downloadUsageEventRequestLog(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id, err := parseEventID(request)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	row, err := h.repo.GetUsageEvent(request.Context(), id)
	if errors.Is(err, repository.ErrNotFound) {
		writeError(writer, http.StatusNotFound, "usage event not found")
		return
	}
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	if strings.TrimSpace(row.RequestID) == "" {
		writeError(writer, http.StatusConflict, "this record has no CPA request id to look up")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()
	payload, _, fetchErr := client.DownloadRequestLog(ctx, row.RequestID)
	if fetchErr != nil {
		_ = h.recordAudit(request, "request_log.download", "request_log", row.RequestID, "failure", map[string]any{"error": fetchErr.Error()})
		writeCPAFacadeError(writer, fetchErr)
		return
	}
	if auditErr := h.recordAudit(request, "request_log.download", "request_log", row.RequestID, "success", map[string]any{"size_bytes": len(payload)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; request log download aborted")
		return
	}
	name := sanitizeLogName(row.RequestID)
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, name))
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(payload)
}

// listUsageFacets returns the filter values actually present in a window.
func (h *Handler) listUsageFacets(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	window, windowErr := dashboardWindowFromRequest(request, time.Now().UTC())
	if windowErr != "" {
		writeError(writer, http.StatusBadRequest, windowErr)
		return
	}
	facets, err := h.repo.GetUsageFacets(request.Context(), defaultInstanceID(), window.FromMS, window.ToMS)
	if err != nil {
		h.writeUsageQueryError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"window": window, "facets": facets})
}

// writeUsageQueryError turns a missing-schema state into something the UI can
// explain, instead of a 500 on a fresh install before the first capture.
// validEventResult mirrors the repository's accepted result vocabulary.
func validEventResult(value string) bool {
	switch value {
	case "", repository.ResultAll, repository.ResultSuccess, repository.ResultFailed:
		return true
	default:
		return false
	}
}

func (h *Handler) writeUsageQueryError(writer http.ResponseWriter, err error) {
	if strings.Contains(strings.ToLower(err.Error()), "no such table") {
		writeError(writer, http.StatusServiceUnavailable, "usage tables are not initialised yet")
		return
	}
	writeInternalError(writer, err)
}

var logNamePattern = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func parseEventID(request *http.Request) (int64, error) {
	raw := strings.TrimSpace(chi.URLParam(request, "id"))
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("usage event id must be a positive integer")
	}
	return id, nil
}

// sanitizeLogName keeps a CPA request id from injecting quote or separator
// characters into a Content-Disposition header.
func sanitizeLogName(requestID string) string {
	cleaned := logNamePattern.ReplaceAllString(strings.TrimSpace(requestID), "-")
	cleaned = strings.Trim(cleaned, ".-_")
	if cleaned == "" {
		cleaned = "request"
	}
	if len(cleaned) > 80 {
		cleaned = cleaned[:80]
	}
	return cleaned + ".log"
}

// compile-time assertion that the management client offers the log download.
var _ = (*management.Client).DownloadRequestLog
