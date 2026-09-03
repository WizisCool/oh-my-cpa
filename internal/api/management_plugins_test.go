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

type pluginMockState struct {
	mu          sync.Mutex
	statusCalls map[string]bool
	deleted     string
	installed   string
	configs     map[string]map[string]any
}

func startPluginTestServer(t *testing.T) (*http.Client, string, *repository.Repository, *pluginMockState) {
	t.Helper()
	state := &pluginMockState{
		statusCalls: make(map[string]bool),
		configs:     make(map[string]map[string]any),
	}

	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		state.mu.Lock()
		defer state.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		path := request.URL.Path

		switch {
		case path == "/v0/management/plugins" && request.Method == http.MethodGet:
			_, _ = writer.Write([]byte(`{"plugins":[{"id":"logger","name":"Logger","version":"1.0.0","enabled":true,"permissions":["read_request"]}]}`))
		case strings.HasPrefix(path, "/v0/management/plugins/") && strings.HasSuffix(path, "/status"):
			parts := strings.Split(path, "/")
			id := parts[len(parts)-2]
			var body map[string]bool
			_ = json.NewDecoder(request.Body).Decode(&body)
			state.statusCalls[id] = body["enabled"]
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case strings.HasPrefix(path, "/v0/management/plugins/") && strings.HasSuffix(path, "/config"):
			parts := strings.Split(path, "/")
			id := parts[len(parts)-2]
			var body map[string]any
			_ = json.NewDecoder(request.Body).Decode(&body)
			state.configs[id] = body
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case strings.HasPrefix(path, "/v0/management/plugins/") && request.Method == http.MethodDelete:
			parts := strings.Split(path, "/")
			id := parts[len(parts)-1]
			state.deleted = id
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case path == "/v0/management/plugin-store" && request.Method == http.MethodGet:
			_, _ = writer.Write([]byte(`{"plugins":[{"id":"limiter","name":"Rate Limiter","version":"1.2.0","permissions":["inspect_client_ip"],"installed":false}]}`))
		case strings.HasPrefix(path, "/v0/management/plugin-store/") && strings.HasSuffix(path, "/install"):
			parts := strings.Split(path, "/")
			id := parts[len(parts)-2]
			state.installed = id
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		}
	}))
	t.Cleanup(cpaServer.Close)

	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_plugin_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatalf("open memory repo: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)

	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatalf("new cipher: %v", err)
	}

	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-secret-key"))
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
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
		t.Fatalf("upsert instance: %v", err)
	}

	authManager, err := auth.New("management-secret-value", "/omc", "")
	if err != nil {
		t.Fatalf("new auth manager: %v", err)
	}
	handler := NewHandler(config.Config{
		BasePath: "/omc",
		Version:  "v0.1.0-test",
		Usage:    config.UsageConfig{Enabled: false},
	}, repo, cipher, nil, authManager)

	appServer := httptest.NewServer(handler.Router())
	t.Cleanup(appServer.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("new cookie jar: %v", err)
	}
	client := &http.Client{Jar: jar}

	loginResp, err := client.Post(appServer.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret-value"}`))
	if err != nil || loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login failed: %v", err)
	}

	return client, appServer.URL, repo, state
}

func TestPluginsLifecycle(t *testing.T) {
	client, baseURL, repo, state := startPluginTestServer(t)

	// 1. List installed plugins
	resp, err := client.Get(baseURL + "/omc/api/v1/management/plugins")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("get plugins failed: %v, status: %d", err, resp.StatusCode)
	}
	var pluginsData struct {
		Plugins []map[string]any `json:"plugins"`
		Total   int              `json:"total"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&pluginsData)
	resp.Body.Close()
	if len(pluginsData.Plugins) != 1 || pluginsData.Plugins[0]["id"] != "logger" {
		t.Fatalf("unexpected plugins list: %#v", pluginsData)
	}

	// 2. Set plugin status (disable)
	patchReq, _ := http.NewRequest(http.MethodPatch, baseURL+"/omc/api/v1/management/plugins/logger/status", bytes.NewBufferString(`{"enabled":false}`))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := client.Do(patchReq)
	if err != nil || patchResp.StatusCode != http.StatusOK {
		t.Fatalf("patch status failed: %v, status: %d", err, patchResp.StatusCode)
	}
	patchResp.Body.Close()
	if state.statusCalls["logger"] != false {
		t.Errorf("expected logger plugin to be disabled")
	}

	// 3. Set plugin config
	putReq, _ := http.NewRequest(http.MethodPut, baseURL+"/omc/api/v1/management/plugins/logger/config", bytes.NewBufferString(`{"config":{"level":"debug"}}`))
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := client.Do(putReq)
	if err != nil || putResp.StatusCode != http.StatusOK {
		t.Fatalf("put config failed: %v, status: %d", err, putResp.StatusCode)
	}
	putResp.Body.Close()
	if state.configs["logger"]["level"] != "debug" {
		t.Errorf("expected logger config level debug, got %#v", state.configs["logger"])
	}

	// 4. Delete plugin
	delReq, _ := http.NewRequest(http.MethodDelete, baseURL+"/omc/api/v1/management/plugins/logger", nil)
	delResp, err := client.Do(delReq)
	if err != nil || delResp.StatusCode != http.StatusOK {
		t.Fatalf("delete plugin failed: %v, status: %d", err, delResp.StatusCode)
	}
	delResp.Body.Close()
	if state.deleted != "logger" {
		t.Errorf("expected deleted logger, got %s", state.deleted)
	}

	// 5. List store plugins
	storeResp, err := client.Get(baseURL + "/omc/api/v1/management/plugin-store")
	if err != nil || storeResp.StatusCode != http.StatusOK {
		t.Fatalf("get store failed: %v, status: %d", err, storeResp.StatusCode)
	}
	var storeData struct {
		Plugins []map[string]any `json:"plugins"`
	}
	_ = json.NewDecoder(storeResp.Body).Decode(&storeData)
	storeResp.Body.Close()
	if len(storeData.Plugins) != 1 || storeData.Plugins[0]["id"] != "limiter" {
		t.Fatalf("unexpected store plugins: %#v", storeData)
	}

	// 6. Install plugin
	installResp, err := client.Post(baseURL+"/omc/api/v1/management/plugin-store/limiter/install", "application/json", nil)
	if err != nil || installResp.StatusCode != http.StatusOK {
		t.Fatalf("install plugin failed: %v, status: %d", err, installResp.StatusCode)
	}
	installResp.Body.Close()
	if state.installed != "limiter" {
		t.Errorf("expected installed limiter, got %s", state.installed)
	}

	// 7. Check audit events
	events, err := repo.ListAuditEvents(context.Background(), 20)
	if err != nil || len(events) < 4 {
		t.Fatalf("expected at least 4 audit events recorded, got %d, err: %v", len(events), err)
	}
}
