package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"gopkg.in/yaml.v3"
)

type builtinRuntime struct {
	catalog   *pluginregistry.Catalog
	queue     chan domain.CPAInstance
	mu        sync.Mutex
	cancel    context.CancelFunc
	done      chan struct{}
	newTicker func(time.Duration) (<-chan time.Time, func())
}

var errBuiltinManaged = errors.New("builtin plugins are managed from the built-in plugin page")

const (
	builtinCatalogRefreshInterval = 15 * time.Minute
	builtinDesiredStateInterval   = time.Minute
)

type BuiltinGlobalPolicyDTO struct {
	Enabled  bool  `json:"enabled"`
	Revision int64 `json:"revision"`
}
type BuiltinPluginPolicyDTO struct {
	Enabled bool `json:"enabled"`
}
type BuiltinCatalogDTO struct {
	Status   string `json:"status"`
	Revision string `json:"revision"`
}
type BuiltinPluginDTO struct {
	ID               string                      `json:"id"`
	Name             string                      `json:"name"`
	Description      string                      `json:"description"`
	DescriptionI18n  pluginregistry.Descriptions `json:"description_i18n,omitempty"`
	Version          string                      `json:"version"`
	SourceID         string                      `json:"source_id"`
	SourceKind       string                      `json:"source_kind"`
	Policy           BuiltinPluginPolicyDTO      `json:"policy"`
	Status           string                      `json:"status"`
	InstalledVersion string                      `json:"installed_version"`
	RuntimeVersion   string                      `json:"runtime_version"`
	Registered       bool                        `json:"registered"`
	EffectiveEnabled bool                        `json:"effective_enabled"`
	Reason           string                      `json:"reason"`
}
type BuiltinPluginsDTO struct {
	Policy          BuiltinGlobalPolicyDTO `json:"policy"`
	Catalog         BuiltinCatalogDTO      `json:"catalog"`
	Plugins         []BuiltinPluginDTO     `json:"plugins"`
	LastReconcileAt string                 `json:"last_reconcile_at"`
}

