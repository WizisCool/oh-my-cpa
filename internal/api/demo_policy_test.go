package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func demoHandler(t *testing.T, basePath string) *Handler {
	t.Helper()
	db, err := repository.Open(context.Background(), "file::memory:?cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	// The demo issues sessions from its own fixture key, so the manager is the
	// ordinary one and only the configuration says this deployment is a demo.
	authManager, err := auth.New("demo-fixture-management-key", basePath, "")
	if err != nil {
		t.Fatal(err)
	}
	return NewHandler(config.Config{BasePath: basePath, Version: "test", DemoMode: true}, repository.New(db), cipher, nil, authManager)
}

// The classification table has to be total. A route that no rule describes is
// refused at runtime, so the failure mode of a gap is a blocked feature - but a
// blocked feature is still a defect, and this is what turns it into a failing test
// at the moment the route is added rather than a bug report later.
func TestDemoPolicyClassifiesEveryRegisteredRoute(t *testing.T) {
	const basePath = "/omc"
	handler := demoHandler(t, basePath)
	routes := handler.routes()

	unclassified := make([]string, 0)
	seen := 0
	if err := chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		seen++
		path := stripBasePath(basePath, route)
		if _, match := demoVerdictFor(method, path); match != demoMatchVerdict {
			unclassified = append(unclassified, method+" "+route)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if seen == 0 {
		t.Fatal("no routes were walked, so this test proves nothing")
	}
	if len(unclassified) > 0 {
		sort.Strings(unclassified)
		t.Fatalf("%d route(s) have no demo verdict; classify them in demo_policy.go:\n  %s",
			len(unclassified), strings.Join(unclassified, "\n  "))
	}
}

// The classification itself, stated as the requirement rather than as an
// implementation detail: what a public demonstration must never carry out.
func TestDemoPolicyRefusesTheDangerousSurface(t *testing.T) {
	refused := []struct{ method, path string }{
		{http.MethodPost, "/api/v1/management/oauth/start"},
		{http.MethodPost, "/api/v1/management/oauth/callback"},
		{http.MethodDelete, "/api/v1/management/oauth/session"},
		{http.MethodPost, "/api/v1/management/auth-files"},
		{http.MethodGet, "/api/v1/management/auth-files/download"},
		{http.MethodDelete, "/api/v1/management/auth-files"},
		{http.MethodPatch, "/api/v1/management/auth-files/model-aliases"},
		{http.MethodGet, "/api/v1/management/request-error-logs/request-error-2026-09-19.log"},
		{http.MethodGet, "/api/v1/usage/events/41/request-log"},
		{http.MethodDelete, "/api/v1/management/logs"},
		{http.MethodGet, "/api/v1/management/system/diagnostics"},
		{http.MethodPost, "/api/v1/management/plugin-store/otel-bridge/install"},
		{http.MethodPatch, "/api/v1/management/plugins/usage-exporter/status"},
		{http.MethodDelete, "/api/v1/management/plugins/usage-exporter"},
		{http.MethodPut, "/api/v1/management/plugins/usage-exporter/config"},
		{http.MethodPut, "/api/v1/management/config/source"},
		{http.MethodPut, "/api/v1/management/config/debug"},
		{http.MethodPost, "/api/v1/management/api-keys"},
		{http.MethodDelete, "/api/v1/management/api-keys/0"},
		{http.MethodPost, "/api/v1/management/quota/reset"},
		{http.MethodPost, "/api/v1/management/quota/clear-cooldown"},
		{http.MethodPost, "/api/v1/management/quota/redeem-credit"},
		{http.MethodPost, "/api/v1/management/providers"},
		{http.MethodPut, "/api/v1/management/providers/codex"},
		{http.MethodDelete, "/api/v1/management/providers/codex"},
		{http.MethodPatch, "/api/v1/management/providers/status"},
		// The two calls that would leave the process on an operator's behalf.
		{http.MethodPost, "/api/v1/management/providers/pull-models"},
		{http.MethodPost, "/api/v1/pricing/sync"},
	}
	for _, route := range refused {
		rule, match := demoVerdictFor(route.method, route.path)
		if match != demoMatchVerdict {
			t.Fatalf("%s %s is not classified by a verdict", route.method, route.path)
		}
		if rule.verdict != demoRefuse {
			t.Errorf("%s %s is allowed in demo mode, want refused", route.method, route.path)
		}
		if strings.TrimSpace(rule.reason) == "" {
			t.Errorf("%s %s is refused without a reason the API can report", route.method, route.path)
		}
	}
}

// Everything the console reads while browsing the demonstration has to stay
// reachable, or the demo would be a set of broken pages.
func TestDemoPolicyKeepsTheReadingSurface(t *testing.T) {
	allowed := []struct{ method, path string }{
		{http.MethodGet, "/api/healthz"},
		{http.MethodGet, "/api/auth/session"},
		{http.MethodGet, "/dashboard"},
		{http.MethodGet, "/assets/index-abc123.js"},
		{http.MethodGet, "/favicon.svg"},
		{http.MethodGet, "/api/v1/management/dashboard"},
		{http.MethodGet, "/api/v1/management/dashboard/token-heatmap"},
		{http.MethodGet, "/api/v1/usage/events"},
		{http.MethodGet, "/api/v1/usage/events/41"},
		{http.MethodGet, "/api/v1/usage/facets"},
		{http.MethodGet, "/api/v1/management/logs"},
		{http.MethodGet, "/api/v1/management/api-keys"},
		{http.MethodGet, "/api/v1/management/request-error-logs"},
		{http.MethodGet, "/api/v1/management/request-error-logs"},
		{http.MethodGet, "/api/v1/management/auth-files"},
		{http.MethodGet, "/api/v1/management/auth-files/models"},
		{http.MethodGet, "/api/v1/management/overview"},
		{http.MethodGet, "/api/v1/management/config"},
		{http.MethodGet, "/api/v1/management/config/source"},
		{http.MethodGet, "/api/v1/management/providers"},
		{http.MethodGet, "/api/v1/management/plugins"},
		{http.MethodGet, "/api/v1/management/plugin-store"},
		{http.MethodGet, "/api/v1/management/oauth/providers"},
		{http.MethodGet, "/api/v1/management/quota"},
		{http.MethodGet, "/api/v1/management/quota/auth-codex-01"},
		{http.MethodGet, "/api/v1/management/system"},
		{http.MethodGet, "/api/v1/management/client-key-aliases"},
		{http.MethodGet, "/api/v1/pricing"},
		{http.MethodGet, "/api/v1/resources"},
		// Writes the demonstration can perform on its own fixture or on Oh My CPA's
		// own metadata.
		{http.MethodPatch, "/api/v1/management/auth-files/status"},
		{http.MethodPatch, "/api/v1/management/auth-files/fields"},
		{http.MethodPost, "/api/v1/management/quota/refresh"},
		{http.MethodPost, "/api/v1/instances/default/discover"},
		{http.MethodPut, "/api/v1/preferences/dashboard.range"},
		{http.MethodPut, "/api/v1/management/client-key-aliases"},
		{http.MethodDelete, "/api/v1/management/client-key-aliases/hmac%3Aabc"},
		{http.MethodPatch, "/api/v1/resources/res-1/override"},
		{http.MethodPut, "/api/v1/pricing/models"},
		{http.MethodDelete, "/api/v1/pricing/models/gpt-5"},
		{http.MethodPut, "/api/v1/pricing/sync-schedule"},
		{http.MethodPost, "/api/v1/usage/ingest/refresh"},
	}
	for _, route := range allowed {
		rule, match := demoVerdictFor(route.method, route.path)
		if match != demoMatchVerdict {
			t.Fatalf("%s %s is not classified by a verdict", route.method, route.path)
		}
		if rule.verdict != demoAllow {
			t.Errorf("%s %s is refused in demo mode (%s), want allowed", route.method, route.path, rule.reason)
		}
	}
}

// A route nobody classified is refused rather than served - and that has to hold for
// reads too, which is the case a trailing wildcard gets wrong: a wildcard that serves
// the SPA matches every unlisted `GET` as well, so a read endpoint added without a
// verdict would inherit "public" and be served by the public demo.
func TestDemoPolicyRefusesAnUnclassifiedRoute(t *testing.T) {
	for _, probe := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/management/some/future/mutation"},
		{http.MethodGet, "/api/v1/management/some/future/read"},
		{http.MethodGet, "/api/v1/management/auth-files/export"},
		{http.MethodHead, "/api/v1/usage/events/1"},
		{http.MethodGet, "/api/auth/tokens"},
	} {
		_, match := demoVerdictFor(probe.method, probe.path)
		if match == demoMatchVerdict {
			t.Errorf("%s %s was reported as classified by a verdict", probe.method, probe.path)
		}
		if match != demoMatchFallback {
			t.Errorf("%s %s matched nothing at all, so the SPA wildcard could answer it", probe.method, probe.path)
		}
	}

	handler := demoHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()
	client := demoClient(t, server.URL)

	// The other half of the property: the wildcard still serves the console, including its
	// own routes that begin with `/api-`, which are pages rather than API paths.
	for _, probe := range []struct{ method, path string }{
		{http.MethodGet, "/omc/api/v1/management/some/future/read"},
		{http.MethodGet, "/omc/api/v1/usage/events/1/export"},
	} {
		request, err := http.NewRequest(probe.method, server.URL+probe.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s status = %d, want 403", probe.method, probe.path, response.StatusCode)
		}
		body := readBody(t, response)
		if response.Header.Get(demoBlockedHeader) == "" {
			t.Errorf("%s %s was refused without the demo marker", probe.method, probe.path)
		}
		if !strings.Contains(body, `"code":"`+demoRefusedCode+`"`) {
			t.Errorf("%s %s refusal has no machine-readable code: %s", probe.method, probe.path, body)
		}
	}

	for _, path := range []string{"/omc/api-keys", "/omc/dashboard", "/omc/usage/events"} {
		response, err := client.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body := readBody(t, response)
		if response.StatusCode != http.StatusOK || !strings.Contains(body, "text/html") && !strings.Contains(response.Header.Get("Content-Type"), "text/html") {
			t.Errorf("GET %s = %d (%s), want the console shell", path, response.StatusCode, firstLine(body))
		}
	}
}

func firstLine(value string) string {
	if index := strings.IndexByte(value, '\n'); index >= 0 {
		return value[:index]
	}
	return value
}

// The refusal has to be the server's answer, not the browser's. These calls go
// straight to the router with no page in front of them.
func TestDemoGuardRefusesOverHTTP(t *testing.T) {
	handler := demoHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()
	client := demoClient(t, server.URL)

	for _, call := range []struct {
		method, path, body string
	}{
		{http.MethodPost, "/omc/api/v1/management/oauth/start", `{"provider":"codex"}`},
		{http.MethodPost, "/omc/api/v1/management/auth-files", `{"type":"codex"}`},
		{http.MethodGet, "/omc/api/v1/management/auth-files/download?name=x.json", ""},
		{http.MethodDelete, "/omc/api/v1/management/auth-files", `{"names":["x.json"]}`},
		{http.MethodGet, "/omc/api/v1/management/request-error-logs/x.log", ""},
		{http.MethodGet, "/omc/api/v1/usage/events/1/request-log", ""},
		{http.MethodPost, "/omc/api/v1/management/plugin-store/x/install", `{}`},
		{http.MethodPut, "/omc/api/v1/management/config/source", `{"source":"debug: true"}`},
		{http.MethodPost, "/omc/api/v1/management/quota/redeem-credit", `{"auth_index":"a"}`},
		{http.MethodPost, "/omc/api/v1/management/providers/pull-models", `{}`},
		{http.MethodPost, "/omc/api/v1/pricing/sync", `{}`},
	} {
		request, err := http.NewRequest(call.method, server.URL+call.path, strings.NewReader(call.body))
		if err != nil {
			t.Fatal(err)
		}
		if call.body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body := readBody(t, response)

		if response.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s status = %d, want 403; body=%s", call.method, call.path, response.StatusCode, body)
			continue
		}
		if response.Header.Get(demoBlockedHeader) == "" {
			t.Errorf("%s %s was refused without the demo marker", call.method, call.path)
		}
		// Decoded rather than matched as text: the code is the part a client is allowed to
		// branch on, and the message is prose that may be reworded.
		var refusal struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		if err := json.Unmarshal([]byte(body), &refusal); err != nil {
			t.Errorf("%s %s refusal is not JSON: %s", call.method, call.path, body)
			continue
		}
		if refusal.Code != demoRefusedCode {
			t.Errorf("%s %s refusal code = %q, want %q", call.method, call.path, refusal.Code, demoRefusedCode)
		}
		if !strings.Contains(refusal.Error, "demo mode") {
			t.Errorf("%s %s refusal message = %q, want it to name demo mode", call.method, call.path, refusal.Error)
		}
	}
}

