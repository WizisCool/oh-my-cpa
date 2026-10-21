package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// managedSourceStoredYAML is the file a stand-in gateway has on disk. It is v8, so
// every write path converts nothing and backs nothing up.
const managedSourceStoredYAML = `config-version: 8
plugins:
    enabled: true
`

// managedSourceCPA is a gateway whose store-source list is the thing under test: the
// configuration view is rendered from it, the store catalogue is derived from it, and
// a configuration write changes it. That is what lets a test see whether the file
// ended up agreeing with the operator's switch.
type managedSourceCPA struct {
	mu      sync.Mutex
	sources []string
	writes  []string
	reads   int
	install string
	yaml    string
}

func (f *managedSourceCPA) sourceList() []string {
	return append([]string(nil), f.sources...)
}

func (f *managedSourceCPA) hasSource(source string) bool {
	for _, candidate := range f.sources {
		if candidate == source {
			return true
		}
	}
	return false
}

// render writes the plugins section from the current list; the test only needs the
// shape configyaml reads.
func (f *managedSourceCPA) render() string {
	var document strings.Builder
	document.WriteString(managedSourceStoredYAML)
	if len(f.sources) > 0 {
		document.WriteString("    store-sources:\n")
		for _, source := range f.sources {
			document.WriteString("        - " + source + "\n")
		}
	}
	return document.String()
}

func (f *managedSourceCPA) revision() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return configyaml.ComputeRevision(f.render())
}

func (f *managedSourceCPA) setSources(sources []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sources = append([]string(nil), sources...)
}

func (f *managedSourceCPA) recordedWrites() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.writes...)
}

func managedStoreEntry(storeID, sourceID, sourceName, sourceURL, id, name, version, repository string) map[string]any {
	return map[string]any{
		"store_id": storeID, "source_id": sourceID, "source_name": sourceName, "source_url": sourceURL,
		"id": id, "name": name, "description": name + " for the gateway.", "author": "router-for-me",
		"version": version, "repository": repository, "install_type": "github_release",
		"auth_required": false, "auth_configured": false, "platforms": []any{map[string]any{"goos": "linux", "goarch": "amd64"}},
		"installed": false, "installed_version": "", "effective_enabled": false, "update_available": false,
	}
}

func (f *managedSourceCPA) serve(writer http.ResponseWriter, request *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	writer.Header().Set("Content-Type", "application/json")
	path := strings.TrimPrefix(request.URL.Path, "/v8/management")

	switch {
	case request.Method == http.MethodGet && path == "/config.yaml":
		writer.Header().Set("Content-Type", "application/yaml")
		_, _ = writer.Write([]byte(f.render()))
	case request.Method == http.MethodPatch && path == "/config":
		body, _ := io.ReadAll(request.Body)
		f.writes = append(f.writes, request.Method+" "+path+" "+string(body))
		var merge struct {
			Plugins struct {
				StoreSources []string `json:"store-sources"`
			} `json:"plugins"`
		}
		if json.Unmarshal(body, &merge) == nil && merge.Plugins.StoreSources != nil {
			f.sources = append([]string(nil), merge.Plugins.StoreSources...)
		}
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	case request.Method == http.MethodDelete && path == "/config/plugins/store-sources":
		f.writes = append(f.writes, request.Method+" "+path)
		f.sources = nil
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	case request.Method == http.MethodPut && path == "/config.yaml":
		body, _ := io.ReadAll(request.Body)
		f.writes = append(f.writes, request.Method+" "+path)
		f.yaml = string(body)
		settings, err := configyaml.ReadPluginSettings(f.yaml)
		if err != nil {
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = writer.Write([]byte(`{"error":"invalid_config"}`))
			return
		}
		f.sources = append([]string(nil), settings.StoreSources...)
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	case request.Method == http.MethodGet && path == "/plugins/store":
		f.reads++
		sources := []map[string]any{{
			"id": "official", "name": "official", "url": "https://plugins.router-for-me.example/registry.json",
		}}
		plugins := []map[string]any{managedStoreEntry(
			"official/limiter", "official", "official", "https://plugins.router-for-me.example/registry.json",
			"limiter", "Rate limiter", "1.2.0", "router-for-me/limiter",
		)}
		if f.hasSource(pluginregistry.OMCSourceURL) {
			sources = append(sources, map[string]any{
				"id": pluginregistry.SourceID(pluginregistry.OMCSourceURL), "name": "raw.githubusercontent.com", "url": pluginregistry.OMCSourceURL,
			})
			plugins = append(plugins, managedStoreEntry(
				pluginregistry.SourceID(pluginregistry.OMCSourceURL)+"/usage-digest",
				pluginregistry.SourceID(pluginregistry.OMCSourceURL), "raw.githubusercontent.com", pluginregistry.OMCSourceURL,
				"usage-digest", "Usage digest", "0.3.0", "WizisCool/omc-plugin-usage-digest",
			))
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"plugins_enabled": true, "plugins_dir": "plugins",
			"sources": sources, "source_errors": []any{}, "plugins": plugins,
		})
	case request.Method == http.MethodPost && strings.HasPrefix(path, "/plugins/store/") && strings.HasSuffix(path, "/install"):
		f.install = path + "?" + request.URL.RawQuery
		_, _ = writer.Write([]byte(`{"status":"installed","source_id":"` + pluginregistry.SourceID(pluginregistry.OMCSourceURL) + `","id":"usage-digest","version":"0.3.0","plugins_enabled":true,"restart_required":false}`))
	default:
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":"not_found"}`))
	}
}

