package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/discovery"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func testHandler(t *testing.T, basePath string) *Handler {
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
	authManager, err := auth.New("management-secret", basePath, "")
	if err != nil {
		t.Fatal(err)
	}
	return NewHandler(config.Config{BasePath: basePath, Version: "test"}, repository.New(db), cipher, nil, authManager)
}

func TestRouterSeparatesSPAFromAPIAndRedirectsBasePath(t *testing.T) {
	handler := testHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()

	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(server.URL + "/omc")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusPermanentRedirect {
		t.Fatalf("/omc status = %d, want 308", response.StatusCode)
	}
	if location := response.Header.Get("Location"); location != "/omc/" {
		t.Fatalf("redirect location = %q", location)
	}
	response.Body.Close()

	response, err = http.Get(server.URL + "/omc/some/route")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("SPA status = %d", response.StatusCode)
	}
	if contentType := response.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/html") {
		t.Fatalf("SPA content type = %q", contentType)
	}
	body := make([]byte, 4096)
	n, _ := response.Body.Read(body)
	response.Body.Close()
	if !strings.Contains(string(body[:n]), `"basePath":"/omc"`) && !strings.Contains(string(body[:n]), `basePath: "/omc"`) {
		t.Fatalf("SPA did not include runtime base path: %s", string(body[:n]))
	}

	// The application API is protected, while the static shell remains public.
	response, err = http.Get(server.URL + "/omc/api/v1/not-found")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated API status = %d, want 401", response.StatusCode)
	}
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if _, ok := payload["error"]; !ok {
		t.Fatalf("unauthenticated API payload = %#v", payload)
	}

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	authenticatedClient := &http.Client{Jar: jar}
	loginResponse, err := authenticatedClient.Post(server.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	if loginResponse.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d, want 200", loginResponse.StatusCode)
	}
	if cookie := loginResponse.Header.Get("Set-Cookie"); !strings.Contains(cookie, "omc_session=") || !strings.Contains(cookie, "HttpOnly") || !strings.Contains(cookie, "SameSite=Strict") {
		t.Fatalf("session cookie attributes = %q", cookie)
	}
	if strings.Contains(loginResponse.Header.Get("Set-Cookie"), "Secure") {
		t.Fatalf("local HTTP session unexpectedly marked Secure: %q", loginResponse.Header.Get("Set-Cookie"))
	}
	if cache := loginResponse.Header.Get("Cache-Control"); cache != "no-store" {
		t.Fatalf("login cache-control = %q", cache)
	}
	loginResponse.Body.Close()

	sessionResponse, err := authenticatedClient.Get(server.URL + "/omc/api/auth/session")
	if err != nil {
		t.Fatal(err)
	}
	if sessionResponse.StatusCode != http.StatusOK {
		t.Fatalf("session status = %d, want 200", sessionResponse.StatusCode)
	}
	if cache := sessionResponse.Header.Get("Cache-Control"); cache != "no-store" {
		t.Fatalf("session cache-control = %q", cache)
	}
	var sessionPayload map[string]bool
	if err := json.NewDecoder(sessionResponse.Body).Decode(&sessionPayload); err != nil {
		t.Fatal(err)
	}
	sessionResponse.Body.Close()
	if !sessionPayload["authenticated"] {
		t.Fatalf("session payload = %#v", sessionPayload)
	}

	response, err = authenticatedClient.Get(server.URL + "/omc/api/v1/not-found")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("authenticated API miss status = %d, want 404", response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if _, ok := payload["error"]; !ok {
		t.Fatalf("authenticated API miss payload = %#v", payload)
	}

	invalidCookieRequest, err := http.NewRequest(http.MethodGet, server.URL+"/omc/api/v1/not-found", nil)
	if err != nil {
		t.Fatal(err)
	}
	invalidCookieRequest.AddCookie(&http.Cookie{Name: "omc_session", Value: "invalid"})
	invalidCookieResponse, err := http.DefaultClient.Do(invalidCookieRequest)
	if err != nil {
		t.Fatal(err)
	}
	if invalidCookieResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invalid-cookie API status = %d, want 401", invalidCookieResponse.StatusCode)
	}
	invalidCookieResponse.Body.Close()

	logoutResponse, err := authenticatedClient.Post(server.URL+"/omc/api/auth/logout", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if logoutResponse.StatusCode != http.StatusOK {
		t.Fatalf("logout status = %d, want 200", logoutResponse.StatusCode)
	}
	if cache := logoutResponse.Header.Get("Cache-Control"); cache != "no-store" {
		t.Fatalf("logout cache-control = %q", cache)
	}
	logoutResponse.Body.Close()
	response, err = authenticatedClient.Get(server.URL + "/omc/api/v1/not-found")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("post-logout API status = %d, want 401", response.StatusCode)
	}
	response.Body.Close()

	response, err = http.Get(server.URL + "/omc/assets/does-not-exist.js")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("asset miss status = %d, want 404", response.StatusCode)
	}
	response.Body.Close()

	headResponse, err := http.Head(server.URL + "/omc/")
	if err != nil {
		t.Fatal(err)
	}
	if headResponse.StatusCode != http.StatusOK {
		t.Fatalf("SPA HEAD status = %d, want 200", headResponse.StatusCode)
	}
	headResponse.Body.Close()
}

