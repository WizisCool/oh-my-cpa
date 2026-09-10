package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"fmt"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type configPutScalarRequest struct {
	Value any `json:"value"`
}

type configSourcePutRequest struct {
	YAML     string `json:"yaml"`
	Revision string `json:"revision,omitempty"`
}

type configGrantRequest struct {
	Password string `json:"password"`
}

func (h *Handler) managementConfigSourceGrant(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.auth == nil {
		writeError(writer, http.StatusServiceUnavailable, "authentication manager is unavailable")
		return
	}
	var payload configGrantRequest
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 8*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || strings.TrimSpace(payload.Password) == "" {
		writeError(writer, http.StatusBadRequest, "management key is required")
		return
	}
	if !h.auth.KeyMatches(payload.Password) {
		writeError(writer, http.StatusUnauthorized, "invalid CPA management key")
		return
	}
	token := uuid.NewString()
	expiresAt := time.Now().Add(5 * time.Minute)
	h.grantMu.Lock()
	h.revealGrants[token] = expiresAt
	h.grantMu.Unlock()

	writeJSON(writer, http.StatusOK, map[string]any{
		"grant_token":        token,
		"expires_in_seconds": 300,
	})
}

func (h *Handler) isGrantValid(token string) bool {
	if strings.TrimSpace(token) == "" {
		return false
	}
	h.grantMu.RLock()
	expiresAt, exists := h.revealGrants[token]
	h.grantMu.RUnlock()
	if !exists || time.Now().After(expiresAt) {
		return false
	}
	return true
}

func (h *Handler) managementConfigGet(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	scalars, err := client.ConfigScalars(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	rawYAML, err := client.ConfigYAML(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	rev := configyaml.ComputeRevision(rawYAML)
	safeYAML, err := configyaml.SanitizeSafeYAML(rawYAML)
	if err != nil {
		safeYAML = ""
	}

	writer.Header().Set("ETag", fmt.Sprintf("%q", rev))
	writeJSON(writer, http.StatusOK, map[string]any{
		"scalars":        scalars,
		"supported_keys": management.KnownScalarKeys(),
		"revision":       rev,
		"safe_yaml":      safeYAML,
	})
}

func (h *Handler) managementConfigPutScalar(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	key := chi.URLParam(request, "key")
	if key == "" {
		writeError(writer, http.StatusBadRequest, "config key is required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	body, err := io.ReadAll(io.LimitReader(request.Body, 64*1024))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "failed to read request body")
		return
	}
	defer request.Body.Close()

	var req configPutScalarRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid json body: "+err.Error())
		return
	}

	validatedVal, err := validateScalarValue(key, req.Value)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}

	if auditErr := h.recordAudit(request, "config.save_scalar", "config", key, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; config save aborted")
		return
	}
	if err := client.UpdateConfigScalar(request.Context(), key, validatedVal); err != nil {
		_ = h.recordAudit(request, "config.save_scalar", "config", key, "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	if auditErr := h.recordAudit(request, "config.save_scalar", "config", key, "success", map[string]any{"key": key}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; operation aborted")
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"key":    key,
		"value":  validatedVal,
	})
}

func validateScalarValue(key string, value any) (any, error) {
	switch key {
	case "debug", "request_log", "logging_to_file", "usage_statistics_enabled", "ws_auth", "force_model_prefix":
		if b, ok := value.(bool); ok {
			return b, nil
		}
		return nil, errors.New("value must be a boolean for key " + key)

	case "proxy_url":
		if s, ok := value.(string); ok {
			return strings.TrimSpace(s), nil
		}
		return nil, errors.New("value must be a string for proxy_url")

	case "request_retry", "max_retry_interval", "max_retry_credentials", "logs_max_total_size_mb", "error_logs_max_files":
		switch num := value.(type) {
		case float64:
			if num < 0 {
				return nil, errors.New("value must be non-negative for key " + key)
			}
			return int64(num), nil
		case int64:
			if num < 0 {
				return nil, errors.New("value must be non-negative for key " + key)
			}
			return num, nil
		case int:
			if num < 0 {
				return nil, errors.New("value must be non-negative for key " + key)
			}
			return int64(num), nil
		default:
			return nil, errors.New("value must be an integer for key " + key)
		}

	case "routing_strategy":
		if s, ok := value.(string); ok {
			trimmed := strings.ToLower(strings.TrimSpace(s))
			if trimmed == "round-robin" || trimmed == "round_robin" || trimmed == "least-load" || trimmed == "least_load" || trimmed == "random" {
				return trimmed, nil
			}
			return nil, errors.New("invalid routing strategy: must be round-robin, least-load, or random")
		}
		return nil, errors.New("value must be a string for routing_strategy")

	default:
		return nil, errors.New("unknown or unsupported config scalar key: " + key)
	}
}