func setManagedSourcePreference(t *testing.T, repo *repository.Repository, enabled bool) {
	t.Helper()
	value := "false"
	if enabled {
		value = "true"
	}
	if err := repo.PutPreference(context.Background(), repository.PreferenceOMCPluginSource, value); err != nil {
		t.Fatalf("store the plugin source preference: %v", err)
	}
}

type managedStoreResponse struct {
	Sources      []PluginStoreSourceDTO      `json:"sources"`
	SourceErrors []PluginStoreSourceErrorDTO `json:"source_errors"`
	Plugins      []StorePluginItemDTO        `json:"plugins"`
	Total        int                         `json:"total"`
}

func readManagedStore(t *testing.T, client *http.Client, baseURL string) managedStoreResponse {
	t.Helper()
	response, body := getJSON(t, client, baseURL+"/omc/api/v1/management/plugin-store")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("plugin store: status %d body %s", response.StatusCode, body)
	}
	var store managedStoreResponse
	if err := json.Unmarshal(body, &store); err != nil {
		t.Fatalf("decode the plugin store: %v (%s)", err, body)
	}
	return store
}

// The registry this console ships is present without anyone configuring it, and it is
// listed before the other registries so an operator looking for an Oh My CPA plugin
// finds it without searching.
func TestPluginStoreAddsTheManagedSource(t *testing.T) {
	gateway := &managedSourceCPA{}
	client, baseURL, repo := startDashboardTestServerStoring(t, managedSourceStoredYAML, gateway.serve)

	store := readManagedStore(t, client, baseURL)
	writes := gateway.recordedWrites()
	if len(writes) != 1 || !strings.Contains(writes[0], pluginregistry.OMCSourceURL) {
		t.Fatalf("configuration writes = %q, want one write adding the registry", writes)
	}
	// The repair is an ordinary configuration write, so it keeps a copy first and
	// records why it happened rather than changing the file silently.
	backups := listConfigBackupsForTest(t, client, baseURL)
	if len(backups.Backups) != 1 || backups.Backups[0].Reason != "plugin_settings" || backups.Backups[0].Layout != "v8" {
		t.Fatalf("backups = %+v, want the pre-repair copy with the plugin-settings reason", backups.Backups)
	}
	events, err := repo.ListAuditEvents(context.Background(), 20)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	isAudited := false
	for _, event := range events {
		if event.Action == "plugin.source" && event.Result == "success" && event.TargetID == "plugins.store-sources" {
			isAudited = true
			break
		}
	}
	if !isAudited {
		t.Fatalf("audit events = %+v, want a successful plugin.source record", events)
	}
	if len(store.Plugins) != 2 {
		t.Fatalf("store entries = %#v, want the built-in and the managed registry's", store.Plugins)
	}
	if !store.Plugins[0].IsOMC || store.Plugins[0].SourceName != pluginregistry.OMCSourceName {
		t.Fatalf("first entry = %#v, want the managed registry's entry named and pinned first", store.Plugins[0])
	}
	if store.Plugins[1].IsOMC || !store.Plugins[1].IsOfficial {
		t.Fatalf("second entry = %#v, want the official one after it", store.Plugins[1])
	}
	if len(store.Sources) != 2 || store.Sources[1].Name != pluginregistry.OMCSourceName {
		t.Fatalf("sources = %#v, want the managed registry renamed", store.Sources)
	}

	// Reading again is idempotent: the file already agrees with the switch.
	readManagedStore(t, client, baseURL)
	if writes := gateway.recordedWrites(); len(writes) != 1 {
		t.Fatalf("configuration writes = %q, want no second repair", writes)
	}
}

