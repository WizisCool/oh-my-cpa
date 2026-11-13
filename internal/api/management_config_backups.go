package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// configBackupStore is where the stored CPA configuration file is kept before
// each write (see management.ConfigBackup).
func (h *Handler) configBackupStore() repository.ConfigBackupStore {
	return repository.ConfigBackupStore{Repo: h.repo, Cipher: h.cipher}
}

type configBackupSink struct {
	store repository.ConfigBackupStore
}

func (s configBackupSink) KeepConfig(ctx context.Context, snapshot management.ConfigSnapshot) error {
	_, _, err := s.store.Save(ctx, configBackupInput(snapshot), time.Now().UTC())
	return err
}

func configBackupInput(snapshot management.ConfigSnapshot) repository.ConfigBackupInput {
	layout := repository.ConfigLayoutLegacy
	if snapshot.IsV8 {
		layout = repository.ConfigLayoutV8
	}
	return repository.ConfigBackupInput{GatewayURL: snapshot.BaseURL, Document: snapshot.YAML, Layout: layout, Reason: snapshot.Reason}
}

// configBackupSink is nil when the handler has no store, which makes every
// write that would convert a legacy file refuse instead of converting it
// unrecoverably.
func (h *Handler) configBackupSink() management.ConfigBackup {
	if h.repo == nil || h.cipher == nil {
		return nil
	}
	return configBackupSink{store: h.configBackupStore()}
}

// parseConfigBackupID reads the route's backup id, answering 404 itself when the
// id cannot name a stored backup.
func (h *Handler) parseConfigBackupID(writer http.ResponseWriter, request *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(request, "id"), 10, 64)
	if err != nil || id <= 0 || h.repo == nil || h.cipher == nil {
		writeError(writer, http.StatusNotFound, "configuration backup not found")
		return 0, false
	}
	return id, true
}

// ConfigBackupsResponseDTO lists stored CPA configuration snapshots and retention settings.
type ConfigBackupsResponseDTO struct {
	Backups  []repository.ConfigBackup       `json:"backups"`
	Settings repository.ConfigBackupSettings `json:"settings"`
}

// ConfigBackupSettingsResponseDTO wraps updated config backup retention settings.
type ConfigBackupSettingsResponseDTO struct {
	Settings repository.ConfigBackupSettings `json:"settings"`
}

// ConfigBackupCreateResponseDTO returns a saved config backup and whether a new snapshot was created.
type ConfigBackupCreateResponseDTO struct {
	Backup  repository.ConfigBackup `json:"backup"`
	Created bool                    `json:"created"`
}

// ConfigBackupDetailResponseDTO reveals a decrypted config backup YAML along with metadata.
type ConfigBackupDetailResponseDTO struct {
	Backup repository.ConfigBackup `json:"backup"`
	YAML   string                  `json:"yaml"`
}

// ConfigBackupRestoreResponseDTO confirms a config backup restore and reports the new CPA revision.
type ConfigBackupRestoreResponseDTO struct {
	Status   string `json:"status"`
	Revision string `json:"revision,omitempty"`
}

// @Summary List configuration backups
// @Description Return encrypted CPA configuration backup metadata and retention settings.
// @Tags ConfigBackups
// @Produce json
// @Security CookieAuth
// @Success 200 {object} ConfigBackupsResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Router /v1/management/config/backups [get]
func (h *Handler) listConfigBackups(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeJSON(writer, http.StatusOK, ConfigBackupsResponseDTO{Backups: []repository.ConfigBackup{}, Settings: repository.ConfigBackupSettings{
			Retention:       repository.CONFIG_BACKUP_RETENTION_DEFAULT,
			RetentionMin:    repository.CONFIG_BACKUP_RETENTION_MIN,
			RetentionMax:    repository.CONFIG_BACKUP_RETENTION_MAX,
			LegacyRetention: repository.CONFIG_LEGACY_BACKUP_RETENTION,
		}})
		return
	}
	store := h.configBackupStore()
	backups, err := store.List(request.Context())
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	settings, err := store.Settings(request.Context())
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, ConfigBackupsResponseDTO{Backups: backups, Settings: settings})
}