// Every response says it is the demonstration, and a write says its result is not
// durable. A page that renders a stored value has no other way to know.
func TestDemoResponsesAreMarked(t *testing.T) {
	handler := demoHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()
	client := demoClient(t, server.URL)

	response, err := client.Get(server.URL + "/omc/api/v1/management/dashboard")
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, response)
	if response.Header.Get(demoHeader) != demoValue {
		t.Fatalf("read response is not marked as a demo: %v", response.Header)
	}
	if response.Header.Get(demoPersistenceHeader) != "" {
		t.Fatal("a read reports a persistence caveat it does not have")
	}

	request, err := http.NewRequest(http.MethodPatch, server.URL+"/omc/api/v1/management/auth-files/status", strings.NewReader(`{"name":"x.json","disabled":true}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, response)
	if response.Header.Get(demoPersistenceHeader) != demoNotPersisted {
		t.Fatalf("a write does not report that it is not persisted: %v", response.Header)
	}
}

// The console cannot be reached behind a sign-in card the visitor has no key for,
// so the session endpoint hands one out. It grants nothing: the refusals above are
// what protects the surface.
func TestDemoSessionIsIssuedOnFirstSight(t *testing.T) {
	handler := demoHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()

	client := &http.Client{}
	response, err := client.Get(server.URL + "/omc/api/auth/session")
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, response)
	if !strings.Contains(body, `"authenticated":true`) {
		t.Fatalf("demo session = %s, want an issued session", body)
	}
	if len(response.Cookies()) == 0 {
		t.Fatal("a demo session was reported without a cookie")
	}

	// And the API is reachable with no further interaction.
	request, err := http.NewRequest(http.MethodGet, server.URL+"/omc/api/v1/management/dashboard", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, cookie := range response.Cookies() {
		request.AddCookie(cookie)
	}
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pricing with the demo session = %d, want 200", response.StatusCode)
	}
}

// A read must never be refused for lack of a session. The console issues its first
// queries in parallel with the session check, and on the platform the demo is
// deployed to those requests can reach a different container instance than the one
// that minted the cookie - so a 401 here would turn a working page into a sign-in
// card. Each such request is served and handed the cookie it was missing.
func TestDemoServesAnUnauthenticatedRead(t *testing.T) {
	handler := demoHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()

	// No jar at all: every request is as unauthenticated as the first one of a page.
	client := &http.Client{}
	for _, path := range []string{"/omc/api/v1/preferences", "/omc/api/v1/management/dashboard", "/omc/api/v1/usage/events"} {
		response, err := client.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body := readBody(t, response)
		if response.StatusCode != http.StatusOK {
			t.Errorf("GET %s = %d (%s), want 200", path, response.StatusCode, body)
		}
		if len(response.Cookies()) == 0 {
			t.Errorf("GET %s was served without issuing the missing session", path)
		}
	}

	// A cross-site mutation is still refused, so the demonstration cannot be driven
	// from another origin.
	request, err := http.NewRequest(http.MethodPut, server.URL+"/omc/api/v1/preferences/dashboard.range", strings.NewReader(`{"value":"24h"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://attacker.example")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, response)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin demo write = %d, want 403", response.StatusCode)
	}
}

// The sign-in form is still reachable - a visitor whose cookie was cleared lands on
// it - and it must not be a dead end.
func TestDemoLoginAcceptsAnyPassword(t *testing.T) {
	handler := demoHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()

	response, err := http.Post(server.URL+"/omc/api/auth/login", "application/json", strings.NewReader(`{"password":"anything"}`))
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, response)
	if response.StatusCode != http.StatusOK || !strings.Contains(body, `"authenticated":true`) {
		t.Fatalf("demo login = %d %s, want an issued session", response.StatusCode, body)
	}
}

