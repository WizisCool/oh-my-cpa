package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

type capFixtureCPA struct {
	mu      sync.Mutex
	queries []string
	missing map[string]bool
}

func (f *capFixtureCPA) serve(writer http.ResponseWriter, request *http.Request) {
	path := strings.TrimPrefix(request.URL.Path, "/v0/management")
	f.mu.Lock()
	f.queries = append(f.queries, path)
	isMissing := f.missing[path]
	f.mu.Unlock()

	if isMissing {
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":"not found"}`))
		return
	}

	switch path {
	case "/config", "/config.yaml", "/api-keys", "/plugins", "/plugin-store", "/latest-version", "/auth-files", "/codex-api-key", "/openai-compatibility", "/claude-api-key", "/gemini-api-key", "/oauth-excluded-models", "/get-auth-status":
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	default:
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":"not found"}`))
	}
}

func TestManagementCapabilitiesProbeSupported(t *testing.T) {
	fixture := &capFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)

	base := baseURL + "/omc/api/v1/management/capabilities/plugins"
	response, payload := getJSON(t, client, base)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}

	var report CapabilityProbeReport
	if err := json.Unmarshal(payload, &report); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if report.Key != "plugins" {
		t.Errorf("expected key plugins, got %s", report.Key)
	}
	if report.Status != "supported" {
		t.Errorf("expected status supported, got %s", report.Status)
	}
	if len(report.Checks) != 1 || report.Checks[0].Status != "supported" || report.Checks[0].HTTPStatus != 200 {
		t.Errorf("unexpected checks: %+v", report.Checks)
	}
}

func TestManagementCapabilitiesProbePartialAndMissing(t *testing.T) {
	fixture := &capFixtureCPA{
		missing: map[string]bool{
			"/config.yaml": true,
		},
	}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)

	// config has 2 checks: /config (200) and /config.yaml (404) -> partial
	base := baseURL + "/omc/api/v1/management/capabilities/config"
	response, payload := getJSON(t, client, base)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}

	var report CapabilityProbeReport
	if err := json.Unmarshal(payload, &report); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if report.Status != "partial" {
		t.Errorf("expected status partial, got %s", report.Status)
	}

	// plugins missing
	fixture.mu.Lock()
	fixture.missing["/plugins"] = true
	fixture.mu.Unlock()

	basePlugins := baseURL + "/omc/api/v1/management/capabilities/plugins"
	response, payload = getJSON(t, client, basePlugins)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var pluginsReport CapabilityProbeReport
	if err := json.Unmarshal(payload, &pluginsReport); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if pluginsReport.Status != "missing" {
		t.Errorf("expected status missing, got %s", pluginsReport.Status)
	}
}

func TestManagementCapabilitiesUnknownKeyRejected(t *testing.T) {
	fixture := &capFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)

	// arbitrary key or injection attempt
	for _, badKey := range []string{"unknown", "../config", "arbitrary-path", "usage-queue"} {
		base := baseURL + "/omc/api/v1/management/capabilities/" + badKey
		response, _ := getJSON(t, client, base)
		if response.StatusCode != http.StatusNotFound {
			t.Errorf("expected 404 for bad key %q, got %d", badKey, response.StatusCode)
		}
	}
}
