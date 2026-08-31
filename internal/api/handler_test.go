package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
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
	return NewHandler(config.Config{BasePath: basePath, Version: "test"}, repository.New(db), cipher, nil)
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

	response, err = http.Get(server.URL + "/omc/api/v1/not-found")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("API miss status = %d, want 404", response.StatusCode)
	}
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if _, ok := payload["error"]; !ok {
		t.Fatalf("API miss payload = %#v", payload)
	}

	response, err = http.Get(server.URL + "/omc/assets/does-not-exist.js")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("asset miss status = %d, want 404", response.StatusCode)
	}
	response.Body.Close()
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
