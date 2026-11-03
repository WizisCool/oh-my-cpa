package api

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/backup"
)

type DatabaseBackupOAuthDTO struct {
	ID               string `json:"id"`
	AuthorizationURL string `json:"authorization_url,omitempty"`
	ExpiresAtMS      int64  `json:"expires_at_ms"`
	Status           string `json:"status"`
}

func backupOAuthDTO(value backup.OAuthConnection) DatabaseBackupOAuthDTO {
	return DatabaseBackupOAuthDTO{value.ID, value.AuthorizationURL, value.ExpiresAtMS, value.Status}
}
func (h *Handler) startDatabaseBackupOAuth(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	var input struct {
		Provider          string `json:"provider"`
		ClientID          string `json:"client_id"`
		ClientSecret      string `json:"client_secret"`
		AutomaticCallback bool   `json:"automatic_callback"`
	}
	if !readAgentInput(w, r, &input) {
		return
	}
	options := backup.OAuthStart{Provider: input.Provider, ClientID: input.ClientID, ClientSecret: input.ClientSecret}
	if input.AutomaticCallback {
		origin, err := url.Parse(strings.TrimSpace(r.Header.Get("Origin")))
		if err != nil || origin.Host == "" || (origin.Scheme != "https" && origin.Scheme != "http") {
			writeDatabaseBackupError(w, http.StatusBadRequest, "a browser origin is required", "database_backup_settings")
			return
		}
		// The mutation middleware has admitted this origin. Use the same
		// browser-facing address that the operator registered in the wizard.
		options.RedirectURL = origin.Scheme + "://" + origin.Host + h.cfg.BasePath + "/api/auth/database-backup/callback"
	}
	value, err := h.databaseBackups.StartOAuth(r.Context(), options)
	if err != nil {
		h.databaseBackupError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, backupOAuthDTO(value))
}
func (h *Handler) getDatabaseBackupOAuth(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	value, err := h.databaseBackups.OAuthStatus(chi.URLParam(r, "id"))
	if err != nil {
		h.databaseBackupError(w, err)
		return
	}
	writeJSON(w, 200, backupOAuthDTO(value))
}
func (h *Handler) completeDatabaseBackupOAuth(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	var input struct {
		CallbackURL string `json:"callback_url"`
	}
	if !readAgentInput(w, r, &input) {
		return
	}
	// Code exchange and account discovery may need two provider requests.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Minute)); err != nil {
		h.logger.Warn("cloud authorization response deadline not applied", "error", err)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	if err := h.databaseBackups.CompleteOAuth(ctx, chi.URLParam(r, "id"), input.CallbackURL); err != nil {
		h.databaseBackupError(w, err)
		return
	}
	h.getDatabaseBackupOAuth(w, r)
}
func (h *Handler) cancelDatabaseBackupOAuth(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	h.databaseBackups.CancelOAuth(chi.URLParam(r, "id"))
	w.WriteHeader(http.StatusNoContent)
}
func (h *Handler) databaseBackupOAuthCallback(w http.ResponseWriter, r *http.Request) {
	if !h.databaseBackupsReady(w) {
		return
	}
	// Code exchange and account discovery may need two provider requests.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Minute)); err != nil {
		h.logger.Warn("cloud authorization response deadline not applied", "error", err)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	if err := h.databaseBackups.OAuthCallback(ctx, r.URL.Query().Get("state"), r.URL.Query().Get("code"), r.URL.Query().Get("error")); err != nil {
		h.databaseBackupError(w, err)
		return
	}
	// Strip provider response parameters before returning to the console. The
	// original setup window observes the server-side session, never the token.
	http.Redirect(w, r, h.cfg.BasePath+"/system", http.StatusSeeOther)
}
