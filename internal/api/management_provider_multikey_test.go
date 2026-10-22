package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestConfigProviderSavesEveryKey(t *testing.T) {
	for _, spec := range providerConfigFamilies {
		for _, isCreate := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/create=%t", spec.Family, isCreate), func(t *testing.T) {
				fixture := newProviderTestFixture(t)
				family := string(spec.Family)
				fixture.state.mu.Lock()
				*fixture.state.providerList(family) = []map[string]any{
					{"api-key": "fixture-existing", "auth-index": "fixture-index", "base-url": "https://existing.test", "websockets": true},
					{"api-key": "fixture-neighbour", "auth-index": "neighbour-index", "base-url": "https://neighbour.test"},
				}
				fixture.state.mu.Unlock()
				sourceID, neighbourID := spec.IDPrefix+"0", spec.IDPrefix+"1"
				ctx := context.Background()
				for _, preference := range []string{repository.PreferenceProviderNames, repository.PreferenceProviderWebsites, repository.PreferenceProviderIcons} {
					values, _ := json.Marshal(map[string]string{sourceID: "source-value", neighbourID: "neighbour-value"})
					if err := fixture.handler.repo.PutPreference(ctx, preference, string(values)); err != nil {
						t.Fatal(err)
					}
				}
				method, path := http.MethodPost, providersEndpoint
				ids := []string{spec.IDPrefix + "2", spec.IDPrefix + "3"}
				if !isCreate {
					method, path, ids = http.MethodPut, path+"/"+sourceID, []string{sourceID, spec.IDPrefix + "2"}
				}
				body := fmt.Sprintf(`{"family":%q,"expected_auth_index":"fixture-index","name":"Multi-key relay","website":"https://site.test","base_url":"https://relay.test/v1","prefix":"team","priority":4,"disabled":true,"runtime_policy":{"cooling":"enabled","request_retry":2},"headers":{"X-Team":"test"},"model_entries":[{"name":"model-one","alias":"one"}],"keys":[{"api_key":"fixture-first","proxy_url":"http://proxy-one.test","weight":3},{"api_key":"fixture-second","proxy_url":"http://proxy-two.test","weight":7}]}`, family)
				response, payload := doJSON(t, fixture.client, method, fixture.baseURL+path, body)
				if response.StatusCode != http.StatusOK {
					t.Fatalf("save status=%d", response.StatusCode)
				}
				var result struct {
					ID  string   `json:"id"`
					IDs []string `json:"ids"`
				}
				if err := json.Unmarshal(payload, &result); err != nil {
					t.Fatal(err)
				}
				if result.ID != ids[0] || !reflect.DeepEqual(result.IDs, ids) {
					t.Errorf("saved ids=%v primary=%s, want %v", result.IDs, result.ID, ids)
				}
				if strings.Contains(string(payload), "fixture-first") || strings.Contains(string(payload), "fixture-second") {
					t.Error("save response contains credentials")
				}
				fixture.state.mu.Lock()
				rows := *fixture.state.providerList(family)
				writes := fixture.state.putCount
				fixture.state.mu.Unlock()
				wantCount := 4
				if !isCreate {
					wantCount = 3
				}
				if len(rows) != wantCount {
					t.Fatalf("stored %d credentials, want %d", len(rows), wantCount)
				}
				if writes != 1 {
					t.Errorf("CPA writes=%d, want one atomic write", writes)
				}
				if rows[1]["api-key"] != "fixture-neighbour" || rows[1]["base-url"] != "https://neighbour.test" {
					t.Error("save changed the neighbouring credential")
				}
				_, listedRaw := getJSON(t, fixture.client, fixture.baseURL+providersEndpoint+"?include_keys=true")
				var listed struct {
					Providers []ProviderItemDTO `json:"providers"`
				}
				if err := json.Unmarshal(listedRaw, &listed); err != nil {
					t.Fatal(err)
				}
				for position, id := range ids {
					rowIndex := 2 + position
					if !isCreate {
						rowIndex = 0
						if position == 1 {
							rowIndex = 2
						}
					}
					row := rows[rowIndex]
					wantKey, wantProxy, wantWeight := "fixture-first", "http://proxy-one.test", 3
					if position == 1 {
						wantKey, wantProxy, wantWeight = "fixture-second", "http://proxy-two.test", 7
					}
					if row["api-key"] != wantKey || row["proxy-url"] != wantProxy || row["weight"] != float64(wantWeight) {
						t.Errorf("key %d lost its credentials, proxy or weight", position)
					}
					if row["base-url"] != "https://relay.test/v1" || row["prefix"] != "team" || row["priority"] != float64(4) || !reflect.DeepEqual(row["excluded-models"], []any{"*"}) {
						t.Errorf("key %d lost common settings", position)
					}
					if row["request-retry"] != float64(2) || row["disable-cooling"] != false {
						t.Errorf("key %d lost its runtime policy", position)
					}
					if !reflect.DeepEqual(row["headers"], map[string]any{"X-Team": "test"}) {
						t.Errorf("key %d lost its shared headers", position)
					}
					if !isCreate && row["websockets"] != true {
						t.Errorf("key %d lost unmodelled settings", position)
					}
					model := storedModel(t, row, "model-one")
					if model["alias"] != "one" {
						t.Error("model alias was not preserved")
					}
					isFound := false
					for _, provider := range listed.Providers {
						if provider.ID == id {
							isFound = true
							if len(provider.KeyEntries) != 1 || provider.KeyEntries[0].APIKey != wantKey || provider.Name != "Multi-key relay" || provider.Website != "https://site.test" {
								t.Errorf("row %s did not round trip its key and metadata", id)
							}
						}
					}
					if !isFound {
						t.Errorf("row %s missing after save", id)
					}
				}
				for _, preference := range []string{repository.PreferenceProviderNames, repository.PreferenceProviderWebsites, repository.PreferenceProviderIcons} {
					raw, _, err := fixture.handler.repo.GetPreference(ctx, preference)
					if err != nil {
						t.Fatal(err)
					}
					values := map[string]string{}
					if err := json.Unmarshal([]byte(raw), &values); err != nil {
						t.Fatal(err)
					}
					if values[neighbourID] != "neighbour-value" {
						t.Errorf("%s moved neighbouring metadata", preference)
					}
					if !isCreate && preference == repository.PreferenceProviderIcons {
						for _, id := range ids {
							if values[id] != "source-value" {
								t.Errorf("new row %s did not inherit its icon", id)
							}
						}
					}
				}
			})
		}
	}
}

