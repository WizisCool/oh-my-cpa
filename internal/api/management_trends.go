package api

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

func trendsQueryOptions(request *http.Request, maxTop int, dimensions ...repository.UsageDimension) (repository.UsageDimension, int, string) {
	query := request.URL.Query()
	group := repository.UsageDimension(query.Get("group_by"))
	if group == "" {
		group = repository.UsageDimensionModel
	}
	if !slices.Contains(dimensions, group) {
		return "", 0, "unsupported group_by"
	}
	top := 5
	if raw := query.Get("top"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxTop {
			return "", 0, fmt.Sprintf("top must be between 1 and %d", maxTop)
		}
		top = parsed
	}
	for _, filter := range []string{"api_key", "model", "model_alias", "provider", "auth_index", "client_agent"} {
		if len(query[filter]) > repository.MaxUsageEventFilterValues {
			return "", 0, "too many values for " + filter
		}
	}
	return group, top, ""
}

func (h *Handler) trendsFactQuery(ctx context.Context, request *http.Request, window insightsWindow, compare *insightsCompareWindow, zone *time.Location) (repository.UsageFactQuery, error) {
	query := repository.UsageFactQuery{
		InstanceID: defaultInstanceID(), FromMS: window.FromMS, ToMS: window.ToMS,
		Calendar: &repository.UsageCalendar{Location: zone, Unit: window.Bucket.calendarUnit()},
		Filters:  h.insightsRhythmFilters(request), ClientAgents: insightsClientAgents(request),
	}
	if h.repo != nil {
		fromMS, toMS := window.FromMS, window.ToMS
		if compare != nil {
			fromMS = min(fromMS, compare.FromMS)
			toMS = max(toMS, compare.ToMS)
		}
		agents, err := h.repo.ResolveTrendsDimensionFilters(ctx, query.InstanceID, fromMS, toMS, query.Filters, query.ClientAgents)
		if err != nil {
			return query, err
		}
		query.ClientAgents = agents
	}
	return query, nil
}

func trendsBucketStart(bucket insightsBucket, startMS int64, zone *time.Location) int64 {
	// Only month buckets need a second fold. The repository has already assigned
	// every other bucket, including repeated local hours at clock changes.
	if bucket == insightsBucketMonth {
		return bucket.bucketStart(time.UnixMilli(startMS), zone).UnixMilli()
	}
	return startMS
}

type trendsGroupName struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	Alias          string `json:"alias,omitempty"`
	Mask           string `json:"mask,omitempty"`
	FilterDisabled bool   `json:"filter_disabled,omitempty"`
}

func isEndpointURL(value string) bool {
	return strings.Contains(value, "://") || strings.HasPrefix(value, "//")
}

func (h *Handler) trendsGroupProjection(group repository.UsageDimension, id string) trendsGroupName {
	safeID := security.MaskEmailAddresses(security.RedactText(id))
	label := safeID
	if label == "" {
		label = "unknown"
	}
	if group == repository.UsageDimensionKey && !strings.HasPrefix(id, "hmac:") && isEndpointURL(id) {
		if opaque := repository.TrendsOpaqueGroupID(h.cipher, group, id); opaque != "" {
			return trendsGroupName{ID: opaque, Label: "endpoint"}
		}
		return trendsGroupName{ID: "endpoint", Label: "endpoint", FilterDisabled: true}
	}
	if group != repository.UsageDimensionKey && safeID != id {
		if opaque := repository.TrendsOpaqueGroupID(h.cipher, group, id); opaque != "" {
			return trendsGroupName{ID: opaque, Label: label}
		}
		return trendsGroupName{ID: safeID, Label: label, FilterDisabled: true}
	}
	return trendsGroupName{ID: safeID, Label: label}
}

func (h *Handler) trendsGroupIdentity(group repository.UsageDimension, id string) (outID, label string) {
	projected := h.trendsGroupProjection(group, id)
	return projected.ID, projected.Label
}

func (h *Handler) trendsGroupNames(ctx context.Context, group repository.UsageDimension, ids []string) (map[string]trendsGroupName, error) {
	names := make(map[string]trendsGroupName, len(ids))
	for _, id := range ids {
		names[id] = h.trendsGroupProjection(group, id)
	}
	if group != repository.UsageDimensionKey {
		return names, nil
	}
	fingerprints := make([]string, 0, len(ids))
	for _, id := range ids {
		if strings.HasPrefix(id, "hmac:") {
			fingerprints = append(fingerprints, id)
		}
	}
	aliases, err := h.repo.ClientKeyAliasesFor(ctx, defaultInstanceID(), fingerprints)
	if err != nil {
		return nil, err
	}
	masks, err := h.repo.ClientKeyMasksFor(ctx, defaultInstanceID(), fingerprints)
	if err != nil {
		return nil, err
	}
	for _, id := range fingerprints {
		alias, mask := security.MaskEmailAddresses(security.RedactText(aliases[id])), security.NormalizeMask(masks[id])
		label := alias
		if label == "" {
			label = mask
		}
		if label == "" {
			label = id
		}
		names[id] = trendsGroupName{ID: id, Label: label, Alias: alias, Mask: mask}
	}
	return names, nil
}
