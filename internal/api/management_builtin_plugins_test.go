package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type builtinGatewayFixture struct {
	mu               sync.Mutex
	handler          *Handler
	installed        bool
	nativeOnly       bool
	enabled          bool
	registered       bool
	runtimeVersion   string
	effective        bool
	restart          bool
	sourceOverride   string
	installedVersion string
	installRegisters bool
	pluginsEnabled   bool
	dangerousAuth    bool
	mutations        atomic.Int32
	callback         chan struct{}
}

func (fixture *builtinGatewayFixture) setState(installed, nativeOnly, enabled, registered, effective bool, runtimeVersion, installedVersion string) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	fixture.installed = installed
	fixture.nativeOnly = nativeOnly
	fixture.enabled = enabled
	fixture.registered = registered
	fixture.effective = effective
	fixture.runtimeVersion = runtimeVersion
	fixture.installedVersion = installedVersion
}

func (fixture *builtinGatewayFixture) currentEnabled() bool {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return fixture.enabled
}

func (fixture *builtinGatewayFixture) currentInstalled() bool {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return fixture.installed
}

func (fixture *builtinGatewayFixture) serve(writer http.ResponseWriter, request *http.Request) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	sourceURL, _ := fixture.handler.builtinRegistryURL()
	sourceID := pluginregistry.SourceID(sourceURL)
	writer.Header().Set("Content-Type", "application/json")
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		fixture.mutations.Add(1)
	}
	switch {
	case request.URL.Path == "/v0/management/config":
		_, _ = writer.Write([]byte(`{"plugins":{"enabled":true}}`))
	case request.URL.Path == "/v8/management/config.yaml":
		writer.Header().Set("Content-Type", "application/yaml")
		if fixture.dangerousAuth {
			fmt.Fprintf(writer, "config-version: 8\nplugins:\n  enabled: %t\n  store-sources:\n    - %s\n  store-auth:\n    - match: %s\n      type: bearer\n      apply-to: [\" Registry \"]\n      token-env: CPA_SYNTHETIC_PLUGIN_TOKEN\n      allow-insecure: true\n", fixture.pluginsEnabled, sourceURL, strings.Replace(sourceURL, "http://", "HTTP://", 1))
		} else {
			fmt.Fprintf(writer, "config-version: 8\nplugins:\n  enabled: %t\n  store-sources:\n    - %s\n  store-auth:\n    - match: %s\n      type: none\n      apply-to: [registry]\n      allow-insecure: true\n", fixture.pluginsEnabled, sourceURL, sourceURL)
		}
		if fixture.installed {
			if fixture.sourceOverride != "" {
				sourceID = fixture.sourceOverride
			}
			fmt.Fprintf(writer, "  configs:\n    omc-zcode-oauth:\n      enabled: %t\n      store:\n        source-id: %s\n        source-url: %s\n        version: %s\n", fixture.enabled, sourceID, sourceURL, fixture.installedVersion)
		}
	case request.URL.Path == "/v8/management/config" && request.Method == http.MethodPatch:
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			http.Error(writer, "invalid config patch", http.StatusBadRequest)
			return
		}
		if plugins, ok := body["plugins"].(map[string]any); ok {
			if configs, ok := plugins["configs"].(map[string]any); ok {
				if plugin, ok := configs["omc-zcode-oauth"].(map[string]any); ok {
					if enabled, ok := plugin["enabled"].(bool); ok {
						fixture.enabled = enabled
					}
				}
			}
		}
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{}`))
	case request.URL.Path == "/v8/management/plugins" && request.Method == http.MethodGet:
		if fixture.installed || fixture.nativeOnly {
			metadata := map[string]any{}
			if fixture.registered {
				metadata = map[string]any{"name": "ZCode OAuth", "version": fixture.runtimeVersion}
			}
			path := "plugins/omc-zcode-oauth.so"
			configured := fixture.installed
			_ = json.NewEncoder(writer).Encode(map[string]any{"plugins_enabled": fixture.pluginsEnabled, "plugins": []any{map[string]any{"id": "omc-zcode-oauth", "path": path, "configured": configured, "registered": fixture.registered, "enabled": fixture.enabled, "effective_enabled": fixture.effective, "metadata": metadata}}})
		} else {
			_, _ = writer.Write([]byte(fmt.Sprintf(`{"plugins_enabled":%t,"plugins":[]}`, fixture.pluginsEnabled)))
		}
	case strings.HasSuffix(request.URL.Path, "/omc-zcode-oauth/install"):
		if request.URL.Query().Get("source") != pluginregistry.SourceID(sourceURL) {
			http.Error(writer, "missing exact source", 400)
			return
		}
		var body struct {
			Version string `json:"version"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		manifest := fixture.handler.builtinCatalog().State().Manifest.Plugins
		if len(manifest) != 1 || body.Version != manifest[0].Version {
			http.Error(writer, "missing exact version", 400)
			return
		}
		if len(fixture.handler.providerWrites.permits) != 1 {
			http.Error(writer, "installer is outside shared gate", 500)
			return
		}
		// A real CPA installer synchronously re-fetches this registry. The callback
		// cannot acquire the gate held by the operation waiting for this response.
		callback, err := http.NewRequestWithContext(request.Context(), http.MethodGet, sourceURL, nil)
		if err != nil {
			http.Error(writer, "callback request", 500)
			return
		}
		response, err := http.DefaultClient.Do(callback)
		if err != nil {
			http.Error(writer, "callback failed", 500)
			return
		}
		raw, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 200 || !strings.Contains(string(raw), `"type":"direct"`) {
			http.Error(writer, "callback did not return approval", 500)
			return
		}
		select {
		case fixture.callback <- struct{}{}:
		default:
		}
		fixture.installed = true
		fixture.nativeOnly = false
		fixture.enabled = true
		fixture.installedVersion = body.Version
		if fixture.installRegisters && !fixture.restart {
			fixture.registered = true
			fixture.effective = true
			fixture.runtimeVersion = body.Version
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"status": "installed", "id": "omc-zcode-oauth", "version": body.Version, "plugins_enabled": fixture.pluginsEnabled, "restart_required": fixture.restart})
	case request.URL.Path == "/v8/management/plugins/omc-zcode-oauth" && request.Method == http.MethodDelete:
		if !fixture.installed {
			http.NotFound(writer, request)
			return
		}
		fixture.installed = false
		fixture.nativeOnly = false
		fixture.enabled = false
		fixture.registered = false
		fixture.effective = false
		fixture.runtimeVersion = ""
		fixture.installedVersion = ""
		_ = json.NewEncoder(writer).Encode(map[string]any{"status": "deleted", "id": "omc-zcode-oauth", "file_deleted": true, "configured_removed": true, "restart_required": false})
	default:
		http.NotFound(writer, request)
	}
}