func TestConfigProviderKeyValidationAndBlankRows(t *testing.T) {
	for _, test := range []struct {
		name, method, keys    string
		wantStatus, wantCount int
		wantCode              string
	}{
		{"create skips blank rows", http.MethodPost, `[{"api_key":" "},{"api_key":"fixture-new"},{"api_key":""}]`, http.StatusOK, 2, ""},
		{"edit keeps masked first key and adds another", http.MethodPut, `[{"api_key":""},{"api_key":"fixture-new"},{"api_key":" "}]`, http.StatusOK, 2, ""},
		{"create refuses an empty credential list", http.MethodPost, `[{"api_key":" "}]`, http.StatusBadRequest, 1, providerKeyRequiredCode},
		{"create refuses duplicate keys", http.MethodPost, `[{"api_key":"fixture-new"},{"api_key":" fixture-new "}]`, http.StatusBadRequest, 1, providerDuplicateKeyCode},
		{"edit refuses duplicate keys", http.MethodPut, `[{"api_key":""},{"api_key":"sk-codex-secret-key-9999"}]`, http.StatusBadRequest, 1, providerDuplicateKeyCode},
		{"create refuses an existing identity", http.MethodPost, `[{"api_key":"fixture-new"},{"api_key":"sk-codex-secret-key-9999"}]`, http.StatusConflict, 1, providerCredentialExistsCode},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newProviderTestFixture(t)
			path := providersEndpoint
			if test.method == http.MethodPut {
				path += "/codex-0"
			}
			body := `{"family":"codex","base_url":"https://api.openai.com","keys":` + test.keys + `}`
			response, payload := doJSON(t, fixture.client, test.method, fixture.baseURL+path, body)
			if response.StatusCode != test.wantStatus {
				t.Errorf("status=%d, want %d", response.StatusCode, test.wantStatus)
			}
			// The console translates these refusals, so the code is the contract and
			// the English message is only the fallback.
			var refusal struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(payload, &refusal); err != nil {
				t.Fatalf("decode refusal: %v", err)
			}
			if refusal.Code != test.wantCode {
				t.Errorf("code=%q, want %q", refusal.Code, test.wantCode)
			}
			fixture.state.mu.Lock()
			defer fixture.state.mu.Unlock()
			if len(fixture.state.codexProviders) != test.wantCount {
				t.Errorf("stored rows=%d, want %d", len(fixture.state.codexProviders), test.wantCount)
			}
			if test.wantStatus != http.StatusOK && fixture.state.putCount != 0 {
				t.Error("refused request wrote to CPA")
			}
			if test.wantStatus == http.StatusOK && len(fixture.state.codexProviders) == 2 {
				if fixture.state.codexProviders[0]["api-key"] != "sk-codex-secret-key-9999" || fixture.state.codexProviders[1]["api-key"] != "fixture-new" {
					t.Error("blank rows changed the stored secret or prevented the new key from being saved")
				}
			}
		})
	}
}

