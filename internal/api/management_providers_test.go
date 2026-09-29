package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type providerFakeServerState struct {
	mu              sync.Mutex
	clientKeys      []string
	oaiProviders    []map[string]any
	codexProviders  []map[string]any
	claudeProviders []map[string]any
	geminiProviders []map[string]any
	metaProviders   []map[string]any
	// familyLists serves the config API-key families that need no per-family
	// instrumentation (xai, vertex, interactions), keyed by family.
	familyLists map[string]*[]map[string]any
	// putCount counts the provider writes CPA actually received, so a test can
	// assert that a refused write never reached the gateway.
	putCount int
	// hooksMu guards the hooks below, which a test installs before issuing any
	// request and the serving goroutines read per request.
	hooksMu sync.Mutex
	// beforeCodexRead runs on the serving goroutine before the codex list is
	// read, which lets a test slow a read down so a second toggle really races it.
	beforeCodexRead func()
	// openCodexSections counts how many codex read-modify-write windows are open
	// at once, and peakCodexSections is the high-water mark. One flight at a time
	// is the property that stops a whole-list write from discarding another; a
	// value above 1 means two toggles read the same baseline.
	openCodexSections int
	peakCodexSections int
}

// providerList is the fixture's list for one family, as serveProviderGroups
// reads and writes it; the caller holds the state lock.
func (s *providerFakeServerState) providerList(family string) *[]map[string]any {
	switch family {
	case "openai-compatibility":
		return &s.oaiProviders
	case "codex":
		return &s.codexProviders
	case "claude":
		return &s.claudeProviders
	case "gemini":
		return &s.geminiProviders
	case "meta":
		return &s.metaProviders
	}
	return s.familyLists[family]
}

func (s *providerFakeServerState) setBeforeCodexRead(hook func()) {
	s.hooksMu.Lock()
	defer s.hooksMu.Unlock()
	s.beforeCodexRead = hook
}

func (s *providerFakeServerState) runBeforeCodexRead() {
	s.hooksMu.Lock()
	hook := s.beforeCodexRead
	s.hooksMu.Unlock()
	if hook != nil {
		hook()
	}
}

// beginCodexSection and endCodexSection bracket one whole-list read-modify-write
// as CPA observes it. They take the state lock themselves, so a test can call
// them around a deliberately slow read without holding the fixture's mutex.
func (s *providerFakeServerState) beginCodexSection() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.openCodexSections++
	if s.openCodexSections > s.peakCodexSections {
		s.peakCodexSections = s.openCodexSections
	}
}

func (s *providerFakeServerState) endCodexSection() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.openCodexSections > 0 {
		s.openCodexSections--
	}
}

func (s *providerFakeServerState) codexSectionPeak() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peakCodexSections
}

// providerTestFixture is the assembled console plus the fake CPA it talks to.
// Tests that need the Handler itself read the gate; the common case uses
// startProviderTestServer, which exposes only the client and the fixture state.
type providerTestFixture struct {
	client  *http.Client
	baseURL string
	state   *providerFakeServerState
	handler *Handler
}

func startProviderTestServer(t *testing.T) (*http.Client, string, *providerFakeServerState) {
	t.Helper()
	fixture := newProviderTestFixture(t)
	return fixture.client, fixture.baseURL, fixture.state
}

