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
	DailyAtMinute   int                            `json:"daily_at_minute"`
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
	dto := DatabaseBackupAutomationDTO{Enabled: value.Enabled, DailyAtMinute: value.DailyAtMinute, KeepLocal: value.KeepLocal, KeepRemote: value.KeepRemote, HasPassphrase: value.Passphrase != "", NextRunAtMS: value.NextRunAtMS, LastRunAtMS: value.LastRunAtMS, LastSuccessAtMS: value.LastSuccessAtMS, LastError: value.LastError, Destinations: []DatabaseBackupDestinationDTO{}}
	for _, c := range value.Destinations {
		dto.Destinations = append(dto.Destinations, DatabaseBackupDestinationDTO{c.ID, c.Name, c.Provider, c.Root, len(c.Options) > 0})
	}
	return dto
}

// PutDatabaseBackupAutomationRequestDTO updates automated database backup schedules and remote destinations.
type PutDatabaseBackupAutomationRequestDTO struct {
	Enabled       bool                       `json:"enabled"`
	DailyAtMinute int                        `json:"daily_at_minute"`
	KeepLocal     int                        `json:"keep_local"`
	KeepRemote    int                        `json:"keep_remote"`
	Passphrase    string                     `json:"passphrase"`
	Destinations  []backup.DestinationConfig `json:"destinations"`
}

// DatabaseBackupProbeResponseDTO confirms remote backup destination reachability.
type DatabaseBackupProbeResponseDTO struct {
	OK bool `json:"ok"`
}

// DatabaseBackupArchiveListResponseDTO lists remote encrypted database backup archives.
type DatabaseBackupArchiveListResponseDTO struct {
	Items []DatabaseBackupArchiveDTO `json:"items"`
}

// InspectDatabaseArchiveRequestDTO stages a remote or local archive for pre-restore inspection.
type InspectDatabaseArchiveRequestDTO struct {
	Key           string `json:"key"`
	DestinationID string `json:"destination_id"`
	Passphrase    string `json:"passphrase"`
}

// @Summary Get automated database backup settings
// @Description Return schedule, retention counts, redacted destinations, and run history for automated SQLite backups.
// @Tags DatabaseBackups
// @Produce json
// @Security CookieAuth
// @Success 200 {object} DatabaseBackupAutomationDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/system/database-backup-automation [get]
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

// @Summary Configure automated database backups
// @Description Save schedule, retention, encryption passphrase, and remote destinations for automated backups.
// @Tags DatabaseBackups
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body PutDatabaseBackupAutomationRequestDTO true "Automation configuration"
// @Success 200 {object} DatabaseBackupAutomationDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 422 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/system/database-backup-automation [put]
func (h *Handler) putDatabaseAutomation(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	var input PutDatabaseBackupAutomationRequestDTO
	if !readAgentInput(w, r, &input) {
		return
	}
	if err := h.databaseBackups.ConfigureAutomation(r.Context(), backup.Automation{Enabled: input.Enabled, DailyAtMinute: input.DailyAtMinute, KeepLocal: input.KeepLocal, KeepRemote: input.KeepRemote, Passphrase: input.Passphrase, Destinations: input.Destinations}); err != nil {
		h.databaseBackupError(w, err)
		return
	}
	h.getDatabaseAutomation(w, r)
}

// @Summary Run automated database backup now
// @Description Trigger an immediate automated database backup and remote upload job.
// @Tags DatabaseBackups
// @Produce json
// @Security CookieAuth
// @Success 202 {object} DatabaseBackupJobDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/system/database-backup-automation/run [post]
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

// @Summary Probe a remote backup destination
// @Description Verify connectivity and write permissions for a configured database backup destination.
// @Tags DatabaseBackups
// @Produce json
// @Security CookieAuth
// @Param id path string true "Destination ID"
// @Success 200 {object} DatabaseBackupProbeResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/system/database-backup-destinations/{id}/probe [post]
func (h *Handler) probeDatabaseDestination(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	ctx, cancel := h.contextWithBackupTimeout(w, r)
	defer cancel()
	if err := h.databaseBackups.ProbeDestination(ctx, chi.URLParam(r, "id")); err != nil {
		h.databaseBackupError(w, err)
		return
	}
	writeJSON(w, 200, DatabaseBackupProbeResponseDTO{OK: true})
}

// @Summary Download database recovery profile
// @Description Download an encrypted `.omcrecovery` profile bundle containing destination metadata for disaster recovery.
// @Tags DatabaseBackups
// @Produce octet-stream
// @Security CookieAuth
// @Success 200 {file} binary
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/system/database-backup-recovery-profile [get]
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

// @Summary List database backup archives
// @Description List local or remote backup archive files, optionally filtered by destination_id.
// @Tags DatabaseBackups
// @Produce json
// @Security CookieAuth
// @Param destination_id query string false "Optional remote destination ID (omit for local archives)"
// @Success 200 {object} DatabaseBackupArchiveListResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/system/database-backup-archives [get]
func (h *Handler) listDatabaseArchives(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	ctx, cancel := h.contextWithBackupTimeout(w, r)
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
	writeJSON(w, 200, DatabaseBackupArchiveListResponseDTO{Items: dto})
}

// @Summary Download a database backup archive
// @Description Stream a stored encrypted database backup archive file by archive key.
// @Tags DatabaseBackups
// @Produce octet-stream
// @Security CookieAuth
// @Param key path string true "Archive key"
// @Success 200 {file} binary
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/system/database-backup-archives/{key}/download [get]
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

// @Summary Stage and inspect a database backup archive
// @Description Decrypt and validate a local or remote backup archive before applying a restore.
// @Tags DatabaseBackups
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body InspectDatabaseArchiveRequestDTO true "Archive key, destination ID, and passphrase"
// @Success 201 {object} DatabaseBackupJobDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 422 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/system/database-backup-archives/inspect [post]
func (h *Handler) inspectDatabaseArchive(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	var input InspectDatabaseArchiveRequestDTO
	if !readAgentInput(w, r, &input) {
		return
	}
	ctx, cancel := h.contextWithBackupTimeout(w, r)
	defer cancel()
	job, err := h.databaseBackups.StageArchive(ctx, input.DestinationID, input.Key, input.Passphrase)
	if err != nil {
		h.databaseBackupError(w, err)
		return
	}
	writeJSON(w, 201, databaseBackupDTO(job))
}

// contextWithBackupTimeout bounds a synchronous cloud call and extends the response's write
// deadline to match: the server's ordinary 30-second write timeout would otherwise cut a slow probe
// or remote listing off after the work finished, and the browser would see a reset connection
// instead of the result or its refusal code.
func (h *Handler) contextWithBackupTimeout(w http.ResponseWriter, r *http.Request) (context.Context, context.CancelFunc) {
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Minute)); err != nil {
		h.logger.Warn("database backup response deadline not applied", "error", err)
	}
	return context.WithTimeout(r.Context(), 15*time.Minute)
}