func (h *Handler) managementConfigSourceGet(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	grantToken := strings.TrimSpace(request.Header.Get("X-Reveal-Grant"))
	if !h.isGrantValid(grantToken) {
		writeJSON(writer, http.StatusForbidden, map[string]string{
			"error": "reauthentication required to view raw configuration source",
			"code":  "reauth_required",
		})
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	yamlStr, err := client.ConfigYAML(request.Context())
	if err != nil {
		_ = h.recordAudit(request, "config.reveal_source", "config", "config_source_yaml", "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}
	rev := configyaml.ComputeRevision(yamlStr)
	if auditErr := h.recordAudit(request, "config.reveal_source", "config", "config_source_yaml", "success", map[string]any{"revision": rev, "size_bytes": len(yamlStr)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; config reveal aborted")
		return
	}

	writer.Header().Set("ETag", fmt.Sprintf("%q", rev))
	writeJSON(writer, http.StatusOK, map[string]any{
		"yaml":       yamlStr,
		"size_bytes": len(yamlStr),
		"revision":   rev,
	})
}

func (h *Handler) managementConfigSourcePut(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")

	body, err := io.ReadAll(io.LimitReader(request.Body, 2*1024*1024))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "failed to read request body")
		return
	}
	defer request.Body.Close()

	var req configSourcePutRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid json body: "+err.Error())
		return
	}

	if strings.TrimSpace(req.YAML) == "" {
		writeError(writer, http.StatusBadRequest, "configuration YAML cannot be empty")
		return
	}

	if synErr := configyaml.ValidateSyntax([]byte(req.YAML)); synErr != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"error":  "invalid YAML syntax: " + synErr.Error(),
			"code":   "yaml_syntax_error",
			"line":   synErr.Line,
			"column": synErr.Column,
		})
		return
	}

	expectedRev := strings.Trim(strings.TrimSpace(request.Header.Get("If-Match")), `"`)
	if expectedRev == "" {
		expectedRev = strings.Trim(strings.TrimSpace(req.Revision), `"`)
	}
	if expectedRev == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"error": "config revision or If-Match header is required for conflict protection",
			"code":  "missing_revision",
		})
		return
	}

	h.configMu.Lock()
	defer h.configMu.Unlock()

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	currentYAML, err := client.ConfigYAML(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	currentRev := configyaml.ComputeRevision(currentYAML)
	if !strings.EqualFold(expectedRev, currentRev) {
		writeJSON(writer, http.StatusConflict, map[string]any{
			"error":            "configuration has been modified by another session",
			"code":             "config_conflict",
			"current_revision": currentRev,
		})
		return
	}

	finalYAML, err := configyaml.RestoreSentinels(req.YAML, currentYAML)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "failed to process configuration sentinels: "+err.Error())
		return
	}

	if auditErr := h.recordAudit(request, "config.save_source", "config", "config_source_yaml", "attempt", map[string]any{"revision": expectedRev, "size_bytes": len(finalYAML)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; config save aborted")
		return
	}
	if err := client.UpdateConfigYAML(request.Context(), finalYAML); err != nil {
		_ = h.recordAudit(request, "config.save_source", "config", "config_source_yaml", "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	newRev := configyaml.ComputeRevision(finalYAML)
	if auditErr := h.recordAudit(request, "config.save_source", "config", "config_source_yaml", "success", map[string]any{"revision": newRev, "size_bytes": len(finalYAML)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; operation aborted")
		return
	}

	writer.Header().Set("ETag", fmt.Sprintf("%q", newRev))
	writeJSON(writer, http.StatusOK, map[string]any{
		"status":     "ok",
		"size_bytes": len(finalYAML),
		"revision":   newRev,
	})
}