// Switching the source off removes it from the gateway's file and from the catalogue;
// switching it back on restores both.
func TestPluginStoreFollowsTheManagedSourceSwitch(t *testing.T) {
	gateway := &managedSourceCPA{sources: []string{"https://plugins.example/registry.json", pluginregistry.OMCSourceURL}}
	client, baseURL, repo := startDashboardTestServerStoring(t, managedSourceStoredYAML, gateway.serve)

	setManagedSourcePreference(t, repo, false)
	store := readManagedStore(t, client, baseURL)
	if gateway.hasSource(pluginregistry.OMCSourceURL) {
		t.Fatalf("the switched-off registry remained in the file: %q", gateway.sourceList())
	}
	if len(store.Plugins) != 1 || store.Plugins[0].IsOMC {
		t.Fatalf("store entries = %#v, want none from the switched-off registry", store.Plugins)
	}
	for _, source := range store.Sources {
		if source.Name == pluginregistry.OMCSourceName {
			t.Fatalf("sources = %#v, want the switched-off registry absent", store.Sources)
		}
	}
	// The operator's own registry is untouched.
	if !gateway.hasSource("https://plugins.example/registry.json") {
		t.Fatalf("the operator's registry was removed with it: %q", gateway.sourceList())
	}

	setManagedSourcePreference(t, repo, true)
	store = readManagedStore(t, client, baseURL)
	if !gateway.hasSource(pluginregistry.OMCSourceURL) {
		t.Fatalf("the switched-on registry is missing from the file: %q", gateway.sourceList())
	}
	if len(store.Plugins) != 2 || !store.Plugins[0].IsOMC {
		t.Fatalf("store entries = %#v, want the managed registry back and first", store.Plugins)
	}
}

// The managed registry is not one of the sources the settings page edits: it is
// omitted from the editable list, reported separately, and put back on every save.
func TestPluginSettingsKeepTheManagedSourceOutOfTheEditableList(t *testing.T) {
	gateway := &managedSourceCPA{sources: []string{pluginregistry.OMCSourceURL}}
	client, baseURL, _ := startDashboardTestServerStoring(t, managedSourceStoredYAML, gateway.serve)
	response, body := getJSON(t, client, baseURL+"/omc/api/v1/management/plugins/settings")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("settings: status %d body %s", response.StatusCode, body)
	}
	var settings PluginSettingsDTO
	if err := json.Unmarshal(body, &settings); err != nil {
		t.Fatal(err)
	}
	if len(settings.StoreSources) != 0 {
		t.Fatalf("store_sources = %#v, want the managed registry excluded", settings.StoreSources)
	}
	if !settings.OMCSourceEnabled || settings.OMCSourceURL != pluginregistry.OMCSourceURL {
		t.Fatalf("managed source = %t %q", settings.OMCSourceEnabled, settings.OMCSourceURL)
	}

	// A client that submits the managed address itself must not end up listing it
	// twice, and one that omits it must not remove it.
	payload, err := json.Marshal(map[string]any{
		"revision":      settings.Revision,
		"enabled":       true,
		"store_sources": []string{"https://plugins.example/registry.json", pluginregistry.OMCSourceURL},
		"store_auth":    []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	putResponse, putBody := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/plugins/settings", string(payload))
	if putResponse.StatusCode != http.StatusOK {
		t.Fatalf("save settings: status %d body %s", putResponse.StatusCode, putBody)
	}
	var saved PluginSettingsDTO
	if err := json.Unmarshal(putBody, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.StoreSources) != 1 || saved.StoreSources[0] != "https://plugins.example/registry.json" {
		t.Fatalf("saved store_sources = %#v, want only the operator's registry", saved.StoreSources)
	}
	want := []string{"https://plugins.example/registry.json", pluginregistry.OMCSourceURL}
	if got := gateway.sourceList(); len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("written sources = %#v, want the operator's then the managed one", got)
	}
}

