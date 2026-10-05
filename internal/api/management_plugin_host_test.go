package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
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
	// A page written for CPAMC attaches whatever key it found; it must not replace the
	// one this process holds, and must not reach the plugin beside it.
	request.Header.Set("Authorization", "Bearer key-the-page-typed")
	request.Header.Set("X-Management-Key", "key-the-page-typed")
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
		if event.Action == "plugin.route_call" && event.TargetID == "/v0/management/logger/credentials" {
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

	// These are CPA's own routes. Through the host they would answer with the raw
	// management documents - the stored configuration with every upstream key in it -
	// which the console's own API never returns.
	for _, target := range []string{
		"/v0/management/config.yaml",
		"/v0/management/config/plugins",
		"/v0/management/auth-files/download",
		"/v0/management/API-CALL",
		"/v0/management/logger/../config.yaml",
		"/v0/management/",
		"/v8/management/config.yaml",
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

	for _, target := range []string{"/v0/resource/plugins/logger/console", "/v0/management/logger/status"} {
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
