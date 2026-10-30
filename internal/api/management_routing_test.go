package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// routingFixtureCPA is a stand-in gateway holding one Claude key group, two OAuth
// credentials and the routing settings, and applying the writes the board makes
// so the read back after a plan reflects them.
type routingFixtureCPA struct {
	mu       sync.Mutex
	strategy string
	groups   []map[string]any
	files    []map[string]any
	// isDroppingFields makes the gateway accept a credential patch without
	// persisting it, the way an older CPA drops a field it does not know.
	isDroppingFields bool
	configWrites     []map[string]any
	fieldWrites      []map[string]any
}

func newRoutingFixtureCPA() *routingFixtureCPA {
	return &routingFixtureCPA{
		strategy: "round-robin",
		groups: []map[string]any{{
			"name":            "team",
			"x-operator-note": "keep me",
			"keys": []any{
				map[string]any{"api-key": "sk-a", "prefix": "team", "excluded-models": []any{"*-b"}},
				map[string]any{"api-key": "sk-b", "weight": float64(2), "models": []any{map[string]any{"name": "claude-up", "alias": "claude-pin"}}},
			},
		}},
		files: []map[string]any{
			{"name": "codex-a.json", "auth_index": "auth-a", "provider": "codex", "priority": float64(5), "weight": float64(3)},
			{"name": "codex-b.json", "auth_index": "auth-b", "provider": "codex"},
		},
	}
}

// runtimeKeys flattens the stored groups the way CPA's v0 list does.
func (f *routingFixtureCPA) runtimeKeys() []map[string]any {
	entries := []map[string]any{}
	for _, group := range f.groups {
		keys, _ := group["keys"].([]any)
		for _, raw := range keys {
			key := raw.(map[string]any)
			entry := map[string]any{}
			for field, value := range group {
				if field != "keys" && field != "name" {
					entry[field] = value
				}
			}
			for field, value := range key {
				entry[field] = value
			}
			entry["auth-index"] = "key-" + key["api-key"].(string)
			entries = append(entries, entry)
		}
	}
	return entries
}

func (f *routingFixtureCPA) serve(writer http.ResponseWriter, request *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := request.URL.Path
	switch {
	case request.Method == http.MethodGet && path == "/v8/management/config":
		_ = json.NewEncoder(writer).Encode(map[string]any{"routing": map[string]any{"strategy": f.strategy}})
	case request.Method == http.MethodGet && path == "/v8/management/config/api-keys/claude":
		_ = json.NewEncoder(writer).Encode(f.groups)
	case request.Method == http.MethodPatch && path == "/v8/management/config":
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		f.configWrites = append(f.configWrites, body)
		if routing, ok := body["routing"].(map[string]any); ok {
			if strategy, ok := routing["strategy"].(string); ok {
				f.strategy = strategy
			}
		}
		if apiKeys, ok := body["api-keys"].(map[string]any); ok {
			if raw, ok := apiKeys["claude"].([]any); ok {
				f.groups = nil
				for _, group := range raw {
					f.groups = append(f.groups, group.(map[string]any))
				}
			}
		}
		writer.WriteHeader(http.StatusOK)
	case request.Method == http.MethodGet && path == "/v0/management/claude-api-key":
		_ = json.NewEncoder(writer).Encode(map[string]any{"claude-api-key": f.runtimeKeys()})
	case request.Method == http.MethodGet && strings.HasPrefix(path, "/v0/management/") && (strings.HasSuffix(path, "-api-key") || strings.HasSuffix(path, "/openai-compatibility")):
		_, _ = writer.Write([]byte(`{}`))
	case request.Method == http.MethodGet && path == "/v8/management/routing/model-definitions/claude":
		_, _ = writer.Write([]byte(`{"models":[{"id":"claude-a"},{"id":"claude-b"}]}`))
	case request.Method == http.MethodGet && path == "/v8/management/credentials/models":
		if request.URL.Query().Get("name") != "codex-a.json" {
			writer.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = writer.Write([]byte(`{"models":[{"id":"gpt-x"},{"id":"gpt-x"}]}`))
	case request.Method == http.MethodGet && path == "/v8/management/credentials":
		_ = json.NewEncoder(writer).Encode(map[string]any{"files": f.files})
	case request.Method == http.MethodPatch && path == "/v8/management/credentials/fields":
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		f.fieldWrites = append(f.fieldWrites, body)
		if !f.isDroppingFields {
			for _, file := range f.files {
				if file["name"] != body["name"] {
					continue
				}
				for _, field := range []string{"priority", "weight"} {
					if value, ok := body[field]; ok {
						if value == nil {
							delete(file, field)
						} else {
							file[field] = value
						}
					}
				}
			}
		}
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	default:
		writer.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(writer, `{"error":"not_found"}`)
	}
}

type routingBoardReply struct {
	Revision string `json:"revision"`
	Settings struct {
		Strategy string `json:"strategy"`
	} `json:"settings"`
	Members []struct {
		Key      string `json:"key"`
		Priority int    `json:"priority"`
		Weights  []struct {
			Weight *int64 `json:"weight"`
		} `json:"weights"`
	} `json:"members"`
}

type routingOutcomeReply struct {
	IsComplete bool `json:"is_complete"`
	Results    []struct {
		Key    string `json:"key"`
		Status string `json:"status"`
		Code   string `json:"code"`
	} `json:"results"`
	Board *routingBoardReply `json:"board"`
}

func readRoutingBoardReply(t *testing.T, client *http.Client, baseURL string) routingBoardReply {
	t.Helper()
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/routing")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("board status = %d body %s", response.StatusCode, payload)
	}
	var board routingBoardReply
	if err := json.Unmarshal(payload, &board); err != nil {
		t.Fatal(err)
	}
	return board
}