func TestConfigProviderMultiKeySaveSafety(t *testing.T) {
	t.Run("audit failure", func(t *testing.T) {
		handler := &Handler{}
		request := SaveProviderRequest{Family: "codex", BaseURL: "https://relay.test", Keys: []SaveProviderKeyEntry{{APIKey: "fixture-one"}, {APIKey: "fixture-two"}}}
		audit := func(string, string, string, string, map[string]any) error { return errors.New("audit unavailable") }
		for _, isCreate := range []bool{true, false} {
			var err error
			if isCreate {
				_, err = handler.createProvider(context.Background(), nil, request, audit)
			} else {
				_, err = handler.updateProvider(context.Background(), nil, "codex-0", request, audit)
			}
			var refusal *providerWriteError
			if !errors.As(err, &refusal) || refusal.status != http.StatusInternalServerError {
				t.Fatalf("audit failure did not abort before contacting CPA: %v", err)
			}
		}
	})
	t.Run("stale identity", func(t *testing.T) {
		fixture := newProviderTestFixture(t)
		response, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/codex-0", `{"family":"codex","expected_auth_index":"stale-index","base_url":"https://relay.test","keys":[{"api_key":"fixture-one"},{"api_key":"fixture-two"}]}`)
		if response.StatusCode != http.StatusConflict {
			t.Fatalf("stale identity status=%d", response.StatusCode)
		}
		if !strings.Contains(string(payload), providerStaleIdentityCode) {
			t.Fatalf("stale identity refusal lacks %q: %s", providerStaleIdentityCode, payload)
		}
		fixture.state.mu.Lock()
		defer fixture.state.mu.Unlock()
		if fixture.state.putCount != 0 || len(fixture.state.codexProviders) != 1 {
			t.Error("stale identity changed CPA")
		}
	})
	t.Run("metadata failure reports partial commit", func(t *testing.T) {
		fixture := newProviderTestFixture(t)
		if err := fixture.handler.repo.PutPreference(context.Background(), repository.PreferenceProviderNames, "invalid JSON"); err != nil {
			t.Fatal(err)
		}
		response, payload := doJSON(t, fixture.client, http.MethodPost, fixture.baseURL+providersEndpoint, `{"family":"codex","name":"Relay","base_url":"https://relay.test","keys":[{"api_key":"fixture-one"},{"api_key":"fixture-two"}]}`)
		if response.StatusCode == http.StatusOK || !strings.Contains(string(payload), providerPartialCommitCode) {
			t.Fatalf("metadata failure did not report partial commit, status=%d", response.StatusCode)
		}
		fixture.state.mu.Lock()
		defer fixture.state.mu.Unlock()
		if fixture.state.putCount != 1 || len(fixture.state.codexProviders) != 3 {
			t.Error("CPA did not commit the complete credential batch")
		}
	})
}
