package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// OMC Community has a fixed source address and an operator-owned visibility
// preference. Catalog reads do not repair CPA configuration; manual installs and
// configuration writes reconcile the source inside their shared write gate.
// The preference is independent from signed builtin lifecycle authorization.

// isOMCPluginStoreURL reports whether a registry URL or a store entry's source URL is
// Oh My CPA's own registry.
func isOMCPluginStoreURL(raw string) bool {
	return strings.TrimSpace(raw) == pluginregistry.OMCSourceURL
}

// omcPluginSourceEnabled reads the operator's choice. Unset means on: a fresh
// installation has the registry without anyone configuring it.
func (h *Handler) omcPluginSourceEnabled(ctx context.Context) (bool, error) {
	if h.repo == nil {
		return true, nil
	}
	raw, found, err := h.repo.GetPreference(ctx, repository.PreferenceOMCPluginSource)
	if err != nil {
		return false, err
	}
	if !found {
		return true, nil
	}
	var enabled *bool
	if json.Unmarshal([]byte(raw), &enabled) != nil || enabled == nil {
		// A document this build cannot parse - or a JSON null, which decodes into
		// the zero value rather than failing - was not written by this build; the
		// source's documented default is the state a fresh installation is in.
		return true, nil
	}
	return *enabled, nil
}

// errPluginSourcePreferenceUnavailable marks a switch that could not be read. It
// wraps the repository's error so errors.Is can still reach the cause; the response
// is chosen by this condition, never by its text, because a database failure can name
// tables and values that must not reach a caller.
var errPluginSourcePreferenceUnavailable = errors.New("the plugin source preference could not be read")

// errPluginSourceAuditUnavailable marks a repair refused because its audit record
// could not be written. A sentinel rather than a message, so the response stays a
// fixed sentence however the audit implementation words its failure.
var errPluginSourceAuditUnavailable = errors.New("the plugin source repair could not be audited")

// pluginSourceEnabled reads the switch through the condition the response writer
// recognises. The requirement that makes the caller fail closed - no repair without a
// readable switch - is also what keeps the repository's error out of the response.
func (h *Handler) pluginSourceEnabled(ctx context.Context) (bool, error) {
	enabled, err := h.omcPluginSourceEnabled(ctx)
	if err != nil {
		return false, fmt.Errorf("%w: %w", errPluginSourcePreferenceUnavailable, err)
	}
	return enabled, nil
}

// reconcileOMCPluginSourceLocked assumes the caller already holds the provider write
// gate and the configuration mutex. A configuration save calls it inside its own
// lock scope, so repairing what that save removed cannot land between the save and
// the revision it reports.
func (h *Handler) reconcileOMCPluginSourceLocked(ctx context.Context, request *http.Request, client *management.Client) (bool, error) {
	enabled, err := h.pluginSourceEnabled(ctx)
	if err != nil {
		return false, err
	}
	rawYAML, err := client.ConfigYAML(ctx)
	if err != nil {
		return false, err
	}
	settings, err := configyaml.ReadPluginSettings(rawYAML)
	if err != nil {
		return false, err
	}
	if slices.ContainsFunc(settings.StoreSources, isOMCPluginStoreURL) == enabled {
		return enabled, nil
	}

	details := map[string]any{"source": pluginregistry.OMCSourceURL, "enabled": enabled}
	if auditErr := h.recordAudit(request, "plugin.source", "config", "plugins.store-sources", "attempt", details); auditErr != nil {
		return false, errPluginSourceAuditUnavailable
	}
	sources := configyaml.StoreSourcesWith(settings.StoreSources, pluginregistry.OMCSourceURL, enabled)
	change := management.ConfigChange{Path: []string{"plugins", "store-sources"}, Value: sources}
	if len(sources) == 0 {
		// An empty list is how CPA spells "none": the key itself is removed.
		change = management.ConfigChange{Path: []string{"plugins", "store-sources"}, Remove: true}
	}
	if err := client.ApplyConfigChanges(management.WithBackupReason(ctx, management.BackupReasonPluginSettings), []management.ConfigChange{change}); err != nil {
		_ = h.recordAudit(request, "plugin.source", "config", "plugins.store-sources", "failure", map[string]any{"error": publicCPAErrorMessage(err)})
		return false, err
	}
	_ = h.recordAudit(request, "plugin.source", "config", "plugins.store-sources", "success", details)
	return enabled, nil
}

// writePluginSourceError reports that the managed registry could not be brought in
// line with the operator's choice. The message is chosen by condition, never by
// copying the error: a repository failure names tables, a transport failure names the
// gateway's URL, and a rejected configuration can quote the content that was refused.
//
// A busy write gate keeps its own retryable answer, local failures answer as local,
// and everything else is CPA's answer, which `publicCPAErrorMessage` reduces to its
// allowlisted sentences.
func writePluginSourceError(writer http.ResponseWriter, err error, isAfterConfigSave bool) {
	switch {
	case errors.Is(err, errProviderWriteBusy):
		writeProviderWriteError(writer, err)
		return
	case errors.Is(err, configyaml.ErrPluginSettingsUnreadable):
		if isAfterConfigSave {
			// The save landed before the repair read it back. Say so: the editor's
			// next save meets the revision conflict, and a message that read as a
			// plain refusal would make that follow-up inexplicable.
			writeJSON(writer, http.StatusUnprocessableEntity, map[string]any{
				"error": fmt.Sprintf("the configuration was saved, but its plugins section cannot be read: %v", err),
				"code":  "plugin_settings_unreadable",
			})
			return
		}
		writePluginSettingsUnreadable(writer, err)
		return
	case errors.Is(err, errPluginSourcePreferenceUnavailable):
		if isAfterConfigSave {
			// The save is durable; only the repair is missing. Saying so is what
			// keeps the editor's next save from reading as an unexplained conflict.
			// The cause goes to the log; the response stays fixed.
			slog.Error("the managed plugin source could not be restored after a configuration save", "error", err)
			writeJSON(writer, http.StatusInternalServerError, map[string]any{
				"error": "the configuration was saved, but the Oh My CPA plugin source could not be restored",
				"code":  "plugin_source_reconcile_failed",
			})
			return
		}
		// A local failure with no safe detail to share. The repository's words go
		// to the log, which is where an operator can act on them.
		writeInternalError(writer, err)
		return
	case errors.Is(err, errPluginSourceAuditUnavailable):
		// Fail-closed: nothing was written, so the response says the repair was
		// refused rather than what the audit insert reported.
		message := "the Oh My CPA plugin source could not be changed because its audit record could not be written"
		if isAfterConfigSave {
			message = "the configuration was saved, but the Oh My CPA plugin source could not be restored because its audit record could not be written"
		}
		writeJSON(writer, http.StatusInternalServerError, map[string]any{
			"error": message,
			"code":  "plugin_source_reconcile_failed",
		})
		return
	}

	message := "the Oh My CPA plugin source could not be written to the gateway configuration: "
	if isAfterConfigSave {
		message = "the configuration was saved, but the Oh My CPA plugin source could not be restored: "
	}
	message += publicCPAErrorMessage(err)
	writeJSON(writer, http.StatusBadGateway, map[string]any{
		"error": message,
		"code":  "plugin_source_reconcile_failed",
	})
}

// pluginSourceReadError reports a preference read that failed, before any store or
// settings read depends on it.
func (h *Handler) pluginSourceReadError(writer http.ResponseWriter, err error) {
	writeInternalError(writer, fmt.Errorf("read the Oh My CPA plugin source preference: %w", err))
}