func newProviderTestFixture(t *testing.T) providerTestFixture {
	t.Helper()
	state := &providerFakeServerState{
		clientKeys: []string{"sk-original-key-1", "sk-original-key-2"},
		oaiProviders: []map[string]any{
			{
				"name":     "relay-station",
				"base-url": "https://user:pass@relay.example.test/v1?token=secret",
				"disabled": false,
				"api-keys": []string{"sk-provider-secret-key-1234"},
				"models":   []map[string]string{{"name": "gpt-4o"}},
			},
		},
		codexProviders: []map[string]any{
			{
				"prefix":     "codex-line",
				"auth-index": "c-1",
				"base-url":   "https://api.openai.com",
				"api-key":    "sk-codex-secret-key-9999",
			},
		},
		claudeProviders: []map[string]any{
			{
				"api-key":    "sk-ant-secret-1234",
				"auth-index": "ant-1",
				"base-url":   "https://api.anthropic.com",
			},
		},
		geminiProviders: []map[string]any{
			{
				"api-key":    "gemini-test-token-1234",
				"auth-index": "gem-1",
			},
		},
		metaProviders: []map[string]any{
			{
				"api-key":    "meta-test-token-1234",
				"auth-index": "meta-1",
				"base-url":   "https://api.meta.ai/v1",
			},
		},
		familyLists: map[string]*[]map[string]any{
			// The fields the console does not model are CPA settings an operator
			// wrote in config.yaml; they are here so a round trip can prove they
			// survive an edit.
			"xai": &[]map[string]any{{
				"api-key":       "xai-test-token-1234",
				"auth-index":    "xai-1",
				"base-url":      "https://api.x.ai/v1",
				"websockets":    true,
				"request-retry": 2,
			}},
			"vertex":       &[]map[string]any{},
			"interactions": &[]map[string]any{},
		},
	}

	cpaServer := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		// A codex read followed later by a provider write is one read-modify-write
		// window. Bracketing both here is what lets a test assert that two windows
		// never overlap, which is the invariant that prevents a lost update.
		isCodexRead := request.Method == http.MethodGet && (request.URL.Path == "/v0/management/codex-api-key" || request.URL.Path == "/v8/management/config/api-keys/codex")
		if isCodexRead || (request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config") {
			state.beginCodexSection()
			defer state.endCodexSection()
		}
		// The read hook runs before the state lock is taken, so a test can slow a
		// read without also blocking the write it is meant to race.
		if request.Method == http.MethodGet && request.URL.Path == "/v0/management/codex-api-key" {
			state.runBeforeCodexRead()
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		if serveProviderGroups(writer, request, state.providerList, func(string) { state.putCount++ }) {
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		path := request.URL.Path

		switch {
		case path == "/v8/management/config" && request.Method == http.MethodGet:
			_ = json.NewEncoder(writer).Encode(map[string]any{"access": map[string]any{"api-keys": state.clientKeys}})
		case path == "/v8/management/config" && request.Method == http.MethodPatch:
			var merge struct {
				Access struct {
					APIKeys []string `json:"api-keys"`
				} `json:"access"`
			}
			_ = json.NewDecoder(request.Body).Decode(&merge)
			state.clientKeys = merge.Access.APIKeys
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case path == "/v0/management/openai-compatibility" && request.Method == http.MethodGet:
			_ = json.NewEncoder(writer).Encode(map[string]any{"openai-compatibility": state.oaiProviders})
		case strings.HasSuffix(path, "-api-key") && request.Method == http.MethodGet && state.providerList(strings.TrimSuffix(strings.TrimPrefix(path, "/v0/management/"), "-api-key")) != nil:
			family := strings.TrimSuffix(strings.TrimPrefix(path, "/v0/management/"), "-api-key")
			_ = json.NewEncoder(writer).Encode(map[string]any{family + "-api-key": *state.providerList(family)})
		default:
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(cpaServer.Close)

	// The cipher is created first so the repository can be opened with it. Caller
	// key identity is a keyed fingerprint, so a repository without the cipher
	// degrades every identity to the shared redaction marker and key aliases
	// cannot be exercised at all.
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	db, err := repository.Open(context.Background(),
		fmt.Sprintf("file:mem_providers_%d?mode=memory&cache=shared", time.Now().UnixNano()),
		repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)

	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-management-key"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 cpaServer.URL,
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}

	authManager, err := auth.New("management-secret-value", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{BasePath: "/omc", Version: "test"}, repo, cipher, nil, authManager)
	appServer := httptest.NewServer(handler.Router())
	t.Cleanup(appServer.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	loginResp, err := client.Post(appServer.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret-value"}`))
	if err != nil || loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login failed: %v", err)
	}

	return providerTestFixture{client: client, baseURL: appServer.URL, state: state, handler: handler}
}

func TestManagementProvidersEndpoints(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	// 1. GET providers: assert plaintext keys and raw URLs are returned unmasked
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/providers?include_keys=true")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get providers status = %d body %s", resp.StatusCode, payload)
	}
	payloadStr := string(payload)
	for _, secret := range []string{"sk-provider-secret-key-1234", "sk-codex-secret-key-9999", "sk-ant-secret-1234", "user:pass@", "?token=secret"} {
		if !strings.Contains(payloadStr, secret) {
			t.Fatalf("providers list must return %q in plaintext, got: %s", secret, payloadStr)
		}
	}

	var res struct {
		Providers []ProviderItemDTO `json:"providers"`
	}
	if err := json.Unmarshal(payload, &res); err != nil || len(res.Providers) < 4 {
		t.Fatalf("unexpected providers count: %s", payload)
	}

	// The default projection is sanitized: key_configured stays, plaintext
	// key material never reaches pages whose contract excludes it.
	_, sanitized := getJSON(t, client, baseURL+"/omc/api/v1/management/providers")
	sanitizedStr := string(sanitized)
	for _, secret := range []string{"sk-provider-secret-key-1234", "sk-codex-secret-key-9999", "sk-ant-secret-1234"} {
		if strings.Contains(sanitizedStr, secret) {
			t.Fatalf("sanitized providers list must not contain %q: %s", secret, sanitizedStr)
		}
	}
	if !strings.Contains(sanitizedStr, `"key_configured":true`) {
		t.Fatalf("sanitized list must keep the configured signal: %s", sanitizedStr)
	}

	// 2. PATCH provider status
	patchBody := `{"family":"openai-compatibility","index":0,"disabled":true}`
	resp, payload = doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/providers/status", patchBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("patch provider status = %d body %s", resp.StatusCode, payload)
	}

	state.mu.Lock()
	disabledVal := state.oaiProviders[0]["disabled"]
	state.mu.Unlock()
	if disabledVal != true {
		t.Fatalf("expected provider disabled true on CPA, got %v", disabledVal)
	}
}

