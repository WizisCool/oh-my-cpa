package api

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type modelCatalogRefreshDTO struct {
	OK               bool                     `json:"ok"`
	Catalogs         []modelCatalogOutcomeDTO `json:"catalogs"`
	ChangedProviders []string                 `json:"changed_providers"`
	Code             string                   `json:"code,omitempty"`
	Error            string                   `json:"error,omitempty"`
}

type modelCatalogOutcomeDTO struct {
	Catalog          string   `json:"catalog"`
	Status           string   `json:"status"`
	ChangedProviders []string `json:"changed_providers"`
	ErrorCode        string   `json:"error_code,omitempty"`
}

func (h *Handler) refreshModelSquareCatalogs(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, isReady := h.managementClientOrError(writer, request)
	if !isReady {
		return
	}
	if err := h.recordAudit(request, "model_catalog.refresh", "model_catalog", "all", "attempt", nil); err != nil {
		writeAuditFailure(writer, "audit log failure; model catalog refresh aborted")
		return
	}
	result, meta, err := client.RefreshModelCatalogs(request.Context())
	if err != nil {
		code := "catalog_refresh_failed"
		status := http.StatusBadGateway
		message := "CPA model catalog refresh failed"
		if management.IsMissingCapability(err) {
			code = "catalog_refresh_unsupported"
			status = http.StatusNotImplemented
			message = "CPA does not support model catalog refresh"
		}
		h.recordModelCatalogRefreshOutcome(request, "failure", map[string]any{"code": code})
		writeJSON(writer, status, map[string]string{"error": message, "code": code})
		return
	}
	dto := projectModelCatalogRefresh(result, meta.StatusCode)
	outcome := "success"
	status := http.StatusOK
	if !dto.OK {
		outcome = "failure"
		status = http.StatusBadGateway
	}
	h.recordModelCatalogRefreshOutcome(request, outcome, map[string]any{
		"catalogs": dto.Catalogs, "changed_providers": dto.ChangedProviders,
	})
	writeJSON(writer, status, dto)
}

func (h *Handler) recordModelCatalogRefreshOutcome(request *http.Request, outcome string, details map[string]any) {
	// Disconnecting after the POST must not prevent recording its known outcome.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), 5*time.Second)
	defer cancel()
	// CPA may already have published providers. An audit failure cannot undo it
	// and must not invite a duplicate mutation by replacing the refresh result.
	_ = h.recordAudit(request.WithContext(ctx), "model_catalog.refresh", "model_catalog", "all", outcome, details)
}

func projectModelCatalogRefresh(result management.ModelCatalogRefreshResult, upstreamStatus int) modelCatalogRefreshDTO {
	dto := modelCatalogRefreshDTO{
		OK:       result.OK != nil && *result.OK && upstreamStatus == http.StatusOK,
		Catalogs: make([]modelCatalogOutcomeDTO, 0, 3), ChangedProviders: []string{},
	}
	for _, catalog := range []string{"catalog", "codex-catalog", "devin-catalog"} {
		outcome, hasOutcome := result.Catalogs[catalog]
		projected := modelCatalogOutcomeDTO{Catalog: catalog, Status: "error", ChangedProviders: []string{}}
		switch {
		case hasOutcome && outcome.Refreshed && !outcome.Skipped && outcome.Error == "":
			projected.Status = "refreshed"
			projected.ChangedProviders = safeModelCatalogProviders(outcome.ChangedProviders)
		case hasOutcome && outcome.Skipped && !outcome.Refreshed && outcome.Error == "":
			projected.Status = "skipped"
		case hasOutcome && !outcome.Refreshed && !outcome.Skipped && outcome.Error != "":
			projected.ErrorCode = "refresh_failed"
		default:
			projected.ErrorCode = "invalid_response"
		}
		if projected.Status == "error" {
			dto.OK = false
		}
		dto.Catalogs = append(dto.Catalogs, projected)
		dto.ChangedProviders = append(dto.ChangedProviders, projected.ChangedProviders...)
	}
	slices.Sort(dto.ChangedProviders)
	dto.ChangedProviders = slices.Compact(dto.ChangedProviders)
	if !dto.OK {
		dto.Code = "catalog_refresh_failed"
		dto.Error = "CPA model catalog refresh failed"
	}
	return dto
}

func safeModelCatalogProviders(providers []string) []string {
	projected := []string{}
	for _, provider := range providers {
		// These are the finite identifiers CPA's three native catalogs publish,
		// not arbitrary labels from its source document or plugin registry.
		switch provider {
		case "claude", "gemini", "gemini-interactions", "vertex", "aistudio", "codex", "kimi", "kimi-ai", "kimi.ai", "kimi.com", "antigravity", "xai", "devin", "meta":
			projected = append(projected, provider)
		}
	}
	slices.Sort(projected)
	return slices.Compact(projected)
}