func (h *Handler) builtinRegistryURL() (string, error) {
	// This origin is for CPA's server-to-server callback. It must never derive from
	// Host, forwarding headers, the browser URL or the console's public URL.
	raw := strings.TrimSpace(h.cfg.BuiltinRegistryOrigin)
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("CPA to OMC registry origin is not configured")
	}
	return strings.TrimRight(parsed.String(), "/") + h.cfg.BasePath + pluginregistry.PublicRegistryPath, nil
}
func (h *Handler) builtinCatalog() *pluginregistry.Catalog { return h.builtins.catalog }
func (h *Handler) publicBuiltinRegistry(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	// Keep this completely independent of management authentication and CPA. CPA
	// can call it synchronously while its installer holds OMC's write gate.
	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", "GET")
		writeError(writer, http.StatusMethodNotAllowed, "only GET is supported")
		return
	}
	for key := range request.URL.Query() {
		if key != "plugin_id" && key != "version" {
			writeError(writer, http.StatusBadRequest, "unsupported registry query")
			return
		}
	}
	raw, err := h.builtinCatalog().Registry(request.URL.Query().Get("plugin_id"), request.URL.Query().Get("version"))
	if err != nil {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]any{"error": "builtin release registry is unavailable", "code": "builtin_catalog_frozen"})
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(raw)
}
func (h *Handler) getBuiltinPlugins(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	policy, err := h.repo.BuiltinPolicy(request.Context(), instance)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	dto := h.projectBuiltinPlugins(instance, policy)
	// Observations stay raw: do not populate Metadata.Version from Store identity.
	client, err := h.clientForInstance(request.Context(), instance)
	if err == nil {
		list, readErr := client.PluginList(request.Context())
		if readErr == nil {
			records, recordErr := readPluginInstallRecords(request.Context(), client)
			if recordErr != nil {
				for index := range dto.Plugins {
					if dto.Plugins[index].Status != "blocked" {
						dto.Plugins[index].Status = "indeterminate"
						dto.Plugins[index].Reason = "cpa_unavailable"
					}
				}
				writeJSON(writer, http.StatusOK, dto)
				return
			}
			expectedURL, _ := h.builtinRegistryURL()
			for index := range dto.Plugins {
				plugin := &dto.Plugins[index]
				record, recorded := pluginInstallRecord{}, false
				owned := false
				if recordErr == nil {
					record, recorded = records[plugin.ID]
					owned = builtinInstallRecordOwned(record, recorded, expectedURL)
					if recorded {
						plugin.InstalledVersion = record.Version
					}
				}
				native := builtinNativePlugin(list, plugin.ID)
				if native != nil {
					plugin.Registered = native.Registered
					plugin.EffectiveEnabled = native.EffectiveEnabled
					plugin.RuntimeVersion = native.DisplayVersion()
				}
				if plugin.Status == "blocked" {
					continue
				}
				if recorded && !owned {
					plugin.Status = "source_conflict"
					plugin.Reason = "installed_from_another_source"
					continue
				}
				if !recorded || !owned {
					if native != nil {
						plugin.Status = "source_conflict"
						plugin.Reason = "unowned_plugin_exists"
					} else {
						plugin.Status = "not_installed"
						plugin.Reason = ""
					}
					continue
				}
				if native == nil {
					plugin.Status = "not_installed"
					plugin.Reason = ""
					continue
				}
				if !native.Enabled {
					plugin.Status = "disabled"
					plugin.Reason = ""
					continue
				}
				if native.Registered && native.EffectiveEnabled && native.DisplayVersion() == plugin.Version && plugin.InstalledVersion == plugin.Version && plugin.Policy.Enabled {
					plugin.Status = "running"
					plugin.Reason = ""
					continue
				}
				if native.Path != "" {
					if policy.Operations[plugin.ID].State == "restart_required" {
						plugin.Status = "restart_required"
						plugin.Reason = "runtime_not_confirmed"
					} else {
						plugin.Status = "indeterminate"
						plugin.Reason = "runtime_not_confirmed"
					}
				} else {
					plugin.Status = "not_installed"
					plugin.Reason = ""
				}
			}
		} else {
			for index := range dto.Plugins {
				if dto.Plugins[index].Status != "blocked" {
					dto.Plugins[index].Status = "indeterminate"
					dto.Plugins[index].Reason = "cpa_unavailable"
				}
			}
		}
	} else {
		for index := range dto.Plugins {
			if dto.Plugins[index].Status != "blocked" {
				dto.Plugins[index].Status = "indeterminate"
				dto.Plugins[index].Reason = "cpa_unavailable"
			}
		}
	}
	writeJSON(writer, http.StatusOK, dto)
}
func (h *Handler) projectBuiltinPlugins(instance domain.CPAInstance, policy repository.BuiltinPolicy) BuiltinPluginsDTO {
	state := h.builtinCatalog().State()
	dto := BuiltinPluginsDTO{Policy: BuiltinGlobalPolicyDTO{Enabled: policy.Enabled, Revision: policy.Revision}, Catalog: BuiltinCatalogDTO{Status: state.Status, Revision: state.Revision}, Plugins: []BuiltinPluginDTO{}, LastReconcileAt: policy.LastReconcileAt}
	sourceURL, _ := h.builtinRegistryURL()
	plugins := state.Manifest.Plugins

	for _, plugin := range plugins {
		override := policy.Overrides[plugin.ID]
		item := BuiltinPluginDTO{ID: plugin.ID, Name: plugin.Name, Description: plugin.Description, DescriptionI18n: plugin.DescriptionI18n, Version: plugin.Version, SourceID: builtinSourceID(sourceURL), SourceKind: "builtin", Policy: BuiltinPluginPolicyDTO{Enabled: override.State != "disabled"}, Status: "not_installed"}
		if state.Status != "ready" {
			item.Status = "blocked"
			item.Reason = "catalog_" + state.Status
		}
		if !policy.Enabled {
			item.Status = "blocked"
			item.Reason = "automation_disabled"
		}
		if operation, ok := policy.Operations[plugin.ID]; ok {
			item.Status = operation.State
			if item.Status == "removed" {
				item.Status = "not_installed"
			} else {
				item.InstalledVersion = operation.Version
			}
			item.Reason = operation.Reason
		}
		if override.State == "disabled" {
			item.Status = "disabled"
			item.Reason = ""
		}
		dto.Plugins = append(dto.Plugins, item)
	}
	return dto
}
func decodeBuiltinBody(writer http.ResponseWriter, request *http.Request, target any) bool {
	request.Body = http.MaxBytesReader(writer, request.Body, 8192)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid builtin policy")
		return false
	}
	if decoder.Decode(new(any)) != io.EOF {
		writeError(writer, http.StatusBadRequest, "invalid builtin policy")
		return false
	}
	return true
}
func (h *Handler) putBuiltinPolicy(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		Enabled  *bool `json:"enabled"`
		Revision int64 `json:"revision"`
	}
	if !decodeBuiltinBody(writer, request, &body) {
		return
	}
	if body.Enabled == nil {
		writeError(writer, http.StatusBadRequest, "enabled is required")
		return
	}
	if !h.enterConfigWrite(writer, request) {
		return
	}
	defer h.leaveConfigWrite()
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	policy, err := h.repo.BuiltinPolicy(request.Context(), instance)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	policy.Enabled = *body.Enabled
	if err = h.recordAudit(request, "plugin.builtin_policy", "builtin_policy", repository.BuiltinGatewayID(instance), "attempt", map[string]any{"enabled": policy.Enabled}); err != nil {
		writeAuditFailure(writer, "audit failure; builtin policy unchanged")
		return
	}
	if err = h.repo.SaveBuiltinPolicy(request.Context(), instance, policy, body.Revision, "", nil); err != nil {
		writeBuiltinPolicyError(writer, err)
		return
	}
	if policy.Enabled {
		h.queueBuiltinReconcile(instance)
	} else if err := h.uninstallBuiltinPluginsLocked(request, instance); err != nil {
		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "builtin policy was saved but uninstalling its plugins could not be confirmed", "code": "builtin_policy_apply_incomplete"})
		return
	}
	h.getBuiltinPlugins(writer, request)
}
func writeBuiltinPolicyError(writer http.ResponseWriter, err error) {
	if errors.Is(err, errBuiltinManaged) {
		writeJSON(writer, http.StatusConflict, map[string]any{"error": "built-in plugins are managed from their dedicated page", "code": "builtin_plugins_managed_separately"})
		return
	}
	if errors.Is(err, repository.ErrBuiltinPolicyConflict) || errors.Is(err, repository.ErrBuiltinBindingChanged) {
		writeJSON(writer, http.StatusConflict, map[string]any{"error": "builtin policy or gateway binding changed; reload before retrying", "code": "policy_revision_conflict"})
		return
	}
	writeInternalError(writer, err)
}
func (h *Handler) putBuiltinPluginPolicy(writer http.ResponseWriter, request *http.Request) {
	id, ok := pluginIDFromRequest(writer, request)
	if !ok {
		return
	}
	var body struct {
		Enabled  *bool `json:"enabled"`
		Revision int64 `json:"revision"`
	}
	if !decodeBuiltinBody(writer, request, &body) {
		return
	}
	if body.Enabled == nil {
		writeError(writer, http.StatusBadRequest, "enabled is required")
		return
	}
	known := id == "omc-zcode-oauth"
	for _, entry := range h.builtinCatalog().State().Manifest.Plugins {
		if entry.ID == id {
			known = true
		}
	}
	if !known {
		writeError(writer, http.StatusNotFound, "builtin plugin not found")
		return
	}

	if !h.enterConfigWrite(writer, request) {
		return
	}
	defer h.leaveConfigWrite()
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	policy, err := h.repo.BuiltinPolicy(request.Context(), instance)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	if !policy.Enabled {
		writeJSON(writer, http.StatusConflict, map[string]any{"error": "builtin plugins are switched off", "code": "builtin_automation_disabled"})
		return
	}
	state := "default"
	if !*body.Enabled {
		state = "disabled"
	}
	if err = h.recordAudit(request, "plugin.builtin_policy", "builtin_plugin", id, "attempt", map[string]any{"enabled": *body.Enabled}); err != nil {
		writeAuditFailure(writer, "audit failure; builtin policy unchanged")
		return
	}
	override := repository.BuiltinPluginPolicy{State: state}
	if err = h.repo.SaveBuiltinPolicy(request.Context(), instance, policy, body.Revision, id, &override); err != nil {
		writeBuiltinPolicyError(writer, err)
		return
	}
	if err := h.applyBuiltinPluginEnabledLocked(request, instance, id, *body.Enabled); err != nil {
		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "builtin policy was saved but the gateway operation could not be confirmed", "code": "builtin_policy_apply_incomplete"})
		return
	}
	if *body.Enabled {
		h.queueBuiltinReconcile(instance)
	}
	h.getBuiltinPlugins(writer, request)
}
func (h *Handler) reconcileBuiltinPlugins(writer http.ResponseWriter, request *http.Request) {
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	h.queueBuiltinReconcile(instance)
	h.getBuiltinPlugins(writer, request)
}
func (h *Handler) queueBuiltinReconcile(instance domain.CPAInstance) {
	select {
	case h.builtins.queue <- instance:
	default:
	}
}