// A save must not re-add the managed registry while the operator has it switched off.
func TestPluginSettingsDoNotRestoreASwitchedOffManagedSource(t *testing.T) {
	gateway := &managedSourceCPA{sources: []string{"https://plugins.example/registry.json", pluginregistry.OMCSourceURL}}
	client, baseURL, repo := startDashboardTestServerStoring(t, managedSourceStoredYAML, gateway.serve)
	setManagedSourcePreference(t, repo, false)

	response, body := getJSON(t, client, baseURL+"/omc/api/v1/management/plugins/settings")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("settings: status %d body %s", response.StatusCode, body)
	}
	var settings PluginSettingsDTO
	if err := json.Unmarshal(body, &settings); err != nil {
		t.Fatal(err)
	}
	if settings.OMCSourceEnabled {
		t.Fatalf("the switch reads on after being stored off")
	}
	payload, _ := json.Marshal(map[string]any{
		"revision":      settings.Revision,
		"enabled":       true,
		"store_sources": []string{"https://plugins.example/registry.json"},
		"store_auth":    []any{},
	})
	putResponse, putBody := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/plugins/settings", string(payload))
	if putResponse.StatusCode != http.StatusOK {
		t.Fatalf("save settings: status %d body %s", putResponse.StatusCode, putBody)
	}
	if got := gateway.sourceList(); len(got) != 1 || got[0] != "https://plugins.example/registry.json" {
		t.Fatalf("written sources = %#v, want the managed registry left out", got)
	}
}

// A configuration save that removes the managed registry is repaired inside the same
// transaction, and the revision the editor receives is the repaired document.
func TestConfigurationPatchRestoresTheManagedSource(t *testing.T) {
	gateway := &managedSourceCPA{sources: []string{pluginregistry.OMCSourceURL}}
	client, baseURL, _ := startDashboardTestServerStoring(t, managedSourceStoredYAML, gateway.serve)

	payload, _ := json.Marshal(map[string]any{
		"revision": gateway.revision(),
		"changes":  []map[string]any{{"path": []string{"plugins", "store-sources"}, "remove": true}},
	})
	response, body := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/config", string(payload))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("save configuration: status %d body %s", response.StatusCode, body)
	}
	var saved struct {
		SafeYAML string `json:"safe_yaml"`
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(body, &saved); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(saved.SafeYAML, pluginregistry.OMCSourceURL) {
		t.Fatalf("the editor's baseline does not contain the managed registry: %s", saved.SafeYAML)
	}
	if !gateway.hasSource(pluginregistry.OMCSourceURL) {
		t.Fatalf("the managed registry was not restored: %q", gateway.sourceList())
	}
	if saved.Revision != gateway.revision() {
		t.Fatalf("revision = %q, want the repaired document's %q", saved.Revision, gateway.revision())
	}
}

// The whole-document editor is the same rule: a document that omits the managed
// registry is stored, then repaired, and the baseline returned carries it.
func TestConfigurationSourceSaveRestoresTheManagedSource(t *testing.T) {
	gateway := &managedSourceCPA{sources: []string{pluginregistry.OMCSourceURL}}
	client, baseURL, _ := startDashboardTestServerStoring(t, managedSourceStoredYAML, gateway.serve)

	payload, _ := json.Marshal(map[string]any{
		"revision": gateway.revision(),
		"yaml":     managedSourceStoredYAML + "    store-sources:\n        - https://plugins.example/registry.json\n",
	})
	response, body := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(payload))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("save configuration source: status %d body %s", response.StatusCode, body)
	}
	var saved struct {
		YAML string `json:"yaml"`
	}
	if err := json.Unmarshal(body, &saved); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(saved.YAML, pluginregistry.OMCSourceURL) || !strings.Contains(saved.YAML, "https://plugins.example/registry.json") {
		t.Fatalf("saved yaml = %s, want both registries", saved.YAML)
	}
}

