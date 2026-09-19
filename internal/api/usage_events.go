package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
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
	// APIKeyAlias is the operator-assigned name for the caller key, resolved
	// server-side from the fingerprint in APIGroupKey. It is a display label
	// only: APIGroupKey stays the filter identity, so renaming a key never
	// changes what a saved filter or a drill-down link selects. Empty when the
	// key has not been named.
	APIKeyAlias string `json:"api_key_alias,omitempty"`
	// APIKeyMask is the display-only label for the caller key. The request
	// record keeps only a fingerprint, so records ingested before the mask
	// column existed omit it.
	APIKeyMask string `json:"api_key_mask,omitempty"`
	// ProviderKeyMask is the display-only mask of the upstream credential that
	// answered the request, resolved at read time from the credential lists CPA
	// currently reports (see usage_provider_key_masks.go). It is empty whenever
	// the credential cannot be identified - a rotated, deleted or disabled key,
	// an OAuth credential, or a gateway that could not be read - in which case
	// the console prints nothing rather than a guess.
	ProviderKeyMask     string `json:"provider_key_mask,omitempty"`
	Source              string `json:"source,omitempty"`
	UserAgent           string `json:"user_agent,omitempty"`
	Model               string `json:"model"`
	ModelAlias          string `json:"model_alias,omitempty"`
	ReasoningEffort     string `json:"reasoning_effort,omitempty"`
	ServiceTier         string `json:"service_tier,omitempty"`
	ResponseServiceTier string `json:"response_service_tier,omitempty"`
	Failed              bool   `json:"failed"`
	Generate            bool   `json:"generate"`
	Stream              *bool  `json:"stream,omitempty"`
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
	ResourceID     *string  `json:"resource_id,omitempty"`
	ResourceName   *string  `json:"resource_name,omitempty"`
	HasRequestLog  bool     `json:"has_request_log"`
	CostUSD        *float64 `json:"cost_usd,omitempty"`
	PricingStatus  string   `json:"pricing_status"`
	PriceVersionID *int64   `json:"price_version_id,omitempty"`
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
	item.Stream = row.Stream
	item.LatencyMS = row.LatencyMS
	item.TTFTMS = row.TTFTMS
	item.ResourceID = row.ResourceID
	item.ResourceName = row.ResourceName
	item.HasRequestLog = row.HasRequestLog
	item.CostUSD = row.CostUSD
	item.PricingStatus = row.PricingStatus
	item.PriceVersionID = row.PriceVersionID
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

// maxUsageFilterParamLength bounds one filter value. Every column the console
// filters on is stored bounded (the widest is 256 characters), so a longer term
// cannot match anything and is refused rather than silently returning nothing.
const maxUsageFilterParamLength = 256

// usageEventMultiParams reads one repeated query parameter into a bounded list.
//
// Repeated parameters are the multi-select wire format: `?model=a&model=b` means
// "a or b", and a single occurrence keeps working so dashboard drill-down links
// written before multi-select existed are unchanged. Values are never split on a
// comma: a comma is a legal character in a model name, a source label and a
// caller mask, so splitting would corrupt the very values being filtered on.
func usageEventMultiParams(query url.Values, key string) ([]string, error) {
	raw := query[key]
	if len(raw) == 0 {
		return nil, nil
	}
	if len(raw) > repository.MaxUsageEventFilterValues {
		return nil, fmt.Errorf("%s accepts at most %d values", key, repository.MaxUsageEventFilterValues)
	}
	values := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, value := range raw {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if len(trimmed) > maxUsageFilterParamLength {
			return nil, fmt.Errorf("%s values must be at most %d characters", key, maxUsageFilterParamLength)
		}
		if _, duplicate := seen[trimmed]; duplicate {
			continue
		}
		seen[trimmed] = struct{}{}
		values = append(values, trimmed)
	}
	return values, nil
}

// usageEventTextParam reads one optional substring filter.
func usageEventTextParam(query url.Values, key string) (string, error) {
	values, err := usageEventMultiParams(query, key)
	if err != nil {
		return "", err
	}
	if len(values) == 0 {
		return "", nil
	}
	if len(values) > 1 {
		return "", fmt.Errorf("%s accepts a single value", key)
	}
	return values[0], nil
}

