package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

const (
	managementAuthFileRequestLimit = 256 * 1024
	managementAuthFileUploadLimit  = 16 * 1024 * 1024
	managementAuthFileNameLimit    = 255
	managementAuthFileListLimit    = 2000
	managementAuthFileFieldLimit   = 4096
)

var errManagementAuthFileNotFound = errors.New("auth file not found")

// The auth-files facade deliberately projects CPA entries into a browser-safe
// shape. Account, path, token, metadata, and other credential-bearing fields
// are not part of this DTO; downloads are a separate, explicit admin action.
type managementAuthFileResponse struct {
	Name           string                                `json:"name"`
	AuthIndex      string                                `json:"auth_index,omitempty"`
	Type           string                                `json:"type,omitempty"`
	Provider       string                                `json:"provider,omitempty"`
	Status         string                                `json:"status,omitempty"`
	StatusMessage  string                                `json:"status_message,omitempty"`
	Disabled       bool                                  `json:"disabled"`
	Unavailable    bool                                  `json:"unavailable"`
	RuntimeOnly    bool                                  `json:"runtime_only"`
	Email          string                                `json:"email,omitempty"`
	ProjectID      string                                `json:"project_id,omitempty"`
	Success        int64                                 `json:"success"`
	Failed         int64                                 `json:"failed"`
	RecentRequests []managementAuthFileRequestBucket     `json:"recent_requests,omitempty"`
	Quota          *managementQuotaObservation           `json:"quota,omitempty"`
	ModelQuotas    map[string]managementQuotaObservation `json:"model_quotas,omitempty"`
	Models         []managementAuthFileModel             `json:"models,omitempty"`
	Priority       int                                   `json:"priority,omitempty"`
	Weight         int64                                 `json:"weight,omitempty"`
	Note           string                                `json:"note,omitempty"`
}

type managementAuthFileRequestBucket struct {
	Time    string `json:"time,omitempty"`
	Success int64  `json:"success"`
	Failed  int64  `json:"failed"`
}

type managementAuthFileModel struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name,omitempty"`
}

type managementQuotaObservation struct {
	ObservedAt string            `json:"observed_at,omitempty"`
	Signals    map[string]string `json:"signals,omitempty"`
}

type managementAuthFilesResponse struct {
	Files []managementAuthFileResponse `json:"files"`
	Total int                          `json:"total"`
}

// managementAuthFileSafeFields is the allowlisted subset of an auth file that
// the edit drawer may read. The raw file is downloaded only inside the Go
// process; credentials, tokens and free-form metadata never enter the response.
type managementAuthFileSafeFields struct {
	Name           string   `json:"name"`
	Priority       *int     `json:"priority,omitempty"`
	Weight         *int64   `json:"weight,omitempty"`
	Prefix         string   `json:"prefix,omitempty"`
	ProxyURL       string   `json:"proxy_url,omitempty"`
	Expired        string   `json:"expired,omitempty"`
	DisableCooling bool     `json:"disable_cooling"`
	Websockets     bool     `json:"websockets"`
	UsingAPI       bool     `json:"using_api"`
	Note           string   `json:"note,omitempty"`
	ExcludedModels []string `json:"excluded_models,omitempty"`
}

