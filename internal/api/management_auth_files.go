package api

import (
	"context"
	"errors"
	"fmt"
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