// StartBuiltinWorker is separate from construction: the HTTP listener must be
// serving before CPA can synchronously read the local registry during install.
func (h *Handler) StartBuiltinWorker(ctx context.Context) error {
	if h.cfg.IsDemoMode {
		return nil
	}
	if h.repo == nil || h.cipher == nil || h.providerWrites.permits == nil || h.builtinCatalog() == nil {
		return errors.New("builtin lifecycle requires persistence, encrypted backup, audit and shared write gate")
	}
	h.builtins.mu.Lock()
	defer h.builtins.mu.Unlock()
	if h.builtins.cancel != nil {
		return nil
	}
	runCtx, cancel := context.WithCancel(ctx)
	h.builtins.cancel = cancel
	h.builtins.done = make(chan struct{})
	go func() {
		defer close(h.builtins.done)
		newTicker := h.builtins.newTicker
		if newTicker == nil {
			newTicker = func(interval time.Duration) (<-chan time.Time, func()) {
				ticker := time.NewTicker(interval)
				return ticker.C, ticker.Stop
			}
		}
		catalogTicks, stopCatalogTicker := newTicker(builtinCatalogRefreshInterval)
		defer stopCatalogTicker()
		stateTicks, stopStateTicker := newTicker(builtinDesiredStateInterval)
		defer stopStateTicker()
		trigger := func() {
			if instance, err := h.repo.GetInstance(runCtx, defaultInstanceID()); err == nil {
				h.queueBuiltinReconcile(instance)
			}
		}
		trigger()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-catalogTicks:
				trigger()
			case <-stateTicks:
				instance, err := h.repo.GetInstance(runCtx, defaultInstanceID())
				if err != nil {
					continue
				}
				checkCtx, stop := context.WithTimeout(runCtx, 30*time.Second)
				drift, err := h.builtinDesiredStateDrift(checkCtx, instance)
				stop()
				if err != nil {
					h.logger.Warn("builtin desired-state check failed", "error", err)
					continue
				}
				if drift {
					h.queueBuiltinReconcile(instance)
				}
			case instance := <-h.builtins.queue:
				callCtx, stop := context.WithTimeout(runCtx, 2*time.Minute)
				shouldRefresh := true
				if policy, err := h.repo.BuiltinPolicy(callCtx, instance); err == nil && !policy.Enabled {
					shouldRefresh = false
				}
				if shouldRefresh {
					if err := h.builtinCatalog().Refresh(callCtx); err != nil {
						h.logger.Warn("builtin reconciliation skipped: release refresh failed", "error", err)
						stop()
						continue
					}
				}
				if err := h.runBuiltinReconcile(callCtx, instance); err != nil {
					h.logger.Warn("builtin reconciliation stopped", "error", err)
				} else {
					h.logger.Info("builtin reconciliation complete", "binding_generation", instance.BindingGeneration)
				}
				stop()
			}
		}
	}()
	return nil
}
func (h *Handler) CloseBuiltinWorker() {
	h.builtins.mu.Lock()
	cancel, done := h.builtins.cancel, h.builtins.done
	h.builtins.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

type pluginInstallRecord struct {
	Name        string
	Author      string
	Description string
	ID          string
	Repository  string
	Install     pluginregistry.Install
	SourceID    string
	SourceURL   string
	SourceName  string
	Version     string
}

func readPluginInstallRecords(ctx context.Context, client *management.Client) (map[string]pluginInstallRecord, error) {
	raw, err := client.ConfigYAML(ctx)
	if err != nil {
		return nil, err
	}
	var config struct {
		Plugins struct {
			Configs map[string]struct {
				Store struct {
					Name        string                 `yaml:"name"`
					Author      string                 `yaml:"author"`
					Description string                 `yaml:"description"`
					ID          string                 `yaml:"id"`
					Repository  string                 `yaml:"repository"`
					Install     pluginregistry.Install `yaml:"install"`
					SourceID    string                 `yaml:"source-id"`
					SourceURL   string                 `yaml:"source-url"`
					SourceName  string                 `yaml:"source-name"`
					Version     string                 `yaml:"version"`
				} `yaml:"store"`
			} `yaml:"configs"`
		} `yaml:"plugins"`
	}
	if err := yaml.Unmarshal([]byte(raw), &config); err != nil {
		return nil, err
	}
	result := map[string]pluginInstallRecord{}
	for id, entry := range config.Plugins.Configs {
		if entry.Store.SourceID != "" || entry.Store.Version != "" {
			result[id] = pluginInstallRecord{Name: entry.Store.Name, Author: entry.Store.Author, Description: entry.Store.Description, ID: entry.Store.ID, Repository: entry.Store.Repository, Install: entry.Store.Install, SourceID: entry.Store.SourceID, SourceURL: entry.Store.SourceURL, SourceName: entry.Store.SourceName, Version: entry.Store.Version}
		}
	}
	return result, nil
}

func builtinNativePlugin(list management.PluginList, id string) *management.PluginItem {
	for index := range list.Plugins {
		if list.Plugins[index].ID == id {
			return &list.Plugins[index]
		}
	}
	return nil
}

func builtinInstallRecordOwned(record pluginInstallRecord, installed bool, sourceURL string) bool {
	return installed && record.SourceURL == sourceURL && record.SourceID == pluginregistry.SourceID(sourceURL)
}

func builtinRuntimeConfirmed(native *management.PluginItem, version string) bool {
	return native != nil && native.Enabled && native.Registered && native.EffectiveEnabled && native.DisplayVersion() == version
}

func builtinOperationIsUnsettled(operation repository.BuiltinOperation) bool {
	switch operation.State {
	case "pending", "indeterminate", "restart_required", "blocked":
		return true
	default:
		return false
	}
}

// builtinDesiredStateDrift is a read-only convergence probe. It looks for the
// externally caused differences a periodic pass can repair without refreshing the
// release snapshot: a managed install disappearing or changing version, its native
// switch changing, or a disabled builtin being re-enabled outside the console.
func (h *Handler) builtinDesiredStateDrift(ctx context.Context, instance domain.CPAInstance) (bool, error) {
	policy, err := h.repo.BuiltinPolicy(ctx, instance)
	if err != nil {
		return false, err
	}
	sourceURL, err := h.builtinRegistryURL()
	if err != nil {
		return false, nil
	}
	client, err := h.clientForInstance(ctx, instance)
	if err != nil {
		return false, err
	}
	records, err := readPluginInstallRecords(ctx, client)
	if err != nil {
		return false, err
	}
	if !policy.Enabled {
		for _, record := range records {
			if builtinInstallRecordOwned(record, true, sourceURL) {
				return true, nil
			}
		}
		return false, nil
	}
	state := h.builtinCatalog().State()
	if state.Status != "ready" {
		return false, nil
	}
	list, err := client.PluginList(ctx)
	if err != nil {
		return false, err
	}
	// The CPA plugin system is an operator-controlled global switch. While it is
	// off, automatic writes cannot make the desired state observable; wait for it
	// to be turned back on instead of queueing a reconciliation every minute.
	if !list.PluginsEnabled {
		return false, nil
	}
	for _, plugin := range state.Manifest.Plugins {
		record, installed := records[plugin.ID]
		owned := builtinInstallRecordOwned(record, installed, sourceURL)
		native := builtinNativePlugin(list, plugin.ID)
		operation := policy.Operations[plugin.ID]
		if policy.Overrides[plugin.ID].State == "disabled" {
			if installed && !owned {
				continue
			}
			if !installed && native != nil {
				continue
			}
			if owned && native != nil && native.Enabled {
				return true, nil
			}
			if builtinOperationIsUnsettled(operation) {
				continue
			}
			if !owned || native == nil || record.Version != plugin.Version || (native.DisplayVersion() != "" && native.DisplayVersion() != plugin.Version) {
				return true, nil
			}
			continue
		}
		if builtinOperationIsUnsettled(operation) {
			// A missing install after a failed or still-unknown operation is not
			// enough evidence to redispatch every minute. Startup and release
			// checks revisit it; a live external toggle remains immediate.
			if owned && native != nil && !native.Enabled {
				return true, nil
			}
			continue
		}
		if !owned {
			// A foreign install record or a native file without an OMC record is
			// not proof of ownership. Never reclaim a same-id plugin silently.
			if installed || native != nil {
				continue
			}
			return true, nil
		}
		if native == nil || !native.Enabled || record.Version != plugin.Version {
			return true, nil
		}
		if builtinRuntimeConfirmed(native, plugin.Version) {
			continue
		}
		// A non-empty runtime version that disagrees with the approved file is
		// evidence that the file or configuration was changed externally. Retry
		// the exact approved install. When runtime is merely not yet confirmed,
		// an unsettled operation is the expected state and must not cause a
		// reconciliation loop.
		if native.DisplayVersion() != "" && !builtinOperationIsUnsettled(operation) {
			return true, nil
		}
	}
	return false, nil
}

func (h *Handler) runBuiltinReconcile(ctx context.Context, expected domain.CPAInstance) error {
	if h.repo == nil || h.cipher == nil || h.providerWrites.permits == nil {
		return errors.New("builtin execution dependencies unavailable")
	}
	if err := h.providerWrites.acquire(ctx); err != nil {
		return err
	}
	defer h.providerWrites.release()
	h.configMu.Lock()
	defer h.configMu.Unlock()
	if err := h.repo.CheckBuiltinBinding(ctx, expected); err != nil {
		return err
	}
	policy, err := h.repo.BuiltinPolicy(ctx, expected)
	if err != nil {
		return err
	}
	sourceURL, err := h.builtinRegistryURL()
	if err != nil {
		return err
	}
	client, err := h.clientForInstance(ctx, expected)
	if err != nil {
		return err
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://builtin-worker/internal", nil)
	request.Header.Set("X-OMC-Worker", "builtin-lifecycle")
	if !policy.Enabled {
		return h.uninstallBuiltinPluginsWithClientLocked(ctx, request, expected, client, sourceURL)
	}
	state := h.builtinCatalog().State()
	if state.Status != "ready" {
		return pluginregistry.ErrFrozen
	}
	// Reachability is verified before modifying CPA; use our own local public
	// handler too in tests, with no write-gate recursion.
	probe, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(probe)
	if err != nil {
		return errors.New("CPA to OMC registry origin is unreachable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("CPA to OMC registry origin is unavailable")
	}
	for _, plugin := range state.Manifest.Plugins {
		if err := h.repo.CheckBuiltinBinding(ctx, expected); err != nil {
			return err
		}
		latestPolicy, err := h.repo.BuiltinPolicy(ctx, expected)
		if err != nil {
			return err
		}
		if latestPolicy.Revision != policy.Revision || !latestPolicy.Enabled {
			return fmt.Errorf("builtin policy changed before reconciliation: %w", repository.ErrBuiltinPolicyConflict)
		}
		override := latestPolicy.Overrides[plugin.ID]
		operation := latestPolicy.Operations[plugin.ID]
		list, err := client.PluginList(ctx)
		if err != nil {
			return err
		}
		if !list.PluginsEnabled {
			return nil
		}
		records, err := readPluginInstallRecords(ctx, client)
		if err != nil {
			return err
		}
		record, installed := records[plugin.ID]
		owned := builtinInstallRecordOwned(record, installed, sourceURL)
		native := builtinNativePlugin(list, plugin.ID)

		// Migrate only an exact, immutable legacy release. A same-id plugin from
		// another source, or a native file with no install record, is not ours to
		// replace. Leaving a source conflict visible is safer than claiming
		// executable code without proof of origin.
		if installed && !owned {
			migrated, migrateErr := h.migrateBuiltinSourceLocked(ctx, request, client, expected, plugin.ID, record, sourceURL)
			if migrateErr != nil {
				return migrateErr
			}
			if migrated {
				record.SourceID = pluginregistry.SourceID(sourceURL)
				record.SourceURL = sourceURL
				owned = true
			} else {
				if err := h.repo.SaveBuiltinOperation(ctx, expected, plugin.ID, repository.BuiltinOperation{State: "source_conflict", Reason: "installed_from_another_source"}); err != nil {
					return err
				}
				continue
			}
		}

		if !installed && native != nil {
			if err := h.repo.SaveBuiltinOperation(ctx, expected, plugin.ID, repository.BuiltinOperation{State: "source_conflict", Reason: "unowned_plugin_exists"}); err != nil {
				return err
			}
			continue
		}

		overrideDisabled := override.State == "disabled"
		if overrideDisabled {
			currentVersion := owned && native != nil && record.Version == plugin.Version && (native.DisplayVersion() == "" || native.DisplayVersion() == plugin.Version)
			if owned && native != nil && native.Enabled {
				if err := h.setBuiltinPluginEnabledWithClientLocked(ctx, request, expected, client, plugin.ID, record.Version, false); err != nil {
					return err
				}
				continue
			}
			if currentVersion {
				if operation.State == "disabled" {
					continue
				}
				if err := h.repo.SaveBuiltinOperation(ctx, expected, plugin.ID, repository.BuiltinOperation{Version: record.Version, State: "disabled"}); err != nil {
					return err
				}
				continue
			}
			if builtinOperationIsUnsettled(operation) {
				continue
			}
		}

		if owned && native != nil && record.Version == plugin.Version && builtinRuntimeConfirmed(native, plugin.Version) {
			if err := h.repo.SaveBuiltinOperation(ctx, expected, plugin.ID, repository.BuiltinOperation{Version: plugin.Version, State: "running"}); err != nil {
				return err
			}
			continue
		}
		if !overrideDisabled && owned && native != nil && !native.Enabled {
			if err := h.setBuiltinPluginEnabledWithClientLocked(ctx, request, expected, client, plugin.ID, record.Version, true); err != nil {
				return err
			}
			continue
		}

		mustInstall := !installed || !owned || native == nil || record.Version != plugin.Version
		if !mustInstall && !builtinOperationIsUnsettled(operation) && native.DisplayVersion() != "" && native.DisplayVersion() != plugin.Version {
			// An exact install record with a different native version means the
			// file was replaced outside OMC. Reinstall the approved version. While
			// an operation is unsettled, the same observation may be its pending
			// outcome, so wait instead of redispatching it on every pass.
			mustInstall = true
		}
		if !mustInstall {
			// An unchanged file that is not registered yet normally needs a CPA
			// restart. Do not repeatedly dispatch an install while that outcome is
			// already known; an external switch change or version mismatch above
			// still takes the repair path.
			if builtinOperationIsUnsettled(operation) || operation.State == "blocked" {
				continue
			}
			if err := h.repo.SaveBuiltinOperation(ctx, expected, plugin.ID, repository.BuiltinOperation{Version: record.Version, State: "restart_required", Reason: "runtime_not_confirmed"}); err != nil {
				return err
			}
			continue
		}

		if owned {
			versions := []string{record.Version}
			if native != nil && native.DisplayVersion() != "" {
				versions = append(versions, native.DisplayVersion())
			}
			for _, observedVersion := range versions {
				if comparison, comparable := pluginregistry.CompareVersions(plugin.Version, observedVersion); !comparable || comparison < 0 {
					return pluginregistry.ErrReleaseDowngrade
				}
			}
		}
		settingsRaw, err := client.ConfigYAML(ctx)
		if err != nil {
			return err
		}
		settings, err := configyaml.ReadPluginSettings(settingsRaw)
		if err != nil {
			return err
		}
		if !settings.Enabled {
			return nil
		}
		if err := h.ensureBuiltinSourceLocked(ctx, request, client, settings, sourceURL); err != nil {
			return err
		}

		if err := h.repo.CheckBuiltinBinding(ctx, expected); err != nil {
			return err
		}
		if err := h.recordAudit(request, "plugin.builtin_install", "builtin_plugin", plugin.ID, "attempt", map[string]any{"version": plugin.Version, "changed_paths": []string{"plugins.configs." + plugin.ID}}); err != nil {
			return err
		}
		if err := h.repo.SaveBuiltinOperation(ctx, expected, plugin.ID, repository.BuiltinOperation{Version: plugin.Version, State: "pending"}); err != nil {
			return err
		}
		// CPA installs this exact observed release and verifies its checksum; its
		// second registry fetch cannot select a newer release in the middle of a write.
		client.WithPluginExecutionGuard(func(guardCtx context.Context) error {
			if err := h.repo.CheckBuiltinBinding(guardCtx, expected); err != nil {
				return err
			}
			current, err := h.repo.BuiltinPolicy(guardCtx, expected)
			if err != nil {
				return err
			}
			override := current.Overrides[plugin.ID]
			if current.Revision != policy.Revision || !current.Enabled || (override.State == "disabled") != overrideDisabled {
				return fmt.Errorf("builtin policy changed before install (revision=%d expected=%d enabled=%t override=%s): %w", current.Revision, policy.Revision, current.Enabled, override.State, repository.ErrBuiltinPolicyConflict)
			}
			if _, err := h.builtinCatalog().Registry(plugin.ID, plugin.Version); err != nil {
				return err
			}
			raw, err := client.ConfigYAML(guardCtx)
			if err != nil {
				return err
			}
			settings, err := configyaml.ReadPluginSettings(raw)
			if err != nil {
				return err
			}
			if _, err := builtinPublicAuthRule(settings, sourceURL); err != nil {
				return err
			}
			observed, err := client.PluginList(guardCtx)
			if err != nil {
				return err
			}
			if !observed.PluginsEnabled {
				return errors.New("CPA plugin system is disabled")
			}
			for _, entry := range observed.Plugins {
				if !overrideDisabled && entry.ID == plugin.ID && !entry.Enabled {
					return errors.New("CPA plugin was disabled before install")
				}
			}
			return nil
		})
		result, installErr := client.InstallPlugin(ctx, plugin.ID, pluginregistry.SourceID(sourceURL), plugin.Version)
		client.WithPluginExecutionGuard(nil)
		if installErr != nil {
			state, reason := "indeterminate", "install_outcome_unknown"
			if errors.Is(installErr, management.ErrConfigBackupUnavailable) || errors.Is(installErr, management.ErrConfigChanged) || errors.Is(installErr, repository.ErrBuiltinPolicyConflict) || errors.Is(installErr, repository.ErrBuiltinBindingChanged) || errors.Is(installErr, pluginregistry.ErrFrozen) {
				state = "blocked"
				reason = "prewrite_refused"
			}
			_ = h.repo.SaveBuiltinOperation(context.WithoutCancel(ctx), expected, plugin.ID, repository.BuiltinOperation{Version: plugin.Version, State: state, Reason: reason})
			_ = h.recordAudit(request, "plugin.builtin_install", "builtin_plugin", plugin.ID, "failure", map[string]any{"outcome": "indeterminate"})
			return fmt.Errorf("install builtin release: %w", installErr)
		}
		outcome := repository.BuiltinOperation{Version: result.Version, State: "indeterminate", Reason: "runtime_not_confirmed"}
		if result.RestartRequired {
			outcome.State = "restart_required"
			outcome.Reason = "cpa_restart_required"
		}
		if overrideDisabled {
			if err := h.setBuiltinPluginEnabledWithClientLocked(ctx, request, expected, client, plugin.ID, result.Version, false); err != nil {
				_ = h.recordAudit(request, "plugin.builtin_install", "builtin_plugin", plugin.ID, "failure", map[string]any{"outcome": "installed_disable_failed", "version": result.Version})
				return err
			}
			if err := h.recordAudit(request, "plugin.builtin_install", "builtin_plugin", plugin.ID, "success", map[string]any{"state": "disabled", "version": result.Version}); err != nil {
				return fmt.Errorf("plugin installed and disabled but outcome audit failed: %w", err)
			}
			continue
		}
		readback, readErr := client.PluginList(ctx)
		installedRecords, recordsErr := readPluginInstallRecords(ctx, client)
		installedRecord := installedRecords[plugin.ID]
		if readErr == nil && recordsErr == nil && installedRecord.SourceURL == sourceURL && installedRecord.SourceID == pluginregistry.SourceID(sourceURL) && installedRecord.Version == plugin.Version {
			for _, observed := range readback.Plugins {
				if observed.ID == plugin.ID && observed.Registered && observed.EffectiveEnabled && observed.DisplayVersion() == plugin.Version {
					outcome.State = "running"
					outcome.Reason = ""
				}
			}
		}
		if err := h.repo.SaveBuiltinOperation(context.WithoutCancel(ctx), expected, plugin.ID, outcome); err != nil {
			return err
		}
		if err := h.recordAudit(request, "plugin.builtin_install", "builtin_plugin", plugin.ID, "success", map[string]any{"state": outcome.State, "version": result.Version}); err != nil {
			return fmt.Errorf("plugin installed but outcome audit failed: %w", err)
		}
	}
	return h.repo.MarkBuiltinReconciled(ctx, expected)
}

func (h *Handler) rejectBuiltinStoreInstall(id, sourceID string) error {
	sourceURL, err := h.builtinRegistryURL()
	if err != nil {
		return nil
	}
	if sourceID == pluginregistry.SourceID(sourceURL) {
		return errBuiltinManaged
	}
	if sourceID == "" {
		for _, plugin := range h.builtinCatalog().State().Manifest.Plugins {
			if plugin.ID == id {
				return errBuiltinManaged
			}
		}
	}
	return nil
}

// Builtin-owned records may only be removed or toggled through the dedicated
// builtin endpoint. A same-id plugin from another source is not builtin-owned.
func (h *Handler) rejectBuiltinNativeMutationLocked(request *http.Request, client *management.Client, id string) error {
	sourceURL, err := h.builtinRegistryURL()
	if err != nil {
		return nil
	}
	records, err := readPluginInstallRecords(request.Context(), client)
	if err != nil {
		return err
	}
	record, ok := records[id]
	if !ok || record.SourceURL != sourceURL || record.SourceID != pluginregistry.SourceID(sourceURL) {
		return nil
	}
	return errBuiltinManaged
}

func (h *Handler) applyBuiltinPluginEnabledLocked(request *http.Request, instance domain.CPAInstance, id string, enabled bool) error {
	sourceURL, err := h.builtinRegistryURL()
	if err != nil {
		return nil
	}
	client, err := h.clientForInstance(request.Context(), instance)
	if err != nil {
		return err
	}
	records, err := readPluginInstallRecords(request.Context(), client)
	if err != nil {
		return err
	}
	record, ok := records[id]
	if !ok {
		return nil
	}
	if record.SourceID != pluginregistry.SourceID(sourceURL) || record.SourceURL != sourceURL {
		return nil
	}
	return h.setBuiltinPluginEnabledWithClientLocked(request.Context(), request, instance, client, id, record.Version, enabled)
}

// setBuiltinPluginEnabledWithClientLocked is shared by the operator API and the
// periodic reconciler. The reconciler repairs a toggle changed outside OMC with
// the same audited, backup-protected write path as the UI.
func (h *Handler) setBuiltinPluginEnabledWithClientLocked(ctx context.Context, request *http.Request, instance domain.CPAInstance, client *management.Client, id, version string, enabled bool) error {
	if h.configBackupSink() == nil {
		return management.ErrConfigBackupUnavailable
	}
	if err := h.repo.CheckBuiltinBinding(ctx, instance); err != nil {
		return err
	}
	if err := h.recordAudit(request, "plugin.builtin_override", "builtin_plugin", id, "attempt", map[string]any{"enabled": enabled, "changed_paths": []string{"plugins.configs." + id}}); err != nil {
		return err
	}
	if err := client.SetPluginEnabled(ctx, id, enabled); err != nil {
		_ = h.repo.SaveBuiltinOperation(context.WithoutCancel(ctx), instance, id, repository.BuiltinOperation{Version: version, State: "indeterminate", Reason: "toggle_outcome_unknown"})
		_ = h.recordAudit(request, "plugin.builtin_override", "builtin_plugin", id, "failure", map[string]any{"enabled": enabled})
		return err
	}
	state := "pending"
	reason := "waiting_for_runtime"
	if !enabled {
		state = "disabled"
		reason = ""
	}
	if err := h.repo.SaveBuiltinOperation(ctx, instance, id, repository.BuiltinOperation{Version: version, State: state, Reason: reason}); err != nil {
		return err
	}
	return h.recordAudit(request, "plugin.builtin_override", "builtin_plugin", id, "success", map[string]any{"enabled": enabled})
}

func (h *Handler) uninstallBuiltinPluginsLocked(request *http.Request, instance domain.CPAInstance) error {
	// An unconfigured callback has no current OMC-owned source to uninstall.
	if strings.TrimSpace(h.cfg.BuiltinRegistryOrigin) == "" {
		return nil
	}
	sourceURL, err := h.builtinRegistryURL()
	if err != nil {
		return err
	}
	client, err := h.clientForInstance(request.Context(), instance)
	if err != nil {
		return err
	}
	return h.uninstallBuiltinPluginsWithClientLocked(request.Context(), request, instance, client, sourceURL)
}

func (h *Handler) uninstallBuiltinPluginsWithClientLocked(ctx context.Context, request *http.Request, instance domain.CPAInstance, client *management.Client, sourceURL string) error {
	if h.configBackupSink() == nil {
		return management.ErrConfigBackupUnavailable
	}
	records, err := readPluginInstallRecords(ctx, client)
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(records))
	for id, record := range records {
		if record.SourceURL == sourceURL && record.SourceID == pluginregistry.SourceID(sourceURL) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		if err := h.repo.CheckBuiltinBinding(ctx, instance); err != nil {
			return err
		}
		record := records[id]
		if err := h.recordAudit(request, "plugin.builtin_uninstall", "builtin_plugin", id, "attempt", map[string]any{"version": record.Version}); err != nil {
			return err
		}
		result, err := client.DeletePlugin(ctx, id)
		if err != nil {
			_ = h.repo.SaveBuiltinOperation(context.WithoutCancel(ctx), instance, id, repository.BuiltinOperation{Version: record.Version, State: "indeterminate", Reason: "uninstall_outcome_unknown"})
			_ = h.recordAudit(request, "plugin.builtin_uninstall", "builtin_plugin", id, "failure", map[string]any{"outcome": "unknown"})
			return err
		}
		state := "removed"
		reason := ""
		if result.RestartRequired {
			state = "restart_required"
			reason = "removal_requires_restart"
		}
		if err := h.repo.SaveBuiltinOperation(ctx, instance, id, repository.BuiltinOperation{Version: record.Version, State: state, Reason: reason}); err != nil {
			return err
		}
		if err := h.recordAudit(request, "plugin.builtin_uninstall", "builtin_plugin", id, "success", map[string]any{"state": state, "version": record.Version}); err != nil {
			return err
		}
	}
	return h.repo.MarkBuiltinReconciled(ctx, instance)
}

func (h *Handler) guardNativeBuiltinRouteLocked(request *http.Request, client *management.Client, routePath string, body []byte) error {
	path := strings.TrimPrefix(strings.TrimPrefix(routePath, management.PluginRoutePrefix), management.PluginRouteV8Prefix)
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 4 && parts[0] == "plugins" && parts[1] == "store" && parts[3] == "install" {
		return h.rejectBuiltinStoreInstall(parts[2], request.URL.Query().Get("source"))
	}
	if len(parts) == 3 && parts[0] == "plugin-store" && parts[2] == "install" {
		return h.rejectBuiltinStoreInstall(parts[1], request.URL.Query().Get("source"))
	}
	if len(parts) == 2 && parts[0] == "plugins" && request.Method == http.MethodDelete {
		return h.rejectBuiltinNativeMutationLocked(request, client, parts[1])
	}
	if len(parts) == 3 && parts[0] == "plugins" && parts[2] == "enabled" {
		return h.rejectBuiltinNativeMutationLocked(request, client, parts[1])
	}
	return nil
}

func builtinSourceID(address string) string {
	if address == "" {
		return ""
	}
	return pluginregistry.SourceID(address)
}

func (h *Handler) ensureBuiltinSourceLocked(ctx context.Context, request *http.Request, client *management.Client, settings configyaml.PluginSettings, sourceURL string) error {
	changes := []management.ConfigChange{}
	paths := []string{}
	hasSource := false
	for _, source := range settings.StoreSources {
		if source == sourceURL {
			hasSource = true
		}
	}
	if !hasSource {
		changes = append(changes, management.ConfigChange{Path: []string{"plugins", "store-sources"}, Value: append(settings.StoreSources, sourceURL)})
		paths = append(paths, "plugins.store-sources")
	}
	hasPublicRule, err := builtinPublicAuthRule(settings, sourceURL)
	if err != nil {
		return err
	}
	if strings.HasPrefix(sourceURL, "http://") && !hasPublicRule {
		settings.StoreAuth = append(settings.StoreAuth, configyaml.PluginStoreAuthRule{Match: sourceURL, ApplyTo: []string{"registry"}, Type: "none", AllowInsecure: true})
		set, _, err := configyaml.PluginSettingsEdit(settings)
		if err != nil {
			return err
		}
		changes = append(changes, management.ConfigChange{Path: []string{"plugins", "store-auth"}, Value: set["store-auth"]})
		paths = append(paths, "plugins.store-auth")
	}

	if len(changes) == 0 {
		return nil
	}
	if err := h.recordAudit(request, "plugin.builtin_source", "config", "plugins", "attempt", map[string]any{"changed_paths": paths}); err != nil {
		return err
	}
	if err := client.ApplyConfigChanges(management.WithBackupReason(ctx, management.BackupReasonPluginSettings), changes); err != nil {
		return err
	}
	// Verify what CPA actually retained before dispatching an executable install.
	raw, err := client.ConfigYAML(ctx)
	if err != nil {
		return err
	}
	saved, err := configyaml.ReadPluginSettings(raw)
	if err != nil {
		return err
	}
	found := false
	for _, source := range saved.StoreSources {
		if source == sourceURL {
			found = true
		}
	}
	if !found {
		return management.ErrPluginMutationConflict
	}
	if _, err := builtinPublicAuthRule(saved, sourceURL); err != nil {
		return err
	}
	return h.recordAudit(request, "plugin.builtin_source", "config", "plugins", "success", map[string]any{"changed_paths": paths})
}

// CPA chooses the first auth rule by case-insensitive scheme/host and a path
// boundary, not by a raw URL prefix. Match those semantics before permitting a
// public callback, so an existing credential rule cannot win over a later none.
func builtinPublicAuthRule(settings configyaml.PluginSettings, sourceURL string) (bool, error) {
	target, err := url.Parse(sourceURL)
	if err != nil {
		return false, err
	}
	for _, rule := range settings.StoreAuth {
		parsed, err := url.Parse(strings.TrimSpace(rule.Match))
		if err != nil {
			continue
		}
		if !strings.EqualFold(parsed.Scheme, target.Scheme) || !strings.EqualFold(parsed.Host, target.Host) {
			continue
		}
		pathMatches := parsed.Path == "" || parsed.Path == "/" || target.Path == parsed.Path || (strings.HasSuffix(parsed.Path, "/") && strings.HasPrefix(target.Path, parsed.Path)) || strings.HasPrefix(target.Path, parsed.Path+"/")
		if !pathMatches {
			continue
		}
		applies, hasRequestKind := false, false
		for _, kind := range rule.ApplyTo {
			normalized := strings.TrimSpace(kind)
			if normalized == "" {
				continue
			}
			hasRequestKind = true
			if strings.EqualFold(normalized, "registry") {
				applies = true
			}
		}
		// CPA removes blank kinds before matching; an empty normalized list
		// applies to every request, including registry callbacks.
		if !hasRequestKind {
			applies = true
		}
		if !applies {
			continue
		}
		if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != target.Path || !strings.EqualFold(strings.TrimSpace(rule.Type), "none") || (strings.EqualFold(target.Scheme, "http") && !rule.AllowInsecure) {
			return false, errors.New("builtin registry conflicts with an existing CPA store auth rule")
		}
		return true, nil
	}
	return false, nil
}
