package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPluginHostServesThePluginPageRebasedOntoTheConsole(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)

	resp, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/plugin-host/v0/resource/plugins/logger/console", "")
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("plugin page: status %d type %q body %s", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	page := string(body)
	// The page is written for CPA's root. Under the console it must reach the host for
	// its API base and its stylesheet, or every request it makes lands outside the
	// console's base path and never reaches a plugin.
	for _, want := range []string{
		`content="/omc/api/v1/plugin-host/v0/management/logger"`,
		`href="/omc/api/v1/plugin-host/v0/resource/plugins/logger/app.css"`,
		`const API='/omc/api/v1/plugin-host/v0/management/logger'`,
		// A reference to another origin is that origin's, not a path to re-base.
		`"https://cpa.example/v0/management/logger"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("plugin page does not contain %s:\n%s", want, page)
		}
	}
	// The run-time shim has to be parsed before any script of the page's own.
	shim, script := strings.Index(page, "<script>(function(){var P="), strings.Index(page, "<script>const API")
	if shim < 0 || shim > script || shim < strings.Index(page, "<head>") {
		t.Errorf("shim at %d, page script at %d: the shim must come first, inside the document", shim, script)
	}
	// CPA hands a request's headers to the plugin's handler, and a resource is
	// unauthenticated by contract: the management key must not travel with it.
	if state.resourceAuthorization != "" {
		t.Errorf("resource read carried Authorization %q", state.resourceAuthorization)
	}
	if resp.Header.Get("Set-Cookie") != "" {
		t.Errorf("a plugin set a cookie on the console's origin: %q", resp.Header.Get("Set-Cookie"))
	}

	_, css := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/plugin-host/v0/resource/plugins/logger/app.css", "")
	if string(css) != `body{background:url(/omc/api/v1/plugin-host/v0/resource/plugins/logger/bg.png)}` {
		t.Errorf("stylesheet = %s, want its reference re-based", css)
	}
	// Bytes that are not text are the plugin's own and pass through untouched.
	_, image := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/plugin-host/v0/resource/plugins/logger/bg.png", "")
	if string(image) != "/v0/management/raw-bytes" {
		t.Errorf("image body = %q, want it unmodified", image)
	}

	missing, _ := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/plugin-host/v0/resource/plugins/logger/absent", "")
	if missing.StatusCode != http.StatusNotFound {
		t.Errorf("unknown resource: status %d, want the plugin's 404", missing.StatusCode)
	}
}

func TestPluginHostCallsPluginRoutesWithTheServerSideKey(t *testing.T) {
	client, baseURL, repo, state := startPluginTestServer(t)

	request, _ := http.NewRequest(http.MethodPost, baseURL+"/omc/api/v1/plugin-host/v0/management/logger/credentials?id=7", strings.NewReader(`{"label":"a"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", baseURL)
	// Credential-less pages retain the session bridge; explicit credentials are tested
	// separately and must never be upgraded to the stored server key.
	resp, err := client.Do(request)
	if err != nil {
		t.Fatalf("plugin route: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != `{"plugin":"logger","ok":true}` {
		t.Fatalf("plugin route: status %d body %s", resp.StatusCode, body)
	}
	state.mu.Lock()
	calls := append([]pluginRouteCall(nil), state.routeCalls...)
	state.mu.Unlock()
	if len(calls) != 1 {
		t.Fatalf("route calls = %#v, want one", calls)
	}
	call := calls[0]
	if call.method != http.MethodPost || call.path != "/v0/management/logger/credentials" || call.query != "id=7" || call.body != `{"label":"a"}` || call.contentType != "application/json" {
		t.Errorf("forwarded call = %#v, want the page's method, path, query and body", call)
	}
	if call.authorization != "Bearer cpa-secret-key" || call.managementKey != "" || call.cookie != "" {
		t.Errorf("forwarded credentials = %q / %q / %q, want only this process's key", call.authorization, call.managementKey, call.cookie)
	}

	events, err := repo.ListAuditEvents(context.Background(), 20)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	outcomes := 0
	for _, event := range events {
		if event.Action == "plugin.route_call" && event.TargetID == "/v0/management/" {
			outcomes++
		}
	}
	if outcomes != 2 {
		t.Errorf("audit rows for the plugin write = %d, want its attempt and its outcome", outcomes)
	}

	// A plugin's own failure is the page's to read, status and body.
	missing, missingBody := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/plugin-host/v0/management/logger/missing", "")
	if missing.StatusCode != http.StatusNotFound || string(missingBody) != `{"error":"not found"}` {
		t.Errorf("plugin 404: status %d body %s", missing.StatusCode, missingBody)
	}
}

func TestPluginHostRefusesWhatIsNotAPluginRoute(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)

	// Trusting installed pages does not permit arbitrary URLs or outbound API-call
	// bridges. Ordinary facade DTO tests remain separate from this raw surface.
	for _, target := range []string{
		"/v0/management/API-CALL",
		"/v8/management/requests/api-call",
		"/v8/management/requests/api-call/child",
		"/v1/models/child",
		"/v0/management/logger/../config.yaml",
		"/v0/management/",
		"/v0/resource/plugins/logger",
		"/v0/resource/plugins/logger/../../management/config.yaml",
		"/v1/chat/completions",
	} {
		resp, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/plugin-host"+target, "")
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s: status %d body %s, want 404", target, resp.StatusCode, body)
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.routeCalls) != 0 {
		t.Errorf("refused paths reached CPA: %#v", state.routeCalls)
	}
}

func TestPluginHostRequiresTheConsoleSession(t *testing.T) {
	_, baseURL, _, state := startPluginTestServer(t)

	for _, target := range []string{"/v0/resource/plugins/logger/console", "/v0/management/logger/status", "/v0/management/config", "/v8/management/config/api-keys", "/v1/models"} {
		resp, err := http.Get(baseURL + "/omc/api/v1/plugin-host" + target)
		if err != nil {
			t.Fatalf("GET %s: %v", target, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s without a session: status %d, want 401", target, resp.StatusCode)
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.routeCalls) != 0 {
		t.Errorf("unauthenticated requests reached CPA: %#v", state.routeCalls)
	}
}

func TestPluginHostPreservesExplicitCredentialFailures(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)
	for _, target := range []string{"/v0/management/plugins/example/state", "/v0/management/config", "/v8/management/config/api-keys"} {
		for _, credential := range []struct{ header, value string }{
			{"Authorization", "Bearer invalid-page-key"},
			{"Authorization", "Bearer"},
			{"Authorization", ""},
			{"X-Management-Key", ""},
			{"X-Management-Key", "invalid-page-key"},
		} {
			request, _ := http.NewRequest(http.MethodGet, baseURL+"/omc/api/v1/plugin-host"+target, nil)
			request.Header.Set(credential.header, credential.value)
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != http.StatusUnauthorized || string(body) != `{"error":"unauthorized"}` {
				t.Fatalf("%s using %s: status=%d body=%s", target, credential.header, response.StatusCode, body)
			}
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.routeCalls) != 0 {
		t.Fatalf("invalid credentials invoked the plugin: %#v", state.routeCalls)
	}
}

func TestPluginHostNativeStartupRequestChain(t *testing.T) {
	client, baseURL, repo, state := startPluginTestServer(t)
	host := baseURL + "/omc/api/v1/plugin-host"
	for _, step := range []struct{ method, target, credential, body, want string }{
		{http.MethodGet, "/v0/management/config", "cpa-secret-key", "", "synthetic-client-key"},
		{http.MethodGet, "/v8/management/config/api-keys", "cpa-secret-key", "", "synthetic-provider-key"},
		{http.MethodGet, "/v1/models", "synthetic-client-key", "", "gpt-plugin-synthetic"},
		{http.MethodPost, "/v0/management/plugins/example/credentials/sync", "cpa-secret-key", `{"credentials":[]}`, `"ok":true`},
		{http.MethodGet, "/v0/management/plugins/example/state", "cpa-secret-key", "", `"ok":true`},
		{http.MethodGet, "/v0/management/auth-files/models?name=fixture.json", "cpa-secret-key", "", "gpt-plugin-synthetic"},
		{http.MethodPatch, "/v0/management/auth-files/status", "cpa-secret-key", `{"name":"fixture.json","disabled":false}`, `"status":"ok"`},
	} {
		request, _ := http.NewRequest(step.method, host+step.target, strings.NewReader(step.body))
		request.Header.Set("Authorization", "Bearer "+step.credential)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", baseURL)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK || !strings.Contains(string(body), step.want) || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("%s %s: status=%d body=%s cache=%q", step.method, step.target, response.StatusCode, body, response.Header.Get("Cache-Control"))
		}
	}
	state.mu.Lock()
	writes := state.nativeWrites
	state.mu.Unlock()
	if writes != 1 {
		t.Fatalf("native writes=%d, want one", writes)
	}
	var copies int
	if err := repo.SQL().QueryRow("SELECT COUNT(*) FROM cpa_config_backups").Scan(&copies); err != nil || copies != 1 {
		t.Fatalf("configuration backups=%d err=%v, want one", copies, err)
	}
	events, err := repo.ListAuditEvents(context.Background(), 30)
	if err != nil {
		t.Fatal(err)
	}
	pluginEvents := 0
	for _, event := range events {
		if event.Action == "plugin.route_call" {
			pluginEvents++
		}
	}
	if pluginEvents != 14 {
		t.Fatalf("plugin audit rows=%d, want an attempt/outcome for all seven requests", pluginEvents)
	}
	for _, event := range events {
		encoded, _ := json.Marshal(event)
		for _, secret := range []string{"cpa-secret-key", "synthetic-client-key", "synthetic-provider-key", "fixture.json"} {
			if strings.Contains(string(encoded), secret) {
				t.Fatalf("audit retained request data: %s", encoded)
			}
		}
	}
}

func TestPluginHostModelsNeverSubstituteManagementCredentials(t *testing.T) {
	client, baseURL, _, _ := startPluginTestServer(t)
	for _, credential := range []string{"", "cpa-secret-key", "wrong-client-key"} {
		request, _ := http.NewRequest(http.MethodGet, baseURL+"/omc/api/v1/plugin-host/v1/models", nil)
		if credential != "" {
			request.Header.Set("Authorization", "Bearer "+credential)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("models accepted credential class %q: %d", credential, response.StatusCode)
		}
	}
}

func TestPluginHostAuditsReadsFailClosed(t *testing.T) {
	for _, phase := range []string{"attempt", "success"} {
		t.Run(phase, func(t *testing.T) {
			client, baseURL, repo, state := startPluginTestServer(t)
			_, err := repo.SQL().Exec(`CREATE TRIGGER reject_plugin_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'plugin.route_call' AND NEW.result = '` + phase + `' BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`)
			if err != nil {
				t.Fatal(err)
			}
			response, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/plugin-host/v0/management/config", "")
			if response.StatusCode != http.StatusInternalServerError || !strings.Contains(string(body), auditWriteFailedCode) || strings.Contains(string(body), "synthetic-") {
				t.Fatalf("failed %s audit leaked config: %d %s", phase, response.StatusCode, body)
			}
			if phase == "attempt" {
				state.mu.Lock()
				defer state.mu.Unlock()
				if state.nativeReads != 0 {
					t.Fatalf("failed audit reached CPA: reads=%d", state.nativeReads)
				}
			}
		})
	}
}

func TestPluginHostNativeWriteGateAndCredentialRefusal(t *testing.T) {
	client, baseURL, repo, state := startPluginTestServer(t)
	request, _ := http.NewRequest(http.MethodPatch, baseURL+"/omc/api/v1/plugin-host/v0/management/auth-files/status", strings.NewReader(`{"disabled":true}`))
	request.Header.Set("Origin", baseURL)
	request.Header.Set("Authorization", "Bearer wrong-management-key")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invalid native-write credential: status=%d", response.StatusCode)
	}
	var copies int
	if err := repo.SQL().QueryRow("SELECT COUNT(*) FROM cpa_config_backups").Scan(&copies); err != nil || copies != 0 {
		t.Fatalf("invalid credential created %d backups: %v", copies, err)
	}

	state.handler.providerWrites.permits <- struct{}{}
	state.handler.providerWrites.acquireTimeout = 10 * time.Millisecond
	t.Cleanup(func() { <-state.handler.providerWrites.permits })
	response, body := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/plugin-host/v0/management/auth-files/status", `{"disabled":true}`)
	if response.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(body), `"code":"write_busy"`) {
		t.Fatalf("native write bypassed gate: %d %s", response.StatusCode, body)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.nativeWrites != 0 {
		t.Fatalf("refused native writes=%d", state.nativeWrites)
	}
}

func TestPluginHostRebasesOnlySupportedReferences(t *testing.T) {
	for _, prefix := range []string{"/omc/api/v1/plugin-host", "/console/custom/api/v1/plugin-host", "/api/v1/plugin-host"} {
		input := `const config="/v0/management/config";const groups='/v8/management/config/api-keys';const models="/v1/models?kind=a";const remote="https://other.example/v8/management/config";const already="` + prefix + `/v0/management/config";const chat="/v1/chat/completions";`
		output := string(rebasePluginReferences([]byte(input), prefix))
		for _, expected := range []string{prefix + "/v0/management/config", prefix + "/v8/management/config/api-keys", prefix + "/v1/models?kind=a", "https://other.example/v8/management/config", `const chat="/v1/chat/completions"`} {
			if !strings.Contains(output, expected) {
				t.Errorf("%s missing in %s", expected, output)
			}
		}
		if strings.Contains(output, prefix+prefix) {
			t.Fatalf("reference rebased twice: %s", output)
		}
	}
}

func TestPluginHostWriteAuditOutcomes(t *testing.T) {
	for _, phase := range []string{"attempt", "success"} {
		t.Run(phase, func(t *testing.T) {
			client, baseURL, repo, state := startPluginTestServer(t)
			_, err := repo.SQL().Exec(`CREATE TRIGGER reject_plugin_write_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'plugin.route_call' AND NEW.result = '` + phase + `' BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`)
			if err != nil {
				t.Fatal(err)
			}
			response, _ := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/plugin-host/v0/management/plugins/example/run", `{}`)
			state.mu.Lock()
			defer state.mu.Unlock()
			if phase == "attempt" && (response.StatusCode != http.StatusInternalServerError || len(state.routeCalls) != 0) {
				t.Fatalf("unaudited write executed: status=%d calls=%d", response.StatusCode, len(state.routeCalls))
			}
			if phase == "success" && (response.StatusCode != http.StatusOK || len(state.routeCalls) != 1) {
				t.Fatalf("landed write lost its success: status=%d calls=%d", response.StatusCode, len(state.routeCalls))
			}
		})
	}
}

func TestPluginHostNativeWriteFailsClosedOnBackupFailure(t *testing.T) {
	client, baseURL, repo, state := startPluginTestServer(t)
	_, err := repo.SQL().Exec(`CREATE TRIGGER reject_plugin_backup BEFORE INSERT ON cpa_config_backups BEGIN SELECT RAISE(FAIL, 'backup unavailable'); END`)
	if err != nil {
		t.Fatal(err)
	}
	response, body := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/plugin-host/v8/management/config", `{"observability":{"logs":{"debug":true}}}`)
	if response.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(body), `"code":"config_backup_failed"`) {
		t.Fatalf("backup failure: %d %s", response.StatusCode, body)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.configPuts != 0 {
		t.Fatalf("failed backup permitted %d native writes", state.configPuts)
	}
}

func TestPluginHostRejectsCrossOriginWrites(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)
	for _, target := range []string{"/v0/management/plugins/example/run", "/v8/management/config"} {
		request, _ := http.NewRequest(http.MethodPost, baseURL+"/omc/api/v1/plugin-host"+target, strings.NewReader(`{}`))
		request.Header.Set("Origin", "https://other.example")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("cross-origin write accepted: %s status=%d", target, response.StatusCode)
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.routeCalls) != 0 || state.configPuts != 0 {
		t.Fatalf("cross-origin write reached CPA")
	}
}

func TestPluginHostAuditOmitsCallerPathsAndQueries(t *testing.T) {
	client, baseURL, repo, _ := startPluginTestServer(t)
	for _, suffix := range []string{
		"/v8/management/config/api-keys/synthetic-path-secret?token=synthetic-query-secret",
		"/v0/management/plugins/example/state?token=synthetic-query-secret",
	} {
		response, _ := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/plugin-host"+suffix, "")
		if response.StatusCode >= http.StatusInternalServerError {
			t.Fatalf("unexpected host failure: %d", response.StatusCode)
		}
	}
	events, err := repo.ListAuditEvents(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, event := range events {
		if event.Action != "plugin.route_call" {
			continue
		}
		count++
		encoded, _ := json.Marshal(event)
		if strings.Contains(string(encoded), "synthetic-path-secret") || strings.Contains(string(encoded), "synthetic-query-secret") {
			t.Fatalf("caller data persisted in plugin audit: %s", encoded)
		}
	}
	if count != 4 {
		t.Fatalf("plugin audit count=%d, want four", count)
	}
}

func TestPluginHostManagementCredentialPrecedence(t *testing.T) {
	client, baseURL, _, _ := startPluginTestServer(t)
	for _, credential := range []struct {
		authorization string
		status        int
	}{
		{"Bearer invalid-page-key", http.StatusUnauthorized},
		{"", http.StatusOK},
	} {
		request, _ := http.NewRequest(http.MethodGet, baseURL+"/omc/api/v1/plugin-host/v0/management/config", nil)
		request.Header.Set("Authorization", credential.authorization)
		request.Header.Set("X-Management-Key", "cpa-secret-key")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != credential.status {
			t.Fatalf("CPA credential precedence: got %d, want %d", response.StatusCode, credential.status)
		}
	}
}

func TestPluginHostManagementHEAD(t *testing.T) {
	client, baseURL, repo, _ := startPluginTestServer(t)
	response, body := doJSON(t, client, http.MethodHead, baseURL+"/omc/api/v1/plugin-host/v0/management/config", "")
	if response.StatusCode != http.StatusOK || len(body) != 0 || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("native HEAD: status=%d body=%s cache=%s", response.StatusCode, body, response.Header.Get("Cache-Control"))
	}
	events, err := repo.ListAuditEvents(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, event := range events {
		if event.Action == "plugin.route_call" {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("HEAD audit count=%d, want two", count)
	}
}