// A self-hosted deployment must be untouched by any of this. Same routes, no demo
// header, no issued session, and the dangerous calls reach their handlers.
func TestSelfHostedRouterIsUnchanged(t *testing.T) {
	handler := testHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()

	response, err := http.Get(server.URL + "/omc/api/auth/session")
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, response)
	if body != `{"authenticated":false}` {
		t.Fatalf("self-hosted session = %s, want an unauthenticated answer", body)
	}
	if response.Header.Get(demoHeader) != "" {
		t.Fatal("a self-hosted response is marked as a demo")
	}

	// The demo guard is not installed, so an unclassified path is answered by the
	// ordinary API rather than refused with a demo message.
	response, err = http.Post(server.URL+"/omc/api/v1/management/oauth/start", "application/json", strings.NewReader(`{"provider":"codex"}`))
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, response)
	if response.StatusCode == http.StatusForbidden {
		t.Fatal("a self-hosted route was refused by the demo policy")
	}
}

func demoClient(t *testing.T, baseURL string) *http.Client {
	t.Helper()
	// The guard runs above authentication, but the reads behind it do not: the demo
	// session is fetched once here so the calls under test are the ones being
	// measured.
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	response, err := client.Get(baseURL + "/omc/api/auth/session")
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, response)
	return client
}

func readBody(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(data))
}