func (h *Handler) listManagementAuthFiles(writer http.ResponseWriter, request *http.Request) {
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	files, err := client.AuthFiles(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	nameFilter := strings.TrimSpace(request.URL.Query().Get("name"))
	authIndexFilter := strings.TrimSpace(request.URL.Query().Get("auth_index"))
	projected := make([]managementAuthFileResponse, 0, len(files.Files))
	for _, file := range files.Files {
		if nameFilter != "" && file.Name != nameFilter && file.ID != nameFilter {
			continue
		}
		if authIndexFilter != "" && file.AuthIndex != authIndexFilter {
			continue
		}
		projected = append(projected, projectManagementAuthFile(file))
		if len(projected) >= managementAuthFileListLimit {
			break
		}
	}
	sort.Slice(projected, func(i, j int) bool {
		return strings.ToLower(projected[i].Name) < strings.ToLower(projected[j].Name)
	})
	writeJSON(writer, http.StatusOK, managementAuthFilesResponse{Files: projected, Total: len(projected)})
}

func (h *Handler) patchManagementAuthFileStatus(writer http.ResponseWriter, request *http.Request) {
	var payload struct {
		Name      string `json:"name"`
		AuthIndex string `json:"auth_index"`
		Disabled  *bool  `json:"disabled"`
	}
	if err := decodeManagementJSON(writer, request, managementAuthFileRequestLimit, &payload); err != nil {
		return
	}
	name, selectorErr := validateAuthSelector(payload.Name)
	if selectorErr != nil {
		writeError(writer, http.StatusBadRequest, selectorErr.Error())
		return
	}
	if payload.Disabled == nil {
		writeError(writer, http.StatusBadRequest, "disabled is required")
		return
	}
	if len(payload.AuthIndex) > managementAuthFileNameLimit {
		writeError(writer, http.StatusBadRequest, "auth_index is too long")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if _, err := client.PatchAuthFileStatus(request.Context(), name, strings.TrimSpace(payload.AuthIndex), *payload.Disabled); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "disabled": *payload.Disabled})
}

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
	if managementAuthFileNeedsSafeReadback(fields) {
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
	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"file":   projectManagementAuthFile(file),
		"fields": safeFields,
	})
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

func (h *Handler) getManagementAuthFileSafeFields(writer http.ResponseWriter, request *http.Request) {
	name, selectorErr := validateAuthSelector(request.URL.Query().Get("name"))
	if selectorErr != nil {
		writeError(writer, http.StatusBadRequest, selectorErr.Error())
		return
	}
	authIndex := strings.TrimSpace(request.URL.Query().Get("auth_index"))
	if len([]rune(authIndex)) > managementAuthFileNameLimit {
		writeError(writer, http.StatusBadRequest, "auth_index is too long")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	fields, err := h.readManagementAuthFileSafeFields(request.Context(), client, name, authIndex)
	if err != nil {
		_ = h.recordAudit(request, "auth_file.fields_read", "auth_file", name, "failure", map[string]any{"error": err.Error()})
		if errors.Is(err, errManagementAuthFileNotFound) {
			writeError(writer, http.StatusNotFound, "auth file not found")
			return
		}
		writeCPAFacadeError(writer, err)
		return
	}
	if auditErr := h.recordAudit(request, "auth_file.fields_read", "auth_file", name, "success", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; safe fields were not returned")
		return
	}
	writeJSON(writer, http.StatusOK, fields)
}

func (h *Handler) readManagementAuthFileSafeFields(ctx context.Context, client *management.Client, name, authIndex string) (managementAuthFileSafeFields, error) {
	if _, err := findManagementAuthFileFromClient(ctx, client, name, authIndex); err != nil {
		return managementAuthFileSafeFields{}, err
	}
	data, _, err := client.DownloadAuthFile(ctx, name)
	if err != nil {
		return managementAuthFileSafeFields{}, err
	}
	return projectManagementAuthFileSafeFields(name, data)
}

func findManagementAuthFileFromClient(ctx context.Context, client *management.Client, name, authIndex string) (management.AuthFile, error) {
	files, err := client.AuthFiles(ctx)
	if err != nil {
		return management.AuthFile{}, err
	}
	file, ok := findManagementAuthFile(files.Files, name, authIndex)
	if !ok {
		return management.AuthFile{}, errManagementAuthFileNotFound
	}
	return file, nil
}

func findManagementAuthFile(files []management.AuthFile, name, authIndex string) (management.AuthFile, bool) {
	name = strings.TrimSpace(name)
	authIndex = strings.TrimSpace(authIndex)
	for _, file := range files {
		if file.Name != name && file.ID != name {
			continue
		}
		if authIndex != "" && file.AuthIndex != authIndex {
			continue
		}
		return file, true
	}
	return management.AuthFile{}, false
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

func sortedMapKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func boolValue(value any) bool {
	flag, _ := value.(bool)
	return flag
}

func firstBool(source map[string]any, keys ...string) bool {
	for _, key := range keys {
		if value, ok := source[key]; ok {
			return boolValue(value)
		}
	}
	return false
}

func intValue(value any) int {
	switch typed := value.(type) {
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	case float64:
		return int(typed)
	case int:
		return typed
	case int64:
		return int(typed)
	default:
		return 0
	}
}

func int64Value(value any) int64 {
	switch typed := value.(type) {
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	default:
		return 0
	}
}

func stringSliceValue(value any) []string {
	if typed, ok := value.([]string); ok {
		return typed
	}
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			result = append(result, strings.TrimSpace(text))
		}
	}
	return result
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

func equalStringSlices(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if strings.TrimSpace(left[index]) != strings.TrimSpace(right[index]) {
			return false
		}
	}
	return true
}

