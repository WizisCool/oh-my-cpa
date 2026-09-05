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
	if _, err := client.PatchAuthFileFields(request.Context(), validatedName, fields); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok"})
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
		handleUploadResults(writer, request.Context(), client, files)
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
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "uploaded": 1, "files": []string{name}})
}

type multipartFileHeader struct {
	filename string
	open     func() (multipart.File, error)
}

func handleUploadResults(writer http.ResponseWriter, ctx context.Context, client *management.Client, files []*multipartFileHeader) {
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

	// 1. Process upstream explicit failures
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

	// 2. Process upstream explicit successes
	seenSuccess := make(map[string]bool)
	confirmedDeleted := make([]string, 0, len(requested))

	if rawFiles, ok := cpaResp["files"].([]any); ok {
		for _, item := range rawFiles {
			rawName, isStr := item.(string)
			if !isStr || !requestedSet[rawName] || seenSuccess[rawName] || seenFailed[rawName] {
				continue
			}
			confirmedDeleted = append(confirmedDeleted, rawName)
			seenSuccess[rawName] = true
		}
	} else if len(requested) == 1 && len(failures) == 0 {
		// Documented CPA single-file contract: returns {"status": "ok"} or {"deleted": 1} without files array
		name := requested[0]
		if status, isStr := cpaResp["status"].(string); isStr && (status == "ok" || status == "success") {
			confirmedDeleted = append(confirmedDeleted, name)
			seenSuccess[name] = true
		} else if deleted, isNum := cpaResp["deleted"].(float64); isNum && deleted == 1 {
			confirmedDeleted = append(confirmedDeleted, name)
			seenSuccess[name] = true
		} else if deletedInt, isInt := cpaResp["deleted"].(int); isInt && deletedInt == 1 {
			confirmedDeleted = append(confirmedDeleted, name)
			seenSuccess[name] = true
		}
	}

	// 3. Any requested file neither confirmed deleted nor explicitly failed is unconfirmed
	for _, name := range requested {
		if !seenSuccess[name] && !seenFailed[name] {
			failures = append(failures, authFileDeleteFailureItem{
				Name:  name,
				Error: "deletion unconfirmed by upstream",
			})
			seenFailed[name] = true
		}
	}

	// 4. Compute status
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
		fields[canonical] = decoded
	}
	return fields, nil
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
