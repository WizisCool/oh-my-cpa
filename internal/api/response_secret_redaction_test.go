package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestOrdinaryAuthFileDTOSecrets(t *testing.T) {
	const sentinel = "opaque-token-sentinel"
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v8/management/credentials":
			_, _ = fmt.Fprintf(w, `{"files":[{"name":"demo.json","auth_index":"new-index","provider":"codex","status_message":"Bearer %s","quota":{"signals":{"access_token":"%s","Authorization":"Bearer %s","state":"ok"}}}]}`, sentinel, sentinel, sentinel)
		default:
			http.NotFound(w, r)
		}
	})
	response, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/auth-files", "")
	leaked := strings.Contains(string(body), sentinel)
	t.Logf("ordinary-list status=%d opaque-token-exposed=%v", response.StatusCode, leaked)
	if response.StatusCode != 200 {
		t.Fatal("fixture did not reach ordinary list")
	}
	if leaked {
		t.Error("ordinary auth-file DTO leaks credential-bearing signals/status")
	}
}

func TestStaleAuthFileIdentityDoesNotMutate(t *testing.T) {
	var writes atomic.Int32
	var priority atomic.Int32
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v8/management/credentials/fields":
			if r.Method == http.MethodPatch {
				writes.Add(1)
				var body struct {
					Priority *int `json:"priority"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body.Priority != nil {
					priority.Store(int32(*body.Priority))
				}
			}
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		case "/v8/management/credentials":
			_, _ = fmt.Fprintf(w, `{"files":[{"name":"demo.json","auth_index":"new-index","priority":%d}]}`, priority.Load())
		default:
			http.NotFound(w, r)
		}
	})
	response, _ := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/auth-files/fields", `{"name":"demo.json","auth_index":"old-index","priority":5}`)
	t.Logf("stale selector response=%d upstream_mutations=%d replacement_priority=%d", response.StatusCode, writes.Load(), priority.Load())
	if priority.Load() != 0 {
		t.Error("replacement resource actually changed from priority0 to5")
	}
	if writes.Load() != 0 {
		t.Error("same-name replacement mutated before stale identity is checked")
	}
	if response.StatusCode != http.StatusConflict {
		t.Errorf("expected stale identity conflict got%d", response.StatusCode)
	}
}

func TestProviderPullErrorDoesNotRevealStoredKey(t *testing.T) {
	const storedKey = "opaque-stored-provider-key"
	var sawStoredKey atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawStoredKey.Store(r.Header.Get("Authorization") == "Bearer "+storedKey)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprintf(w, `{"error":{"message":"Authorization: %s"}}`, r.Header.Get("Authorization"))
	}))
	defer upstream.Close()
	client, baseURL, _ := startProviderTestServer(t)
	requestBody, _ := json.Marshal(map[string]any{"family": "claude", "name": "Relay", "base_url": upstream.URL, "keys": []map[string]string{{"api_key": storedKey}}})
	response, _ := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/claude-0", string(requestBody))
	if response.StatusCode != 200 {
		t.Fatalf("provider fixture update status%d", response.StatusCode)
	}
	response, body := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", `{"provider_id":"claude-0"}`)
	leaked := strings.Contains(string(body), storedKey)
	t.Logf("provider_id_only=true stored-key-sent=%v response=%d stored-key-exposed=%v", sawStoredKey.Load(), response.StatusCode, leaked)
	if !sawStoredKey.Load() {
		t.Fatal("fixture did not resolve stored provider credential")
	}
	if leaked {
		t.Error("ordinary model-pull error reveals stored provider credential")
	}
}

func TestOrdinaryQuotaErrorDoesNotExposeUpstreamToken(t *testing.T) {
	const sentinel = "opaque-quota-error-token"
	var calls atomic.Int32
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v8/management/credentials":
			_, _ = w.Write([]byte(`{"files":[{"name":"fixture-codex.json","auth_index":"fixture-codex-index","type":"codex","provider":"codex","disabled":false}]}`))
		case "/v8/management/requests/api-call":
			calls.Add(1)
			_, _ = fmt.Fprintf(w, `{"status_code":401,"body":{"message":"Bearer %s"}}`, sentinel)
		default:
			http.NotFound(w, r)
		}
	})
	response, body := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/quota/refresh", `{"auth_index":"fixture-codex-index"}`)
	exposed := strings.Contains(string(body), sentinel)
	t.Logf("ordinary quota-refresh status=%d CPA-mock-executions=%d secret-exposed=%v", response.StatusCode, calls.Load(), exposed)
	if calls.Load() != 1 || response.StatusCode != http.StatusOK {
		t.Fatal("fixture failed to reach quota refresh path")
	}
	if exposed {
		t.Error("ordinary quota error DTO exposes CPA-substituted opaque token echo")
	}
}