// usageEventBoundParam reads one inclusive numeric bound. A present-but-empty
// parameter (`?min_latency=`) clears the bound, which is what the console emits
// when the operator empties a range field, so it is not an error.
func usageEventBoundParam(query url.Values, key string) (*int64, error) {
	raw, present := query[key]
	if !present {
		return nil, nil
	}
	trimmed := strings.TrimSpace(raw[len(raw)-1])
	if trimmed == "" {
		return nil, nil
	}
	parsed, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("%s must be an integer", key)
	}
	if parsed < 0 {
		return nil, fmt.Errorf("%s cannot be negative", key)
	}
	return &parsed, nil
}

// usageEventCostBoundParam converts a decimal USD bound into the nanos the cost
// column is stored in. The digits are scaled in string form rather than through
// float64 so the conversion is exact: a bound of 0.1 must not land one nano
// below the value it was meant to include.
func usageEventCostBoundParam(query url.Values, key string) (*int64, error) {
	raw, present := query[key]
	if !present {
		return nil, nil
	}
	trimmed := strings.TrimSpace(raw[len(raw)-1])
	if trimmed == "" {
		return nil, nil
	}
	nanos, err := parseUSDAmountNanos(trimmed)
	if err != nil {
		return nil, fmt.Errorf("%s %s", key, err.Error())
	}
	return &nanos, nil
}

// parseUSDAmountNanos converts a non-negative decimal dollar amount of at most
// nine fractional digits into integer nanos.
//
// Precision is refused rather than rounded. A bound of 0.0000001 USD is a real
// constraint that this column cannot express, and rounding it to zero would turn
// "cost at most a tenth of a nano-dollar" into "cost at most nothing" - a
// silently wrong answer in place of a validation error.
func parseUSDAmountNanos(value string) (int64, error) {
	whole, fraction, hasPoint := strings.Cut(value, ".")
	if whole == "" && !hasPoint {
		return 0, errors.New("must be a non-negative decimal amount")
	}
	// At least one digit is required somewhere: "." and "" both parse as zero on
	// their own, and neither is an amount the operator typed on purpose.
	if strings.IndexFunc(whole+fraction, func(r rune) bool { return r >= '0' && r <= '9' }) < 0 {
		return 0, errors.New("must be a non-negative decimal amount")
	}
	for _, digit := range whole + fraction {
		if digit < '0' || digit > '9' {
			return 0, errors.New("must be a non-negative decimal amount")
		}
	}
	if len(fraction) > 9 {
		return 0, errors.New("supports at most nine decimal places")
	}
	if whole == "" {
		whole = "0"
	}
	// Leading zeros are dropped after scaling, where the only zeros in play are
	// padding: trimming the whole part earlier would move the decimal point.
	digits := strings.TrimLeft(whole+fraction+strings.Repeat("0", 9-len(fraction)), "0")
	if digits == "" {
		return 0, nil
	}
	nanos, err := strconv.ParseInt(digits, 10, 64)
	if err != nil {
		return 0, errors.New("is out of range")
	}
	return nanos, nil
}

// usageEventRangeValid rejects a range whose ends cross, which no record can
// satisfy. Accepting it would present an empty list as a data problem.
func usageEventRangeValid(key string, min, max *int64) error {
	if min == nil || max == nil {
		return nil
	}
	if *min > *max {
		return fmt.Errorf("%s must not be greater than %s", key+"_min", key+"_max")
	}
	return nil
}

