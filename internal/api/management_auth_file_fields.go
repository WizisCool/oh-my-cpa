package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func (h *Handler) patchManagementAuthFileFields(writer http.ResponseWriter, request *http.Request) {
	var raw map[string]json.RawMessage
	if err := decodeManagementJSON(writer, request, managementAuthFileRequestLimit, &raw); err != nil {
		return
	}
	nameValue, exists := raw["name"]
	if !exists {
		writeError(writer, http.StatusBadRequest, "name is required")
		return
	}
	var name string
	if err := json.Unmarshal(nameValue, &name); err != nil {
		writeError(writer, http.StatusBadRequest, "name is required")
		return
	}
	validatedName, selectorErr := validateAuthSelector(name)
	if selectorErr != nil {
		writeError(writer, http.StatusBadRequest, selectorErr.Error())
		return
	}
	delete(raw, "name")
	authIndex := ""
	if rawAuthIndex, exists := raw["auth_index"]; exists {
		if err := json.Unmarshal(rawAuthIndex, &authIndex); err != nil {
			writeError(writer, http.StatusBadRequest, "auth_index must be a string")
			return
		}
		authIndex = strings.TrimSpace(authIndex)
		if len([]rune(authIndex)) > managementAuthFileNameLimit {
			writeError(writer, http.StatusBadRequest, "auth_index is too long")
			return
		}
		delete(raw, "auth_index")
	}
	fields, err := normalizeManagementAuthFileFields(raw)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if len(fields) == 0 {
		writeError(writer, http.StatusBadRequest, "no fields to update")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if auditErr := h.recordAudit(request, "auth_file.fields_update", "auth_file", validatedName, "attempt", map[string]any{"fields": sortedMapKeys(fields)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; field update aborted")
		return
	}
	if _, err := client.PatchAuthFileFields(request.Context(), validatedName, fields); err != nil {
		_ = h.recordAudit(request, "auth_file.fields_update", "auth_file", validatedName, "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	// A successful PATCH only says the gateway accepted the request. Read the
	// persisted file and the runtime projection back before answering, so a
	// dropped priority, weight or note cannot be reported as saved.
	safeFields := managementAuthFileSafeFields{Name: validatedName}
	hasSafeReadback := managementAuthFileNeedsSafeReadback(fields)
	if hasSafeReadback {
		var readbackErr error
		safeFields, readbackErr = h.readManagementAuthFileSafeFields(request.Context(), client, validatedName, authIndex)
		if readbackErr != nil {
			_ = h.recordAudit(request, "auth_file.fields_update", "auth_file", validatedName, "failure", map[string]any{"error": "readback failed"})
			writeError(writer, http.StatusBadGateway, "field update could not be verified")
			return
		}
	}
	files, err := client.AuthFiles(request.Context())
	if err != nil {
		_ = h.recordAudit(request, "auth_file.fields_update", "auth_file", validatedName, "failure", map[string]any{"error": "runtime readback failed"})
		writeError(writer, http.StatusBadGateway, "field update could not be verified")
		return
	}
	file, ok := findManagementAuthFile(files.Files, validatedName, authIndex)
	if !ok {
		_ = h.recordAudit(request, "auth_file.fields_update", "auth_file", validatedName, "failure", map[string]any{"error": "record missing after update"})
		writeError(writer, http.StatusBadGateway, "field update could not be verified")
		return
	}
	if mismatch := managementAuthFileFieldMismatch(fields, file, safeFields); mismatch != "" {
		_ = h.recordAudit(request, "auth_file.fields_update", "auth_file", validatedName, "failure", map[string]any{"error": mismatch})
		writeError(writer, http.StatusBadGateway, "CPA did not persist "+mismatch)
		return
	}
	if auditErr := h.recordAudit(request, "auth_file.fields_update", "auth_file", validatedName, "success", map[string]any{"fields": sortedMapKeys(fields), "verified": true}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure after field update")
		return
	}
	payload := map[string]any{
		"status": "ok",
		"file":   projectManagementAuthFile(file),
	}
	// A zero-valued projection would tell the drawer that untouched safe fields
	// are empty, so only a verified readback may be published.
	if hasSafeReadback {
		payload["fields"] = safeFields
	}
	writeJSON(writer, http.StatusOK, payload)
}

func managementAuthFileNeedsSafeReadback(fields map[string]any) bool {
	for key := range fields {
		switch key {
		case "prefix", "proxy_url", "expired", "disable_cooling", "websockets", "using_api", "excluded_models":
			return true
		}
	}
	return false
}

func projectManagementAuthFileSafeFields(name string, data []byte) (managementAuthFileSafeFields, error) {
	var source map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&source); err != nil || source == nil {
		return managementAuthFileSafeFields{}, errors.New("auth file is not a JSON object")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return managementAuthFileSafeFields{}, errors.New("auth file must contain one JSON object")
	}
	fields := managementAuthFileSafeFields{Name: name}
	if priority, ok := source["priority"]; ok {
		parsed := intValue(priority)
		fields.Priority = &parsed
	}
	if weight, ok := source["weight"]; ok {
		parsed := int64Value(weight)
		fields.Weight = &parsed
	}
	fields.Prefix = boundedText(stringValue(source["prefix"]), managementAuthFileFieldLimit)
	fields.ProxyURL = boundedText(stringValue(source["proxy_url"]), managementAuthFileFieldLimit)
	fields.Expired = boundedText(stringValue(source["expired"]), managementAuthFileFieldLimit)
	fields.Note = boundedText(stringValue(source["note"]), managementAuthFileFieldLimit)
	fields.DisableCooling = firstBool(source, "disable_cooling", "disable-cooling")
	fields.Websockets = boolValue(source["websockets"])
	fields.UsingAPI = firstBool(source, "using_api", "using-api")
	fields.ExcludedModels = projectExcludedModels(source)
	return fields, nil
}

func managementAuthFileFieldMismatch(requested map[string]any, file management.AuthFile, safe managementAuthFileSafeFields) string {
	for key, raw := range requested {
		switch key {
		case "prefix":
			if stringValue(raw) != safe.Prefix {
				return "prefix"
			}
		case "proxy_url":
			if stringValue(raw) != safe.ProxyURL {
				return "proxy_url"
			}
		case "expired":
			if stringValue(raw) != safe.Expired {
				return "expired"
			}
		case "disable_cooling":
			if boolValue(raw) != safe.DisableCooling {
				return "disable_cooling"
			}
		case "websockets":
			if boolValue(raw) != safe.Websockets {
				return "websockets"
			}
		case "using_api":
			if boolValue(raw) != safe.UsingAPI {
				return "using_api"
			}
		case "excluded_models":
			if !equalStringSlices(stringSliceValue(raw), safe.ExcludedModels) {
				return "excluded_models"
			}
		case "priority":
			if intValue(raw) != file.Priority {
				return "priority"
			}
		case "weight":
			if int64Value(raw) != file.Weight {
				return "weight"
			}
		case "note":
			if stringValue(raw) != boundedText(file.Note, managementAuthFileFieldLimit) {
				return "note"
			}
		}
	}
	return ""
}

func projectExcludedModels(source map[string]any) []string {
	raw, ok := source["excluded_models"]
	if !ok {
		raw = source["excluded-models"]
	}
	values := stringSliceValue(raw)
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = boundedText(value, managementAuthFileFieldLimit)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func normalizeManagementAuthFileFields(raw map[string]json.RawMessage) (map[string]any, error) {
	allowed := map[string]string{
		"prefix":          "prefix",
		"proxy_url":       "proxy_url",
		"proxy-url":       "proxy_url",
		"headers":         "headers",
		"priority":        "priority",
		"weight":          "weight",
		"disable_cooling": "disable_cooling",
		"disable-cooling": "disable_cooling",
		"websockets":      "websockets",
		"using_api":       "using_api",
		"using-api":       "using_api",
		"note":            "note",
		"excluded_models": "excluded_models",
		"excluded-models": "excluded_models",
		"expired":         "expired",
	}
	fields := make(map[string]any, len(raw))
	seen := make(map[string]string, len(raw))
	for key, value := range raw {
		canonical, ok := allowed[strings.TrimSpace(key)]
		if !ok {
			return nil, fmt.Errorf("field %q is not allowed", key)
		}
		if previous, exists := seen[canonical]; exists {
			return nil, fmt.Errorf("fields %q and %q refer to the same field", previous, key)
		}
		seen[canonical] = key
		decoded, err := decodeManagementValue(value)
		if err != nil {
			return nil, fmt.Errorf("invalid field %q", key)
		}
		if err := validateManagementAuthFileField(canonical, decoded); err != nil {
			return nil, err
		}
		normalized, err := normalizeManagementAuthFileField(canonical, decoded)
		if err != nil {
			return nil, err
		}
		fields[canonical] = normalized
	}
	return fields, nil
}

func normalizeManagementAuthFileField(name string, value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	switch name {
	case "prefix", "proxy_url", "note":
		return strings.TrimSpace(value.(string)), nil
	case "priority":
		number, err := numberInt64(value)
		if err != nil || number < -9007199254740991 || number > 9007199254740991 {
			return nil, fmt.Errorf("field %q must be a safe integer", name)
		}
		return json.Number(strconv.FormatInt(number, 10)), nil
	case "weight":
		number, err := numberInt64(value)
		if err != nil {
			return nil, fmt.Errorf("field %q must be an integer", name)
		}
		if number <= 0 {
			number = 0
		}
		if number > 1_000_000 {
			return nil, fmt.Errorf("field %q must not exceed 1000000", name)
		}
		return json.Number(strconv.FormatInt(number, 10)), nil
	case "excluded_models":
		raw := value.([]any)
		seen := make(map[string]struct{}, len(raw))
		models := make([]string, 0, len(raw))
		for _, item := range raw {
			model := strings.TrimSpace(item.(string))
			if model == "" {
				continue
			}
			key := strings.ToLower(model)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			models = append(models, model)
		}
		return models, nil
	default:
		return value, nil
	}
}

func validateManagementAuthFileField(name string, value any) error {
	if value == nil {
		switch name {
		case "prefix", "proxy_url", "headers", "priority", "weight", "note", "expired":
			return nil
		default:
			return fmt.Errorf("field %q cannot be null", name)
		}
	}
	switch name {
	case "prefix", "proxy_url", "note", "expired":
		text, ok := value.(string)
		if !ok || len([]rune(text)) > managementAuthFileFieldLimit {
			return fmt.Errorf("field %q must be a short string", name)
		}
	case "priority", "weight":
		number, ok := value.(json.Number)
		if !ok {
			return fmt.Errorf("field %q must be an integer", name)
		}
		if _, err := number.Int64(); err != nil {
			return fmt.Errorf("field %q must be an integer", name)
		}
	case "disable_cooling", "websockets", "using_api":
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("field %q must be boolean", name)
		}
	case "headers":
		headers, ok := value.(map[string]any)
		if !ok || len(headers) > 64 {
			return errors.New("headers must be an object with at most 64 entries")
		}
		for key, headerValue := range headers {
			text, ok := headerValue.(string)
			if !ok || len([]rune(key)) > 256 || len([]rune(text)) > managementAuthFileFieldLimit {
				return errors.New("headers must contain short string keys and values")
			}
		}
	case "excluded_models":
		models, ok := value.([]any)
		if !ok || len(models) > 256 {
			return errors.New("excluded_models must be an array of at most 256 strings")
		}
		for _, model := range models {
			text, ok := model.(string)
			if !ok || len([]rune(text)) > managementAuthFileFieldLimit {
				return errors.New("excluded_models must contain short strings")
			}
		}
	}
	return nil
}