// Installing from the managed registry repairs the file first: CPA can only install
// from a source it knows.
func TestPluginInstallReconcilesTheManagedSource(t *testing.T) {
	gateway := &managedSourceCPA{}
	client, baseURL, _ := startDashboardTestServerStoring(t, managedSourceStoredYAML, gateway.serve)

	response, body := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/plugin-store/usage-digest/install",
		`{"source_id":"`+pluginregistry.SourceID(pluginregistry.OMCSourceURL)+`"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("install: status %d body %s", response.StatusCode, body)
	}
	if !strings.HasPrefix(gateway.install, "/plugins/store/usage-digest/install?source=source-") {
		t.Fatalf("install reached CPA as %q, want the managed source named", gateway.install)
	}
	if !gateway.hasSource(pluginregistry.OMCSourceURL) {
		t.Fatalf("the install did not repair the file: %q", gateway.sourceList())
	}
}

// The demonstration serves a fixed catalogue and refuses configuration writes, so the
// switch is answered by the store response itself rather than by a repair.
func TestPluginStoreInADemonstrationFiltersTheSwitchedOffManagedSource(t *testing.T) {
	gateway := &managedSourceCPA{sources: []string{pluginregistry.OMCSourceURL}}
	handler := func(writer http.ResponseWriter, request *http.Request) { gateway.serve(writer, request) }
	client, baseURL, repo := startDashboardTestServerStoring(t, managedSourceStoredYAML, handler, func(handler *Handler) {
		handler.cfg.IsDemoMode = true
	})
	setManagedSourcePreference(t, repo, false)

	store := readManagedStore(t, client, baseURL)
	if len(store.Plugins) != 1 || store.Plugins[0].IsOMC {
		t.Fatalf("store entries = %#v, want the demonstration's managed entries withheld", store.Plugins)
	}
	if writes := gateway.recordedWrites(); len(writes) != 0 {
		t.Fatalf("configuration writes = %q, want none in a demonstration", writes)
	}
}

// A JSON null decodes into the zero value without an error, so it is not a "false"
// the operator chose: it is a document this build cannot read, and the source's
// default is on. The write path refuses it, but a value stored by an older build or
// another writer still has to be read safely.
func TestPluginStoreTreatsAStoredNullPreferenceAsOn(t *testing.T) {
	gateway := &managedSourceCPA{}
	client, baseURL, repo := startDashboardTestServerStoring(t, managedSourceStoredYAML, gateway.serve)
	if err := repo.PutPreference(context.Background(), repository.PreferenceOMCPluginSource, "null"); err != nil {
		t.Fatalf("store the null preference: %v", err)
	}

	store := readManagedStore(t, client, baseURL)
	if !gateway.hasSource(pluginregistry.OMCSourceURL) {
		t.Fatalf("a null preference removed the managed registry: %q", gateway.sourceList())
	}
	if len(store.Plugins) != 2 || !store.Plugins[0].IsOMC {
		t.Fatalf("store entries = %#v, want the managed registry's entry", store.Plugins)
	}
}

// A configuration save can leave a plugins section this build cannot read back. The
// save has already landed at that point, so the refusal has to say so rather than read
// as "nothing happened" and leave the editor's next save in a conflict it cannot explain.
func TestPluginSourceReconcileErrorAfterASaveSaysTheSaveLanded(t *testing.T) {
	unreadable := fmt.Errorf("%w: plugins: scalar", configyaml.ErrPluginSettingsUnreadable)

	recorder := httptest.NewRecorder()
	writePluginSourceError(recorder, unreadable, true)
	body := recorder.Body.String()
	if recorder.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(body, "configuration was saved") ||
		!strings.Contains(body, `"code":"plugin_settings_unreadable"`) {
		t.Fatalf("after-save refusal = %d %s, want a saved statement with a stable code", recorder.Code, body)
	}

	recorder = httptest.NewRecorder()
	writePluginSourceError(recorder, unreadable, false)
	body = recorder.Body.String()
	if recorder.Code != http.StatusUnprocessableEntity || strings.Contains(body, "configuration was saved") {
		t.Fatalf("plain refusal = %d %s, want it to claim no save", recorder.Code, body)
	}
}
