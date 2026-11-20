package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const (
	managementAuthFileExportMaxFiles = 100
	managementAuthFileExportMaxBytes = 64 * 1024 * 1024
)

// AuthFileExportRequestDTO names one or more credential auth files to export in a ZIP archive.
type AuthFileExportRequestDTO struct {
	Names []string `json:"names"`
}

// @Summary Export multiple raw auth files as a ZIP archive
// @Description Download selected credential auth files as a single ZIP attachment after recording fail-closed audit events. Aborts if any requested file fails to download.
// @Tags AuthFiles
// @Accept json
// @Produce application/zip
// @Security CookieAuth
// @Param body body AuthFileExportRequestDTO true "Batch export payload"
// @Success 200 {file} binary
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 413 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 501 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/auth-files/export [post]
func (h *Handler) exportManagementAuthFiles(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, managementAuthFileRequestLimit)
	var payload AuthFileExportRequestDTO
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		if errors.Is(err, io.EOF) {
			writeError(writer, http.StatusBadRequest, "one to one hundred names are required")
			return
		}
		writeError(writer, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(writer, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(payload.Names) == 0 || len(payload.Names) > managementAuthFileExportMaxFiles {
		writeError(writer, http.StatusBadRequest, "one to one hundred names are required")
		return
	}

	unique := make([]string, 0, len(payload.Names))
	seen := make(map[string]struct{}, len(payload.Names))
	for _, rawName := range payload.Names {
		name, validationErr := validateJSONUploadName(rawName)
		if validationErr != nil {
			writeError(writer, http.StatusBadRequest, validationErr.Error())
			return
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		unique = append(unique, name)
	}
	targetSummary := strings.Join(unique, ",")

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	if auditErr := h.recordAudit(request, "auth_file.export", "auth_file", targetSummary, "attempt", map[string]any{
		"count": len(unique),
	}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; export aborted")
		return
	}

	var archive bytes.Buffer
	zipWriter := zip.NewWriter(&archive)
	now := h.now().UTC()
	var totalRawBytes int64
	for _, name := range unique {
		data, _, err := client.DownloadAuthFile(request.Context(), name)
		if err != nil {
			_ = zipWriter.Close()
			_ = h.recordAudit(request, "auth_file.export", "auth_file", targetSummary, "failure", map[string]any{
				"count":       len(unique),
				"failed_file": name,
				"error":       publicCPAErrorMessage(err),
			})
			writeCPAFacadeError(writer, err)
			return
		}
		totalRawBytes += int64(len(data))
		if totalRawBytes > managementAuthFileExportMaxBytes {
			_ = zipWriter.Close()
			_ = h.recordAudit(request, "auth_file.export", "auth_file", targetSummary, "failure", map[string]any{
				"count":     len(unique),
				"raw_bytes": totalRawBytes,
				"error":     "export archive exceeds size limit",
			})
			writeError(writer, http.StatusRequestEntityTooLarge, "export archive exceeds size limit")
			return
		}
		entry, err := zipWriter.CreateHeader(&zip.FileHeader{
			Name:     name,
			Method:   zip.Deflate,
			Modified: now,
		})
		if err != nil {
			_ = zipWriter.Close()
			_ = h.recordAudit(request, "auth_file.export", "auth_file", targetSummary, "failure", map[string]any{
				"count": len(unique),
				"error": err.Error(),
			})
			writeInternalError(writer, err)
			return
		}
		if _, err := entry.Write(data); err != nil {
			_ = zipWriter.Close()
			_ = h.recordAudit(request, "auth_file.export", "auth_file", targetSummary, "failure", map[string]any{
				"count": len(unique),
				"error": err.Error(),
			})
			writeInternalError(writer, err)
			return
		}
	}
	if err := zipWriter.Close(); err != nil {
		_ = h.recordAudit(request, "auth_file.export", "auth_file", targetSummary, "failure", map[string]any{
			"count": len(unique),
			"error": err.Error(),
		})
		writeInternalError(writer, err)
		return
	}

	if auditErr := h.recordAudit(request, "auth_file.export", "auth_file", targetSummary, "success", map[string]any{
		"count":         len(unique),
		"raw_bytes":     totalRawBytes,
		"archive_bytes": archive.Len(),
	}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; export aborted")
		return
	}

	fileName := fmt.Sprintf("oauth-credentials-%s.zip", now.Format("20060102-150405"))
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", fileName))
	writer.Header().Set("Content-Type", "application/zip")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(archive.Bytes())
}
