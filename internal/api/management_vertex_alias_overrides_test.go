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

func TestVertexOAuthAliasOverridesRoundTripAndReadback(t *testing.T) {
	for _, initial := range []bool{false, true} {
		t.Run(fmt.Sprint(initial), func(t *testing.T) {
			var mu sync.Mutex
			state := map[string][]management.OAuthModelAlias{"vertex": {
				{Name: "partner/model", Alias: "first", OpenAPI: &initial},
				{Name: "partner/model", Alias: "second"},
			}}
			shouldDropOverride := false
			client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v8/management/config/oauth/model-alias":
					_ = json.NewEncoder(w).Encode(state)
				case r.Method == http.MethodPatch && r.URL.Path == "/v8/management/config":
					var patch struct {
						OAuth struct {
							Aliases map[string][]management.OAuthModelAlias `json:"model-alias"`
						} `json:"oauth"`
					}
					_ = json.NewDecoder(r.Body).Decode(&patch)
					state = patch.OAuth.Aliases
					if shouldDropOverride {
						state["vertex"][0].OpenAPI = nil
					}
					fmt.Fprint(w, `{"status":"ok"}`)
				default:
					fmt.Fprint(w, `{}`)
				}
			})
			endpoint := base + "/omc/api/v1/management/auth-files/model-aliases"
			response, raw := doJSON(t, client, http.MethodGet, endpoint, "")
			var read struct {
				Aliases map[string][]managementOAuthModelAlias `json:"aliases"`
			}
			if response.StatusCode != 200 || json.Unmarshal(raw, &read) != nil {
				t.Fatalf("read: %d %s", response.StatusCode, raw)
			}
			if value := read.Aliases["vertex"][0].OpenAPI; value == nil || *value != initial {
				t.Fatalf("override not projected: %s", raw)
			}
			read.Aliases["vertex"][1].DisplayName = "Edited sibling"
			payload, _ := json.Marshal(map[string]any{"provider": "vertex", "aliases": read.Aliases["vertex"]})
			response, raw = doJSON(t, client, http.MethodPatch, endpoint, string(payload))
			if response.StatusCode != 200 {
				t.Fatalf("save: %d %s", response.StatusCode, raw)
			}
			var sent map[string]any
			_ = json.Unmarshal([]byte(recorder.last(t, http.MethodPatch, "/v8/management/config").Body), &sent)
			aliases := sent["oauth"].(map[string]any)["model-alias"].(map[string]any)["vertex"].([]any)
			if aliases[0].(map[string]any)["openapi"] != initial || aliases[1].(map[string]any)["display-name"] != "Edited sibling" {
				t.Fatalf("write lost overrides: %#v", aliases)
			}
			// A successful upstream acknowledgement is not proof that the override persisted.
			mu.Lock()
			shouldDropOverride = true
			mu.Unlock()
			response, raw = doJSON(t, client, http.MethodPatch, endpoint, string(payload))
			if response.StatusCode != 502 {
				t.Fatalf("unverified save: %d %s", response.StatusCode, raw)
			}
			read.Aliases["vertex"][0].OpenAPI = nil
			payload, _ = json.Marshal(map[string]any{"provider": "vertex", "aliases": read.Aliases["vertex"]})
			response, raw = doJSON(t, client, http.MethodPatch, endpoint, string(payload))
			if response.StatusCode != 200 || strings.Contains(string(raw), `"openapi"`) {
				t.Fatalf("clear inheritance: %d %s", response.StatusCode, raw)
			}
			response, raw = doJSON(t, client, http.MethodPatch, endpoint, `{"provider":"codex","aliases":[{"name":"a","alias":"b","openapi":false}]}`)
			if response.StatusCode != 400 {
				t.Fatalf("wrong family: %d %s", response.StatusCode, raw)
			}
		})
	}
}

func TestVertexCredentialAliasOverridesPreserveAndClear(t *testing.T) {
	for _, value := range []bool{false, true} {
		t.Run(fmt.Sprint(value), func(t *testing.T) {
			upstream, stored := vertexOpenAPIUpstream(t)
			stored()["model_aliases"] = []any{map[string]any{"name": "partner/model", "alias": "one", "openapi": value}, map[string]any{"name": "partner/model", "alias": "two"}}
			client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", upstream)
			response, raw := doJSON(t, client, http.MethodGet, base+"/omc/api/v1/management/auth-files/safe-fields?name=vertex-sa.json&auth_index=vertex-1", "")
			var fields managementAuthFileSafeFields
			if response.StatusCode != 200 || json.Unmarshal(raw, &fields) != nil || fields.ModelAliases[0].OpenAPI == nil || *fields.ModelAliases[0].OpenAPI != value {
				t.Fatalf("safe projection: %s", raw)
			}
			fields.ModelAliases[1].DisplayName = "Edited"
			payload, _ := json.Marshal(map[string]any{"name": "vertex-sa.json", "auth_index": "vertex-1", "model_aliases": fields.ModelAliases})
			endpoint := base + "/omc/api/v1/management/auth-files/fields"
			response, raw = doJSON(t, client, http.MethodPatch, endpoint, string(payload))
			if response.StatusCode != 200 {
				t.Fatalf("verified aliases: %d %s", response.StatusCode, raw)
			}
			var sent map[string]any
			_ = json.Unmarshal([]byte(recorder.last(t, http.MethodPatch, "/v8/management/credentials/fields").Body), &sent)
			if sent["model_aliases"].([]any)[0].(map[string]any)["openapi"] != value {
				t.Fatalf("wire lost false/true: %#v", sent)
			}
			response, raw = doJSON(t, client, http.MethodPatch, endpoint, `{"name":"vertex-sa.json","auth_index":"vertex-1","model_aliases":[{"name":"partner/model","alias":"one","openapi":null}]}`)
			var cleared struct {
				Fields managementAuthFileSafeFields `json:"fields"`
			}
			_ = json.Unmarshal(raw, &cleared)
			if response.StatusCode != 200 || len(cleared.Fields.ModelAliases) != 1 || cleared.Fields.ModelAliases[0].OpenAPI != nil {
				t.Fatalf("inherit: %d %s", response.StatusCode, raw)
			}
			response, raw = doJSON(t, client, http.MethodPatch, endpoint, `{"name":"codex.json","auth_index":"codex-1","model_aliases":[{"name":"a","alias":"b","openapi":true}]}`)
			if response.StatusCode != 400 {
				t.Fatalf("family: %d %s", response.StatusCode, raw)
			}
		})
	}
}