func (h *Handler) uploadManagementAuthFiles(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, managementAuthFileUploadLimit)
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	if strings.HasPrefix(strings.ToLower(request.Header.Get("Content-Type")), "multipart/form-data") {
		if err := request.ParseMultipartForm(2 * 1024 * 1024); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid multipart form")
			return
		}
		files := make([]*multipartFileHeader, 0)
		for key, headers := range request.MultipartForm.File {
			if key != "file" && key != "files" {
				continue
			}
			for _, header := range headers {
				files = append(files, &multipartFileHeader{filename: header.Filename, open: header.Open})
			}
		}
		if len(files) == 0 {
			writeError(writer, http.StatusBadRequest, "no files uploaded")
			return
		}
		if len(files) > 100 {
			writeError(writer, http.StatusBadRequest, "too many files")
			return
		}
		h.handleUploadResults(writer, request.Context(), client, files)
		return
	}

	name, validationErr := validateJSONUploadName(request.URL.Query().Get("name"))
	if validationErr != nil {
		writeError(writer, http.StatusBadRequest, validationErr.Error())
		return
	}
	data, err := io.ReadAll(io.LimitReader(request.Body, managementAuthFileUploadLimit+1))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "cannot read upload")
		return
	}
	if int64(len(data)) > managementAuthFileUploadLimit {
		writeError(writer, http.StatusRequestEntityTooLarge, "upload is too large")
		return
	}
	if err := validateAuthJSON(data); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := client.UploadAuthFile(request.Context(), name, data); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "uploaded": 1, "files": []string{name}})
}

type multipartFileHeader struct {
	filename string
	open     func() (multipart.File, error)
}

func (h *Handler) handleUploadResults(writer http.ResponseWriter, ctx context.Context, client *management.Client, files []*multipartFileHeader) {
	uploaded := make([]string, 0, len(files))
	failed := make([]map[string]string, 0)
	for _, file := range files {
		name, uploadNameErr := validateJSONUploadName(file.filename)
		if uploadNameErr != nil {
			failed = append(failed, map[string]string{"name": filepath.Base(file.filename), "error": uploadNameErr.Error()})
			continue
		}
		source, err := file.open()
		if err != nil {
			failed = append(failed, map[string]string{"name": name, "error": "cannot open upload"})
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(source, managementAuthFileUploadLimit+1))
		_ = source.Close()
		if readErr != nil || int64(len(data)) > managementAuthFileUploadLimit {
			failed = append(failed, map[string]string{"name": name, "error": "upload is too large or unreadable"})
			continue
		}
		if jsonErr := validateAuthJSON(data); jsonErr != nil {
			failed = append(failed, map[string]string{"name": name, "error": jsonErr.Error()})
			continue
		}
		if _, uploadErr := client.UploadAuthFile(ctx, name, data); uploadErr != nil {
			failed = append(failed, map[string]string{"name": name, "error": publicCPAErrorMessage(uploadErr)})
			continue
		}
		uploaded = append(uploaded, name)
	}
	if len(uploaded) > 0 && h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	if len(failed) > 0 {
		status := http.StatusMultiStatus
		writeJSON(writer, status, map[string]any{"status": "partial", "uploaded": len(uploaded), "files": uploaded, "failed": failed})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "uploaded": len(uploaded), "files": uploaded})
}

