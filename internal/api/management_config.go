package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type configPutScalarRequest struct {
	Value any `json:"value"`
}

type configSourcePutRequest struct {
	YAML string `json:"yaml"`
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

	writeJSON(writer, http.StatusOK, map[string]any{
		"scalars":        scalars,
		"supported_keys": management.KnownScalarKeys(),
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

	if err := client.UpdateConfigScalar(request.Context(), key, validatedVal); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"key":    key,
		"value":  validatedVal,
	})
}

func validateScalarValue(key string, val any) (any, error) {
	switch key {
	case "debug", "request_log", "logging_to_file", "usage_statistics_enabled", "ws_auth", "force_model_prefix":
		if b, ok := val.(bool); ok {
			return b, nil
		}
		return nil, errors.New("value must be a boolean for key " + key)

	case "proxy_url":
		if s, ok := val.(string); ok {
			return strings.TrimSpace(s), nil
		}
		return nil, errors.New("value must be a string for proxy_url")

	case "request_retry", "max_retry_interval", "max_retry_credentials", "logs_max_total_size_mb", "error_logs_max_files":
		switch num := val.(type) {
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
		if s, ok := val.(string); ok {
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
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	yamlStr, err := client.ConfigYAML(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"yaml":       yamlStr,
		"size_bytes": len(yamlStr),
	})
}

func (h *Handler) managementConfigSourcePut(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

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

	if err := client.UpdateConfigYAML(request.Context(), req.YAML); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":     "ok",
		"size_bytes": len(req.YAML),
	})
}
