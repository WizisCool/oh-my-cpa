package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func TestSIWCLocalStatusClosedProjection(t *testing.T) {
	for _, status := range []string{"off", "valid", "invalid", "", "future-secret-value"} {
		source := management.AuthFile{SIWCSummary: management.SIWCSummary{SIWCStatus: status, SIWCBound: true, SIWCExpiresAt: "2099-01-01T00:00:00Z"}, Provider: "codex"}
		body, _ := json.Marshal(projectManagementAuthFile(source))
		if status == "" || status == "future-secret-value" {
			if strings.Contains(string(body), `"siwc_status"`) {
				t.Fatalf("inferred or unknown status leaked: %s", body)
			}
		} else if !strings.Contains(string(body), fmt.Sprintf(`"siwc_status":%q`, status)) {
			t.Fatalf("missing enum: %s", body)
		}
	}
}

func TestSIWCUseSwitchPreservesPartitionsAndVerifies(t *testing.T) {
	var mu sync.Mutex
	stored := map[string]any{"type": "codex", "access_token": "SYNTHETIC-ORDINARY", "use_siwc": true, "siwc": map[string]any{"access_token": "SYNTHETIC-BOUND", "refresh_token": "SYNTHETIC-REFRESH", "client_id": "SYNTHETIC-CLIENT"}}
	shouldDropWrite := false
	client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/v8/management/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"files": []any{map[string]any{"name": "codex.json", "auth_index": "idx", "provider": "codex", "use_siwc": stored["use_siwc"], "siwc_bound": true, "siwc_status": "invalid"}, map[string]any{"name": "vertex.json", "auth_index": "v", "provider": "vertex"}}})
		case "/v8/management/credentials/download":
			_ = json.NewEncoder(w).Encode(stored)
		case "/v8/management/credentials/fields":
			var patch map[string]any
			_ = json.NewDecoder(r.Body).Decode(&patch)
			if len(patch) != 2 || patch["name"] != "codex.json" {
				t.Errorf("switch changed more than the field: %#v", patch)
			}
			if !shouldDropWrite {
				stored["use_siwc"] = patch["use_siwc"]
			}
			fmt.Fprint(w, `{"status":"ok"}`)
		default:
			fmt.Fprint(w, `{}`)
		}
	})
	endpoint := base + "/omc/api/v1/management/auth-files/fields"
	for _, value := range []bool{false, true} {
		response, raw := doJSON(t, client, http.MethodPatch, endpoint, fmt.Sprintf(`{"name":"codex.json","auth_index":"idx","use_siwc":%t}`, value))
		if response.StatusCode != 200 || strings.Contains(string(raw), "SYNTHETIC-") || !strings.Contains(string(raw), `"siwc_status":"invalid"`) {
			t.Fatalf("switch: %d %s", response.StatusCode, raw)
		}
	}
	mu.Lock()
	shouldDropWrite = true
	mu.Unlock()
	response, raw := doJSON(t, client, http.MethodPatch, endpoint, `{"name":"codex.json","auth_index":"idx","use_siwc":false}`)
	if response.StatusCode != 502 {
		t.Fatalf("unverified switch: %d %s", response.StatusCode, raw)
	}
	for _, payload := range []string{
		`{"name":"vertex.json","auth_index":"v","use_siwc":false}`,
		`{"name":"codex.json","auth_index":"idx","use_siwc":null}`,
		`{"name":"codex.json","auth_index":"idx","use_siwc":"false"}`,
	} {
		response, raw = doJSON(t, client, http.MethodPatch, endpoint, payload)
		if response.StatusCode != 400 {
			t.Fatalf("invalid switch: %d %s", response.StatusCode, raw)
		}
	}
	response, raw = doJSON(t, client, http.MethodPatch, endpoint, `{"name":"codex.json","auth_index":"stale","use_siwc":false}`)
	if response.StatusCode != 409 {
		t.Fatalf("stale target: %d %s", response.StatusCode, raw)
	}
	response, raw = doJSON(t, client, http.MethodGet, base+"/omc/api/v1/management/oauth/siwc/status?name=codex.json", "")
	if response.StatusCode != 400 {
		t.Fatalf("credential selector accepted as session: %d %s", response.StatusCode, raw)
	}
	mu.Lock()
	defer mu.Unlock()
	if stored["access_token"] != "SYNTHETIC-ORDINARY" || stored["siwc"].(map[string]any)["access_token"] != "SYNTHETIC-BOUND" {
		t.Fatal("credential partitions changed")
	}
	for _, request := range recorder.all() {
		if strings.Contains(request.Path, "/oauth/") {
			t.Fatalf("status/toggle invoked binding or refresh: %s", request.Path)
		}
	}
}

func TestSIWCUseSwitchRefusesDuplicateNameEvenWithAuthIndex(t *testing.T) {
	client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"files":[{"name":"codex.json","auth_index":"one","provider":"codex"},{"name":"codex.json","auth_index":"two","provider":"codex"}]}`)
	})
	response, raw := doJSON(t, client, http.MethodPatch, base+"/omc/api/v1/management/auth-files/fields", `{"name":"codex.json","auth_index":"one","use_siwc":false}`)
	if response.StatusCode != 409 {
		t.Fatalf("ambiguous patch: %d %s", response.StatusCode, raw)
	}
	for _, request := range recorder.all() {
		if request.Method == http.MethodPatch {
			t.Fatal("ambiguous selector reached CPA write")
		}
	}
}

func TestSIWCUseSwitchRequiresBindingOnlyWhenEnabling(t *testing.T) {
	var mu sync.Mutex
	isEnabled := true
	client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/v8/management/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"files": []any{map[string]any{"name": "codex.json", "auth_index": "cx", "provider": "codex", "siwc_bound": false, "use_siwc": isEnabled, "siwc_status": "invalid"}}})
		case "/v8/management/credentials/download":
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "codex", "use_siwc": isEnabled})
		case "/v8/management/credentials/fields":
			var patch map[string]any
			_ = json.NewDecoder(r.Body).Decode(&patch)
			isEnabled = patch["use_siwc"].(bool)
			fmt.Fprint(w, `{"status":"ok"}`)
		}
	})
	endpoint := base + "/omc/api/v1/management/auth-files/fields"
	response, raw := doJSON(t, client, http.MethodPatch, endpoint, `{"name":"codex.json","auth_index":"cx","use_siwc":true}`)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unbound enable: %d %s", response.StatusCode, raw)
	}
	for _, request := range recorder.all() {
		if request.Method == http.MethodPatch {
			t.Fatal("unbound enable reached the gateway write")
		}
	}
	response, raw = doJSON(t, client, http.MethodPatch, endpoint, `{"name":"codex.json","auth_index":"cx","use_siwc":false}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unbound disable: %d %s", response.StatusCode, raw)
	}
}