// usageEventFilterFromRequest translates the console's query string into the
// shared filter vocabulary. Every failure is the caller's: an unparsable bound,
// an unknown enum or a reversed range is a malformed request, not a server
// fault, so the messages are written to be shown next to the field.
func usageEventFilterFromRequest(request *http.Request, window dashboardWindow) (repository.UsageEventFilter, error) {
	query := request.URL.Query()
	filter := repository.UsageEventFilter{
		InstanceID: defaultInstanceID(),
		FromMS:     window.FromMS,
		ToMS:       window.ToMS,
		Result:     strings.ToLower(strings.TrimSpace(query.Get("result"))),
		CostState:  strings.ToLower(strings.TrimSpace(query.Get("cost"))),
		Cursor:     query.Get("cursor"),
	}
	multi := []struct {
		key    string
		target *[]string
	}{
		{"model", &filter.Models},
		{"model_alias", &filter.ModelAliases},
		{"provider", &filter.Providers},
		{"api_key", &filter.APIGroupKeys},
		{"auth_index", &filter.AuthIndexes},
		{"source", &filter.Sources},
		{"auth_type", &filter.AuthTypes},
		{"executor", &filter.ExecutorTypes},
		{"reasoning", &filter.ReasoningEfforts},
		{"service_tier", &filter.ServiceTiers},
	}
	for _, dimension := range multi {
		values, err := usageEventMultiParams(query, dimension.key)
		if err != nil {
			return filter, err
		}
		*dimension.target = values
	}

	text := []struct {
		key    string
		target *string
	}{
		{"q", &filter.Search},
		{"endpoint", &filter.Endpoint},
		{"ua", &filter.UserAgent},
		{"request_id", &filter.RequestID},
	}
	for _, entry := range text {
		value, err := usageEventTextParam(query, entry.key)
		if err != nil {
			return filter, err
		}
		*entry.target = value
	}

	numeric := []struct {
		key    string
		target **int64
	}{
		{"latency_min", &filter.MinLatencyMS},
		{"latency_max", &filter.MaxLatencyMS},
		{"tokens_min", &filter.MinTokens},
		{"tokens_max", &filter.MaxTokens},
	}
	for _, entry := range numeric {
		value, err := usageEventBoundParam(query, entry.key)
		if err != nil {
			return filter, err
		}
		*entry.target = value
	}
	for _, entry := range []struct {
		key    string
		target **int64
	}{
		{"cost_min", &filter.MinCostNanos},
		{"cost_max", &filter.MaxCostNanos},
	} {
		value, err := usageEventCostBoundParam(query, entry.key)
		if err != nil {
			return filter, err
		}
		*entry.target = value
	}

	if err := usageEventRangeValid("latency", filter.MinLatencyMS, filter.MaxLatencyMS); err != nil {
		return filter, err
	}
	if err := usageEventRangeValid("tokens", filter.MinTokens, filter.MaxTokens); err != nil {
		return filter, err
	}
	if err := usageEventRangeValid("cost", filter.MinCostNanos, filter.MaxCostNanos); err != nil {
		return filter, err
	}
	if rawLimit := strings.TrimSpace(query.Get("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			return filter, errors.New("limit must be a positive integer")
		}
		filter.Limit = parsed
	}
	return filter, nil
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
	filter, filterErr := usageEventFilterFromRequest(request, window)
	if filterErr != nil {
		writeError(writer, http.StatusBadRequest, filterErr.Error())
		return
	}
	if !validEventResult(filter.Result) {
		writeError(writer, http.StatusBadRequest, "result must be one of all, success or failed")
		return
	}
	if !validCostState(filter.CostState) {
		writeError(writer, http.StatusBadRequest, "cost must be one of priced or unpriced")
		return
	}
	if err := repository.ValidUsageCursor(filter.Cursor); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	// `since` asks only for a count of what has been recorded past the reader's
	// own boundary (a row id, not a timestamp). It is optional, and an
	// unparseable value is refused rather than ignored: silently dropping it would
	// report "nothing new" forever.
	if rawSince := strings.TrimSpace(request.URL.Query().Get("since")); rawSince != "" {
		since, parseErr := strconv.ParseInt(rawSince, 10, 64)
		if parseErr != nil || since < 0 {
			writeError(writer, http.StatusBadRequest, "since must be a non-negative record id")
			return
		}
		filter.SinceID = since
	}
	page, err := h.repo.ListUsageEvents(request.Context(), filter)
	if err != nil {
		// A filter the repository refuses is still a malformed request. Its own
		// message names internal columns, so the response stays generic.
		if errors.Is(err, repository.ErrUsageFilterInvalid) {
			writeError(writer, http.StatusBadRequest, "invalid usage event filter")
			return
		}
		// A cursor from before the list was ordered by request time can name a row
		// that no longer exists, and its timestamp is unrecoverable. Conflict tells
		// the console to drop its cursor and reload the first page; serving a page
		// from an unknown position would be worse than an error.
		if errors.Is(err, repository.ErrUsageCursorStale) {
			writeJSON(writer, http.StatusConflict, map[string]any{
				"error": "the pagination cursor is no longer valid; reload the first page",
				"code":  "cursor_stale",
			})
			return
		}
		h.writeUsageQueryError(writer, err)
		return
	}

	items := make([]usageEventResponse, 0, len(page.Items))
	for _, row := range page.Items {
		items = append(items, projectUsageEvent(row))
	}
	h.attachClientKeyAliases(request, items)
	// Which provider key answered is resolved after projection, like the caller key
	// alias, because it is a read-time label over credentials CPA currently holds
	// rather than a fact stored with the record.
	h.attachProviderKeyMasks(request, items)
	writeJSON(writer, http.StatusOK, map[string]any{
		"window":        window,
		"items":         items,
		"next_cursor":   page.NextCursor,
		"has_more":      page.HasMore,
		"limit":         page.Limit,
		"arrived_count": page.ArrivedCount,
	})
}

