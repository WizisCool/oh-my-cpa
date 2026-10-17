package api

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// USAGE_ROUTING_WINDOW is the live routing panel's rolling window. The panel is
// a picture of what the gateway is doing now, not a report: an attempt stays on
// it for one minute after it finished and then leaves. History belongs to the
// request list.
const USAGE_ROUTING_WINDOW = time.Minute

type usageRoutingCooldown struct {
	AuthIndex     string `json:"auth_index"`
	Provider      string `json:"provider"`
	StatusCode    int    `json:"status_code,omitempty"`
	QuotaExceeded bool   `json:"quota_exceeded"`
	UntilMS       int64  `json:"until_at_ms"`
}

type usageRoutingResponse struct {
	AsOfMS   int64 `json:"as_of_ms"`
	WindowMS int64 `json:"window_ms"`
	// Records are attempts, newest first, projected exactly as the request list
	// projects them, so the panel names a model and a credential the way the
	// list does.
	Records   []usageEventResponse   `json:"records"`
	HasMore   bool                   `json:"has_more"`
	Cooldowns []usageRoutingCooldown `json:"cooldowns"`
}

// usageRouting answers the attempts of the rolling routing window.
//
// Everything is read back from request records: CPA writes one per attempt, so
// a record is a route a request actually took, and several records sharing a
// request id are a request CPA moved to another credential. Nothing is inferred
// from configuration. Without `after` the answer is the whole window; with
// `after=<record id>` it is only what was recorded since, which is how the
// panel follows the live stream without re-reading the minute it already holds.
// The browser ages attempts out of the window on its own clock.
func (h *Handler) usageRouting(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	var afterID int64
	if raw := strings.TrimSpace(request.URL.Query().Get("after")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			writeError(writer, http.StatusBadRequest, "after must be a record id")
			return
		}
		afterID = parsed
	}
	now := h.now().UTC()

	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()
	routing, err := h.repo.QueryUsageRouting(ctx, repository.UsageRoutingQuery{
		InstanceID: defaultInstanceID(),
		FromMS:     now.Add(-USAGE_ROUTING_WINDOW).UnixMilli(),
		AfterID:    afterID,
		NowMS:      now.UnixMilli(),
	})
	if err != nil {
		h.writeUsageQueryError(writer, fmt.Errorf("read usage routing: %w", err))
		return
	}

	response := usageRoutingResponse{
		AsOfMS:    now.UnixMilli(),
		WindowMS:  USAGE_ROUTING_WINDOW.Milliseconds(),
		Records:   make([]usageEventResponse, 0, len(routing.Records)),
		HasMore:   routing.HasMore,
		Cooldowns: make([]usageRoutingCooldown, 0, len(routing.Cooldowns)),
	}
	for _, row := range routing.Records {
		response.Records = append(response.Records, projectUsageEvent(row))
	}
	h.attachClientKeyAliases(request, response.Records)
	h.attachProviderKeyMasks(request, response.Records)
	for _, cooldown := range routing.Cooldowns {
		response.Cooldowns = append(response.Cooldowns, usageRoutingCooldown{
			AuthIndex: cooldown.AuthIndex, Provider: cooldown.Provider, StatusCode: cooldown.StatusCode,
			QuotaExceeded: cooldown.QuotaExceeded, UntilMS: cooldown.UntilMS,
		})
	}
	writeJSON(writer, http.StatusOK, response)
}
