package api

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

type capabilityEndpointCheck struct {
	Name     string
	Endpoint string
}

// capabilityCheckCatalog maps known UI capability keys to their safe, read-only
// CPA probe endpoints. This is a strict compile-time whitelist: arbitrary CPA
// paths can never be requested through this probe facade.
var capabilityCheckCatalog = map[string][]capabilityEndpointCheck{
	"quick-start": {
		{Name: "config", Endpoint: "/config"},
		{Name: "api_keys", Endpoint: "/api-keys"},
	},
	"ai-providers": {
		{Name: "config", Endpoint: "/config"},
		{Name: "codex_api_key", Endpoint: "/codex-api-key"},
		{Name: "openai_compatibility", Endpoint: "/openai-compatibility"},
		{Name: "claude_api_key", Endpoint: "/claude-api-key"},
		{Name: "gemini_api_key", Endpoint: "/gemini-api-key"},
	},
	"oauth": {
		{Name: "oauth_excluded_models", Endpoint: "/oauth-excluded-models"},
		{Name: "auth_status", Endpoint: "/get-auth-status"},
	},
	"quota": {
		{Name: "auth_files", Endpoint: "/auth-files"},
	},
	"config": {
		{Name: "config_json", Endpoint: "/config"},
		{Name: "config_yaml", Endpoint: "/config.yaml"},
	},
	"plugins": {
		{Name: "plugins", Endpoint: "/plugins"},
	},
	"plugin-store": {
		{Name: "plugin_store", Endpoint: "/plugin-store"},
	},
	"system": {
		{Name: "latest_version", Endpoint: "/latest-version"},
		{Name: "auth_files", Endpoint: "/auth-files"},
	},
}

// CapabilityCheckItem represents one probed endpoint check.
type CapabilityCheckItem struct {
	Name       string `json:"name"`
	Endpoint   string `json:"endpoint"`
	Status     string `json:"status"` // "supported", "missing", "offline", "error"
	HTTPStatus int    `json:"http_status"`
	LatencyMs  int64  `json:"latency_ms"`
	Message    string `json:"message,omitempty"`
}

// CapabilityProbeReport represents the overall probe outcome for a feature slice.
type CapabilityProbeReport struct {
	Key        string                `json:"key"`
	Status     string                `json:"status"` // "supported", "partial", "missing", "offline", "error", "not_probeable"
	Checks     []CapabilityCheckItem `json:"checks"`
	ProbedAtMs int64                 `json:"probed_at_ms"`
}

func (h *Handler) managementCapabilityProbe(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	key := chi.URLParam(request, "key")
	checks, found := capabilityCheckCatalog[key]
	if !found {
		writeError(writer, http.StatusNotFound, "unknown capability key")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()

	results := make([]CapabilityCheckItem, len(checks))
	var wg sync.WaitGroup

	for i, checkDef := range checks {
		wg.Add(1)
		go func(idx int, chk capabilityEndpointCheck) {
			defer wg.Done()
			probe := client.ProbeEndpoint(ctx, chk.Endpoint)
			results[idx] = CapabilityCheckItem{
				Name:       chk.Name,
				Endpoint:   "/v0/management" + chk.Endpoint,
				Status:     probe.Status,
				HTTPStatus: probe.StatusCode,
				LatencyMs:  probe.LatencyMs,
				Message:    probe.Error,
			}
		}(i, checkDef)
	}
	wg.Wait()

	report := CapabilityProbeReport{
		Key:        key,
		Status:     computeOverallCapabilityStatus(results),
		Checks:     results,
		ProbedAtMs: time.Now().UnixMilli(),
	}

	writeJSON(writer, http.StatusOK, report)
}

func computeOverallCapabilityStatus(checks []CapabilityCheckItem) string {
	if len(checks) == 0 {
		return "not_probeable"
	}
	supportedCount := 0
	missingCount := 0
	offlineCount := 0
	errorCount := 0

	for _, c := range checks {
		switch c.Status {
		case "supported":
			supportedCount++
		case "missing":
			missingCount++
		case "offline":
			offlineCount++
		case "error":
			errorCount++
		}
	}

	if supportedCount == len(checks) {
		return "supported"
	}
	if missingCount == len(checks) {
		return "missing"
	}
	if offlineCount == len(checks) {
		return "offline"
	}
	if supportedCount > 0 {
		return "partial"
	}
	if offlineCount > 0 {
		return "offline"
	}
	return "error"
}