func patchRoutingPlan(t *testing.T, client *http.Client, baseURL string, plan map[string]any) (*http.Response, []byte) {
	t.Helper()
	body, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	return doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/routing", string(body))
}

func effectiveKeyPriority(group, key map[string]any) float64 {
	if value, ok := key["priority"].(float64); ok {
		return value
	}
	value, _ := group["priority"].(float64)
	return value
}

// A plan moves provider keys and changes settings in one backed-up config write
// that keeps every field it did not name, then patches each credential in turn.
func TestRoutingPlanAppliesAsOneConfigWriteAndVerifiedCredentialPatches(t *testing.T) {
	fixture := newRoutingFixtureCPA()
	client, baseURL, repo := startDashboardTestServer(t, fixture.serve)

	board := readRoutingBoardReply(t, client, baseURL)
	if len(board.Members) != 4 || board.Settings.Strategy != "round-robin" {
		t.Fatalf("board = %+v", board)
	}
	response, payload := patchRoutingPlan(t, client, baseURL, map[string]any{
		"revision": board.Revision,
		"settings": map[string]any{"strategy": "ff"},
		"members": []any{
			map[string]any{"key": "provider:claude-0", "priority": 10},
			// Unchanged values write nothing for this member.
			map[string]any{"key": "provider:claude-1", "priority": 0, "weights": []any{map[string]any{"index": 0, "weight": 2}}},
			map[string]any{"key": "credential:codex-a.json", "weights": []any{map[string]any{"index": 0, "weight": nil}}},
			map[string]any{"key": "credential:codex-b.json", "priority": 7},
		},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("plan status = %d body %s", response.StatusCode, payload)
	}
	var outcome routingOutcomeReply
	if err := json.Unmarshal(payload, &outcome); err != nil {
		t.Fatal(err)
	}
	if !outcome.IsComplete || len(outcome.Results) != 4 || outcome.Board == nil || outcome.Board.Settings.Strategy != "fill-first" {
		t.Fatalf("outcome = %s", payload)
	}
	for _, result := range outcome.Results {
		if result.Status != "applied" {
			t.Fatalf("result %+v in %s", result, payload)
		}
	}

	if len(fixture.configWrites) != 1 {
		t.Fatalf("config writes = %d, want one change set", len(fixture.configWrites))
	}
	groups := fixture.groups
	if len(groups) == 0 || groups[0]["x-operator-note"] != "keep me" {
		t.Fatalf("written groups lost an unnamed field: %+v", groups)
	}
	priorities := map[string]float64{}
	weights := map[string]any{}
	for _, group := range groups {
		for _, raw := range group["keys"].([]any) {
			key := raw.(map[string]any)
			priorities[key["api-key"].(string)] = effectiveKeyPriority(group, key)
			weights[key["api-key"].(string)] = key["weight"]
		}
	}
	if priorities["sk-a"] != 10 || priorities["sk-b"] != 0 || weights["sk-b"] != float64(2) {
		t.Fatalf("written keys: priorities %v weights %v", priorities, weights)
	}

	if len(fixture.fieldWrites) != 2 {
		t.Fatalf("credential writes = %+v", fixture.fieldWrites)
	}
	if first := fixture.fieldWrites[0]; first["name"] != "codex-a.json" || first["weight"] != nil || len(first) != 2 {
		t.Fatalf("first credential write = %+v", first)
	}
	if second := fixture.fieldWrites[1]; second["name"] != "codex-b.json" || second["priority"] != float64(7) {
		t.Fatalf("second credential write = %+v", second)
	}

	_, backups := getJSON(t, client, baseURL+"/omc/api/v1/management/config/backups")
	if !strings.Contains(string(backups), `"reason":"routing_plan"`) {
		t.Fatalf("backups = %s", backups)
	}
	events, err := repo.ListAuditEvents(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	results := []string{}
	for _, event := range events {
		if event.Action == "routing.apply" {
			results = append(results, event.Result)
		}
	}
	if strings.Join(results, ",") != "success,attempt" && strings.Join(results, ",") != "attempt,success" {
		t.Fatalf("routing audit = %v", results)
	}
}

// A plan quoting a board that has since changed, or one whose audit cannot be
// recorded, writes nothing at all.
func TestRoutingPlanRefusesStaleRevisionAndUnauditedWrite(t *testing.T) {
	fixture := newRoutingFixtureCPA()
	client, baseURL, repo := startDashboardTestServer(t, fixture.serve)
	board := readRoutingBoardReply(t, client, baseURL)

	response, payload := patchRoutingPlan(t, client, baseURL, map[string]any{
		"revision": strings.Repeat("0", 64),
		"members":  []any{map[string]any{"key": "provider:claude-0", "priority": 10}},
	})
	if response.StatusCode != http.StatusConflict || !strings.Contains(string(payload), `"routing_conflict"`) {
		t.Fatalf("stale plan = %d body %s", response.StatusCode, payload)
	}

	response, payload = patchRoutingPlan(t, client, baseURL, map[string]any{
		"revision": board.Revision,
		"members":  []any{map[string]any{"key": "provider:claude-0", "priority": 0}},
	})
	if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), `"routing_no_changes"`) {
		t.Fatalf("no-op plan = %d body %s", response.StatusCode, payload)
	}

	if _, err := repo.SQL().Exec("DROP TABLE audit_events"); err != nil {
		t.Fatal(err)
	}
	response, payload = patchRoutingPlan(t, client, baseURL, map[string]any{
		"revision": board.Revision,
		"members":  []any{map[string]any{"key": "credential:codex-b.json", "priority": 4}},
	})
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("unaudited plan = %d body %s", response.StatusCode, payload)
	}
	if len(fixture.configWrites) != 0 || len(fixture.fieldWrites) != 0 {
		t.Fatalf("refused plans wrote: config %d credentials %d", len(fixture.configWrites), len(fixture.fieldWrites))
	}
}

