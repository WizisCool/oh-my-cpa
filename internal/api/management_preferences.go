package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"

	"github.com/go-chi/chi/v5"

	"github.com/oh-my-cpa/oh-my-cpa/internal/exchangerate"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/timezone"
)

// knownPreferences is the whole public surface of the preferences API. The
// endpoint stores UI state, not application data, so a key has to be listed
// here before a browser can write it — otherwise this becomes an arbitrary
// blob store reachable through the session.
var knownPreferences = map[string]bool{
	repository.PreferenceDashboardRange:         true,
	repository.PreferenceInsightsRange:          true,
	repository.PreferenceLogFilters:             true,
	repository.PreferenceProviderIcons:          true,
	repository.PreferenceProviderNames:          true,
	repository.PreferenceProviderWebsites:       true,
	repository.PreferenceUsageEventsView:        true,
	repository.PreferenceUsageEventsColumns:     true,
	repository.PreferenceOAuthManagementView:    true,
	repository.PreferenceProviderOrder:          true,
	repository.PreferenceRoutingCardOrder:       true,
	repository.PreferenceCredentialOrder:        true,
	repository.PreferenceOAuthSectionOrder:      true,
	repository.PreferencePluginOrder:            true,
	repository.PreferenceWarmupTaskOrder:        true,
	repository.PreferenceTimezone:               true,
	repository.PreferenceDisplayCurrency:        true,
	repository.PreferenceTokenStyle:             true,
	repository.PreferenceTpsCalculationMode:     true,
	repository.PreferenceModelView:              true,
	repository.PreferenceRequestModelIcons:      true,
	repository.PreferenceDashboardComparison:    true,
	repository.PreferenceTheme:                  true,
	repository.PreferenceReducedMotion:          true,
	repository.PreferenceFonts:                  true,
	repository.PreferenceNavHidden:              true,
	repository.PreferenceNavOrder:               true,
	repository.PreferenceSidebarCollapsed:       true,
	repository.PreferenceDrawerWidths:           true,
	repository.PreferenceDashboardLayout:        true,
	repository.PreferenceDashboardOrder:         true,
	repository.PreferenceDashboardProviderOrder: true,
	repository.PreferencePlaygroundSession:      true,
	repository.PreferenceAgentTarget:            true,
	repository.PreferenceUpdateDismissals:       true,
	repository.PreferenceQuotaAutoRefresh:       true,
	repository.PreferenceUpdateCheck:            true,
	repository.PreferenceOMCPluginSource:        true,
}

// PreferenceListResponseDTO returns all allowlisted console UI preferences and the configured timezone.
// Each stored JSON document is kept as the client sent it; the console owns each key's shape while
// the server checks only that it parses.
type PreferenceListResponseDTO struct {
	Preferences map[string]json.RawMessage `json:"preferences"`
	TimeZone    repository.TimezoneInfo    `json:"time_zone"`
}

// PreferencePutResponseDTO returns the persisted preference key and JSON value.
type PreferencePutResponseDTO struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

// @Summary List console preferences
// @Description Return all allowlisted server-persisted UI preferences and the configured OMC timezone.
// @Tags Preferences
// @Produce json
// @Security CookieAuth
// @Success 200 {object} PreferenceListResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/preferences [get]
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
	preferences := map[string]json.RawMessage{}
	for key, raw := range stored {
		if !knownPreferences[key] || !json.Valid([]byte(raw)) {
			// A value written by an older build that no longer parses must not
			// take the whole response down; the client falls back to its own
			// default for that key.
			continue
		}
		preferences[key] = json.RawMessage(raw)
	}
	zone, err := h.repo.ReadTimezone(ctx)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, PreferenceListResponseDTO{Preferences: preferences, TimeZone: zone})
}

// @Summary Update a console preference
// @Description Validate and persist an allowlisted console UI preference JSON document.
// @Tags Preferences
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param key path string true "Allowlisted preference key"
// @Param body body object true "Arbitrary valid JSON document for the preference key"
// @Success 200 {object} PreferencePutResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/preferences/{key} [put]
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
	if key == repository.PreferenceDisplayCurrency {
		var code string
		if json.Unmarshal(body, &code) != nil || !exchangerate.IsDisplayCurrency(code) {
			writeError(writer, http.StatusBadRequest, "invalid_display_currency")
			return
		}
		if code != "USD" {
			snapshot, err := h.repo.ReadExchangeRates(request.Context())
			if err != nil {
				writeInternalError(writer, err)
				return
			}
			isAvailable := false
			for _, rate := range snapshot.Rates {
				if rate.Currency == code {
					isAvailable = true
					break
				}
			}
			if !isAvailable {
				writeError(writer, http.StatusBadRequest, "display_currency_unavailable")
				return
			}
		}
	}
	// The automatic quota refresh policy decides when the server makes provider requests on
	// its own, so its shape is enforced on the way in rather than guessed at by the loop.
	if key == repository.PreferenceQuotaAutoRefresh {
		if _, err := quota.ParseAutoRefreshSettings(body); err != nil {
			writeError(writer, http.StatusBadRequest, quota.ErrInvalidAutoRefreshSettings.Error())
			return
		}
	}
	// The update check interval decides how often the sweep spends GitHub requests, so it is
	// held to the same rule.
	if key == repository.PreferenceUpdateCheck {
		if _, err := release.ParseUpdateCheckSettings(body); err != nil {
			writeError(writer, http.StatusBadRequest, release.ErrInvalidUpdateCheckSettings.Error())
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
	// Every save, move and delete of a provider re-keys the positional overlays, so one that is
	// not an object of strings would fail each of those writes until someone replaced it.
	if slices.Contains(positionalProviderOverlays, key) {
		var values map[string]string
		if json.Unmarshal(body, &values) != nil {
			writeError(writer, http.StatusBadRequest, "a provider overlay preference must be an object of strings")
			return
		}
	}
	if key == repository.PreferenceSidebarCollapsed {
		var isCollapsed *bool
		if json.Unmarshal(body, &isCollapsed) != nil || isCollapsed == nil {
			writeError(writer, http.StatusBadRequest, "the sidebar collapsed preference must be true or false")
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
	if key == repository.PreferenceProviderIcons || key == repository.PreferenceProviderNames {
		h.identityArchive.reset()
		if client, clientErr := h.capabilityClient(request.Context()); clientErr == nil {
			_ = h.readProviderItems(request.Context(), client)
		}
		h.publishStateSync("management-providers", "management-providers-sanitized", stateScopeIdentityDirectory)
	}
	writeJSON(writer, http.StatusOK, PreferencePutResponseDTO{Key: key, Value: json.RawMessage(body)})
}
