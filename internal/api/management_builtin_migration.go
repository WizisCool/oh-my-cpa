package api

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
)

// These are the two exact published spellings of ZCode's former registry, not a
// host/owner heuristic. The candy registry is deliberately not an equivalent.
var legacyZCodeRegistryURLs = []string{
	"https://raw.githubusercontent.com/WizisCool/omc-zcode-oauth/refs/heads/main/registry.json",
	"https://raw.githubusercontent.com/WizisCool/omc-zcode-oauth/main/registry.json",
}

func (h *Handler) migrateBuiltinSourceLocked(ctx context.Context, request *http.Request, client *management.Client, instance domain.CPAInstance, id string, record pluginInstallRecord, target string) (bool, error) {
	if id != "omc-zcode-oauth" || record.ID != id || record.Repository != "https://github.com/WizisCool/omc-zcode-oauth" || record.Version == "" {
		return false, nil
	}
	known := false
	for _, address := range legacyZCodeRegistryURLs {
		if record.SourceURL == address && record.SourceID == pluginregistry.SourceID(address) {
			known = true
		}
	}
	if !known {
		return false, nil
	}
	raw, err := h.builtinCatalog().Registry(id, record.Version)
	if err != nil {
		return false, nil
	}
	var approved struct {
		Plugins []pluginregistry.Plugin `json:"plugins"`
	}
	if json.Unmarshal(raw, &approved) != nil || len(approved.Plugins) != 1 {
		return false, nil
	}
	// A mutable github-release record has no artifact identity to compare. It is
	// not enough evidence to adopt executable code, even when id/version match.
	// Direct legacy records must match every approved platform URL and digest.
	if !reflect.DeepEqual(record.Install, approved.Plugins[0].Install) {
		return false, nil
	}
	if err := h.repo.CheckBuiltinBinding(ctx, instance); err != nil {
		return false, err
	}
	paths := []string{"plugins.configs." + id + ".store.source-id", "plugins.configs." + id + ".store.source-url", "plugins.configs." + id + ".store.source-name"}
	if err := h.recordAudit(request, "plugin.builtin_source_migration", "builtin_plugin", id, "attempt", map[string]any{"changed_paths": paths, "version": record.Version}); err != nil {
		return false, err
	}
	prefix := []string{"plugins", "configs", id, "store"}
	changes := []management.ConfigChange{}
	for key, value := range map[string]string{"source-id": pluginregistry.SourceID(target), "source-url": target, "source-name": pluginregistry.BuiltinSourceName} {
		path := append(append([]string(nil), prefix...), key)
		changes = append(changes, management.ConfigChange{Path: path, Value: value})
	}
	if err := client.ApplyConfigChanges(management.WithBackupReason(ctx, management.BackupReasonPluginSettings), changes); err != nil {
		return false, err
	}
	records, err := readPluginInstallRecords(ctx, client)
	if err != nil {
		return false, err
	}
	updated := records[id]
	if updated.SourceID != pluginregistry.SourceID(target) || updated.SourceURL != target || updated.Version != record.Version || updated.Repository != record.Repository || !reflect.DeepEqual(updated.Install, record.Install) {
		return false, management.ErrPluginMutationConflict
	}
	if err := h.recordAudit(request, "plugin.builtin_source_migration", "builtin_plugin", id, "success", map[string]any{"changed_paths": paths, "version": record.Version}); err != nil {
		return true, err
	}
	return true, nil
}
