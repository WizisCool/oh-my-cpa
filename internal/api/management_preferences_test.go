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

	_, payload = getJSON(t, client, base)
	if !strings.Contains(string(payload), `"dashboard_range":{"preset":"6h"}`) ||
		!strings.Contains(string(payload), `"log_filters":{"hideManagement":true,"levels":["warn"],"statusClass":"all"}`) ||
		!strings.Contains(string(payload), `"provider_icons":{"openai-compat-0":"DeepSeek","relay":"OpenAI"}`) ||
		!strings.Contains(string(payload), `"usage_events_view":{"preset":"24h","result":"failed","grouping":"provider","advanced":true}`) ||
		!strings.Contains(string(payload), `"usage_events_columns":{"time":120,"provider":220,"tps":90}`) ||
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
	if _, found, err = repo.GetPreference(context.Background(), repository.PreferenceUsageEventsColumns); err != nil || !found {
		t.Fatalf("usage events columns not persisted: found=%v err=%v", found, err)
	}
}
