package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/statecoord"
)

func TestStateCoordinatorHTTPProviderAndKeyWriteBehindCoalescing(t *testing.T) {
	fixture := newProviderTestFixture(t)
	if err := fixture.handler.EnableStateCoordinator(context.Background(), StateCoordinatorOptions{
		DebounceWindow: 40 * time.Millisecond,
		MaxBatchWait:   500 * time.Millisecond,
	}); err != nil {
		t.Fatalf("EnableStateCoordinator failed: %v", err)
	}
	t.Cleanup(func() { fixture.handler.CloseStateCoordinator(context.Background()) })

	// 1. Verify /management/state returns { version: 1, data: ... } with zero secret leakage.
	resp, rawState := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/state")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /management/state status = %d body = %s", resp.StatusCode, rawState)
	}
	if strings.Contains(string(rawState), "sk-codex-secret-key-9999") || strings.Contains(string(rawState), "sk-original-key-1") {
		t.Fatalf("GET /management/state leaked secret material: %s", rawState)
	}
	var stateEnv struct {
		Version uint64                `json:"version"`
		Data    SafeProjectedStateDTO `json:"data"`
	}
	if err := json.Unmarshal(rawState, &stateEnv); err != nil {
		t.Fatalf("decode state envelope: %v", err)
	}
	if stateEnv.Version != 1 {
		t.Fatalf("bootstrap version = %d, want 1", stateEnv.Version)
	}

	// 2. Open SSE /api/events stream and verify initial `ready` frame.
	sseCtx, cancelSSE := context.WithCancel(context.Background())
	defer cancelSSE()
	sseReq, err := http.NewRequestWithContext(sseCtx, http.MethodGet, fixture.baseURL+"/omc/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	sseResp, err := fixture.client.Do(sseReq)
	if err != nil {
		t.Fatalf("open /api/events: %v", err)
	}
	defer sseResp.Body.Close()
	if sseResp.StatusCode != http.StatusOK {
		t.Fatalf("/api/events status = %d, want 200", sseResp.StatusCode)
	}

	frames := readSSEFrames(sseResp)
	select {
	case first := <-frames:
		if first.event != "ready" {
			t.Fatalf("first SSE event = %q, want ready", first.event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for SSE ready frame")
	}

	// 3. Burst 5 rapid codex toggles inside 40ms debounce window; verify immediate HTTP 200
	// and coalescing into 1 upstream CPA write.
	fixture.state.mu.Lock()
	putsBefore := fixture.state.putCount
	fixture.state.mu.Unlock()

	for i := range 5 {
		disabled := i%2 == 0 // i=0:true, 1:false, 2:true, 3:false, 4:true
		body := fmt.Sprintf(`{"family":"codex","index":0,"disabled":%t}`, disabled)
		r, p := doJSON(t, fixture.client, http.MethodPatch, fixture.baseURL+"/omc/api/v1/management/providers/status", body)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("toggle %d status = %d body = %s", i, r.StatusCode, p)
		}
	}

	select {
	case synced := <-frames:
		if synced.event != "state_sync" {
			t.Fatalf("expected state_sync SSE frame, got %+v", synced)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for coalesced state_sync SSE frame")
	}

	fixture.state.mu.Lock()
	putsDelta := fixture.state.putCount - putsBefore
	codexExcluded := fixture.state.codexProviders[0]["excluded-models"]
	fixture.state.mu.Unlock()
	if putsDelta != 1 {
		t.Fatalf("expected 5 rapid toggles to coalesce into 1 CPA write, got %d", putsDelta)
	}
	if !strings.Contains(fmt.Sprintf("%v", codexExcluded), "*") {
		t.Fatalf("expected codex-0 excluded-models to contain *, got %#v", codexExcluded)
	}

	// 4. Verify client API key create + in-place update + delete over Write-Behind.
	rCreate, pCreate := doJSON(t, fixture.client, http.MethodPost, fixture.baseURL+"/omc/api/v1/management/api-keys", `{"key":"sk-wb-key-alpha"}`)
	if rCreate.StatusCode != http.StatusOK || strings.Contains(string(pCreate), "sk-wb-key-alpha") {
		t.Fatalf("create key failed or leaked raw key: %d %s", rCreate.StatusCode, pCreate)
	}
	rUpdate, pUpdate := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+"/omc/api/v1/management/api-keys/2", `{"key":"sk-wb-key-beta"}`)
	if rUpdate.StatusCode != http.StatusOK || strings.Contains(string(pUpdate), "sk-wb-key-beta") {
		t.Fatalf("update key failed or leaked raw key: %d %s", rUpdate.StatusCode, pUpdate)
	}

	select {
	case synced := <-frames:
		if synced.event != "state_sync" {
			t.Fatalf("expected state_sync for client keys batch, got %+v", synced)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for client keys state_sync frame")
	}

	fixture.state.mu.Lock()
	clientKeysSnapshot := append([]string(nil), fixture.state.clientKeys...)
	fixture.state.mu.Unlock()
	if len(clientKeysSnapshot) != 3 || clientKeysSnapshot[2] != "sk-wb-key-beta" {
		t.Fatalf("coalesced client keys in CPA = %#v, want 3 keys ending in sk-wb-key-beta", clientKeysSnapshot)
	}
}

func TestStateCoordinatorSSESyncErrorRollbackAndSecretRedaction(t *testing.T) {
	fixture := &configFixtureCPA{}
	var capturedHandler *Handler
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve, func(h *Handler) {
		capturedHandler = h
	})
	if err := capturedHandler.EnableStateCoordinator(context.Background(), StateCoordinatorOptions{
		DebounceWindow: 35 * time.Millisecond,
		MaxBatchWait:   500 * time.Millisecond,
	}); err != nil {
		t.Fatalf("EnableStateCoordinator failed: %v", err)
	}
	t.Cleanup(func() { capturedHandler.CloseStateCoordinator(context.Background()) })

	sseCtx, cancelSSE := context.WithCancel(context.Background())
	defer cancelSSE()
	sseReq, err := http.NewRequestWithContext(sseCtx, http.MethodGet, baseURL+"/omc/api/v1/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	sseResp, err := client.Do(sseReq)
	if err != nil {
		t.Fatalf("open /api/v1/events: %v", err)
	}
	defer sseResp.Body.Close()

	frames := readSSEFrames(sseResp)
	select {
	case first := <-frames:
		if first.event != "ready" {
			t.Fatalf("first SSE event = %q, want ready", first.event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for SSE ready frame")
	}

	// Make upstream CPA reject writes while quoting secrets from the stored document.
	fixture.mu.Lock()
	fixture.yamlData = configFixtureYAML + "api-keys:\n    codex:\n        - api-key: secret-codex-key\n"
	fixture.rejectWrites = true
	fixture.rejectMessage = "invalid debug flag near top-secret-management-key and secret-codex-key"
	fixture.mu.Unlock()
	if err := capturedHandler.stateCoord.Bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Optimistic PUT returns HTTP 200 immediately with debug=true in memory.
	putResp, putPayload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/debug", `{"value":true}`)
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /management/config/debug status = %d body = %s", putResp.StatusCode, putPayload)
	}

	// Background flush fails -> coordinator reloads authoritative debug=false from CPA
	// and broadcasts sanitized sync_error over SSE.
	select {
	case errFrame := <-frames:
		if errFrame.event != "sync_error" {
			t.Fatalf("expected sync_error SSE frame, got %+v", errFrame)
		}
		for _, secret := range []string{"top-secret-management-key", "secret-codex-key", "secret-gemini-key"} {
			if strings.Contains(errFrame.data, secret) {
				t.Fatalf("SSE sync_error leaked stored secret %q: %s", secret, errFrame.data)
			}
		}
		var payload struct {
			Type    string                `json:"type"`
			Version uint64                `json:"version"`
			Code    string                `json:"code"`
			Scopes  []string              `json:"scopes"`
			Data    SafeProjectedStateDTO `json:"data"`
		}
		if err := json.Unmarshal([]byte(errFrame.data), &payload); err != nil {
			t.Fatalf("decode sync_error payload: %v (%s)", err, errFrame.data)
		}
		if payload.Code != "config_rejected" {
			t.Fatalf("sync_error code = %q, want config_rejected", payload.Code)
		}
		if payload.Data.Scalars.Debug {
			t.Fatal("sync_error snapshot did not roll back debug to authoritative false")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for SSE sync_error frame")
	}

	// Subsequent <1ms GET /management/config must return rolled-back debug=false.
	_, cfgRaw := getJSON(t, client, baseURL+"/omc/api/v1/management/config")
	var cfgRes struct {
		Scalars struct {
			Debug bool `json:"debug"`
		} `json:"scalars"`
	}
	if err := json.Unmarshal(cfgRaw, &cfgRes); err != nil {
		t.Fatal(err)
	}
	if cfgRes.Scalars.Debug {
		t.Fatal("GET /management/config still reports optimistic debug=true after rollback")
	}
}

func TestStateCoordinatorAuthFileStatusWriteBehindCoalescing(t *testing.T) {
	var (
		mu          sync.Mutex
		patchCount  int
		curDisabled = map[string]bool{"codex-a.json": false, "claude-b.json": false}
		appHandler  *Handler
	)
	client, baseURL, _ := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.URL.Path == "/v8/management/config/config-version":
			_, _ = writer.Write([]byte(`8`))
		case request.URL.Path == "/v8/management/config.yaml":
			writer.Header().Set("Content-Type", "application/yaml")
			_, _ = writer.Write([]byte("observability:\n  logs:\n    debug: false\n"))
		case request.URL.Path == "/v8/management/config":
			_, _ = writer.Write([]byte(`{"observability":{"logs":{"debug":false}}}`))
		case request.URL.Path == "/v8/management/credentials" && request.Method == http.MethodGet:
			mu.Lock()
			dA, dB := curDisabled["codex-a.json"], curDisabled["claude-b.json"]
			mu.Unlock()
			_, _ = fmt.Fprintf(writer, `{"files":[{"name":"codex-a.json","auth_index":"idx-a","provider":"codex","disabled":%t},{"name":"claude-b.json","auth_index":"idx-b","provider":"claude","disabled":%t}]}`, dA, dB)
		case request.URL.Path == "/v8/management/credentials/status" && request.Method == http.MethodPatch:
			var body struct {
				Name     string `json:"name"`
				Disabled bool   `json:"disabled"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			mu.Lock()
			patchCount++
			curDisabled[body.Name] = body.Disabled
			mu.Unlock()
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			_, _ = writer.Write([]byte(`{}`))
		}
	}, func(h *Handler) {
		appHandler = h
	})
	if err := appHandler.EnableStateCoordinator(context.Background(), StateCoordinatorOptions{
		DebounceWindow: 40 * time.Millisecond,
		MaxBatchWait:   500 * time.Millisecond,
	}); err != nil {
		t.Fatalf("EnableStateCoordinator failed: %v", err)
	}
	t.Cleanup(func() { appHandler.CloseStateCoordinator(context.Background()) })

	sseCtx, cancelSSE := context.WithCancel(context.Background())
	defer cancelSSE()
	sseReq, err := http.NewRequestWithContext(sseCtx, http.MethodGet, baseURL+"/omc/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	sseResp, err := client.Do(sseReq)
	if err != nil {
		t.Fatal(err)
	}
	defer sseResp.Body.Close()
	frames := readSSEFrames(sseResp)
	<-frames // ready

	// Burst 4 rapid toggles on codex-a.json (ending disabled=true) + 1 toggle on claude-b.json (disabled=true).
	for _, step := range []struct {
		name     string
		index    string
		disabled bool
	}{
		{"codex-a.json", "idx-a", true},
		{"codex-a.json", "idx-a", false},
		{"codex-a.json", "idx-a", true},
		{"claude-b.json", "idx-b", true},
	} {
		body := fmt.Sprintf(`{"name":%q,"auth_index":%q,"disabled":%t}`, step.name, step.index, step.disabled)
		r, p := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/auth-files/status", body)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("PATCH /management/auth-files/status failed: %d %s", r.StatusCode, p)
		}
	}

	// Immediate <1ms read before flush reflects both disabled=true in memory!
	_, listRaw := getJSON(t, client, baseURL+"/omc/api/v1/management/auth-files")
	var listRes struct {
		Files []struct {
			Name     string `json:"name"`
			Disabled bool   `json:"disabled"`
		} `json:"files"`
	}
	if err := json.Unmarshal(listRaw, &listRes); err != nil {
		t.Fatal(err)
	}
	if len(listRes.Files) != 2 || !listRes.Files[0].Disabled || !listRes.Files[1].Disabled {
		t.Fatalf("projected auth-files read did not reflect immediate optimistic toggle: %+v", listRes.Files)
	}

	select {
	case synced := <-frames:
		if synced.event != "state_sync" {
			t.Fatalf("expected state_sync SSE frame, got %+v", synced)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for auth-file state_sync frame")
	}

	mu.Lock()
	gotPatches := patchCount
	dA, dB := curDisabled["codex-a.json"], curDisabled["claude-b.json"]
	mu.Unlock()
	if gotPatches != 2 {
		t.Fatalf("expected 4 rapid toggles across 2 credentials to coalesce into 2 CPA writes, got %d", gotPatches)
	}
	if !dA || !dB {
		t.Fatalf("upstream CPA disabled state = (%t, %t), want (true, true)", dA, dB)
	}
}

func TestStateCoordinatorBaselineRefreshReplacesConfigurationSlices(t *testing.T) {
	upstream := &configFixtureCPA{}
	var handler *Handler
	_, _, _ = startDashboardTestServer(t, upstream.serve, func(h *Handler) { handler = h })
	if err := handler.EnableStateCoordinator(context.Background(), StateCoordinatorOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handler.CloseStateCoordinator(context.Background()) })

	upstream.mu.Lock()
	upstream.yamlData = strings.ReplaceAll(upstream.yamlData, "debug: false", "debug: true")
	upstream.configData["observability"].(map[string]any)["logs"].(map[string]any)["debug"] = true
	wantRevision := configyaml.ComputeRevision(upstream.yamlData)
	upstream.mu.Unlock()

	handler.refreshCoordinatorBaseline(context.Background())
	env, err := handler.stateCoord.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if env.Data.Revision != wantRevision || !env.Data.Scalars.Debug {
		t.Fatalf("revision and scalar snapshot diverged: revision=%s debug=%t", env.Data.Revision, env.Data.Scalars.Debug)
	}
}

func TestStateCoordinatorExternalChangeRejectsPendingBatchBeforeAnyWrite(t *testing.T) {
	upstream := &configFixtureCPA{}
	var handler *Handler
	_, _, _ = startDashboardTestServer(t, upstream.serve, func(h *Handler) { handler = h })
	if err := handler.EnableStateCoordinator(context.Background(), StateCoordinatorOptions{
		DebounceWindow: time.Hour,
		MaxBatchWait:   time.Hour,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handler.CloseStateCoordinator(context.Background()) })
	frames, unsubscribe, err := handler.stateCoord.Broker().Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	_, err = handler.stateCoord.MutateWithAudit(context.Background(), stateDomainScalars, &statecoord.PendingAuditRecord{
		Action: "config.update", TargetType: "config", TargetID: "debug",
	}, func(state *projectedConfigState) error {
		state.Scalars.Debug = true
		state.ScalarSeq++
		state.PendingScalars["debug"] = pendingScalarEntry{Value: true, Seq: state.ScalarSeq}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = handler.stateCoord.MutateWithAudit(context.Background(), stateDomainClientKeys, &statecoord.PendingAuditRecord{
		Action: "client_key.create", TargetType: "client_key", TargetID: "pending",
	}, func(state *projectedConfigState) error {
		state.ClientKeys = append(state.ClientKeys, "pending-secret-key")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	handler.agent.catalogMu.Lock()
	handler.agent.catalog = &clientKeyCatalog{keys: map[string]string{"old-fingerprint": "old-test-key"}}
	handler.agent.catalogMu.Unlock()
	upstream.mu.Lock()
	upstream.yamlData += "# changed outside OMC\n"
	wantYAML := upstream.yamlData
	upstream.mu.Unlock()
	if err := handler.stateCoord.FlushNow(context.Background()); !errors.Is(err, management.ErrConfigChanged) {
		t.Fatalf("flush error=%v, want config conflict", err)
	}
	writes, _ := upstream.recordedWrites()
	if len(writes) != 0 {
		t.Fatalf("stale pending batch wrote to CPA: %v", writes)
	}
	env, err := handler.stateCoord.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if env.Data.Scalars.Debug || env.Data.ViewYAML != wantYAML || handler.stateCoord.IsDirty() {
		t.Fatalf("conflicting optimistic state was not reconciled: debug=%t dirty=%t", env.Data.Scalars.Debug, handler.stateCoord.IsDirty())
	}
	handler.agent.catalogMu.Lock()
	hasStaleCatalog := handler.agent.catalog != nil
	handler.agent.catalogMu.Unlock()
	if hasStaleCatalog {
		t.Fatal("authoritative conflict recovery retained the old client-key catalog")
	}
	audits, err := handler.repo.ListAuditEvents(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"config.update", "client_key.create"} {
		if !slices.ContainsFunc(audits, func(event repository.AuditEvent) bool {
			return event.Action == action && event.Result == "failure"
		}) {
			t.Fatalf("missing terminal failure audit for %s", action)
		}
	}

	select {
	case event := <-frames:
		if event.Type != statecoord.EventSyncError || event.Code != "config_conflict" {
			t.Fatalf("unexpected conflict event: %+v", event)
		}
	default:
		t.Fatal("missing conflict notification")
	}
}

func TestStateCoordinatorExternalRefreshUpdatesHTTPAndSSE(t *testing.T) {
	upstream := &configFixtureCPA{}
	var handler *Handler
	client, baseURL, _ := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v8/management/config" || request.URL.Path == "/v8/management/config.yaml" {
			upstream.serve(writer, request)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(request.URL.Path, "/v8/management/config/api-keys/") {
			_, _ = writer.Write([]byte(`[]`))
			return
		}
		_, _ = writer.Write([]byte(`{}`))
	}, func(h *Handler) { handler = h })
	if err := handler.EnableStateCoordinator(context.Background(), StateCoordinatorOptions{RefreshInterval: time.Hour}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handler.CloseStateCoordinator(context.Background()) })
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/omc/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	frames := readSSEFrames(stream)
	<-frames // ready

	initialVersion := handler.stateCoord.Version()
	if err := handler.stateCoord.RefreshNow(t.Context()); err != nil {
		t.Fatal(err)
	}
	if handler.stateCoord.Version() != initialVersion {
		t.Fatal("unchanged CPA configuration triggered a state notification")
	}
	upstream.mu.Lock()
	upstream.yamlData = strings.ReplaceAll(upstream.yamlData, "debug: false", "debug: true")
	upstream.configData["observability"].(map[string]any)["logs"].(map[string]any)["debug"] = true
	upstream.configData["access"] = map[string]any{"api-keys": []any{"external-client-secret"}}
	wantRevision := configyaml.ComputeRevision(upstream.yamlData)
	upstream.mu.Unlock()

	if err := handler.stateCoord.RefreshNow(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case frame := <-frames:
		if frame.event != statecoord.EventStateSync || !strings.Contains(frame.data, "management-config") ||
			!strings.Contains(frame.data, "management-identity-directory") || strings.Contains(frame.data, "secret") {
			t.Fatalf("unexpected external-change notification: %+v", frame)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("external change was not delivered over SSE")
	}
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config")
	var config ManagementConfigResponseDTO
	if err := json.Unmarshal(payload, &config); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !config.Scalars.Debug || config.Revision != wantRevision || response.Header.Get("ETag") != `"`+wantRevision+`"` {
		t.Fatalf("HTTP view did not adopt the external config: status=%d payload=%s", response.StatusCode, payload)
	}
	_, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/state")
	var envelope struct {
		Data SafeProjectedStateDTO `json:"data"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.ClientKeysTotal != 1 || strings.Contains(string(payload), "external-client-secret") {
		t.Fatalf("external caller keys were not safely reconciled: %s", payload)
	}
	version := handler.stateCoord.Version()
	if err := handler.stateCoord.RefreshNow(t.Context()); err != nil {
		t.Fatal(err)
	}
	if handler.stateCoord.Version() != version {
		t.Fatal("already synchronized external change was published again")
	}
}

func TestStateCoordinatorBaselineRefreshRetainsNewerPendingIntents(t *testing.T) {
	upstream := &configFixtureCPA{}
	var handler *Handler
	_, _, _ = startDashboardTestServer(t, upstream.serve, func(h *Handler) { handler = h })
	if err := handler.EnableStateCoordinator(context.Background(), StateCoordinatorOptions{
		DebounceWindow: time.Hour, MaxBatchWait: time.Hour, RefreshInterval: time.Hour,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handler.CloseStateCoordinator(context.Background()) })
	_, err := handler.stateCoord.Mutate(t.Context(), stateDomainScalars, func(state *projectedConfigState) error {
		state.ScalarSeq++
		state.PendingScalars["debug"] = pendingScalarEntry{Value: true, Seq: state.ScalarSeq}
		state.Scalars.Debug = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	upstream.mu.Lock()
	upstream.yamlData += "# preceding write completed\n"
	upstream.configData["routing"].(map[string]any)["retry"].(map[string]any)["request-retry"] = 7
	wantRevision := configyaml.ComputeRevision(upstream.yamlData)
	upstream.mu.Unlock()
	handler.refreshCoordinatorBaseline(t.Context())
	env, err := handler.stateCoord.Read(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !handler.stateCoord.IsDirty() || !env.Data.Scalars.Debug || len(env.Data.PendingScalars) != 1 ||
		env.Data.Scalars.RequestRetry != 7 || env.Data.Revision != wantRevision {
		t.Fatalf("newer intent or clean baseline fields lost during refresh: %+v", env.Data.Scalars)
	}
}

type testSSEFrame struct {
	event string
	data  string
}

func readSSEFrames(resp *http.Response) <-chan testSSEFrame {
	frames := make(chan testSSEFrame, 16)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		var cur testSSEFrame
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if cur.event != "" || cur.data != "" {
					frames <- cur
					cur = testSSEFrame{}
				}
				continue
			}
			if after, ok := strings.CutPrefix(line, "event: "); ok {
				cur.event = after
			} else if after, ok := strings.CutPrefix(line, "data: "); ok {
				cur.data = after
			}
		}
	}()
	return frames
}

func TestStateCoordinatorRefreshRejectsMixedRevisionLoad(t *testing.T) {
	upstream := &configFixtureCPA{}
	var handler *Handler
	var changeDuringLoad atomic.Bool
	_, _, _ = startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v8/management/config" && changeDuringLoad.CompareAndSwap(true, false) {
			upstream.mu.Lock()
			upstream.yamlData = strings.ReplaceAll(upstream.yamlData, "debug: false", "debug: true")
			upstream.configData["observability"].(map[string]any)["logs"].(map[string]any)["debug"] = true
			upstream.mu.Unlock()
		}
		upstream.serve(writer, request)
	}, func(h *Handler) { handler = h })
	if err := handler.EnableStateCoordinator(t.Context(), StateCoordinatorOptions{RefreshInterval: time.Hour}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handler.CloseStateCoordinator(context.Background()) })
	upstream.mu.Lock()
	upstream.yamlData += "# externally changed before refresh\n"
	upstream.mu.Unlock()
	changeDuringLoad.Store(true)
	if err := handler.stateCoord.RefreshNow(t.Context()); !errors.Is(err, management.ErrConfigChanged) {
		t.Fatalf("mixed-version reload error=%v, want conflict", err)
	}
	env, err := handler.stateCoord.Read(t.Context())
	if err != nil || env.Data.Scalars.Debug || env.Version != 1 {
		t.Fatalf("mixed-version reload replaced the last good baseline: %+v %v", env.Data.Scalars, err)
	}
	if err := handler.stateCoord.RefreshNow(t.Context()); err != nil {
		t.Fatal(err)
	}
	env, err = handler.stateCoord.Read(t.Context())
	if err != nil || !env.Data.Scalars.Debug || env.Version != 2 {
		t.Fatalf("stable retry did not adopt external configuration: %+v %v", env.Data.Scalars, err)
	}
}

func TestStateCoordinatorRebaseProviderTogglesKeepsFreshProviderMetadata(t *testing.T) {
	fresh := projectedConfigState{
		Revision:     "new-baseline",
		OpenAICompat: []management.OpenAICompatibility{{Name: "relay", BaseURL: "https://new.example.test"}},
		ConfigFamilies: map[management.ConfigKeyFamily][]management.ConfigAPIKey{
			management.ConfigFamilyCodex: {{AuthIndex: "auth-1", APIKey: "provider-test-key", BaseURL: "https://new.example.test", ExcludedModels: []string{"hidden-model"}}},
		},
	}
	pending := cloneProjectedConfigState(fresh)
	pending.OpenAICompat[0].BaseURL = "https://old.example.test"
	pending.ConfigFamilies[management.ConfigFamilyCodex][0].AuthIndex = "auth-old"
	pending.PendingOpenAIToggles = map[string]pendingProviderToggle{"name:relay": {Disabled: true, Seq: 1}}
	pending.PendingFamilyToggles = map[management.ConfigKeyFamily]map[string]pendingProviderToggle{
		management.ConfigFamilyCodex: {"auth:auth-old": {Disabled: true, Seq: 2}},
	}
	rebased := rebaseProjectedConfigState(fresh, pending, []statecoord.DomainKey{
		stateDomainOpenAICompat, statecoord.DomainKey(stateDomainProviderFamilyPrefix + string(management.ConfigFamilyCodex)),
	})
	provider := rebased.ConfigFamilies[management.ConfigFamilyCodex][0]
	if !rebased.OpenAICompat[0].Disabled || rebased.OpenAICompat[0].BaseURL != "https://new.example.test" ||
		provider.BaseURL != "https://new.example.test" || !slices.Contains(provider.ExcludedModels, "*") || !slices.Contains(provider.ExcludedModels, "hidden-model") {
		t.Fatalf("rebasing resurrected stale provider fields or lost a pending toggle: %+v %+v", rebased.OpenAICompat[0], provider)
	}
}

func TestStateCoordinatorObservesDelayedRuntimeReload(t *testing.T) {
	upstream := &configFixtureCPA{}
	var handler *Handler
	var runtimeGeneration atomic.Int32
	runtimeGeneration.Store(1)
	_, _, _ = startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v8/management/config", "/v8/management/config.yaml":
			upstream.serve(writer, request)
		case "/v0/management/config":
			_, _ = fmt.Fprintf(writer, `{"runtime-generation":%d}`, runtimeGeneration.Load())
		case "/v0/management/codex-api-key":
			_, _ = fmt.Fprintf(writer, `{"codex-api-key":[{"api-key":"delayed-runtime-key","auth-index":"idx-%d"}]}`, runtimeGeneration.Load())
		default:
			if strings.HasPrefix(request.URL.Path, "/v8/management/config/api-keys/") {
				_, _ = writer.Write([]byte(`[]`))
			} else {
				_, _ = writer.Write([]byte(`{}`))
			}
		}
	}, func(h *Handler) { handler = h })
	if err := handler.EnableStateCoordinator(t.Context(), StateCoordinatorOptions{RefreshInterval: time.Hour}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handler.CloseStateCoordinator(context.Background()) })
	upstream.mu.Lock()
	upstream.yamlData += "# saved before runtime hot reload\n"
	upstream.mu.Unlock()
	if err := handler.stateCoord.RefreshNow(t.Context()); err != nil {
		t.Fatal(err)
	}
	saved, err := handler.stateCoord.Read(t.Context())
	if err != nil || saved.Data.ConfigFamilies[management.ConfigFamilyCodex][0].AuthIndex != "idx-1" {
		t.Fatalf("unexpected pre-reload projection: %v", err)
	}
	runtimeGeneration.Store(2)
	if err := handler.stateCoord.RefreshNow(t.Context()); err != nil {
		t.Fatal(err)
	}
	applied, err := handler.stateCoord.Read(t.Context())
	if err != nil || applied.Data.Revision != saved.Data.Revision ||
		applied.Data.RuntimeRevision == saved.Data.RuntimeRevision || applied.Data.ConfigFamilies[management.ConfigFamilyCodex][0].AuthIndex != "idx-2" {
		t.Fatalf("unchanged file revision hid a later runtime reload: %v", err)
	}
}