// A credential write the gateway accepts but does not persist is reported as
// uncertain, and the credentials after it are not attempted.
func TestRoutingPlanReportsUnverifiedCredentialAndStops(t *testing.T) {
	fixture := newRoutingFixtureCPA()
	fixture.isDroppingFields = true
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)
	board := readRoutingBoardReply(t, client, baseURL)

	response, payload := patchRoutingPlan(t, client, baseURL, map[string]any{
		"revision": board.Revision,
		"members": []any{
			map[string]any{"key": "credential:codex-a.json", "priority": 9},
			map[string]any{"key": "credential:codex-b.json", "priority": 8},
		},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("plan status = %d body %s", response.StatusCode, payload)
	}
	var outcome routingOutcomeReply
	if err := json.Unmarshal(payload, &outcome); err != nil {
		t.Fatal(err)
	}
	if outcome.IsComplete || len(outcome.Results) != 2 ||
		outcome.Results[0].Status != "uncertain" || outcome.Results[0].Code != "not_verified" ||
		outcome.Results[1].Key != "credential:codex-b.json" || outcome.Results[1].Status != "not_attempted" {
		t.Fatalf("outcome = %s", payload)
	}
	if len(fixture.fieldWrites) != 1 || len(fixture.configWrites) != 0 {
		t.Fatalf("writes: credentials %d config %d", len(fixture.fieldWrites), len(fixture.configWrites))
	}
}

