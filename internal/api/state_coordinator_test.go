package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
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
