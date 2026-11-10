package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/backup"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type DatabaseBackupJobDTO struct {
	ID                  string `json:"id"`
	Kind                string `json:"kind"`
	State               string `json:"state"`
	CreatedAtMS         int64  `json:"created_at_ms"`
	ExpiresAtMS         int64  `json:"expires_at_ms"`
	SizeBytes           int64  `json:"size_bytes"`
	Digest              string `json:"digest"`
	SourceVersion       string `json:"source_version"`
	SourceSchemaVersion int    `json:"source_schema_version"`
	BackupCreatedAtMS   int64  `json:"backup_created_at_ms"`
	Error               string `json:"error,omitempty"`
	HasAuditError       bool   `json:"has_audit_error"`
}

func databaseBackupDTO(job backup.Job) DatabaseBackupJobDTO {
	return DatabaseBackupJobDTO{ID: job.ID, Kind: job.Kind, State: job.State, CreatedAtMS: job.CreatedAtMS, ExpiresAtMS: job.ExpiresAtMS, SizeBytes: job.SizeBytes, Digest: job.Digest, SourceVersion: job.Manifest.Version, SourceSchemaVersion: job.Manifest.SchemaVersion, BackupCreatedAtMS: job.Manifest.CreatedAtMS, Error: job.Error, HasAuditError: job.HasAuditError}
}
func (h *Handler) SetDatabaseBackups(manager *backup.Manager) { h.databaseBackups = manager }
func (h *Handler) databaseBackupsReady(writer http.ResponseWriter) bool {
	writer.Header().Set("Cache-Control", "no-store")
	if h.databaseBackups == nil {
		writeDatabaseBackupError(writer, 503, "database backups are unavailable", "database_backup_unavailable")
		return false
	}
	return true
}
func (h *Handler) databaseBackupError(writer http.ResponseWriter, err error) {
	status, code := http.StatusInternalServerError, "database_backup_failed"
	switch {
	case errors.Is(err, backup.ErrOAuth):
		status, code = http.StatusUnprocessableEntity, "database_backup_oauth"
	case errors.Is(err, backup.ErrNotFound):
		status, code = 404, "database_backup_not_found"
	case errors.Is(err, backup.ErrBusy):
		status, code = 409, "database_backup_busy"
	case errors.Is(err, backup.ErrConfirmation):
		status, code = 409, "database_backup_confirmation"
	case errors.Is(err, backup.ErrAudit):
		status, code = 503, "database_backup_audit"
	case errors.Is(err, backup.ErrAutomationConfig), errors.Is(err, backup.ErrDestinationConfig):
		status, code = 400, "database_backup_settings"
	case errors.Is(err, backup.ErrDestinationProxyUnsupported):
		status, code = 422, "database_backup_proxy_unsupported"
	case errors.Is(err, backup.ErrDestinationFailed), errors.Is(err, backup.ErrCredentialPersistence):
		status, code = 502, "database_backup_destination"
	case errors.Is(err, backup.ErrPassphrase):
		status, code = 400, "database_backup_passphrase"
	case errors.Is(err, backup.ErrUnsupportedVersion):
		status, code = 422, "database_backup_version"
	case errors.Is(err, backup.ErrInvalidArtifact):
		status, code = 422, "database_backup_invalid"
	case errors.Is(err, repository.ErrInsufficientDiskSpace):
		status, code = http.StatusInsufficientStorage, "database_backup_disk_space"
	}
	if status >= 500 {
		h.logger.Error("database backup request failed", "error", err)
	}
	writeDatabaseBackupError(writer, status, "database backup operation could not be completed", code)
}
func (h *Handler) listDatabaseBackups(writer http.ResponseWriter, request *http.Request) {
	if !h.databaseBackupsReady(writer) {
		return
	}
	items := []DatabaseBackupJobDTO{}
	for _, job := range h.databaseBackups.List() {
		items = append(items, databaseBackupDTO(job))
	}
	writeJSON(writer, 200, struct {
		Items []DatabaseBackupJobDTO `json:"items"`
	}{items})
}
func (h *Handler) createDatabaseBackup(writer http.ResponseWriter, request *http.Request) {
	if !h.databaseBackupsReady(writer) {
		return
	}
	var input struct {
		Passphrase string `json:"passphrase"`
	}
	if !readAgentInput(writer, request, &input) {
		return
	}
	job, err := h.databaseBackups.CreateExport(request.Context(), input.Passphrase)
	if err != nil {
		h.databaseBackupError(writer, err)
		return
	}
	writeJSON(writer, 202, databaseBackupDTO(job))
}
func (h *Handler) getDatabaseBackupJob(writer http.ResponseWriter, request *http.Request) {
	if !h.databaseBackupsReady(writer) {
		return
	}
	job, err := h.databaseBackups.Get(chi.URLParam(request, "id"))
	if err != nil {
		h.databaseBackupError(writer, err)
		return
	}
	writeJSON(writer, 200, databaseBackupDTO(job))
}
func (h *Handler) downloadDatabaseBackup(writer http.ResponseWriter, request *http.Request) {
	if !h.databaseBackupsReady(writer) {
		return
	}
	file, job, err := h.databaseBackups.OpenExport(request.Context(), chi.URLParam(request, "id"))
	if err != nil {
		h.databaseBackupError(writer, err)
		return
	}
	defer file.Close()
	// A browser downloads the stream directly; neither the server nor the SPA
	// needs a database-sized byte slice. Bound this authenticated transfer.
	if err := http.NewResponseController(writer).SetWriteDeadline(time.Now().Add(15 * time.Minute)); err != nil {
		h.logger.Warn("database backup download deadline not applied", "job_id", job.ID, "error", err)
	}
	writer.Header().Set("Content-Type", "application/octet-stream")
	writer.Header().Set("Content-Disposition", `attachment; filename="omc-`+job.ID+`.omcbackup"`)
	if _, err := io.Copy(writer, file); err != nil {
		h.logger.Warn("database backup download interrupted", "job_id", job.ID)
	}
}
func (h *Handler) uploadDatabaseRestore(writer http.ResponseWriter, request *http.Request) {
	if !h.databaseBackupsReady(writer) {
		return
	}
	controller := http.NewResponseController(writer)
	if err := controller.SetReadDeadline(time.Now().Add(15 * time.Minute)); err != nil {
		h.logger.Warn("database backup upload read deadline not applied", "error", err)
	}
	if err := controller.SetWriteDeadline(time.Now().Add(15 * time.Minute)); err != nil {
		h.logger.Warn("database backup upload write deadline not applied", "error", err)
	}
	ctx, cancel := context.WithTimeout(request.Context(), 15*time.Minute)
	defer cancel()
	request.Body = http.MaxBytesReader(writer, request.Body, backup.MaxUploadBytes+(1<<20))
	reader, err := request.MultipartReader()
	if err != nil {
		writeDatabaseBackupError(writer, 400, "invalid backup upload", "database_backup_invalid")
		return
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "passphrase" {
		writeDatabaseBackupError(writer, 400, "backup passphrase must precede the file", "database_backup_invalid")
		return
	}
	passphrase, err := io.ReadAll(io.LimitReader(part, 1025))
	if err != nil || len(passphrase) > 1024 {
		writeDatabaseBackupError(writer, 400, "invalid backup passphrase", "database_backup_passphrase")
		return
	}
	part, err = reader.NextPart()
	if err != nil || part.FormName() != "file" {
		writeDatabaseBackupError(writer, 400, "backup file is required", "database_backup_invalid")
		return
	}
	job, err := h.databaseBackups.StageImport(ctx, part, string(passphrase))
	if err != nil {
		h.databaseBackupError(writer, err)
		return
	}
	writeJSON(writer, 201, databaseBackupDTO(job))
}
func (h *Handler) applyDatabaseRestore(writer http.ResponseWriter, request *http.Request) {
	if !h.databaseBackupsReady(writer) {
		return
	}
	var input struct {
		Digest string `json:"digest"`
	}
	if !readAgentInput(writer, request, &input) {
		return
	}
	if err := h.databaseBackups.Apply(request.Context(), chi.URLParam(request, "id"), input.Digest); err != nil {
		h.databaseBackupError(writer, err)
		return
	}
	writeJSON(writer, 202, struct {
		RequiresRestart bool `json:"requires_restart"`
	}{true})
}
func (h *Handler) deleteDatabaseBackup(writer http.ResponseWriter, request *http.Request) {
	if !h.databaseBackupsReady(writer) {
		return
	}
	if err := h.databaseBackups.Delete(request.Context(), chi.URLParam(request, "id")); err != nil {
		h.databaseBackupError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func writeDatabaseBackupError(writer http.ResponseWriter, status int, message, code string) {
	writeJSON(writer, status, struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{message, code})
}