func TestUnifiedProviderArchitectureClaudeCodexGemini(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)

	// 1. Verify Claude provider displays key entries and can be updated with custom name & new key
	updateClaude := `{"family":"claude","name":"Claude 3.5 专线","base_url":"https://api.anthropic.com","keys":[{"api_key":"sk-ant-new-secret-5678","proxy_url":"http://127.0.0.1:7890","weight":3}],"prefix":"fast"}`
	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/claude-0", updateClaude)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update claude provider status = %d body %s", resp.StatusCode, payload)
	}

	// Read providers list and verify custom name and plaintext key in list
	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers?include_keys=true")
	var providersResp struct {
		Providers []ProviderItemDTO `json:"providers"`
	}
	if err := json.Unmarshal(payload, &providersResp); err != nil {
		t.Fatal(err)
	}

	var foundClaude *ProviderItemDTO
	for i := range providersResp.Providers {
		p := &providersResp.Providers[i]
		if p.ID == "claude-0" {
			foundClaude = p
			break
		}
	}
	if foundClaude == nil {
		t.Fatalf("claude-0 provider not found in list")
	}
	if foundClaude.Name != "Claude 3.5 专线" {
		t.Fatalf("expected custom name Claude 3.5 专线, got %q", foundClaude.Name)
	}
	if len(foundClaude.KeyEntries) != 1 {
		t.Fatalf("expected 1 key entry for claude, got %d", len(foundClaude.KeyEntries))
	}
	if foundClaude.KeyEntries[0].ProxyURL != "http://127.0.0.1:7890" {
		t.Fatalf("expected proxy url on claude key entry, got %q", foundClaude.KeyEntries[0].ProxyURL)
	}

	// 2. Toggle status on Claude provider and verify it reflects in list
	patchClaude := `{"family":"claude","index":0,"disabled":true}`
	resp, payload = doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/providers/status", patchClaude)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("patch claude status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers?include_keys=true")
	_ = json.Unmarshal(payload, &providersResp)
	for i := range providersResp.Providers {
		if providersResp.Providers[i].ID == "claude-0" {
			if !providersResp.Providers[i].Disabled {
				t.Fatalf("expected claude-0 to be disabled after toggle")
			}
		}
	}

	// 3. Create Gemini provider with custom name and verify it persists
	createGemini := `{"family":"gemini","name":"Gemini Pro Line","base_url":"https://generativelanguage.googleapis.com","keys":[{"api_key":"gemini-secret-9999"}],"prefix":"gem-pro"}`
	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", createGemini)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create gemini provider status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers?include_keys=true")
	_ = json.Unmarshal(payload, &providersResp)
	foundGemini := false
	for _, p := range providersResp.Providers {
		if p.Name == "Gemini Pro Line" {
			foundGemini = true
			if len(p.KeyEntries) != 1 {
				t.Fatalf("expected 1 key entry on gemini, got %d", len(p.KeyEntries))
			}
		}
	}
	if !foundGemini {
		t.Fatalf("newly created Gemini Pro Line not found in providers list")
	}
}