func TestStateCoordinatorRecoversCommittedBaselineBeforeNextBatch(t *testing.T) {
	for _, externalChange := range []bool{false, true} {
		t.Run(fmt.Sprintf("external_change_%t", externalChange), func(t *testing.T) {
			upstream := &configFixtureCPA{}
			var handler *Handler
			var writes atomic.Int32
			var failReadOnce atomic.Bool
			var externalGeneration atomic.Int32
			_, _, _ = startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/v8/management/config.yaml" && failReadOnce.CompareAndSwap(true, false) {
					writer.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				if request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config" {
					count := writes.Add(1)
					writer.Header().Set("ETag", fmt.Sprintf(`"saved-%d-external-0"`, count))
					if count == 1 {
						_, err := handler.stateCoord.Mutate(t.Context(), stateDomainScalars, func(state *projectedConfigState) error {
							state.ScalarSeq++
							state.PendingScalars["request_retry"] = pendingScalarEntry{Value: int64(11), Seq: state.ScalarSeq}
							state.Scalars.RequestRetry = 11
							return nil
						})
						if err != nil {
							t.Error(err)
						}
						failReadOnce.Store(true)
					}
				}
				if request.URL.Path == "/v8/management/config.yaml" {
					writer.Header().Set("ETag", fmt.Sprintf(`"saved-%d-external-%d"`, writes.Load(), externalGeneration.Load()))
				}
				upstream.serve(writer, request)
			}, func(h *Handler) { handler = h })
			if err := handler.EnableStateCoordinator(t.Context(), StateCoordinatorOptions{
				DebounceWindow: time.Hour, MaxBatchWait: time.Hour, RefreshInterval: time.Hour,
			}); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { handler.CloseStateCoordinator(context.Background()) })
			_, err := handler.stateCoord.Mutate(t.Context(), stateDomainScalars, func(state *projectedConfigState) error {
				state.ScalarSeq++
				state.PendingScalars["debug"] = pendingScalarEntry{Value: true, Seq: state.ScalarSeq}
				state.Scalars.Debug = true
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := handler.stateCoord.FlushNow(t.Context()); err != nil {
				t.Fatal(err)
			}
			env, err := handler.stateCoord.Read(t.Context())
			if err != nil || !env.Data.IsBaselineUnknown || !handler.stateCoord.IsDirty() {
				t.Fatalf("failed readback did not preserve the next batch for recovery: %+v %v", env.Data.Scalars, err)
			}
			if externalChange {
				externalGeneration.Store(1)
				upstream.mu.Lock()
				upstream.yamlData += "# external writer after committed batch\n"
				upstream.mu.Unlock()
				err := handler.stateCoord.FlushNow(t.Context())
				if !errors.Is(err, management.ErrConfigChanged) || writes.Load() != 1 {
					t.Fatalf("external edit was overwritten during baseline recovery: writes=%d error=%v", writes.Load(), err)
				}
				return
			}
			if err := handler.stateCoord.FlushNow(t.Context()); err != nil {
				t.Fatalf("own accepted write was misclassified as external drift: %v", err)
			}
			_, bodies := upstream.recordedWrites()
			if writes.Load() != 2 || len(bodies) != 2 || !strings.Contains(bodies[1], `"request-retry":11`) || handler.stateCoord.IsDirty() {
				t.Fatalf("newer intent was not persisted after recovery: writes=%d bodies=%v", writes.Load(), bodies)
			}
		})
	}
}

