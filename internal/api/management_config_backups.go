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

func (h *Handler) listConfigBackups(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeJSON(writer, http.StatusOK, map[string]any{"backups": []repository.ConfigBackup{}, "settings": repository.ConfigBackupSettings{
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
	writeJSON(writer, http.StatusOK, map[string]any{"backups": backups, "settings": settings})
}

type configBackupSettingsRequest struct {
	Retention int `json:"retention"`
}

// putConfigBackupSettings changes how many v8 copies are kept. A lower value
// deletes the oldest copies at once.
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
	writeJSON(writer, http.StatusOK, map[string]any{"settings": settings})
}

// createConfigBackup keeps the stored file now, outside any write: before an
// edit made by hand on the gateway, for instance. A file identical to the newest
// copy is not stored twice, and the answer says so.
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
	writeJSON(writer, http.StatusOK, map[string]any{"backup": backup, "created": isCreated})
}

// getConfigBackup reveals one kept file. It holds the same secrets as the raw
// source view, so it is audited fail-closed the same way.
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
	writeJSON(writer, http.StatusOK, map[string]any{"backup": backup, "yaml": document})
}

// restoreConfigBackup writes a kept file back to the gateway. The document never
// leaves the server: it is decrypted here and sent to CPA as a whole-document
// save, which keeps the file it replaces first, so a restore is itself undone
// by restoring that copy.
//
// It replaces the whole file without a revision check, because replacing
// whatever is there is what was asked for; the write gate still keeps it from
// interleaving with another save. Only a v8 copy can be restored: CPA's v8 API
// refuses every pre-v8 field name, and a pre-v8 copy is kept for download.
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
	response := map[string]any{"status": "ok"}
	if savedYAML, err := client.ConfigYAML(request.Context()); err == nil {
		response["revision"] = configyaml.ComputeRevision(savedYAML)
		detail["new_revision"] = response["revision"]
	}
	// The configuration is already stored; recordAudit logs failures.
	_ = h.recordAudit(request, "config.restore_backup", "config", target, "success", detail)
	writeJSON(writer, http.StatusOK, response)
}

// deleteConfigBackup removes one kept file. It is audited fail-closed because a
// deleted copy cannot be recovered.
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
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok"})
}