func (h *Handler) deleteManagementAuthFiles(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, managementAuthFileRequestLimit)
	names := make([]string, 0)
	if queryNames := request.URL.Query()["name"]; len(queryNames) > 0 {
		names = append(names, queryNames...)
	} else {
		var payload struct {
			Name  string   `json:"name"`
			Names []string `json:"names"`
		}
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil && !errors.Is(err, io.EOF) {
			writeError(writer, http.StatusBadRequest, "invalid request body")
			return
		}
		if strings.TrimSpace(payload.Name) != "" {
			names = append(names, payload.Name)
		}
		names = append(names, payload.Names...)
	}
	if len(names) == 0 || len(names) > 100 {
		writeError(writer, http.StatusBadRequest, "one to one hundred names are required")
		return
	}
	unique := make([]string, 0, len(names))
	seen := make(map[string]struct{}, len(names))
	for _, rawName := range names {
		name, selectorErr := validateAuthSelector(rawName)
		if selectorErr != nil {
			writeError(writer, http.StatusBadRequest, selectorErr.Error())
			return
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		unique = append(unique, name)
	}
	if auditErr := h.recordAudit(request, "auth_file.delete", "auth_file", strings.Join(unique, ","), "attempt", map[string]any{"count": len(unique)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; deletion aborted")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	cpaResp, err := client.DeleteAuthFiles(request.Context(), unique)
	if err != nil {
		_ = h.recordAudit(request, "auth_file.delete", "auth_file", strings.Join(unique, ","), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	confirmedDeleted, normalizedFailures, outcomeStatus := normalizeDeleteResponse(unique, cpaResp)

	auditOutcome := "success"
	if outcomeStatus == "partial" {
		auditOutcome = "partial"
	} else if outcomeStatus == "failure" {
		auditOutcome = "failure"
	}

	if auditErr := h.recordAudit(request, "auth_file.delete", "auth_file", strings.Join(unique, ","), auditOutcome, map[string]any{"deleted": len(confirmedDeleted), "failed_count": len(normalizedFailures)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure after deletion")
		return
	}

	if len(confirmedDeleted) > 0 && h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}

	if outcomeStatus != "ok" {
		writeJSON(writer, http.StatusMultiStatus, map[string]any{
			"status":  outcomeStatus,
			"deleted": len(confirmedDeleted),
			"files":   confirmedDeleted,
			"failed":  normalizedFailures,
		})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "deleted": len(confirmedDeleted), "files": confirmedDeleted})
}

type authFileDeleteFailureItem struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

func sanitizeDeleteError(raw string) string {
	lower := strings.ToLower(raw)
	switch {
	case strings.Contains(lower, "not found") || strings.Contains(lower, "no such"):
		return "file not found"
	case strings.Contains(lower, "permission") || strings.Contains(lower, "denied"):
		return "permission denied"
	case strings.Contains(lower, "in use") || strings.Contains(lower, "busy"):
		return "file in use"
	default:
		return "deletion failed"
	}
}

func normalizeDeleteResponse(requested []string, cpaResp map[string]any) ([]string, []authFileDeleteFailureItem, string) {
	requestedSet := make(map[string]bool, len(requested))
	for _, name := range requested {
		requestedSet[name] = true
	}

	seenFailed := make(map[string]bool)
	failures := make([]authFileDeleteFailureItem, 0)

	if rawFailed, ok := cpaResp["failed"].([]any); ok {
		for _, item := range rawFailed {
			record, isMap := item.(map[string]any)
			if !isMap {
				continue
			}
			rawName, _ := record["name"].(string)
			if !requestedSet[rawName] || seenFailed[rawName] {
				continue
			}
			rawErr, _ := record["error"].(string)
			if rawErr == "" {
				rawErr, _ = record["message"].(string)
			}
			failures = append(failures, authFileDeleteFailureItem{
				Name:  rawName,
				Error: sanitizeDeleteError(rawErr),
			})
			seenFailed[rawName] = true
		}
	}

	seenSuccess := make(map[string]bool)
	confirmedDeleted := make([]string, 0, len(requested))

	_, hasFiles := cpaResp["files"]
	_, hasFailed := cpaResp["failed"]
	_, hasDeleted := cpaResp["deleted"]

	if rawFiles, ok := cpaResp["files"].([]any); ok {
		for _, item := range rawFiles {
			rawName, isStr := item.(string)
			if !isStr || !requestedSet[rawName] || seenSuccess[rawName] || seenFailed[rawName] {
				continue
			}
			confirmedDeleted = append(confirmedDeleted, rawName)
			seenSuccess[rawName] = true
		}
	} else if len(requested) == 1 && !hasFiles && !hasFailed && !hasDeleted {
		// Documented CPA single-file contract: returns {"status": "ok"} without files/failed/deleted keys
		name := requested[0]
		if status, isStr := cpaResp["status"].(string); isStr && (status == "ok" || status == "success") {
			confirmedDeleted = append(confirmedDeleted, name)
			seenSuccess[name] = true
		}
	}

	if hasDeleted {
		var upstreamDeletedCount int64 = -1
		if dFloat, ok := cpaResp["deleted"].(float64); ok && dFloat >= 0 {
			upstreamDeletedCount = int64(dFloat)
		} else if dInt, ok := cpaResp["deleted"].(int); ok && dInt >= 0 {
			upstreamDeletedCount = int64(dInt)
		} else if dInt64, ok := cpaResp["deleted"].(int64); ok && dInt64 >= 0 {
			upstreamDeletedCount = dInt64
		} else if dNum, ok := cpaResp["deleted"].(json.Number); ok {
			if parsed, err := dNum.Int64(); err == nil && parsed >= 0 {
				upstreamDeletedCount = parsed
			}
		}

		// If upstream explicitly reports deleted == 0, contradiction overrides success
		if upstreamDeletedCount == 0 && len(confirmedDeleted) > 0 {
			for _, name := range confirmedDeleted {
				failures = append(failures, authFileDeleteFailureItem{
					Name:  name,
					Error: "deletion unconfirmed by upstream",
				})
				seenFailed[name] = true
			}
			confirmedDeleted = confirmedDeleted[:0]
			seenSuccess = make(map[string]bool)
		}
	}

	// A file CPA neither confirmed deleted nor reported as failed is unconfirmed;
	// reporting it as success would let a partial upstream delete look complete.
	for _, name := range requested {
		if !seenSuccess[name] && !seenFailed[name] {
			failures = append(failures, authFileDeleteFailureItem{
				Name:  name,
				Error: "deletion unconfirmed by upstream",
			})
			seenFailed[name] = true
		}
	}

	if len(confirmedDeleted) == len(requested) && len(failures) == 0 {
		return confirmedDeleted, failures, "ok"
	}
	if len(confirmedDeleted) == 0 {
		return confirmedDeleted, failures, "failure"
	}
	return confirmedDeleted, failures, "partial"
}

func (h *Handler) downloadManagementAuthFile(writer http.ResponseWriter, request *http.Request) {
	name, validationErr := validateJSONUploadName(request.URL.Query().Get("name"))
	if validationErr != nil {
		writeError(writer, http.StatusBadRequest, validationErr.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	data, _, err := client.DownloadAuthFile(request.Context(), name)
	if err != nil {
		_ = h.recordAudit(request, "auth_file.download", "auth_file", name, "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}
	if auditErr := h.recordAudit(request, "auth_file.download", "auth_file", name, "success", map[string]any{"size_bytes": len(data)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; download aborted")
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(data)
}

func (h *Handler) listManagementAuthFileModels(writer http.ResponseWriter, request *http.Request) {
	name, selectorErr := validateAuthSelector(request.URL.Query().Get("name"))
	if selectorErr != nil {
		writeError(writer, http.StatusBadRequest, selectorErr.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	models, err := client.AuthFileModels(request.Context(), name)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	projected := make([]managementAuthFileModel, 0, len(models))
	for _, model := range models {
		id := boundedText(model.ID, managementAuthFileFieldLimit)
		if id == "" {
			continue
		}
		projected = append(projected, managementAuthFileModel{ID: id, DisplayName: boundedText(model.DisplayName, managementAuthFileFieldLimit)})
		if len(projected) >= managementAuthFileListLimit {
			break
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"models": projected})
}

func (h *Handler) managementClientOrError(writer http.ResponseWriter, request *http.Request) (*management.Client, bool) {
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), sql.ErrNoRows.Error()) {
			writeError(writer, http.StatusServiceUnavailable, "default CPA instance is not configured")
			return nil, false
		}
		writeInternalError(writer, err)
		return nil, false
	}
	client, err := h.clientForInstance(request.Context(), instance)
	if err != nil {
		writeInternalError(writer, err)
		return nil, false
	}
	return client, true
}

func writeCPAFacadeError(writer http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	code := "cpa_unavailable"
	message := "CPA management request failed"
	var httpErr *management.HTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.StatusCode {
		case http.StatusNotFound, http.StatusMethodNotAllowed:
			status = http.StatusNotImplemented
			code = "capability_missing"
			message = "CPA does not support this management operation"
		case http.StatusUnauthorized, http.StatusForbidden:
			status = http.StatusBadGateway
			code = "cpa_authentication_failed"
			message = "CPA management authentication failed"
		case http.StatusBadRequest, http.StatusUnprocessableEntity:
			status = http.StatusBadGateway
			code = "cpa_rejected_request"
			message = "CPA rejected the management request"
			if httpErr.Body != "" {
				var cpaErr struct {
					Error string `json:"error"`
				}
				if errJson := json.Unmarshal([]byte(httpErr.Body), &cpaErr); errJson == nil && cpaErr.Error != "" {
					message = fmt.Sprintf("CPA rejected the management request: %s", cpaErr.Error)
				}
			}
		}
	}
	writeJSON(writer, status, map[string]string{"error": message, "code": code})
}

func publicCPAErrorMessage(err error) string {
	var httpErr *management.HTTPError
	if errors.As(err, &httpErr) {
		if httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusMethodNotAllowed {
			return "CPA does not support this operation"
		}
		return fmt.Sprintf("CPA returned HTTP %d", httpErr.StatusCode)
	}
	return "CPA management request failed"
}

func projectManagementAuthFile(file management.AuthFile) managementAuthFileResponse {
	result := managementAuthFileResponse{
		Name:          boundedText(firstNonEmpty(file.Name, file.ID), managementAuthFileNameLimit),
		AuthIndex:     boundedText(file.AuthIndex, managementAuthFileNameLimit),
		Type:          boundedText(firstNonEmpty(file.Type, file.Provider), managementAuthFileFieldLimit),
		Provider:      boundedText(file.Provider, managementAuthFileFieldLimit),
		Status:        boundedText(file.Status, managementAuthFileFieldLimit),
		StatusMessage: boundedText(file.StatusMessage, managementAuthFileFieldLimit),
		Disabled:      file.Disabled,
		Unavailable:   file.Unavailable,
		RuntimeOnly:   file.RuntimeOnly,
		Email:         boundedText(file.Email, managementAuthFileFieldLimit),
		ProjectID:     boundedText(file.ProjectID, managementAuthFileFieldLimit),
		Success:       nonNegative(file.Success),
		Failed:        nonNegative(file.Failed),
		Priority:      file.Priority,
		Weight:        file.Weight,
		Note:          boundedText(file.Note, managementAuthFileFieldLimit),
		Models:        projectAuthModels(file.Models),
		Quota:         projectQuota(file.Quota),
		ModelQuotas:   projectModelQuotas(file.ModelQuotas),
	}
	for _, bucket := range file.RecentRequests {
		if len(result.RecentRequests) >= managementOverviewBucketCount {
			break
		}
		result.RecentRequests = append(result.RecentRequests, managementAuthFileRequestBucket{
			Time:    boundedText(bucket.Time, managementAuthFileFieldLimit),
			Success: nonNegative(bucket.Success),
			Failed:  nonNegative(bucket.Failed),
		})
	}
	return result
}

func projectAuthModels(models []management.AuthModel) []managementAuthFileModel {
	result := make([]managementAuthFileModel, 0, len(models))
	for _, model := range models {
		id := boundedText(model.ID, managementAuthFileFieldLimit)
		if id == "" {
			continue
		}
		result = append(result, managementAuthFileModel{ID: id, DisplayName: boundedText(model.DisplayName, managementAuthFileFieldLimit)})
		if len(result) >= managementOverviewBucketCount*managementOverviewBucketCount {
			break
		}
	}
	return result
}

func projectQuota(raw map[string]any) *managementQuotaObservation {
	if len(raw) == 0 {
		return nil
	}
	result := &managementQuotaObservation{Signals: map[string]string{}}
	if value, ok := raw["observed_at"]; ok {
		result.ObservedAt = boundedText(fmt.Sprint(value), managementAuthFileFieldLimit)
	}
	if signals, ok := raw["signals"].(map[string]any); ok {
		for key, value := range signals {
			if len(result.Signals) >= 64 {
				break
			}
			key = boundedText(key, 128)
			if key == "" {
				continue
			}
			result.Signals[key] = boundedText(fmt.Sprint(value), managementAuthFileFieldLimit)
		}
	}
	if result.ObservedAt == "" && len(result.Signals) == 0 {
		return nil
	}
	if len(result.Signals) == 0 {
		result.Signals = nil
	}
	return result
}

func projectModelQuotas(raw map[string]map[string]any) map[string]managementQuotaObservation {
	if len(raw) == 0 {
		return nil
	}
	result := make(map[string]managementQuotaObservation)
	for model, value := range raw {
		model = boundedText(model, managementAuthFileFieldLimit)
		if model == "" {
			continue
		}
		if quota := projectQuota(value); quota != nil {
			result[model] = *quota
		}
		if len(result) >= managementOverviewBucketCount*managementOverviewBucketCount {
			break
		}
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

func numberInt64(value any) (int64, error) {
	switch typed := value.(type) {
	case json.Number:
		return typed.Int64()
	case int64:
		return typed, nil
	case int:
		return int64(typed), nil
	default:
		return 0, errors.New("not an integer")
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

func decodeManagementJSON(writer http.ResponseWriter, request *http.Request, limit int64, output any) error {
	request.Body = http.MaxBytesReader(writer, request.Body, limit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid request body")
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeError(writer, http.StatusBadRequest, "invalid request body")
		return errors.New("multiple JSON values")
	}
	return nil
}

func decodeManagementValue(raw json.RawMessage) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func validateJSONUploadName(raw string) (string, error) {
	name, err := validateAuthSelector(raw)
	if err != nil {
		return "", err
	}
	if !strings.HasSuffix(strings.ToLower(name), ".json") {
		return "", errors.New("name must end with .json")
	}
	return name, nil
}

func validateAuthSelector(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len([]rune(name)) > managementAuthFileNameLimit || name == "." || name == ".." {
		return "", errors.New("invalid auth file name")
	}
	if filepath.VolumeName(name) != "" || strings.ContainsAny(name, "/\\:") {
		return "", errors.New("invalid auth file name")
	}
	for _, char := range name {
		if unicode.IsControl(char) {
			return "", errors.New("invalid auth file name")
		}
	}
	return name, nil
}

func validateAuthJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var object map[string]any
	if err := decoder.Decode(&object); err != nil || object == nil {
		return errors.New("auth file must be a JSON object")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("auth file must contain one JSON object")
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func boundedText(value string, limit int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}

func nonNegative(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

// Keep this compile-time reference close to the upload adapter: the standard
// library multipart types are intentionally hidden behind a small adapter so
// the handler can enforce one upload contract.
var _ multipart.File
