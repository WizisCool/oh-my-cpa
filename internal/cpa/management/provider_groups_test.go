package management

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// groupsGateway serves one family's stored groups on the v8 configuration
// route and CPA's runtime list for it on the v0 route, and records what a
// write sends back.
type groupsGateway struct {
	mu      sync.Mutex
	family  string
	stored  string
	runtime string
	written []map[string]any
	removed bool
}

func (g *groupsGateway) handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		g.mu.Lock()
		defer g.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v0/management/config.yaml":
			_, _ = writer.Write([]byte("config-version: 8\n"))
		case request.Method == http.MethodGet && request.URL.Path == "/v0/management/"+g.runtimeEndpoint():
			_, _ = writer.Write([]byte(g.runtime))
		case request.Method == http.MethodGet && request.URL.Path == "/v8/management/config/api-keys/"+g.family:
			if g.stored == "" {
				writer.WriteHeader(http.StatusNotFound)
				_, _ = writer.Write([]byte(`{"error":"not_found"}`))
				return
			}
			_, _ = writer.Write([]byte(g.stored))
		case request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config":
			body, _ := io.ReadAll(request.Body)
			var merge struct {
				APIKeys map[string][]map[string]any `json:"api-keys"`
			}
			_ = json.Unmarshal(body, &merge)
			g.written = merge.APIKeys[g.family]
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case request.Method == http.MethodDelete && request.URL.Path == "/v8/management/config/api-keys/"+g.family:
			g.removed = true
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"error":"unexpected ` + request.Method + " " + request.URL.Path + `"}`))
		}
	})
}

func (g *groupsGateway) runtimeEndpoint() string {
	if g.family == "openai-compatibility" {
		return g.family
	}
	return g.family + "-api-key"
}

func newGroupsClient(t *testing.T, gateway *groupsGateway) *Client {
	t.Helper()
	server := newV8Server(gateway.handler())
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

// claudeTeamGroups is a family an operator grouped by hand: two keys sharing
// an endpoint, models and a priority, the second with its own weight, and a
// second group with one key.
const claudeTeamGroups = `[
  {"name":"team","base-url":"https://a.test","priority":3,"models":[{"name":"m1","alias":"x"}],"disable-cooling":true,
   "keys":[{"api-key":"k1"},{"api-key":"k2","weight":2},{"api-key":"k3"}]},
  {"name":"solo","base-url":"https://b.test","keys":[{"api-key":"k9","proxy-url":"http://proxy.test"}]}
]`

const claudeTeamRuntime = `{"claude-api-key":[
  {"api-key":"k1","base-url":"https://a.test","priority":3,"proxy-url":"","models":[{"name":"m1","alias":"x"}],"disable-cooling":true,"auth-index":"i1"},
  {"api-key":"k2","base-url":"https://a.test","priority":3,"proxy-url":"","weight":2,"models":[{"name":"m1","alias":"x"}],"disable-cooling":true,"auth-index":"i2"},
  {"api-key":"k3","base-url":"https://a.test","priority":3,"proxy-url":"","models":[{"name":"m1","alias":"x"}],"disable-cooling":true,"auth-index":"i3"},
  {"api-key":"k9","base-url":"https://b.test","proxy-url":"http://proxy.test","models":[],"auth-index":"i9"}
]}`

// editClaudeTeam reads the grouped family, applies edit to the flattened list
// and returns the groups the write sent.
func editClaudeTeam(t *testing.T, edit func([]ConfigAPIKey) []ConfigAPIKey) []map[string]any {
	t.Helper()
	gateway := &groupsGateway{family: "claude", stored: claudeTeamGroups, runtime: claudeTeamRuntime}
	client := newGroupsClient(t, gateway)
	entries, err := client.EditableConfigAPIKeys(context.Background(), ConfigFamilyClaude)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.UpdateConfigAPIKeys(context.Background(), ConfigFamilyClaude, edit(entries)); err != nil {
		t.Fatal(err)
	}
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	return gateway.written
}

func decodeGroups(t *testing.T, document string) []map[string]any {
	t.Helper()
	var groups []map[string]any
	if err := json.Unmarshal([]byte(document), &groups); err != nil {
		t.Fatal(err)
	}
	return groups
}

func groupNames(groups []map[string]any) []string {
	names := make([]string, len(groups))
	for i, group := range groups {
		names[i], _ = group["name"].(string)
	}
	return names
}

func groupKeys(group map[string]any) []map[string]any {
	var keys []map[string]any
	for _, key := range group["keys"].([]any) {
		keys = append(keys, key.(map[string]any))
	}
	return keys
}

func TestEditableConfigAPIKeysCarriesRuntimeIndexesAndStoredSettings(t *testing.T) {
	gateway := &groupsGateway{family: "claude", stored: claudeTeamGroups, runtime: claudeTeamRuntime}
	entries, err := newGroupsClient(t, gateway).EditableConfigAPIKeys(context.Background(), ConfigFamilyClaude)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("entries = %d, want the runtime list's 4", len(entries))
	}
	for i, want := range []string{"i1", "i2", "i3", "i9"} {
		if entries[i].AuthIndex != want || entries[i].origin == nil {
			t.Fatalf("entry %d = %+v, want auth index %s and its stored group", i, entries[i], want)
		}
	}
	if entries[1].Weight == nil || *entries[1].Weight != 2 || entries[1].BaseURL != "https://a.test" {
		t.Fatalf("second key = %+v, want its own weight and the group's endpoint", entries[1])
	}
}

func TestEditableConfigAPIKeysSkipsAStoredKeyTheRuntimeLeftOut(t *testing.T) {
	// A duplicate key is dropped by CPA's runtime; the positions the console
	// shows are the runtime's, so the stored duplicate is not matched to one.
	gateway := &groupsGateway{
		family:  "gemini",
		stored:  `[{"name":"g-1","keys":[{"api-key":"dup"}]},{"name":"g-2","keys":[{"api-key":"dup"}]},{"name":"g-3","keys":[{"api-key":"other","prefix":" Team "}]}]`,
		runtime: `{"gemini-api-key":[{"api-key":"dup","auth-index":"a"},{"api-key":"other","prefix":"team","auth-index":"b"}]}`,
	}
	entries, err := newGroupsClient(t, gateway).EditableConfigAPIKeys(context.Background(), ConfigFamilyGemini)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[1].APIKey != "other" || entries[1].AuthIndex != "b" {
		t.Fatalf("entries = %+v", entries)
	}
	if entries[1].Prefix != " Team " {
		t.Fatalf("prefix = %q, want the stored value rather than the runtime's normalized one", entries[1].Prefix)
	}
}

func TestUpdateConfigAPIKeysKeepsAnUnchangedFamilyAsStored(t *testing.T) {
	written := editClaudeTeam(t, func(entries []ConfigAPIKey) []ConfigAPIKey { return entries })
	if want := decodeGroups(t, claudeTeamGroups); !reflect.DeepEqual(written, want) {
		t.Fatalf("groups = %#v\nwant %#v", written, want)
	}
}

func TestUpdateConfigAPIKeysStatesAKeysOwnValueInsideItsGroup(t *testing.T) {
	written := editClaudeTeam(t, func(entries []ConfigAPIKey) []ConfigAPIKey {
		entries[1].ExcludedModels = SetExcludedAll(entries[1].ExcludedModels, true)
		entries[2].Models = nil
		entries[2].Priority = nil
		return entries
	})
	if got := groupNames(written); !reflect.DeepEqual(got, []string{"team", "solo"}) {
		t.Fatalf("groups = %v, want the stored grouping kept", got)
	}
	keys := groupKeys(written[0])
	if !reflect.DeepEqual(keys[1]["excluded-models"], []any{"*"}) {
		t.Fatalf("second key = %#v, want its own exclusion", keys[1])
	}
	// Clearing a group's models or priority for one key is the zero value.
	if !reflect.DeepEqual(keys[2]["models"], []any{}) || keys[2]["priority"] != float64(0) {
		t.Fatalf("third key = %#v, want models [] and priority 0", keys[2])
	}
	if written[0]["priority"] != float64(3) || written[0]["base-url"] != "https://a.test" {
		t.Fatalf("group settings changed: %#v", written[0])
	}
}

func TestUpdateConfigAPIKeysMovesAKeyItsGroupCannotExpress(t *testing.T) {
	written := editClaudeTeam(t, func(entries []ConfigAPIKey) []ConfigAPIKey {
		entries[1].BaseURL = "https://moved.test"
		entries[2].DisableCooling = nil
		return entries
	})
	// Order is the console's provider ids, so it must be kept exactly.
	if got := groupNames(written); !reflect.DeepEqual(got, []string{"team", "team-2", "team-3", "solo"}) {
		t.Fatalf("groups = %v", got)
	}
	if written[1]["base-url"] != "https://moved.test" || groupKeys(written[1])[0]["api-key"] != "k2" {
		t.Fatalf("moved key's group = %#v", written[1])
	}
	// disable-cooling has no key-level spelling of "inherit", so the key that
	// cleared it stands alone without it.
	if _, has := written[2]["disable-cooling"]; has || groupKeys(written[2])[0]["api-key"] != "k3" {
		t.Fatalf("third key's group = %#v, want no disable-cooling", written[2])
	}
	if written[2]["priority"] != float64(3) {
		t.Fatalf("third key's group = %#v, want the rest of its settings", written[2])
	}
}

func TestUpdateConfigAPIKeysChangesASettingWhereItIsStored(t *testing.T) {
	written := editClaudeTeam(t, func(entries []ConfigAPIKey) []ConfigAPIKey {
		five := 5
		for i := 0; i < 3; i++ {
			entries[i].Priority = &five
		}
		entries[3].ProxyURL = "http://other.test"
		return entries
	})
	if written[0]["priority"] != float64(5) {
		t.Fatalf("team group = %#v, want the priority every key now states", written[0])
	}
	for _, key := range groupKeys(written[0]) {
		if _, has := key["priority"]; has {
			t.Fatalf("key repeats the group's value: %#v", key)
		}
	}
	// solo stores its proxy on the key, and a change keeps it there.
	if _, has := written[1]["proxy-url"]; has || groupKeys(written[1])[0]["proxy-url"] != "http://other.test" {
		t.Fatalf("solo group = %#v, want the proxy changed on its key", written[1])
	}
}

func TestUpdateConfigAPIKeysAppendsANewKeyAsItsOwnGroup(t *testing.T) {
	written := editClaudeTeam(t, func(entries []ConfigAPIKey) []ConfigAPIKey {
		return append(entries, ConfigAPIKey{APIKey: "new", BaseURL: "https://c.test", AuthIndex: "runtime-only"})
	})
	last := written[len(written)-1]
	if last["name"] != "claude-1" || last["base-url"] != "https://c.test" {
		t.Fatalf("new group = %#v", last)
	}
	if key := groupKeys(last)[0]; key["api-key"] != "new" || key["auth-index"] != nil {
		t.Fatalf("new key = %#v, want the key without a runtime field", key)
	}
}

func TestUpdateConfigAPIKeysRemovesAnEmptiedFamily(t *testing.T) {
	gateway := &groupsGateway{family: "meta"}
	if err := newGroupsClient(t, gateway).UpdateConfigAPIKeys(context.Background(), ConfigFamilyMeta, nil); err != nil {
		t.Fatal(err)
	}
	if !gateway.removed {
		t.Fatal("an emptied family must be removed, not written as a list")
	}
}

func TestUpdateOpenAICompatibilityKeepsUnmodelledSettings(t *testing.T) {
	gateway := &groupsGateway{
		family: "openai-compatibility",
		stored: `[{"name":"relay","base-url":"https://r.test","request-retry":0,"support-prompt-cache-key":true,
		  "models":[{"name":"m","alias":"a","input-modalities":["text","image"]}],"keys":[{"api-key":"o1"}]}]`,
		runtime: `{"openai-compatibility":[{"name":"relay","base-url":"https://r.test","request-retry":0,"support-prompt-cache-key":true,
		  "models":[{"name":"m","alias":"a","input-modalities":["text","image"]}],"api-key-entries":[{"api-key":"o1","auth-index":"x1"}]}]}`,
	}
	client := newGroupsClient(t, gateway)
	entries, err := client.EditableOpenAICompatibility(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if entries[0].APIKeyEntries[0].AuthIndex != "x1" {
		t.Fatalf("key auth index = %q", entries[0].APIKeyEntries[0].AuthIndex)
	}
	entries[0].Disabled = true
	if err := client.UpdateOpenAICompatibility(context.Background(), entries); err != nil {
		t.Fatal(err)
	}
	want := decodeGroups(t, `[{"name":"relay","base-url":"https://r.test","request-retry":0,"support-prompt-cache-key":true,"disabled":true,
	  "models":[{"name":"m","alias":"a","input-modalities":["text","image"]}],"keys":[{"api-key":"o1"}]}]`)
	if !reflect.DeepEqual(gateway.written, want) {
		t.Fatalf("groups = %#v\nwant %#v", gateway.written, want)
	}
}

func TestOAuthModelAliasesReadAsCPAAppliesThem(t *testing.T) {
	gateway := &configGateway{answer: func(method, path string) (int, string) {
		if method == http.MethodGet && path == "/v8/management/config/oauth/model-alias" {
			return http.StatusOK, `{"Codex":[{"name":" gpt-5 ","alias":"fast"},{"name":"gpt-5.1","alias":"FAST"},{"name":"same","alias":"same"}],"empty":[]}`
		}
		return 0, ""
	}}
	aliases, err := newConfigClient(t, gateway).OAuthModelAliases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]OAuthModelAlias{"codex": {{Name: "gpt-5", Alias: "fast"}}}
	if !reflect.DeepEqual(aliases, want) {
		t.Fatalf("aliases = %#v, want %#v", aliases, want)
	}
}

func TestPatchOAuthModelAliasesReplacesEverySpellingOfTheProvider(t *testing.T) {
	gateway := &configGateway{stored: "config-version: 8\n", answer: func(method, path string) (int, string) {
		if method == http.MethodGet && path == "/v8/management/config/oauth/model-alias" {
			return http.StatusOK, `{"Codex":[{"name":"a","alias":"b"}],"claude":[{"name":"c","alias":"d"}]}`
		}
		return 0, ""
	}}
	client := newConfigClient(t, gateway)
	if err := client.PatchOAuthModelAliases(context.Background(), "codex", []OAuthModelAlias{{Name: "gpt-5", Alias: "fast"}}); err != nil {
		t.Fatal(err)
	}
	sent := strings.Join(gateway.sent(), "\n")
	if !strings.Contains(sent, "PATCH /v8/management/config") || !strings.Contains(sent, "DELETE /v8/management/config/oauth/model-alias/Codex") {
		t.Fatalf("requests = %s", sent)
	}
	if strings.Contains(sent, "model-alias/claude") {
		t.Fatalf("another provider was touched: %s", sent)
	}
}

func TestPluginConfigTellsAnUnconfiguredPluginFromAnUnknownOne(t *testing.T) {
	gateway := &configGateway{answer: func(method, path string) (int, string) {
		switch {
		case strings.HasPrefix(path, "/v8/management/config/plugins/configs/"):
			return http.StatusNotFound, `{"error":"not_found"}`
		case path == "/v8/management/plugins":
			return http.StatusOK, `{"plugins":[{"id":"installed","enabled":false}]}`
		}
		return 0, ""
	}}
	client := newConfigClient(t, gateway)
	config, err := client.PluginConfig(context.Background(), "installed")
	if err != nil || len(config) != 0 {
		t.Fatalf("installed plugin config = %#v, %v; want an empty object", config, err)
	}
	var httpErr *HTTPError
	if _, err := client.PluginConfig(context.Background(), "ghost"); err == nil || !errors.As(err, &httpErr) || !strings.Contains(httpErr.Body, "plugin_not_found") {
		t.Fatalf("unknown plugin err = %v, want plugin_not_found", err)
	}
}

func TestUpdateConfigAPIKeysKeepsAnImplicitDefaultBaseURLImplicit(t *testing.T) {
	// The file states no endpoint; the runtime reports the family default, and
	// the edit form sends back what it showed.
	gateway := &groupsGateway{
		family:  "claude",
		stored:  `[{"name":"team","priority":3,"keys":[{"api-key":"k1"},{"api-key":"k2"}]}]`,
		runtime: `{"claude-api-key":[{"api-key":"k1","base-url":"https://api.default.test","priority":3,"auth-index":"i1"},{"api-key":"k2","base-url":"https://api.default.test","priority":3,"auth-index":"i2"}]}`,
	}
	client := newGroupsClient(t, gateway)
	entries, err := client.EditableConfigAPIKeys(context.Background(), ConfigFamilyClaude)
	if err != nil {
		t.Fatal(err)
	}
	weight := 5
	entries[1].BaseURL = entries[1].SubmittedBaseURL("https://api.default.test")
	entries[1].Weight = &weight
	if err := client.UpdateConfigAPIKeys(context.Background(), ConfigFamilyClaude, entries); err != nil {
		t.Fatal(err)
	}
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	if got := groupNames(gateway.written); !reflect.DeepEqual(got, []string{"team"}) {
		t.Fatalf("groups = %v, want the key to stay in its group", got)
	}
	if _, has := gateway.written[0]["base-url"]; has {
		t.Fatalf("group = %#v, want the default endpoint left implicit", gateway.written[0])
	}
	if keys := groupKeys(gateway.written[0]); keys[1]["weight"] != float64(5) {
		t.Fatalf("keys = %#v, want the edited weight", keys)
	}
	// A different endpoint is still the operator's edit.
	if got := entries[1].SubmittedBaseURL("https://other.test"); got != "https://other.test" {
		t.Fatalf("SubmittedBaseURL = %q", got)
	}
}

func TestUpdateConfigAPIKeysKeepsAnUnmodelledGroupFieldOnTheGroup(t *testing.T) {
	gateway := &groupsGateway{
		family:  "codex",
		stored:  `[{"name":"team","base-url":"https://a.test","websockets":true,"keys":[{"api-key":"k1"},{"api-key":"k2"}]}]`,
		runtime: `{"codex-api-key":[{"api-key":"k1","base-url":"https://a.test","websockets":true,"auth-index":"i1"},{"api-key":"k2","base-url":"https://a.test","websockets":true,"auth-index":"i2"}]}`,
	}
	client := newGroupsClient(t, gateway)
	entries, err := client.EditableConfigAPIKeys(context.Background(), ConfigFamilyCodex)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.UpdateConfigAPIKeys(context.Background(), ConfigFamilyCodex, entries); err != nil {
		t.Fatal(err)
	}
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	want := decodeGroups(t, gateway.stored)
	if !reflect.DeepEqual(gateway.written, want) {
		t.Fatalf("groups = %#v\nwant %#v", gateway.written, want)
	}
}

func TestApplyConfigChangesScrubsSecretsFromARefusal(t *testing.T) {
	server := newV8Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v0/management/config.yaml":
			_, _ = writer.Write([]byte("config-version: 8\napi-keys:\n  gemini:\n    - name: g\n      keys:\n        - api-key: stored-gemini-secret\n"))
		case request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config":
			writer.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = writer.Write([]byte(`{"error":"invalid_config","message":"key new-claude-secret conflicts with stored-gemini-secret"}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	groups := []map[string]any{{"name": "c", "keys": []any{map[string]any{"api-key": "new-claude-secret"}}}}
	err = client.ApplyConfigChanges(context.Background(), []ConfigChange{{Path: ConfigFamilyClaude.GroupsPath(), Value: groups}})
	reason, rejected := IsConfigRejected(err)
	if !rejected {
		t.Fatalf("err = %v, want the refusal kept", err)
	}
	for _, secret := range []string{"new-claude-secret", "stored-gemini-secret"} {
		if strings.Contains(reason, secret) || strings.Contains(err.Error(), secret) {
			t.Fatalf("refusal %q (%v) quotes %s", reason, err, secret)
		}
	}
}