func TestProviderFamiliesXAIVertexInteractions(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	listProviders := func() map[string]ProviderItemDTO {
		t.Helper()
		resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/providers?include_keys=true")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("list providers status = %d body %s", resp.StatusCode, payload)
		}
		var decoded struct {
			Providers []ProviderItemDTO `json:"providers"`
		}
		if err := json.Unmarshal(payload, &decoded); err != nil {
			t.Fatal(err)
		}
		byID := map[string]ProviderItemDTO{}
		for _, provider := range decoded.Providers {
			byID[provider.ID] = provider
		}
		return byID
	}

	xaiRow, ok := listProviders()["xai-0"]
	if !ok || xaiRow.Family != "xai" || xaiRow.Protocol != "xAI Grok" || xaiRow.AuthIndex != "xai-1" {
		t.Fatalf("xai-0 row = %#v (found %v)", xaiRow, ok)
	}

	// An edit through the console rewrites the whole list; the settings it does
	// not model must reach CPA unchanged.
	updateXAI := `{"family":"xai","name":"Grok Line","base_url":"https://api.x.ai/v1","keys":[{"api_key":"xai-new-secret-5678"}]}`
	if resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/xai-0", updateXAI); resp.StatusCode != http.StatusOK {
		t.Fatalf("update xai status = %d body %s", resp.StatusCode, payload)
	}
	state.mu.Lock()
	stored := (*state.familyLists["xai"])[0]
	state.mu.Unlock()
	if stored["api-key"] != "xai-new-secret-5678" || stored["websockets"] != true || stored["request-retry"] != float64(2) {
		t.Fatalf("xai entry after update = %#v, want the new key with websockets and request-retry kept", stored)
	}

	// CPA silently drops an xAI entry without a base URL while answering 200, so
	// the console refuses it before any write reaches the gateway.
	state.mu.Lock()
	putsBefore := state.putCount
	state.mu.Unlock()
	resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", `{"family":"xai","name":"No URL","keys":[{"api_key":"xai-other"}]}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("create xai without base URL status = %d body %s", resp.StatusCode, payload)
	}
	state.mu.Lock()
	putsAfter := state.putCount
	state.mu.Unlock()
	if putsAfter != putsBefore {
		t.Fatalf("a refused xai create reached CPA: %d writes, want %d", putsAfter, putsBefore)
	}

	// Vertex and Interactions take an optional base URL.
	for _, create := range []string{
		`{"family":"vertex","name":"Vertex Line","keys":[{"api_key":"vertex-secret"}],"model_entries":[{"name":"gemini-2.5-pro","alias":"vertex-pro"}]}`,
		`{"family":"interactions","name":"Interactions Line","base_url":"https://generativelanguage.googleapis.com","keys":[{"api_key":"interactions-secret"}]}`,
	} {
		if resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", create); resp.StatusCode != http.StatusOK {
			t.Fatalf("create %s status = %d body %s", create, resp.StatusCode, payload)
		}
	}
	rows := listProviders()
	if row := rows["vertex-0"]; row.Name != "Vertex Line" || row.Family != "vertex" || len(row.Models) != 1 {
		t.Fatalf("vertex-0 row = %#v", row)
	}
	if row := rows["interactions-0"]; row.Name != "Interactions Line" || row.Family != "interactions" {
		t.Fatalf("interactions-0 row = %#v", row)
	}

	// The toggle uses CPA's excluded-all marker, as for every config family.
	if resp, payload := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/providers/status", `{"family":"interactions","index":0,"disabled":true}`); resp.StatusCode != http.StatusOK {
		t.Fatalf("patch interactions status = %d body %s", resp.StatusCode, payload)
	}
	if row := listProviders()["interactions-0"]; !row.Disabled {
		t.Fatalf("interactions-0 should be disabled after the toggle: %#v", row)
	}

	resp, payload = doJSON(t, client, http.MethodDelete, baseURL+"/omc/api/v1/management/providers/vertex-0", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete vertex status = %d body %s", resp.StatusCode, payload)
	}
	if _, isListed := listProviders()["vertex-0"]; isListed {
		t.Fatal("vertex-0 is still listed after its delete")
	}
}

