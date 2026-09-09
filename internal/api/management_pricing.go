package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

// PricingManager is the handler-facing view of the pricing service. The concrete
// *pricing.Service is wired once at startup; tests inject a fake here.
type PricingManager interface {
	ListPrices(ctx context.Context) ([]pricing.ModelPrice, error)
	SaveManualPrices(ctx context.Context, rows []pricing.ModelPrice) error
	DeletePrice(ctx context.Context, model string) (bool, error)
	UsedUnpricedModels(ctx context.Context, limit int) ([]string, error)
	SyncStateView(ctx context.Context) (pricing.SyncState, bool, error)
	TriggerSync() bool
	IsRunning() bool
	SetAutoSyncInterval(ctx context.Context, hours int64) error
}

// SetPricing attaches the pricing service after construction so the app can
// keep the handler builder simple and keep tests free of a real service.
func (h *Handler) SetPricing(manager PricingManager) {
	h.pricing = manager
}

// pricingManualLimit bounds one manual edit batch: an operator edits rows one
// at a time, so a large cap only protects the server.
const pricingManualLimit = 64

// listPricing returns the price table, the models.dev sync state and the
// unpriced-model hints in a single request so the page can render in one round
// trip. A missing service keeps the endpoint honest with 503 instead of an
// empty table.
func (h *Handler) listPricing(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.pricing == nil {
		writeError(writer, http.StatusServiceUnavailable, "pricing service is not available")
		return
	}
	ctx := request.Context()
	rows, err := h.pricing.ListPrices(ctx)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	unpriced, err := h.pricing.UsedUnpricedModels(ctx, 50)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	// Sync bookkeeping is auxiliary. Pricing the recorded traffic must not depend
	// on it, so a state read that still fails degrades to "unknown" with the
	// reason shown as last_error instead of blanking the whole page.
	state, known, err := h.pricing.SyncStateView(ctx)
	if err != nil {
		slog.Warn("pricing sync state unavailable", "error", err)
		state = pricing.SyncState{Source: pricing.SourceModelsDev, LastError: err.Error()}
		known = false
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"source":   pricing.SourceModelsDev,
		"models":   rows,
		"unpriced": unpriced,
		"sync": map[string]any{
			"known":   known,
			"running": h.pricing.IsRunning(),
			"state":   state,
		},
	})
}

// pricingUpdateRequest is the manual edit payload. Unknown fields are rejected
// so a typo silently changing rates is impossible.
type pricingUpdateRequest struct {
	Models []pricing.ModelPrice `json:"models"`
}

// updatePricingModels validates and saves operator edits as manual rows: they
// win over every later models.dev sync.
func (h *Handler) updatePricingModels(writer http.ResponseWriter, request *http.Request) {
	if h.pricing == nil {
		writeError(writer, http.StatusServiceUnavailable, "pricing service is not available")
		return
	}
	var body pricingUpdateRequest
	if err := decodeManagementJSON(writer, request, 16*1024, &body); err != nil {
		return
	}
	if len(body.Models) == 0 {
		writeError(writer, http.StatusBadRequest, "models must contain at least one price row")
		return
	}
	if len(body.Models) > pricingManualLimit {
		writeError(writer, http.StatusBadRequest, "too many rows in one edit")
		return
	}
	var invalid []string
	for index := range body.Models {
		if err := body.Models[index].Validate(); err != nil {
			invalid = append(invalid, fmt.Sprintf("row %d: %s", index, err.Error()))
		}
	}
	if len(invalid) > 0 {
		writeErrorWithDetails(writer, http.StatusBadRequest, "invalid price rows", invalid)
		return
	}
	rows := make([]pricing.ModelPrice, len(body.Models))
	copy(rows, body.Models)
	if err := h.pricing.SaveManualPrices(request.Context(), rows); err != nil {
		writeInternalError(writer, err)
		return
	}
	if err := h.recordAudit(request, "pricing.models.update", "pricing", "", "success", map[string]any{
		"rows": len(rows),
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"updated": len(rows)})
}

// deletePricingModel removes one row. The next sync may recreate it as an auto
// row when models.dev still matches; deleting is therefore the documented way
// to return a model to automatic pricing.
func (h *Handler) deletePricingModel(writer http.ResponseWriter, request *http.Request) {
	if h.pricing == nil {
		writeError(writer, http.StatusServiceUnavailable, "pricing service is not available")
		return
	}
	model := strings.TrimSpace(chi.URLParam(request, "model"))
	if model == "" {
		writeError(writer, http.StatusBadRequest, "model path parameter is required")
		return
	}
	deleted, err := h.pricing.DeletePrice(request.Context(), model)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	if err := h.recordAudit(request, "pricing.model.delete", "pricing", model, "success", map[string]any{
		"deleted": deleted,
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"deleted": deleted})
}

// startPricingSync kicks one background models.dev sync. A sync already in
// flight returns 409 so parallel UI refreshes cannot stack fetches.
func (h *Handler) startPricingSync(writer http.ResponseWriter, request *http.Request) {
	if h.pricing == nil {
		writeError(writer, http.StatusServiceUnavailable, "pricing service is not available")
		return
	}
	if !h.pricing.TriggerSync() {
		writeError(writer, http.StatusConflict, "a pricing sync is already running")
		return
	}
	if err := h.recordAudit(request, "pricing.sync.start", "pricing", pricing.SourceModelsDev, "success", nil); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusAccepted, map[string]any{"started": true})
}

// pricingScheduleRequest is the auto-sync interval update payload.
type pricingScheduleRequest struct {
	IntervalHours *int64 `json:"interval_hours"`
}

// updatePricingSyncSchedule modifies the background sync interval (0 = disabled).
func (h *Handler) updatePricingSyncSchedule(writer http.ResponseWriter, request *http.Request) {
	if h.pricing == nil {
		writeError(writer, http.StatusServiceUnavailable, "pricing service is not available")
		return
	}
	var body pricingScheduleRequest
	if err := decodeManagementJSON(writer, request, 1024, &body); err != nil {
		return
	}
	if body.IntervalHours == nil {
		writeError(writer, http.StatusBadRequest, "interval_hours is required")
		return
	}
	hours := *body.IntervalHours
	if hours < 0 || hours > 168 {
		writeError(writer, http.StatusBadRequest, "interval_hours must be between 0 and 168")
		return
	}
	if err := h.pricing.SetAutoSyncInterval(request.Context(), hours); err != nil {
		writeInternalError(writer, err)
		return
	}
	if err := h.recordAudit(request, "pricing.sync_schedule.update", "pricing", pricing.SourceModelsDev, "success", map[string]any{
		"interval_hours": hours,
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	state, known, _ := h.pricing.SyncStateView(request.Context())
	writeJSON(writer, http.StatusOK, map[string]any{
		"interval_hours": hours,
		"known":          known,
		"state":          state,
	})
}