func TestResourceResponseDoesNotExposeCredentialBearingURLs(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v0/management/auth-files":
			_, _ = writer.Write([]byte(`{"files":[]}`))
		case "/v0/management/codex-api-key":
			_, _ = writer.Write([]byte(`{"codex-api-key":[{"base-url":"https://user:password@provider.example.test/api","proxy-url":"socks5://proxy-user:proxy-password@proxy.example.test:1080"}]}`))
		case "/v0/management/openai-compatibility":
			_, _ = writer.Write([]byte(`{"openai-compatibility":[]}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer cpaServer.Close()
	client, err := management.NewClient(cpaServer.URL, "management-secret", 0, false)
	if err != nil {
		t.Fatal(err)
	}
	resources, _, err := discovery.NewDiscoverer(cipher).Discover(context.Background(), client, "default")
	if err != nil {
		t.Fatal(err)
	}
	serialized, err := json.Marshal(toResourceResponse(resources[0]))
	if err != nil {
		t.Fatal(err)
	}
	text := string(serialized)
	for _, secret := range []string{"user", "password", "proxy-user", "proxy-password"} {
		if strings.Contains(text, secret) {
			t.Fatalf("resource response contains credential %q: %s", secret, text)
		}
	}
	if !strings.Contains(text, `"proxy_configured":"true"`) || strings.Contains(text, "proxy_url") {
		t.Fatalf("resource response proxy metadata = %s", text)
	}
}

func TestHTTPSSessionCookieIsSecure(t *testing.T) {
	manager, err := auth.New("test-management-key", "/omc", "https://example.test/omc")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	if err := manager.Issue(response); err != nil {
		t.Fatal(err)
	}
	if cookie := response.Header().Get("Set-Cookie"); !strings.Contains(cookie, "Secure") {
		t.Fatalf("HTTPS session cookie is not Secure: %q", cookie)
	}
}

func TestRootBasePathServesAPIAtRoot(t *testing.T) {
	handler := testHandler(t, "")
	request := httptest.NewRequest(http.MethodGet, "/api/healthz", nil)
	response := httptest.NewRecorder()
	handler.Router().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("root health status = %d", response.Code)
	}
}

func TestProtectedMutationRequiresSameOrigin(t *testing.T) {
	handler := testHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	login, err := client.Post(server.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	request, err := http.NewRequest(http.MethodPost, server.URL+"/omc/api/v1/instances/default/discover", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", "https://attacker.example")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin mutation status = %d, want 403", response.StatusCode)
	}
	response.Body.Close()
}

func TestInjectRuntimeConfigReplacesTemplateScript(t *testing.T) {
	input := `<html><head><script>if (!window.__OMCPA_CONFIG__) { window.__OMCPA_CONFIG__ = {basePath: "/omc"}; }</script></head></html>`
	output, err := injectRuntimeConfig(input, "/nested/omc")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(output, "window.__OMCPA_CONFIG__") != 1 {
		t.Fatalf("config declaration count in output = %d: %s", strings.Count(output, "window.__OMCPA_CONFIG__"), output)
	}
	if !strings.Contains(output, `<base href="/nested/omc/">`) {
		t.Fatalf("missing base tag: %s", output)
	}
}
