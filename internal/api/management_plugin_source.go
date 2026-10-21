package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

/**
 * Oh My CPA's own plugin registry as a store source.
 *
 * CPA lists the built-in official registry and every `plugins.store-sources` entry.
 * Oh My CPA's registry is not in the file because an operator put it there: it is
 * part of what this console ships, so the store reconciles the file with the
 * operator's preference before it is read, and a configuration save that drops the
 * address is repaired in the same transaction. The preference
 * (`omc_plugin_source_enabled`) is the only switch; the URL is compiled in.
 *
 * A source CPA cannot see would be a source whose entries cannot be installed, so
 * the rule is kept in one direction only: the address is present exactly when the
 * preference says it is.
 */

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

// reconcileOMCPluginSource makes CPA's store-source list agree with the preference
// and reports whether the source is on. It takes the same gate and mutex a
// configuration save does, so it can never interleave with one.
func (h *Handler) reconcileOMCPluginSource(ctx context.Context, request *http.Request, client *management.Client) (bool, error) {
	if h.cfg.IsDemoMode {
		// The demonstration serves a fixture and refuses configuration writes; its
		// dataset already lists the registry.
		return h.omcPluginSourceEnabled(ctx)
	}
	if err := h.providerWrites.acquire(ctx); err != nil {
		return false, err
	}
	defer h.providerWrites.release()
	h.configMu.Lock()
	defer h.configMu.Unlock()
	return h.reconcileOMCPluginSourceLocked(ctx, request, client)
}

// reconcileOMCPluginSourceLocked assumes the caller already holds the provider write
// gate and the configuration mutex. A configuration save calls it inside its own
// lock scope, so repairing what that save removed cannot land between the save and
// the revision it reports.
func (h *Handler) reconcileOMCPluginSourceLocked(ctx context.Context, request *http.Request, client *management.Client) (bool, error) {
	enabled, err := h.omcPluginSourceEnabled(ctx)
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
		return false, errors.New("audit failure; the plugin source was not changed")
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

// dropOMCPluginSource removes the managed registry and its entries from a store
// document. It runs when the source is switched off but CPA still returned it: the
// demonstration never writes its fixture, and a configuration the reconciliation
// could not be reached for must not leak entries the operator switched off.
func dropOMCPluginSource(store *management.PluginStore) {
	store.Plugins = slices.DeleteFunc(store.Plugins, func(item management.StorePluginItem) bool {
		return isOMCPluginStoreURL(item.SourceURL)
	})
	store.Sources = slices.DeleteFunc(store.Sources, func(source management.PluginStoreSource) bool {
		return isOMCPluginStoreURL(source.URL)
	})
	store.SourceErrors = slices.DeleteFunc(store.SourceErrors, func(sourceError management.PluginStoreSourceError) bool {
		return isOMCPluginStoreURL(sourceError.SourceURL)
	})
}

// writePluginSourceError reports that the managed registry could not be brought in
// line with the operator's choice. A busy write gate keeps its own retryable answer;
// everything else names the plugin source, because a store served without it is not
// the store the operator configured.
func writePluginSourceError(writer http.ResponseWriter, err error, isAfterConfigSave bool) {
	if errors.Is(err, errProviderWriteBusy) {
		writeProviderWriteError(writer, err)
		return
	}
	if errors.Is(err, configyaml.ErrPluginSettingsUnreadable) {
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
	}
	message := "the Oh My CPA plugin source could not be written to the gateway configuration: "
	if isAfterConfigSave {
		message = "the configuration was saved, but the Oh My CPA plugin source could not be restored: "
	}
	var httpErr *management.HTTPError
	if errors.As(err, &httpErr) ||
		errors.Is(err, management.ErrConfigBackupUnavailable) ||
		errors.Is(err, management.ErrConfigPartiallyApplied) ||
		errors.Is(err, management.ErrManagementV8Required) {
		message += publicCPAErrorMessage(err)
	} else {
		message += boundedText(security.RedactText(err.Error()), 512)
	}
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