type configBackupSettingsRequest struct {
	Retention int `json:"retention"`
}

// putConfigBackupSettings changes how many v8 copies are kept. A lower value
// deletes the oldest copies at once.
//
// @Summary Update configuration backup retention
// @Description Configure how many v8 CPA configuration snapshots to retain.
// @Tags ConfigBackups
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body configBackupSettingsRequest true "Backup retention settings"
// @Success 200 {object} ConfigBackupSettingsResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/config/backups/settings [put]
func (h *Handler) putConfigBackupSettings(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req configBackupSettingsRequest
	if err := decodeManagementJSON(writer, request, 4*1024, &req); err != nil {
		return
	}
	defer request.Body.Close()
	if h.repo == nil || h.cipher == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	settings, err := h.configBackupStore().SetRetention(request.Context(), req.Retention)
	if errors.Is(err, repository.ErrConfigBackupRetention) {
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"error": fmt.Sprintf("retention must be between %d and %d", repository.CONFIG_BACKUP_RETENTION_MIN, repository.CONFIG_BACKUP_RETENTION_MAX),
			"code":  "config_backup_retention_invalid",
		})
		return
	}
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	_ = h.recordAudit(request, "config.backup_settings", "config", "config_backups", "success", map[string]any{"retention": settings.Retention})
	writeJSON(writer, http.StatusOK, ConfigBackupSettingsResponseDTO{Settings: settings})
}