func TestStateCoordinatorRetriesRuntimeFallbackMetadata(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	fixture.state.groupsReadErrors = map[string]int{"codex": http.StatusServiceUnavailable}
	fixture.state.mu.Unlock()
	if err := fixture.handler.EnableStateCoordinator(t.Context(), StateCoordinatorOptions{RefreshInterval: time.Hour}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { fixture.handler.CloseStateCoordinator(context.Background()) })
	initial, err := fixture.handler.stateCoord.Read(t.Context())
	if err != nil || !initial.Data.RuntimeOnlyFam[management.ConfigFamilyCodex] || !initial.Data.FailedProviderFamilies[management.ConfigFamilyCodex] {
		t.Fatalf("transient editable-read failure was not marked for retry: %v", err)
	}
	client, err := fixture.handler.capabilityClient(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fixture.handler.readProviderItemsWithVersion(t.Context(), client)
	stillDegraded, err := fixture.handler.stateCoord.Read(t.Context())
	if err != nil || !stillDegraded.Data.FailedProviderFamilies[management.ConfigFamilyCodex] {
		t.Fatalf("runtime fallback cleared the editable-read retry marker: %v", err)
	}
	fixture.state.mu.Lock()
	delete(fixture.state.groupsReadErrors, "codex")
	fixture.state.mu.Unlock()
	if err := fixture.handler.stateCoord.RefreshNow(t.Context()); err != nil {
		t.Fatal(err)
	}
	recovered, err := fixture.handler.stateCoord.Read(t.Context())
	if err != nil || recovered.Data.RuntimeOnlyFam[management.ConfigFamilyCodex] || recovered.Data.FailedProviderFamilies[management.ConfigFamilyCodex] {
		t.Fatalf("recovered editable endpoint left a runtime-only projection cached: %v", err)
	}
}

func TestStateCoordinatorPendingFamilyToggleSurvivesRuntimeReindex(t *testing.T) {
	fixture := newProviderTestFixture(t)
	handler := fixture.handler
	if err := handler.EnableStateCoordinator(t.Context(), StateCoordinatorOptions{
		DebounceWindow: time.Hour, MaxBatchWait: time.Hour, RefreshInterval: time.Hour,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handler.CloseStateCoordinator(context.Background()) })
	domain := statecoord.DomainKey(stateDomainProviderFamilyPrefix + string(management.ConfigFamilyCodex))
	mutate := func(disabled bool) error {
		_, err := handler.stateCoord.Mutate(t.Context(), domain, func(state *projectedConfigState) error {
			entry := &state.ConfigFamilies[management.ConfigFamilyCodex][0]
			entry.ExcludedModels = management.SetExcludedAll(entry.ExcludedModels, disabled)
			state.ProviderToggleSeq++
			if state.PendingFamilyToggles == nil {
				state.PendingFamilyToggles = make(map[management.ConfigKeyFamily]map[string]pendingProviderToggle)
			}
			if state.PendingFamilyToggles[management.ConfigFamilyCodex] == nil {
				state.PendingFamilyToggles[management.ConfigFamilyCodex] = make(map[string]pendingProviderToggle)
			}
			selector := familyToggleSelector(0, entry.AuthIndex, entry.APIKey)
			state.PendingFamilyToggles[management.ConfigFamilyCodex][selector] = pendingProviderToggle{Disabled: disabled, Seq: state.ProviderToggleSeq}
			return nil
		})
		return err
	}
	if err := mutate(true); err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	fixture.state.hooksMu.Lock()
	fixture.state.beforeCodexRead = func() {
		once.Do(func() {
			if err := mutate(false); err != nil {
				t.Error(err)
			}
			fixture.state.mu.Lock()
			fixture.state.codexProviders[0]["auth-index"] = "regenerated-index"
			fixture.state.mu.Unlock()
		})
	}
	fixture.state.hooksMu.Unlock()
	if err := handler.stateCoord.FlushNow(t.Context()); err != nil {
		t.Fatal(err)
	}
	env, err := handler.stateCoord.Read(t.Context())
	if err != nil || !handler.stateCoord.IsDirty() || env.Data.ConfigFamilies[management.ConfigFamilyCodex][0].AuthIndex != "regenerated-index" {
		t.Fatalf("reload lost the new runtime identity or queued intent: %v", err)
	}
	if _, exists := env.Data.PendingFamilyToggles[management.ConfigFamilyCodex]["auth:regenerated-index"]; !exists {
		t.Fatal("pending toggle did not follow the credential's regenerated auth index")
	}
	if err := handler.stateCoord.FlushNow(t.Context()); err != nil {
		t.Fatalf("reindexed credential rejected the next batch: %v", err)
	}
	if handler.stateCoord.IsDirty() {
		t.Fatal("pending toggle did not persist after runtime reindex")
	}
	response, payload := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/providers")
	var providers ManagementProviderListResponseDTO
	if err := json.Unmarshal(payload, &providers); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !slices.ContainsFunc(providers.Providers, func(item ProviderItemDTO) bool {
		return item.Family == "codex" && item.AuthIndex == "regenerated-index" && !item.Disabled
	}) {
		t.Fatalf("persisted provider did not retain the newer enable intent: %d %s", response.StatusCode, payload)
	}
	fixture.state.mu.Lock()
	isPersistedDisabled := strings.Contains(fmt.Sprint(fixture.state.codexProviders[0]["excluded-models"]), "*")
	fixture.state.mu.Unlock()
	if isPersistedDisabled {
		t.Fatal("CPA still holds the older disabled state after the second batch")
	}
}