func TestProviderEditKeepsTheSettingsTheFormDoesNotShow(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	fixture.state.oaiProviders = []map[string]any{{
		"name":            "relay",
		"base-url":        "https://relay.test/v1",
		"disable-cooling": false,
		"api-key-entries": []any{map[string]any{"api-key": "sk-relay-1", "headers": map[string]any{"X-Team": "a"}, "auth-index": "r-1"}},
		"models":          []any{map[string]any{"name": "gpt-4o", "alias": "g4", "force-mapping": true, "input-modalities": []any{"text", "image"}}},
	}}
	fixture.state.claudeProviders = []map[string]any{{
		"api-key": "sk-ant-1", "auth-index": "ant-1", "base-url": "https://api.anthropic.com",
		"models": []any{map[string]any{"name": "claude-x", "alias": "cx", "display-name": "Claude X", "input-modalities": []any{"text"}}},
	}}
	fixture.state.mu.Unlock()

	// The shape the edit form sends: the fields it shows, keys left blank to keep.
	updates := map[string]string{
		"openai-compat-0": `{"family":"openai-compatibility","name":"relay","base_url":"https://relay.test/v1","keys":[{"api_key":"","proxy_url":"","weight":2}],"model_entries":[{"name":"gpt-4o","alias":"g4o"}]}`,
		"claude-0":        `{"family":"claude","name":"Claude","base_url":"https://api.anthropic.com","keys":[{"api_key":""}],"model_entries":[{"name":"claude-x","alias":"cx2"}]}`,
	}
	for id, body := range updates {
		if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+"/omc/api/v1/management/providers/"+id, body); resp.StatusCode != http.StatusOK {
			t.Fatalf("update %s = %d %s", id, resp.StatusCode, payload)
		}
	}

	fixture.state.mu.Lock()
	defer fixture.state.mu.Unlock()
	relay := fixture.state.oaiProviders[0]
	key := anyList(relay["api-key-entries"])[0].(map[string]any)
	if key["api-key"] != "sk-relay-1" || key["weight"] != float64(2) || fmt.Sprint(key["headers"]) != "map[X-Team:a]" {
		t.Fatalf("relay key = %#v, want its headers kept beside the edit", key)
	}
	model := anyList(relay["models"])[0].(map[string]any)
	if model["alias"] != "g4o" || model["force-mapping"] != true || fmt.Sprint(model["input-modalities"]) != "[text image]" {
		t.Fatalf("relay model = %#v, want its other settings kept", model)
	}
	if relay["disable-cooling"] != false {
		t.Fatalf("relay disable-cooling = %#v, want the stored false kept", relay["disable-cooling"])
	}
	claudeModel := anyList(fixture.state.claudeProviders[0]["models"])[0].(map[string]any)
	if claudeModel["alias"] != "cx2" || claudeModel["display-name"] != "Claude X" || fmt.Sprint(claudeModel["input-modalities"]) != "[text]" {
		t.Fatalf("claude model = %#v, want its other settings kept", claudeModel)
	}
}
