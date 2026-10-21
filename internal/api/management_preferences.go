package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/timezone"
)

// knownPreferences is the whole public surface of the preferences API. The
// endpoint stores UI state, not application data, so a key has to be listed
// here before a browser can write it — otherwise this becomes an arbitrary
// blob store reachable through the session.
var knownPreferences = map[string]bool{
	repository.PreferenceDashboardRange:      true,
	repository.PreferenceLogFilters:          true,
	repository.PreferenceProviderIcons:       true,
	repository.PreferenceProviderNames:       true,
	repository.PreferenceProviderWebsites:    true,
	repository.PreferenceUsageEventsView:     true,
	repository.PreferenceUsageEventsColumns:  true,
	repository.PreferenceOAuthManagementView: true,
	repository.PreferenceTimezone:            true,
	repository.PreferenceTokenStyle:          true,
	repository.PreferenceTpsCalculationMode:  true,
	repository.PreferenceModelView:           true,
	repository.PreferenceRequestModelIcons:   true,
	repository.PreferenceTheme:               true,
	repository.PreferenceScrollSmoothing:     true,
	repository.PreferenceFonts:               true,
	repository.PreferenceNavHidden:           true,
	repository.PreferenceDashboardLayout:     true,
	repository.PreferencePlaygroundSession:   true,
	repository.PreferenceAgentTarget:         true,
	repository.PreferenceUpdateDismissals:    true,
	repository.PreferenceQuotaAutoRefresh:    true,
	repository.PreferenceOMCPluginSource:     true,
}

// preferenceValue is a stored JSON document kept exactly as the client sent it.
// The console owns each key's shape; the server only checks that it parses.
type preferenceValue = json.RawMessage

func (h *Handler) listPreferences(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()

	stored, err := h.repo.ListPreferences(ctx)
	if err != nil {
		writeInternalError(writer, fmt.Errorf("list preferences: %w", err))
		return
	}
	preferences := map[string]preferenceValue{}
	for key, raw := range stored {
		if !knownPreferences[key] || !json.Valid([]byte(raw)) {
			// A value written by an older build that no longer parses must not
			// take the whole response down; the client falls back to its own
			// default for that key.
			continue
		}
		preferences[key] = preferenceValue(raw)
	}
	zone, err := h.repo.ReadTimezone(ctx)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"preferences": preferences, "time_zone": zone})
}

func (h *Handler) putPreference(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	key := chi.URLParam(request, "key")
	if !knownPreferences[key] {
		writeError(writer, http.StatusBadRequest, "unsupported preference key")
		return
	}
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, repository.MaxPreferenceValueBytes))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "unreadable preference body")
		return
	}
	// Validating the document here is what lets every reader skip the parse
	// check: nothing unparseable can be in the table.
	if !json.Valid(body) {
		writeError(writer, http.StatusBadRequest, "preference value must be a JSON document")
		return
	}
	// The automatic quota refresh policy decides when the server makes provider requests on
	// its own, so its shape is enforced on the way in rather than guessed at by the loop.
	if key == repository.PreferenceQuotaAutoRefresh {
		if _, err := quota.ParseAutoRefreshSettings(body); err != nil {
			writeError(writer, http.StatusBadRequest, quota.ErrInvalidAutoRefreshSettings.Error())
			return
		}
	}
	// The plugin source preference is read by the server when it reconciles CPA's
	// store sources, so it is a switch and nothing else.
	if key == repository.PreferenceOMCPluginSource {
		var enabled *bool
		if json.Unmarshal(body, &enabled) != nil || enabled == nil {
			writeError(writer, http.StatusBadRequest, "the plugin source preference must be true or false")
			return
		}
	}
	if err := h.repo.PutPreference(request.Context(), key, string(body)); err != nil {
		if errors.Is(err, repository.ErrCustomIconMissing) || errors.Is(err, repository.ErrCustomIconName) {
			writeCustomIconError(writer, err)
			return
		}
		if errors.Is(err, repository.ErrFontMissing) || errors.Is(err, repository.ErrFontReference) {
			writeFontError(writer, err)
			return
		}
		if errors.Is(err, timezone.ErrInvalid) {
			writeError(writer, http.StatusBadRequest, "invalid_timezone")
			return
		}
		if errors.Is(err, context.Canceled) {
			return
		}
		writeInternalError(writer, fmt.Errorf("write preference: %w", err))
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"key": key, "value": preferenceValue(body)})
}
