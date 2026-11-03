package api

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/backup"
)

type DatabaseBackupDestinationDTO struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	Root      string `json:"root"`
	HasConfig bool   `json:"has_config"`
}
type DatabaseBackupAutomationDTO struct {
	Enabled         bool                           `json:"enabled"`
	IntervalHours   int                            `json:"interval_hours"`
	KeepLocal       int                            `json:"keep_local"`
	KeepRemote      int                            `json:"keep_remote"`
	HasPassphrase   bool                           `json:"has_passphrase"`
	Destinations    []DatabaseBackupDestinationDTO `json:"destinations"`
	NextRunAtMS     int64                          `json:"next_run_at_ms"`
	LastRunAtMS     int64                          `json:"last_run_at_ms"`
	LastSuccessAtMS int64                          `json:"last_success_at_ms"`
	LastError       string                         `json:"last_error"`
}

func automationDTO(value backup.Automation) DatabaseBackupAutomationDTO {
	dto := DatabaseBackupAutomationDTO{Enabled: value.Enabled, IntervalHours: value.IntervalHours, KeepLocal: value.KeepLocal, KeepRemote: value.KeepRemote, HasPassphrase: value.Passphrase != "", NextRunAtMS: value.NextRunAtMS, LastRunAtMS: value.LastRunAtMS, LastSuccessAtMS: value.LastSuccessAtMS, LastError: value.LastError, Destinations: []DatabaseBackupDestinationDTO{}}
	for _, c := range value.Destinations {
		dto.Destinations = append(dto.Destinations, DatabaseBackupDestinationDTO{c.ID, c.Name, c.Provider, c.Root, len(c.Options) > 0})
	}
	return dto
}
func (h *Handler) getDatabaseAutomation(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	value, err := h.databaseBackups.Automation(r.Context())
	if err != nil {
		h.databaseBackupError(w, err)
		return
	}
	writeJSON(w, 200, automationDTO(value))
}
func (h *Handler) putDatabaseAutomation(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	var input struct {
		Enabled       bool                       `json:"enabled"`
		IntervalHours int                        `json:"interval_hours"`
		KeepLocal     int                        `json:"keep_local"`
		KeepRemote    int                        `json:"keep_remote"`
		Passphrase    string                     `json:"passphrase"`
		Destinations  []backup.DestinationConfig `json:"destinations"`
	}
	if !readAgentInput(w, r, &input) {
		return
	}
	if err := h.databaseBackups.ConfigureAutomation(r.Context(), backup.Automation{Enabled: input.Enabled, IntervalHours: input.IntervalHours, KeepLocal: input.KeepLocal, KeepRemote: input.KeepRemote, Passphrase: input.Passphrase, Destinations: input.Destinations}); err != nil {
		h.databaseBackupError(w, err)
		return
	}
	h.getDatabaseAutomation(w, r)
}
func (h *Handler) runDatabaseAutomation(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	job, err := h.databaseBackups.RunAutomatic()
	if err != nil {
		h.databaseBackupError(w, err)
		return
	}
	writeJSON(w, 202, databaseBackupDTO(job))
}
func (h *Handler) probeDatabaseDestination(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	ctx, cancel := contextWithBackupTimeout(r)
	defer cancel()
	if err := h.databaseBackups.ProbeDestination(ctx, chi.URLParam(r, "id")); err != nil {
		h.databaseBackupError(w, err)
		return
	}
	writeJSON(w, 200, struct {
		OK bool `json:"ok"`
	}{true})
}
func (h *Handler) downloadDatabaseRecoveryProfile(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	var output bytes.Buffer
	if err := h.databaseBackups.WriteRecoveryProfile(r.Context(), &output); err != nil {
		h.databaseBackupError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="omc.omcrecovery"`)
	if _, err := io.Copy(w, &output); err != nil {
		h.logger.Warn("recovery profile download interrupted")
	}
}

type DatabaseBackupArchiveDTO struct {
	Key         string `json:"key"`
	SizeBytes   int64  `json:"size_bytes"`
	CreatedAtMS int64  `json:"created_at_ms"`
}

func (h *Handler) listDatabaseArchives(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	ctx, cancel := contextWithBackupTimeout(r)
	defer cancel()
	items, err := h.databaseBackups.ListArchives(ctx, r.URL.Query().Get("destination_id"))
	if err != nil {
		h.databaseBackupError(w, err)
		return
	}
	dto := []DatabaseBackupArchiveDTO{}
	for _, item := range items {
		dto = append(dto, DatabaseBackupArchiveDTO{item.Key, item.SizeBytes, backup.ArchiveCreatedAtMS(item.Key)})
	}
	sort.Slice(dto, func(i, j int) bool { return dto[i].Key > dto[j].Key })
	writeJSON(w, 200, struct {
		Items []DatabaseBackupArchiveDTO `json:"items"`
	}{dto})
}
func (h *Handler) downloadDatabaseArchive(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	key := chi.URLParam(r, "key")
	file, err := h.databaseBackups.OpenArchive(r.Context(), key)
	if err != nil {
		h.databaseBackupError(w, err)
		return
	}
	defer file.Close()
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Minute)); err != nil {
		h.logger.Warn("database archive download deadline not applied", "error", err)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+key+`"`)
	if _, err := io.Copy(w, file); err != nil {
		h.logger.Warn("database archive download interrupted")
	}
}
func (h *Handler) inspectDatabaseArchive(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	var input struct {
		Key           string `json:"key"`
		DestinationID string `json:"destination_id"`
		Passphrase    string `json:"passphrase"`
	}
	if !readAgentInput(w, r, &input) {
		return
	}
	ctx, cancel := contextWithBackupTimeout(r)
	defer cancel()
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Minute)); err != nil {
		h.logger.Warn("database archive validation deadline not applied", "error", err)
	}
	job, err := h.databaseBackups.StageArchive(ctx, input.DestinationID, input.Key, input.Passphrase)
	if err != nil {
		h.databaseBackupError(w, err)
		return
	}
	writeJSON(w, 201, databaseBackupDTO(job))
}

func contextWithBackupTimeout(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), 15*time.Minute)
}