// attachClientKeyAliases fills in the operator-assigned name for every caller key
// on the page, in one batched lookup.
//
// One query per record would add a round trip per row for what is only a label,
// so the distinct fingerprints of the page are resolved together. The lookup is
// best effort: a failure leaves `api_key_alias` empty and the console falls back
// to the mask, because losing a cosmetic name must not fail the request list
// itself. Aliases are Oh My CPA metadata and never carry key material, so nothing
// sensitive is read or returned here.
func (h *Handler) attachClientKeyAliases(request *http.Request, items []usageEventResponse) {
	if h.repo == nil || len(items) == 0 {
		return
	}
	fingerprints := make([]string, 0, len(items))
	for _, item := range items {
		// Only client-key callers can have an alias. A provider or endpoint
		// fallback identity is not a key, so looking it up would be meaningless.
		if item.APIGroupLabel == "api_key" && item.APIGroupKey != "" {
			fingerprints = append(fingerprints, item.APIGroupKey)
		}
	}
	if len(fingerprints) == 0 {
		return
	}
	aliases, err := h.repo.ClientKeyAliasesFor(request.Context(), defaultInstanceID(), fingerprints)
	if err != nil {
		if h.logger != nil {
			h.logger.Warn("client key alias resolution failed", "error", err.Error())
		}
		return
	}
	for index := range items {
		if items[index].APIGroupLabel != "api_key" {
			continue
		}
		if alias, ok := aliases[items[index].APIGroupKey]; ok {
			items[index].APIKeyAlias = alias
		}
	}
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

	// The provider key mask is resolved on the detail view as well as the list: the
	// two must not disagree about which credential answered, and the drawer is where
	// an operator goes to check the claim a row made.
	item := projectUsageEvent(row)
	applyProviderKeyMask(&item, h.resolveProviderKeyMasks(request, []usageEventResponse{item}))
	response := map[string]any{"event": projectUsageEventDetail(row, item.ProviderKeyMask)}
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
func projectUsageEventDetail(row repository.UsageEventRow, providerKeyMask string) map[string]any {
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
		"provider_key_mask":     providerKeyMask,
		"source":                item.Source,
		"model":                 item.Model,
		"model_alias":           item.ModelAlias,
		"reasoning_effort":      item.ReasoningEffort,
		"service_tier":          item.ServiceTier,
		"response_service_tier": item.ResponseServiceTier,
		"failed":                item.Failed,
		"generate":              item.Generate,
		"stream":                item.Stream,
		"latency_ms":            item.LatencyMS,
		"ttft_ms":               item.TTFTMS,
		"tokens":                item.Tokens,
		"resource_id":           item.ResourceID,
		"resource_name":         item.ResourceName,
		"has_request_log":       item.HasRequestLog,
		"cost_usd":              row.CostUSD,
		"pricing_status":        row.PricingStatus,
		"price_version_id":      row.PriceVersionID,
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
	h.attachFacetAliases(request, &facets)
	writeJSON(writer, http.StatusOK, map[string]any{"window": window, "facets": facets})
}

// attachFacetAliases labels the caller-key facet options with their names.
//
// The facet's `value` is a fingerprint, so without this the dropdown would offer
// identities the operator never chose while the rows they filter now show names.
// One batched lookup covers every option, and the label is best effort: a failure
// leaves the mask in place rather than failing the dropdown.
func (h *Handler) attachFacetAliases(request *http.Request, facets *repository.UsageFacets) {
	if h.repo == nil || facets == nil || len(facets.APIGroupKey) == 0 {
		return
	}
	fingerprints := make([]string, 0, len(facets.APIGroupKey))
	for _, option := range facets.APIGroupKey {
		if option.Value != "" {
			fingerprints = append(fingerprints, option.Value)
		}
	}
	aliases, err := h.repo.ClientKeyAliasesFor(request.Context(), defaultInstanceID(), fingerprints)
	if err != nil {
		if h.logger != nil {
			h.logger.Warn("client key alias resolution for facets failed", "error", err.Error())
		}
		return
	}
	for index := range facets.APIGroupKey {
		if alias, ok := aliases[facets.APIGroupKey[index].Value]; ok {
			facets.APIGroupKey[index].Alias = alias
		}
	}
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

// validCostState mirrors the repository's accepted cost-availability vocabulary.
func validCostState(value string) bool {
	switch value {
	case repository.CostStateAny, repository.CostStatePriced, repository.CostStateUnpriced:
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