// The model lens reads what each member can be asked for: a key's own models or
// its family's built-in list, minus exclusions, under its prefix; a credential's
// registered models; and a credential that cannot be read is unknown, not empty.
func TestRoutingModelsNamesEachMembersCallableModels(t *testing.T) {
	fixture := newRoutingFixtureCPA()
	for index := 0; index < 2000; index++ {
		fixture.files = append(fixture.files, map[string]any{
			"name": fmt.Sprintf("inline-%04d.json", index), "provider": "codex",
			"models": []map[string]any{{"id": "gpt-x"}},
		})
	}
	fixture.files = append(fixture.files, map[string]any{"name": "disabled.json", "disabled": true})
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/routing/models")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("models status = %d body %s", response.StatusCode, payload)
	}
	var models struct {
		Models  map[string][]string `json:"models"`
		Unknown []string            `json:"unknown"`
	}
	if err := json.Unmarshal(payload, &models); err != nil {
		t.Fatal(err)
	}
	expected := map[string]string{
		"provider:claude-0":           "claude-a,team/claude-a",
		"provider:claude-1":           "claude-pin",
		"credential:codex-a.json":     "gpt-x",
		"credential:inline-0000.json": "gpt-x",
		"credential:inline-1999.json": "gpt-x",
		"credential:disabled.json":    "",
	}
	for key, want := range expected {
		if got := strings.Join(models.Models[key], ","); got != want {
			t.Fatalf("%s = %q, want %q (body %s)", key, got, want, payload)
		}
	}
	if len(models.Models) != 2004 {
		t.Fatalf("model entries = %d, want every known provider and credential", len(models.Models))
	}
	if strings.Join(models.Unknown, ",") != "credential:codex-b.json" {
		t.Fatalf("unknown = %v", models.Unknown)
	}
}

func TestRoutingModelsRefusesUnreadableSources(t *testing.T) {
	for _, endpoint := range []string{
		"/v0/management/claude-api-key",
		"/v0/management/openai-compatibility",
		"/v8/management/credentials",
	} {
		t.Run(endpoint, func(t *testing.T) {
			fixture := newRoutingFixtureCPA()
			client, baseURL, _ := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path == endpoint {
					writer.WriteHeader(http.StatusBadGateway)
					return
				}
				fixture.serve(writer, request)
			})
			response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/routing/models")
			if response.StatusCode != http.StatusBadGateway || !strings.Contains(string(payload), `"code":"cpa_unavailable"`) {
				t.Fatalf("unreadable source = %d %s; want an explicit source failure", response.StatusCode, payload)
			}
		})
	}
}