func builtinSnapshot(t *testing.T, version, digest string) []byte {
	t.Helper()
	plugin := pluginregistry.NewCatalog(nil).State().Manifest.Plugins[0]
	plugin.Version = version
	plugin.Install.Type = "direct"
	for _, platform := range []string{"darwin/amd64", "darwin/arm64", "linux/amd64", "linux/arm64", "windows/amd64", "windows/arm64"} {
		parts := strings.Split(platform, "/")
		name := plugin.ID + "_" + version + "_" + parts[0] + "_" + parts[1] + ".zip"
		plugin.Install.Artifacts = append(plugin.Install.Artifacts, pluginregistry.Artifact{GOOS: parts[0], GOARCH: parts[1], URL: plugin.Repository + "/releases/download/v" + version + "/" + name, SHA256: digest, Size: 1024})
	}
	raw, err := json.Marshal(pluginregistry.Manifest{SchemaVersion: 2, Plugins: []pluginregistry.Plugin{plugin}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func builtinReleaseJSON(t *testing.T, snapshot []byte) []byte {
	t.Helper()
	var manifest pluginregistry.Manifest
	if err := json.Unmarshal(snapshot, &manifest); err != nil {
		t.Fatal(err)
	}
	plugin := manifest.Plugins[0]
	assets := []map[string]any{}
	for _, artifact := range plugin.Install.Artifacts {
		name := plugin.ID + "_" + plugin.Version + "_" + artifact.GOOS + "_" + artifact.GOARCH + ".zip"
		assets = append(assets, map[string]any{"name": name, "state": "uploaded", "size": artifact.Size, "digest": "sha256:" + artifact.SHA256, "browser_download_url": artifact.URL})
	}
	raw, err := json.Marshal(map[string]any{"tag_name": "v" + plugin.Version, "draft": false, "prerelease": false, "assets": assets})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func newBuiltinFixture(t *testing.T) (*Handler, *builtinGatewayFixture, *http.Client, string, domain.CPAInstance) {
	t.Helper()
	fixture := &builtinGatewayFixture{runtimeVersion: "0.1.4", installedVersion: "0.1.4", installRegisters: true, enabled: true, registered: true, effective: true, pluginsEnabled: true, callback: make(chan struct{}, 1)}
	var handler *Handler
	client, baseURL, repo := startDashboardTestServerStoring(t, "config-version: 8\nplugins:\n  enabled: true\n", fixture.serve, func(current *Handler) { handler = current; fixture.handler = current })
	handler.cfg.BuiltinRegistryOrigin = baseURL
	if err := handler.builtinCatalog().Accept(context.Background(), builtinSnapshot(t, "0.1.4", strings.Repeat("a", 64))); err != nil {
		t.Fatal(err)
	}
	instance, err := repo.GetInstance(context.Background(), defaultInstanceID())
	if err != nil {
		t.Fatal(err)
	}
	return handler, fixture, client, baseURL, instance
}

func saveBuiltinGlobal(t *testing.T, handler *Handler, instance domain.CPAInstance, enabled bool) repository.BuiltinPolicy {
	t.Helper()
	policy, err := handler.repo.BuiltinPolicy(context.Background(), instance)
	if err != nil {
		t.Fatal(err)
	}
	policy.Enabled = enabled
	if err := handler.repo.SaveBuiltinPolicy(context.Background(), instance, policy, policy.Revision, "", nil); err != nil {
		t.Fatal(err)
	}
	policy, err = handler.repo.BuiltinPolicy(context.Background(), instance)
	if err != nil {
		t.Fatal(err)
	}
	return policy
}

func saveBuiltinPluginEnabled(t *testing.T, handler *Handler, instance domain.CPAInstance, enabled bool) repository.BuiltinPolicy {
	t.Helper()
	policy, err := handler.repo.BuiltinPolicy(context.Background(), instance)
	if err != nil {
		t.Fatal(err)
	}
	state := "default"
	if !enabled {
		state = "disabled"
	}
	override := repository.BuiltinPluginPolicy{State: state}
	if err := handler.repo.SaveBuiltinPolicy(context.Background(), instance, policy, policy.Revision, "omc-zcode-oauth", &override); err != nil {
		t.Fatal(err)
	}
	policy, err = handler.repo.BuiltinPolicy(context.Background(), instance)
	if err != nil {
		t.Fatal(err)
	}
	return policy
}

func TestBuiltinInstallerCallbackDoesNotDeadlockAnd200IsNotRuntimeEvidence(t *testing.T) {
	for _, runtime := range []struct {
		name                           string
		registered, effective, restart bool
		version, want                  string
	}{
		{name: "stored only", want: "indeterminate"},
		{name: "old runtime", registered: true, effective: true, version: "0.1.3", want: "indeterminate"},
		{name: "restart", restart: true, want: "restart_required"},
		{name: "confirmed", registered: true, effective: true, version: "0.1.4", want: "running"},
	} {
		t.Run(runtime.name, func(t *testing.T) {
			handler, fixture, _, baseURL, instance := newBuiltinFixture(t)
			fixture.setState(false, false, false, runtime.registered, runtime.effective, runtime.version, "")
			fixture.mu.Lock()
			fixture.restart = runtime.restart
			fixture.installRegisters = false
			fixture.mu.Unlock()
			// No management session or credentials are needed for the public callback.
			public, err := http.Get(baseURL + "/omc" + pluginregistry.PublicRegistryPath)
			if err != nil {
				t.Fatal(err)
			}
			public.Body.Close()
			if public.StatusCode != 200 {
				t.Fatalf("public registry = %d", public.StatusCode)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			completed := make(chan error, 1)
			go func() { completed <- handler.runBuiltinReconcile(ctx, instance) }()
			select {
			case <-fixture.callback:
			case <-ctx.Done():
				t.Fatal("installer callback deadlocked on write gate")
			}
			select {
			case err := <-completed:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("installer did not complete")
			}
			policy, err := handler.repo.BuiltinPolicy(ctx, instance)
			if err != nil {
				t.Fatal(err)
			}
			if got := policy.Operations["omc-zcode-oauth"].State; got != runtime.want {
				t.Fatalf("runtime outcome = %s, want %s", got, runtime.want)
			}
			if err := handler.runBuiltinReconcile(ctx, instance); err != nil {
				t.Fatal(err)
			}
			if fixture.mutations.Load() != 1 {
				t.Fatalf("unknown success was repeated: CPA mutations=%d", fixture.mutations.Load())
			}
		})
	}
}

func TestBuiltinExecutionRefusesMissingDependenciesGlobalAndSystemSwitches(t *testing.T) {
	for _, failure := range []string{"global off", "plugin system off", "missing cipher", "missing gate", "audit", "backup"} {
		t.Run(failure, func(t *testing.T) {
			handler, fixture, _, _, instance := newBuiltinFixture(t)
			switch failure {
			case "global off":
				saveBuiltinGlobal(t, handler, instance, false)
			case "plugin system off":
				fixture.mu.Lock()
				fixture.pluginsEnabled = false
				fixture.mu.Unlock()
			case "missing cipher":
				handler.cipher = nil
			case "missing gate":
				handler.providerWrites.permits = nil
			case "audit":
				if _, err := handler.repo.SQL().Exec(`CREATE TRIGGER refuse_builtin_audit BEFORE INSERT ON audit_events WHEN NEW.action='plugin.builtin_install' BEGIN SELECT RAISE(FAIL,'audit unavailable'); END`); err != nil {
					t.Fatal(err)
				}
			case "backup":
				if _, err := handler.repo.SQL().Exec(`CREATE TRIGGER refuse_builtin_backup BEFORE INSERT ON cpa_config_backups BEGIN SELECT RAISE(FAIL,'backup unavailable'); END`); err != nil {
					t.Fatal(err)
				}
			}
			_ = handler.runBuiltinReconcile(context.Background(), instance)
			if fixture.mutations.Load() != 0 {
				t.Fatalf("CPA was mutated despite a failed precondition: %d", fixture.mutations.Load())
			}
		})
	}
}

func TestBuiltinQueuedTaskCannotFollowReboundDefaultInstance(t *testing.T) {
	handler, fixture, _, _, instance := newBuiltinFixture(t)
	rebound := instance
	rebound.BaseURL = "http://second.invalid"
	if err := handler.repo.UpsertInstance(context.Background(), rebound); err != nil {
		t.Fatal(err)
	}
	if err := handler.runBuiltinReconcile(context.Background(), instance); !errors.Is(err, repository.ErrBuiltinBindingChanged) {
		t.Fatalf("stale task = %v", err)
	}
	if fixture.mutations.Load() != 0 {
		t.Fatal("old binding was mutated")
	}
}

func TestBuiltinPolicyAPIHasDefaultOnAndRevisionWithoutConsent(t *testing.T) {
	_, _, client, baseURL, _ := newBuiltinFixture(t)
	response, raw := getJSON(t, client, baseURL+"/omc/api/v1/management/builtin-plugins")
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"policy":{"enabled":true,"revision":1}`) || strings.Contains(string(raw), `"consent"`) {
		t.Fatalf("default-on policy = %d %s", response.StatusCode, raw)
	}
	response, raw = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/builtin-plugins/policy", `{"enabled":false,"revision":1}`)
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"policy":{"enabled":false,"revision":2}`) {
		t.Fatalf("disable policy = %d %s", response.StatusCode, raw)
	}
	response, raw = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/builtin-plugins/policy", `{"enabled":true,"revision":1}`)
	if response.StatusCode != http.StatusConflict || !strings.Contains(string(raw), `policy_revision_conflict`) {
		t.Fatalf("stale revision = %d %s", response.StatusCode, raw)
	}
	response, raw = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/builtin-plugins/policy", `{"enabled":true,"revision":2}`)
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"policy":{"enabled":true,"revision":3}`) {
		t.Fatalf("enable policy = %d %s", response.StatusCode, raw)
	}
}

func TestBuiltinPerPluginSwitchDisablesWithoutUninstalling(t *testing.T) {
	handler, fixture, client, baseURL, instance := newBuiltinFixture(t)
	fixture.setState(true, false, true, true, true, "0.1.4", "0.1.4")
	response, raw := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/builtin-plugins/omc-zcode-oauth/policy", `{"enabled":false,"revision":1}`)
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"enabled":false`) || !strings.Contains(string(raw), `"status":"disabled"`) {
		t.Fatalf("disable builtin = %d %s", response.StatusCode, raw)
	}
	if !fixture.currentInstalled() || fixture.currentEnabled() {
		t.Fatalf("per-plugin switch uninstalled instead of disabling: installed=%t enabled=%t", fixture.currentInstalled(), fixture.currentEnabled())
	}
	policy, err := handler.repo.BuiltinPolicy(context.Background(), instance)
	if err != nil {
		t.Fatal(err)
	}
	if policy.Operations["omc-zcode-oauth"].State != "disabled" {
		t.Fatalf("operation = %+v", policy.Operations["omc-zcode-oauth"])
	}
	if fixture.mutations.Load() != 1 {
		t.Fatalf("switch wrote unexpected mutations=%d", fixture.mutations.Load())
	}
}

func TestBuiltinDisabledOverrideKeepsLatestCopyInstalledAndDisabled(t *testing.T) {
	handler, fixture, _, _, instance := newBuiltinFixture(t)
	saveBuiltinPluginEnabled(t, handler, instance, false)
	fixture.setState(true, false, false, true, true, "0.1.3", "0.1.3")
	drift, err := handler.builtinDesiredStateDrift(context.Background(), instance)
	if err != nil || !drift {
		t.Fatalf("stale disabled copy drift=%t err=%v", drift, err)
	}
	if err := handler.runBuiltinReconcile(context.Background(), instance); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	installedVersion := fixture.installedVersion
	fixture.mu.Unlock()
	if !fixture.currentInstalled() || fixture.currentEnabled() || installedVersion != "0.1.4" {
		t.Fatalf("disabled copy did not converge: installed=%t enabled=%t version=%q", fixture.currentInstalled(), fixture.currentEnabled(), installedVersion)
	}
	if fixture.mutations.Load() != 2 {
		t.Fatalf("stale disabled update mutations=%d", fixture.mutations.Load())
	}

	fixture.setState(false, false, false, false, false, "", "")
	drift, err = handler.builtinDesiredStateDrift(context.Background(), instance)
	if err != nil || !drift {
		t.Fatalf("deleted disabled copy drift=%t err=%v", drift, err)
	}
	if err := handler.runBuiltinReconcile(context.Background(), instance); err != nil {
		t.Fatal(err)
	}
	if !fixture.currentInstalled() || fixture.currentEnabled() || fixture.mutations.Load() != 4 {
		t.Fatalf("deleted disabled copy did not return installed and disabled: installed=%t enabled=%t mutations=%d", fixture.currentInstalled(), fixture.currentEnabled(), fixture.mutations.Load())
	}
}

func TestBuiltinReconcileDoesNotDowngradeStoredOrRunningVersion(t *testing.T) {
	for _, state := range []struct{ name, installed, running string }{
		{"newer stored version", "0.1.5", "0.1.5"},
		{"newer running version", "0.1.4", "0.1.5"},
	} {
		t.Run(state.name, func(t *testing.T) {
			handler, fixture, _, _, instance := newBuiltinFixture(t)
			fixture.setState(true, false, true, true, true, state.running, state.installed)
			if err := handler.runBuiltinReconcile(context.Background(), instance); !errors.Is(err, pluginregistry.ErrReleaseDowngrade) {
				t.Fatalf("downgrade refusal = %v", err)
			}
			if fixture.mutations.Load() != 0 {
				t.Fatalf("newer installed version was changed: %d mutations", fixture.mutations.Load())
			}
		})
	}
}

func TestBuiltinFeatureCanBeSwitchedOffBeforeCallbackSetup(t *testing.T) {
	for _, entry := range []struct {
		name, origin string
		status       int
	}{
		{"not configured", "", http.StatusOK},
		{"malformed", "://invalid", http.StatusBadGateway},
	} {
		t.Run(entry.name, func(t *testing.T) {
			handler, fixture, client, baseURL, _ := newBuiltinFixture(t)
			handler.cfg.BuiltinRegistryOrigin = entry.origin
			request, err := http.NewRequest(http.MethodPut, baseURL+"/omc/api/v1/management/builtin-plugins/policy", strings.NewReader(`{"enabled":false,"revision":1}`))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, _ := io.ReadAll(response.Body)
			if response.StatusCode != entry.status || fixture.mutations.Load() != 0 {
				t.Fatalf("switch off before callback setup = %d %s mutations=%d", response.StatusCode, body, fixture.mutations.Load())
			}
		})
	}
}

func TestBuiltinStoreInstallGuardRejectsOnlyTheManagedSource(t *testing.T) {
	handler, _, _, _, _ := newBuiltinFixture(t)
	sourceURL, err := handler.builtinRegistryURL()
	if err != nil {
		t.Fatal(err)
	}
	if err := handler.rejectBuiltinStoreInstall("omc-zcode-oauth", pluginregistry.SourceID(sourceURL)); !errors.Is(err, errBuiltinManaged) {
		t.Fatalf("managed source install = %v", err)
	}
	if err := handler.rejectBuiltinStoreInstall("omc-zcode-oauth", ""); !errors.Is(err, errBuiltinManaged) {
		t.Fatalf("unscoped catalog id install = %v", err)
	}
	if err := handler.rejectBuiltinStoreInstall("omc-zcode-oauth", "source-foreign"); err != nil {
		t.Fatalf("foreign same-id install was over-blocked: %v", err)
	}
}

func TestBuiltinNativeMutationGuardRejectsManagedCopy(t *testing.T) {
	_, fixture, client, baseURL, _ := newBuiltinFixture(t)
	fixture.setState(true, false, true, true, true, "0.1.4", "0.1.4")
	request, err := http.NewRequest(http.MethodPatch, baseURL+"/omc/api/v1/management/plugins/omc-zcode-oauth/enabled", strings.NewReader(`{"enabled":false}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusConflict || !strings.Contains(string(raw), `builtin_plugins_managed_separately`) {
		t.Fatalf("native enable refusal = %d %s", response.StatusCode, raw)
	}
	request, err = http.NewRequest(http.MethodDelete, baseURL+"/omc/api/v1/management/plugins/omc-zcode-oauth", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusConflict || !strings.Contains(string(raw), `builtin_plugins_managed_separately`) {
		t.Fatalf("native delete refusal = %d %s", response.StatusCode, raw)
	}
	if fixture.mutations.Load() != 0 {
		t.Fatalf("native guard mutated CPA: %d", fixture.mutations.Load())
	}
}

func TestBuiltinDesiredStateDriftAndReinstallAfterExternalUninstall(t *testing.T) {
	handler, fixture, _, _, instance := newBuiltinFixture(t)
	fixture.setState(true, false, true, true, true, "0.1.4", "0.1.4")
	drift, err := handler.builtinDesiredStateDrift(context.Background(), instance)
	if err != nil || drift {
		t.Fatalf("healthy state drift=%t err=%v", drift, err)
	}

	// This is the state a foreign panel leaves after deleting a managed plugin:
	// neither the install record nor the native file remains.
	fixture.setState(false, false, false, false, false, "", "")
	drift, err = handler.builtinDesiredStateDrift(context.Background(), instance)
	if err != nil || !drift {
		t.Fatalf("external uninstall drift=%t err=%v", drift, err)
	}
	if err := handler.runBuiltinReconcile(context.Background(), instance); err != nil {
		t.Fatal(err)
	}
	if !fixture.currentInstalled() || fixture.mutations.Load() != 1 {
		t.Fatalf("external uninstall was not repaired: installed=%t mutations=%d", fixture.currentInstalled(), fixture.mutations.Load())
	}
	drift, err = handler.builtinDesiredStateDrift(context.Background(), instance)
	if err != nil || drift {
		t.Fatalf("reinstalled state still drifts=%t err=%v", drift, err)
	}
}

func TestBuiltinDesiredStateDriftRepairsExternalEnableAndHonorsDisabledOverride(t *testing.T) {
	handler, fixture, _, _, instance := newBuiltinFixture(t)
	fixture.setState(true, false, false, true, true, "0.1.4", "0.1.4")
	drift, err := handler.builtinDesiredStateDrift(context.Background(), instance)
	if err != nil || !drift {
		t.Fatalf("external disable drift=%t err=%v", drift, err)
	}
	if err := handler.runBuiltinReconcile(context.Background(), instance); err != nil {
		t.Fatal(err)
	}
	if !fixture.currentEnabled() || fixture.mutations.Load() != 1 {
		t.Fatalf("external disable not repaired: enabled=%t mutations=%d", fixture.currentEnabled(), fixture.mutations.Load())
	}

	fixture.setState(true, false, true, true, true, "0.1.4", "0.1.4")
	saveBuiltinPluginEnabled(t, handler, instance, false)
	fixture.setState(true, false, true, true, true, "0.1.4", "0.1.4")
	drift, err = handler.builtinDesiredStateDrift(context.Background(), instance)
	if err != nil || !drift {
		t.Fatalf("disabled override drift=%t err=%v", drift, err)
	}
	if err := handler.runBuiltinReconcile(context.Background(), instance); err != nil {
		t.Fatal(err)
	}
	if fixture.currentEnabled() {
		t.Fatal("disabled override was re-enabled by an external panel and not repaired")
	}
	if fixture.mutations.Load() != 2 {
		t.Fatalf("disabled override repair mutations=%d", fixture.mutations.Load())
	}
}

func TestBuiltinGlobalOffUninstallsExternallyRestoredCopy(t *testing.T) {
	handler, fixture, client, baseURL, instance := newBuiltinFixture(t)
	saveBuiltinGlobal(t, handler, instance, false)
	fixture.setState(true, false, true, true, true, "0.1.4", "0.1.4")
	drift, err := handler.builtinDesiredStateDrift(context.Background(), instance)
	if err != nil || !drift {
		t.Fatalf("global-off drift=%t err=%v", drift, err)
	}
	if err := handler.runBuiltinReconcile(context.Background(), instance); err != nil {
		t.Fatal(err)
	}
	if fixture.currentInstalled() || fixture.mutations.Load() != 1 {
		t.Fatalf("global off did not uninstall managed copy: installed=%t mutations=%d", fixture.currentInstalled(), fixture.mutations.Load())
	}
	response, raw := getJSON(t, client, baseURL+"/omc/api/v1/management/builtin-plugins")
	var builtins BuiltinPluginsDTO
	if err := json.Unmarshal(raw, &builtins); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || builtins.Policy.Enabled || len(builtins.Plugins) != 1 || builtins.Plugins[0].Status != "not_installed" || builtins.Plugins[0].InstalledVersion != "" {
		t.Fatalf("global-off response exposed an invalid status: %d %s", response.StatusCode, raw)
	}
}

func TestBuiltinSameIDNativeOnlyPluginIsNotClaimed(t *testing.T) {
	handler, fixture, _, _, instance := newBuiltinFixture(t)
	fixture.setState(false, true, true, true, true, "0.1.4", "")
	drift, err := handler.builtinDesiredStateDrift(context.Background(), instance)
	if err != nil || drift {
		t.Fatalf("native-only same-id plugin caused reinstall drift=%t err=%v", drift, err)
	}
	if err := handler.runBuiltinReconcile(context.Background(), instance); err != nil {
		t.Fatal(err)
	}
	if fixture.currentInstalled() || fixture.mutations.Load() != 0 {
		t.Fatalf("native-only plugin was claimed: installed=%t mutations=%d", fixture.currentInstalled(), fixture.mutations.Load())
	}
	policy, err := handler.repo.BuiltinPolicy(context.Background(), instance)
	if err != nil {
		t.Fatal(err)
	}
	if policy.Operations["omc-zcode-oauth"].State != "source_conflict" {
		t.Fatalf("same-id native file was not reported as a conflict: %+v", policy.Operations["omc-zcode-oauth"])
	}
}

func TestBuiltinStatusDoesNotReportStaleRunningAfterExternalUninstall(t *testing.T) {
	handler, fixture, client, baseURL, instance := newBuiltinFixture(t)
	fixture.setState(true, false, true, true, true, "0.1.4", "0.1.4")
	if err := handler.repo.SaveBuiltinOperation(context.Background(), instance, "omc-zcode-oauth", repository.BuiltinOperation{Version: "0.1.4", State: "running"}); err != nil {
		t.Fatal(err)
	}
	response, raw := getJSON(t, client, baseURL+"/omc/api/v1/management/builtin-plugins")
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"status":"running"`) {
		t.Fatalf("installed status = %d %s", response.StatusCode, raw)
	}
	fixture.setState(false, false, false, false, false, "", "")
	response, raw = getJSON(t, client, baseURL+"/omc/api/v1/management/builtin-plugins")
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"status":"not_installed"`) || strings.Contains(string(raw), `"status":"running"`) {
		t.Fatalf("stale status after external uninstall = %d %s", response.StatusCode, raw)
	}
}

type builtinStateTickLog struct{ completed chan string }

func (*builtinStateTickLog) Enabled(context.Context, slog.Level) bool { return true }
func (log *builtinStateTickLog) Handle(_ context.Context, record slog.Record) error {
	if record.Message == "builtin reconciliation complete" || record.Message == "builtin reconciliation stopped" || record.Message == "builtin reconciliation skipped: release refresh failed" {
		log.completed <- record.Message
	}
	return nil
}
func (log *builtinStateTickLog) WithAttrs([]slog.Attr) slog.Handler { return log }
func (log *builtinStateTickLog) WithGroup(string) slog.Handler      { return log }

func TestBuiltinWorkerStateTickReinstallsExternallyDeletedPlugin(t *testing.T) {
	handler, fixture, _, _, instance := newBuiltinFixture(t)
	fixture.setState(true, false, true, true, true, "0.1.4", "0.1.4")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	catalogTicks := make(chan time.Time)
	stateTicks := make(chan time.Time)
	handler.builtins.newTicker = func(interval time.Duration) (<-chan time.Time, func()) {
		switch interval {
		case builtinCatalogRefreshInterval:
			return catalogTicks, func() {}
		case builtinDesiredStateInterval:
			return stateTicks, func() {}
		default:
			t.Errorf("unexpected builtin ticker interval: %s", interval)
			return make(chan time.Time), func() {}
		}
	}
	cycles := &builtinStateTickLog{completed: make(chan string, 1)}
	handler.logger = slog.New(cycles)
	approved, _, err := handler.repo.LoadBuiltinCatalog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	original := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() == "https://api.github.com/repos/WizisCool/omc-zcode-oauth/releases/latest" {
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(builtinReleaseJSON(t, approved)))), Request: request}, nil
		}
		return original.RoundTrip(request)
	})
	defer func() { cancel(); handler.CloseBuiltinWorker(); http.DefaultTransport = original }()
	if err := handler.StartBuiltinWorker(ctx); err != nil {
		t.Fatal(err)
	}
	await := func() {
		t.Helper()
		select {
		case message := <-cycles.completed:
			if message != "builtin reconciliation complete" {
				t.Fatalf("worker cycle ended with %q", message)
			}
		case <-ctx.Done():
			t.Fatal("worker did not complete its cycle")
		}
	}
	await()
	if fixture.mutations.Load() != 0 {
		t.Fatalf("initial healthy cycle mutated CPA: %d", fixture.mutations.Load())
	}
	fixture.setState(false, false, false, false, false, "", "")
	select {
	case stateTicks <- time.Now():
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	await()
	if !fixture.currentInstalled() || fixture.mutations.Load() != 1 {
		t.Fatalf("periodic desired-state pass did not reinstall: installed=%t mutations=%d", fixture.currentInstalled(), fixture.mutations.Load())
	}
	// Publishing another stable release is enough; neither OMC nor its policy changes.
	approved = builtinSnapshot(t, "0.1.5", strings.Repeat("b", 64))
	select {
	case catalogTicks <- time.Now():
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	await()
	fixture.mu.Lock()
	version := fixture.installedVersion
	fixture.mu.Unlock()
	policy, err := handler.repo.BuiltinPolicy(ctx, instance)
	if err != nil || !policy.Enabled || policy.Revision != 1 || version != "0.1.5" || fixture.mutations.Load() != 2 {
		t.Fatalf("stable release did not update the same managed copy: version=%s mutations=%d policy=%+v error=%v", version, fixture.mutations.Load(), policy, err)
	}
}

func TestBuiltinCallbackRejectsCredentialRulesUsingCPAMatchingSemantics(t *testing.T) {
	source := "http://omc.example/omc/plugin-registry/v2.json"
	for _, entry := range []struct {
		name, match, kind string
		allow             bool
		wantError         bool
	}{
		{"exact public", source, "none", true, false},
		{"case-insensitive credential origin", "HTTP://OMC.EXAMPLE/omc/plugin-registry/v2.json", "bearer", true, true},
		{"parent credential prefix", "http://OMC.example/omc/", "header", true, true},
		{"broad none is not our authorization", "http://omc.example/", "none", true, true},
		{"sibling does not match", "http://omc.example/omc/plugin-registry/v2.json-other", "bearer", true, false},
	} {
		t.Run(entry.name, func(t *testing.T) {
			settings := configyaml.PluginSettings{StoreAuth: []configyaml.PluginStoreAuthRule{{Match: entry.match, Type: entry.kind, ApplyTo: []string{"registry"}, AllowInsecure: entry.allow}}}
			_, err := builtinPublicAuthRule(settings, source)
			if (err != nil) != entry.wantError {
				t.Fatalf("auth rule safety=%v want error=%v", err, entry.wantError)
			}
		})
	}
}

func TestBuiltinCallbackAuthConflictStopsBeforeAnyCPAMutation(t *testing.T) {
	handler, fixture, _, _, instance := newBuiltinFixture(t)
	fixture.mu.Lock()
	fixture.dangerousAuth = true
	fixture.mu.Unlock()
	if err := handler.runBuiltinReconcile(context.Background(), instance); err == nil {
		t.Fatal("credential rule matching public callback was accepted")
	}
	if fixture.mutations.Load() != 0 {
		t.Fatalf("CPA mutations=%d", fixture.mutations.Load())
	}
}

func TestBuiltinCallbackAuthUsesFirstApplicableRuleAndNormalizedRequestKind(t *testing.T) {
	source := "https://OMC.example/base/plugin-registry/v2.json"
	credential := configyaml.PluginStoreAuthRule{Match: "HTTPS://omc.EXAMPLE/base/", Type: "bearer", ApplyTo: []string{" Registry "}}
	safe := configyaml.PluginStoreAuthRule{Match: "https://omc.example/base/plugin-registry/v2.json", Type: "none", ApplyTo: []string{"registry"}}
	for _, entry := range []struct {
		name      string
		rules     []configyaml.PluginStoreAuthRule
		wantError bool
	}{
		{"credential first", []configyaml.PluginStoreAuthRule{credential, safe}, true},
		{"blank request kinds apply to all", []configyaml.PluginStoreAuthRule{{Match: credential.Match, Type: "bearer", ApplyTo: []string{" ", "\t"}}, safe}, true},
		{"blank plus artifact is artifact only", []configyaml.PluginStoreAuthRule{{Match: credential.Match, Type: "bearer", ApplyTo: []string{" ", "artifact"}}, safe}, false},
		{"safe first", []configyaml.PluginStoreAuthRule{safe, credential}, false},
		{"different request kind", []configyaml.PluginStoreAuthRule{{Match: source, Type: "bearer", ApplyTo: []string{"artifact"}}, safe}, false},
	} {
		t.Run(entry.name, func(t *testing.T) {
			_, err := builtinPublicAuthRule(configyaml.PluginSettings{StoreAuth: entry.rules}, source)
			if (err != nil) != entry.wantError {
				t.Fatalf("first applicable auth=%v", err)
			}
		})
	}
}
