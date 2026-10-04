package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// The dashboard range is the operator's working context: it has to come back
// after a reload, a service restart and a container rebuild, so it lives in the
// database rather than in browser storage.
func TestPreferencesRoundTripThroughTheDatabase(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	base := baseURL + "/omc/api/v1/preferences"

	// A fresh install has no preferences, and that is a valid empty answer.
	response, payload := getJSON(t, client, base)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var listed struct {
		Preferences map[string]json.RawMessage `json:"preferences"`
	}
	if err := json.Unmarshal(payload, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Preferences) != 0 {
		t.Fatalf("fresh install should list nothing: %s", payload)
	}

	// Only known keys are writable: this is UI state, not a blob store.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/management_key", `{"x":1}`); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown key status = %d body %s", response.StatusCode, payload)
	}
	// Unparseable bodies are refused here so every reader can skip the check.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/dashboard_range", `{"preset":`); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid json status = %d body %s", response.StatusCode, payload)
	}

	if response, payload = doJSON(t, client, http.MethodPut, base+"/dashboard_range", `{"preset":"6h"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("write status = %d body %s", response.StatusCode, payload)
	}

	// The log page's view filters ride the same store, so a reload or a restart
	// does not silently turn management traffic back on.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/log_filters", `{"hideManagement":true,"levels":["warn"],"statusClass":"all"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("log filters status = %d body %s", response.StatusCode, payload)
	}

	// Provider icons are also persisted in the database so custom brand assignments survive restarts.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/provider_icons", `{"openai-compat-0":"DeepSeek","relay":"OpenAI"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("provider icons status = %d body %s", response.StatusCode, payload)
	}

	// Usage events view settings (filters, grouping, advanced visibility) are also persisted.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/usage_events_view", `{"preset":"24h","result":"failed","grouping":"provider","advanced":true}`); response.StatusCode != http.StatusOK {
		t.Fatalf("usage events view status = %d body %s", response.StatusCode, payload)
	}

	// Usage events column preferences are also persisted.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/usage_events_columns", `{"time":120,"provider":220,"tps":90}`); response.StatusCode != http.StatusOK {
		t.Fatalf("usage events columns status = %d body %s", response.StatusCode, payload)
	}

	// The unified OAuth workspace persists only its reading density and page size;
	// filters and task identity remain URL or memory state.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/oauth_management_view_v1", `{"density":"compact","pageSize":24}`); response.StatusCode != http.StatusOK {
		t.Fatalf("OAuth management view status = %d body %s", response.StatusCode, payload)
	}

	// The playground keeps one document: the latest session, with the target named by the key's
	// usage fingerprint rather than the key text.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/agent_target", `{"client_key_fingerprint":"hmac:agent","model":"gpt-5","reasoning_effort":"high"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("agent target status = %d body %s", response.StatusCode, payload)
	}
	if response, payload = doJSON(t, client, http.MethodPut, base+"/playground_session", `{"client_key_fingerprint":"hmac:playground","model":"gpt-5","turns":[]}`); response.StatusCode != http.StatusOK {
		t.Fatalf("playground session status = %d body %s", response.StatusCode, payload)
	}

	// The theme is stored as one document: the mode, the palette each mode uses, and any palette
	// the operator authored. The server keeps it verbatim - it is the console's shape, and the
	// console is the only thing that reads it.
	themeDocument := `{"mode":"system","palettes":{"dark":"midnight","light":"custom"},` +
		`"custom":{"light":{"name":"Studio","base":"porcelain","core":{"bg":"#ffffff",` +
		`"surface":"#f6f6f8","elevated":"#ffffff","fg":"#1c1c1e","fg2":"#505055",` +
		`"muted":"#787880","meta":"#98989f","border":"#e5e5ea","accent":"#005d8f"}}}}`
	if response, payload = doJSON(t, client, http.MethodPut, base+"/omc_theme", themeDocument); response.StatusCode != http.StatusOK {
		t.Fatalf("theme status = %d body %s", response.StatusCode, payload)
	}

	// Scroll smoothing is one of three words; the console parses it and falls back to its default.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/omc_scroll_smoothing", `"system"`); response.StatusCode != http.StatusOK {
		t.Fatalf("scroll smoothing status = %d body %s", response.StatusCode, payload)
	}

	_, payload = getJSON(t, client, base)
	if !strings.Contains(string(payload), `"dashboard_range":{"preset":"6h"}`) ||
		!strings.Contains(string(payload), `"log_filters":{"hideManagement":true,"levels":["warn"],"statusClass":"all"}`) ||
		!strings.Contains(string(payload), `"provider_icons":{"openai-compat-0":"DeepSeek","relay":"OpenAI"}`) ||
		!strings.Contains(string(payload), `"usage_events_view":{"preset":"24h","result":"failed","grouping":"provider","advanced":true}`) ||
		!strings.Contains(string(payload), `"usage_events_columns":{"time":120,"provider":220,"tps":90}`) ||
		!strings.Contains(string(payload), `"oauth_management_view_v1":{"density":"compact","pageSize":24}`) ||
		!strings.Contains(string(payload), `"playground_session":{"client_key_fingerprint":"hmac:playground","model":"gpt-5","turns":[]}`) ||
		!strings.Contains(string(payload), `"agent_target":{"client_key_fingerprint":"hmac:agent","model":"gpt-5","reasoning_effort":"high"}`) ||
		!strings.Contains(string(payload), `"omc_scroll_smoothing":"system"`) ||
		!strings.Contains(string(payload), `"omc_theme":`+themeDocument) {
		t.Fatalf("stored values did not come back verbatim: %s", payload)
	}
	stored, found, err := repo.GetPreference(context.Background(), repository.PreferenceDashboardRange)
	if err != nil || !found {
		t.Fatalf("value must be persisted in the database: found=%v err=%v", found, err)
	}
	if stored != `{"preset":"6h"}` {
		t.Fatalf("database holds %q", stored)
	}
	if _, found, err = repo.GetPreference(context.Background(), repository.PreferenceLogFilters); err != nil || !found {
		t.Fatalf("log filters not persisted: found=%v err=%v", found, err)
	}
	if _, found, err = repo.GetPreference(context.Background(), repository.PreferenceProviderIcons); err != nil || !found {
		t.Fatalf("provider icons not persisted: found=%v err=%v", found, err)
	}
	if _, found, err = repo.GetPreference(context.Background(), repository.PreferenceUsageEventsView); err != nil || !found {
		t.Fatalf("usage events view not persisted: found=%v err=%v", found, err)
	}
	if _, found, err = repo.GetPreference(context.Background(), repository.PreferencePlaygroundSession); err != nil || !found {
		t.Fatalf("playground session not persisted: found=%v err=%v", found, err)
	}
	if _, found, err = repo.GetPreference(context.Background(), repository.PreferenceUsageEventsColumns); err != nil || !found {
		t.Fatalf("usage events columns not persisted: found=%v err=%v", found, err)
	}
	if _, found, err = repo.GetPreference(context.Background(), repository.PreferenceOAuthManagementView); err != nil || !found {
		t.Fatalf("OAuth management view not persisted: found=%v err=%v", found, err)
	}
}

