package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// configBackupStore is where a CPA configuration file is kept before the first
// v8 configuration write converts it (see management.ConfigBackup).
func (h *Handler) configBackupStore() repository.ConfigBackupStore {
	return repository.ConfigBackupStore{Repo: h.repo, Cipher: h.cipher}
}

type configBackupSink struct {
	store repository.ConfigBackupStore
}

func (s configBackupSink) KeepLegacyConfig(ctx context.Context, baseURL, storedYAML string) error {
	_, err := s.store.Save(ctx, baseURL, storedYAML, time.Now().UTC())
	return err
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

func (h *Handler) listConfigBackups(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeJSON(writer, http.StatusOK, map[string]any{"backups": []repository.ConfigBackup{}})
		return
	}
	backups, err := h.configBackupStore().List(request.Context())
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"backups": backups})
}

// getConfigBackup reveals one kept file. It holds the same secrets as the raw
// source view, so it is audited fail-closed the same way.
func (h *Handler) getConfigBackup(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id, err := strconv.ParseInt(chi.URLParam(request, "id"), 10, 64)
	if err != nil || id <= 0 || h.repo == nil || h.cipher == nil {
		writeError(writer, http.StatusNotFound, "configuration backup not found")
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