// createConfigBackup keeps the stored file now, outside any write: before an
// edit made by hand on the gateway, for instance. A file identical to the newest
// copy is not stored twice, and the answer says so.
//
// @Summary Create configuration backup snapshot
// @Description Snapshot and encrypt CPA's current stored configuration file.
// @Tags ConfigBackups
// @Produce json
// @Security CookieAuth
// @Success 200 {object} ConfigBackupCreateResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 413 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/config/backups [post]
func (h *Handler) createConfigBackup(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil || h.cipher == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	isV8, stored, err := client.IsStoredConfigV8(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	snapshot := management.ConfigSnapshot{BaseURL: client.BaseURL(), YAML: stored, IsV8: isV8, Reason: management.BackupReasonManual}
	backup, isCreated, err := h.configBackupStore().Save(request.Context(), configBackupInput(snapshot), time.Now().UTC())
	if errors.Is(err, repository.ErrConfigBackupTooLarge) {
		writeError(writer, http.StatusRequestEntityTooLarge, err.Error())
		return
	}
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	_ = h.recordAudit(request, "config.create_backup", "config", strconv.FormatInt(backup.ID, 10), "success", map[string]any{"revision": backup.Revision, "created": isCreated})
	writeJSON(writer, http.StatusOK, ConfigBackupCreateResponseDTO{Backup: backup, Created: isCreated})
}

// getConfigBackup reveals one kept file. It holds the same secrets as the raw
// source view, so it is audited fail-closed the same way.
//
// @Summary Reveal a configuration backup
// @Description Decrypt and return the YAML content of a stored configuration backup after fail-closed audit logging.
// @Tags ConfigBackups
// @Produce json
// @Security CookieAuth
// @Param id path integer true "Configuration backup ID"
// @Success 200 {object} ConfigBackupDetailResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Router /v1/management/config/backups/{id} [get]
func (h *Handler) getConfigBackup(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id, ok := h.parseConfigBackupID(writer, request)
	if !ok {
		return
	}
	backup, document, err := h.configBackupStore().Load(request.Context(), id)
	if errors.Is(err, repository.ErrNotFound) {
		writeError(writer, http.StatusNotFound, "configuration backup not found")
		return
	}
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	target := strconv.FormatInt(backup.ID, 10)
	if auditErr := h.recordAudit(request, "config.reveal_backup", "config", target, "success", map[string]any{"revision": backup.Revision, "size_bytes": backup.SizeBytes}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; backup reveal aborted")
		return
	}
	writeJSON(writer, http.StatusOK, ConfigBackupDetailResponseDTO{Backup: backup, YAML: document})
}

// restoreConfigBackup writes a kept file back to the gateway. The document never
// leaves the server: it is decrypted here and sent to CPA as a whole-document
// save, which keeps the file it replaces first, so a restore is itself undone
// by restoring that copy.
//
// @Summary Restore a configuration backup
// @Description Write a stored v8 configuration backup back to CPA with automatic pre-write backup.
// @Tags ConfigBackups
// @Produce json
// @Security CookieAuth
// @Param id path integer true "Configuration backup ID"
// @Success 200 {object} ConfigBackupRestoreResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/config/backups/{id}/restore [post]
func (h *Handler) restoreConfigBackup(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id, ok := h.parseConfigBackupID(writer, request)
	if !ok {
		return
	}
	backup, document, err := h.configBackupStore().Load(request.Context(), id)
	if errors.Is(err, repository.ErrNotFound) {
		writeError(writer, http.StatusNotFound, "configuration backup not found")
		return
	}
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	if backup.Layout != repository.ConfigLayoutV8 {
		writeJSON(writer, http.StatusConflict, map[string]any{
			"error": "a pre-v8 configuration file cannot be written through the v8 API; download it instead",
			"code":  "config_backup_legacy",
		})
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	defer h.providerWrites.release()
	h.configMu.Lock()
	defer h.configMu.Unlock()

	if err := h.flushCoordinatorWithinGate(request.Context()); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	// The current document is read only to scrub its secrets from a refusal; a
	// failed read does not block the restore.
	currentYAML, _ := client.ConfigYAML(request.Context())
	target := strconv.FormatInt(backup.ID, 10)
	detail := map[string]any{"revision": backup.Revision, "created_at_ms": backup.CreatedAtMS}
	if auditErr := h.recordAudit(request, "config.restore_backup", "config", target, "attempt", detail); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; backup restore aborted")
		return
	}
	ctx := management.WithBackupReason(request.Context(), management.BackupReasonRestore)
	if err := client.UpdateConfigYAML(ctx, document); err != nil {
		_ = h.recordAudit(request, "config.restore_backup", "config", target, "failure", map[string]any{"error": publicCPAErrorMessage(err)})
		writeCPAFacadeError(writer, scrubConfigRejection(scrubConfigRejection(err, document), currentYAML))
		return
	}
	h.afterConfigWrite()
	response := ConfigBackupRestoreResponseDTO{Status: "ok"}
	if savedYAML, err := client.ConfigYAML(request.Context()); err == nil {
		response.Revision = configyaml.ComputeRevision(savedYAML)
		detail["new_revision"] = response.Revision
	}
	// The configuration is already stored; recordAudit logs failures.
	_ = h.recordAudit(request, "config.restore_backup", "config", target, "success", detail)
	writeJSON(writer, http.StatusOK, response)
}

// deleteConfigBackup removes one kept file. It is audited fail-closed because a
// deleted copy cannot be recovered.
//
// @Summary Delete a configuration backup
// @Description Permanently delete a stored configuration backup after recording an audit entry.
// @Tags ConfigBackups
// @Produce json
// @Security CookieAuth
// @Param id path integer true "Configuration backup ID"
// @Success 200 {object} StatusOKResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Router /v1/management/config/backups/{id} [delete]
func (h *Handler) deleteConfigBackup(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id, ok := h.parseConfigBackupID(writer, request)
	if !ok {
		return
	}
	target := strconv.FormatInt(id, 10)
	if auditErr := h.recordAudit(request, "config.delete_backup", "config", target, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; backup deletion aborted")
		return
	}
	backup, err := h.configBackupStore().Delete(request.Context(), id)
	if errors.Is(err, repository.ErrNotFound) {
		_ = h.recordAudit(request, "config.delete_backup", "config", target, "failure", map[string]any{"error": "not found"})
		writeError(writer, http.StatusNotFound, "configuration backup not found")
		return
	}
	if err != nil {
		_ = h.recordAudit(request, "config.delete_backup", "config", target, "failure", map[string]any{"error": err.Error()})
		writeInternalError(writer, err)
		return
	}
	_ = h.recordAudit(request, "config.delete_backup", "config", target, "success", map[string]any{"revision": backup.Revision, "layout": backup.Layout})
	writeJSON(writer, http.StatusOK, StatusOKResponseDTO{Status: "ok"})
}