func TestTimezonePreferenceControlsCalendarAndMetadata(t *testing.T) {
	t.Setenv("TZ", "Asia/Kathmandu")
	client, baseURL, _ := startDashboardTestServer(t, nil)
	endpoint := baseURL + "/omc/api/v1/preferences"
	response, payload := doJSON(t, client, http.MethodPut, endpoint+"/omc_timezone", `"America/New_York"`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("%d %s", response.StatusCode, payload)
	}
	response, payload = getJSON(t, client, endpoint)
	var body struct {
		TimeZone repository.TimezoneInfo `json:"time_zone"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.TimeZone.Timezone != "America/New_York" || body.TimeZone.ServerTimezone != "Asia/Kathmandu" || body.TimeZone.EffectiveTimezone != "America/New_York" {
		t.Fatalf("%s", payload)
	}
	heatmap := getHeatmapJSON(t, client, heatmapURL(baseURL, ""))
	if heatmap.Timezone != "America/New_York" {
		t.Fatal(heatmap.Timezone)
	}
	for _, raw := range []string{`null`, `{}`, `"Local"`, `"Invalid/Zone"`} {
		response, payload = doJSON(t, client, http.MethodPut, endpoint+"/omc_timezone", raw)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%d %s", response.StatusCode, payload)
		}
	}
	response, payload = doJSON(t, client, http.MethodPut, endpoint+"/omc_timezone", `""`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("%d %s", response.StatusCode, payload)
	}
	if heatmap := getHeatmapJSON(t, client, heatmapURL(baseURL, "")); heatmap.Timezone != "Asia/Kathmandu" {
		t.Fatal(heatmap.Timezone)
	}
}

func TestTpsCalculationPreferenceRoundTrip(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	base := baseURL + "/omc/api/v1/preferences"
	for _, mode := range []string{"exclude_ttft", "include_ttft"} {
		body := `"` + mode + `"`
		response, payload := doJSON(t, client, http.MethodPut, base+"/omc_tps_calculation_mode", body)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("write: status=%d body=%s", response.StatusCode, payload)
		}
		stored, isStored, err := repo.GetPreference(context.Background(), "omc_tps_calculation_mode")
		if err != nil || !isStored || stored != body {
			t.Fatalf("stored=%s found=%t err=%v", stored, isStored, err)
		}
		response, payload = getJSON(t, client, base)
		var listed struct {
			Preferences map[string]json.RawMessage `json:"preferences"`
		}
		if response.StatusCode != http.StatusOK || json.Unmarshal(payload, &listed) != nil || string(listed.Preferences["omc_tps_calculation_mode"]) != body {
			t.Fatalf("read: status=%d body=%s", response.StatusCode, payload)
		}
	}
}
