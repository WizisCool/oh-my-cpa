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

type oauthCPAState struct {
	mu           sync.Mutex
	lastCallback map[string]string
	resetIndex   string
	cancelled    string
}

func startOAuthTestServer(t *testing.T) (*http.Client, string, *oauthCPAState, *repository.Repository) {
	t.Helper()
	state := &oauthCPAState{lastCallback: map[string]string{}}

	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		state.mu.Lock()
		defer state.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		path := request.URL.Path

		switch {
		case strings.HasSuffix(path, "-auth-url"):
			_, _ = writer.Write([]byte(`{"url":"https://auth.example.test/authorize?client_id=123"}`))
		case path == "/v0/management/get-auth-status":
			_, _ = writer.Write([]byte(`{"status":"pending","message":"waiting for callback"}`))
		case path == "/v0/management/oauth-callback":
			var body map[string]string
			_ = json.NewDecoder(request.Body).Decode(&body)
			state.lastCallback = body
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case path == "/v0/management/oauth-session" && request.Method == http.MethodDelete:
			state.cancelled = request.URL.Query().Get("session_id")
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case path == "/v0/management/reset-quota":
			var body map[string]string
			_ = json.NewDecoder(request.Body).Decode(&body)
			state.resetIndex = body["auth_index"]
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case path == "/v0/management/auth-files":
			_, _ = writer.Write([]byte(`{"files":[{"id":"af-1","name":"claude.json","auth_index":"cpa-auth-idx-1","provider":"claude","quota":{"signals":{"remaining":"1000"}},"model_quotas":{"claude-sonnet":{"signals":{"status":"healthy"}}}}]}`))
		default:
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(cpaServer.Close)

	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_oauth_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}

	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-key"))
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

	return client, appServer.URL, state, repo
}

func TestOAuthFlowLifecycle(t *testing.T) {
	client, baseURL, state, repo := startOAuthTestServer(t)

	// 1. List OAuth providers
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/oauth/providers")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list providers status = %d body %s", resp.StatusCode, payload)
	}
	var provRes struct {
		Providers []OAuthProviderDTO `json:"providers"`
	}
	if err := json.Unmarshal(payload, &provRes); err != nil || len(provRes.Providers) < 3 {
		t.Fatalf("unexpected providers response: %s", payload)
	}

	// 2. Start OAuth flow for codex
	startBody := `{"provider":"codex"}`
	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/oauth/start", startBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("start oauth status = %d body %s", resp.StatusCode, payload)
	}
	var startRes struct {
		URL       string `json:"url"`
		SessionID string `json:"session_id"`
		Provider  string `json:"provider"`
	}
	if err := json.Unmarshal(payload, &startRes); err != nil || startRes.URL == "" || startRes.SessionID == "" {
		t.Fatalf("invalid start response: %s", payload)
	}

	// 3. Poll OAuth status
	statusURL := fmt.Sprintf("%s/omc/api/v1/management/oauth/status?session_id=%s", baseURL, startRes.SessionID)
	resp, payload = getJSON(t, client, statusURL)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("poll oauth status = %d body %s", resp.StatusCode, payload)
	}
	var pollRes struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(payload, &pollRes); err != nil || pollRes.Status != "pending" {
		t.Fatalf("unexpected poll status: %s", payload)
	}

	// 4. Handle OAuth callback
	callbackBody := `{"code":"oauth-code-1234","state":"csrf-state-5678"}`
	resp, _ = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/oauth/callback", callbackBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("callback status = %d", resp.StatusCode)
	}
	state.mu.Lock()
	lastCb := state.lastCallback
	state.mu.Unlock()
	if lastCb["code"] != "oauth-code-1234" || lastCb["state"] != "csrf-state-5678" {
		t.Fatalf("CPA received wrong callback: %#v", lastCb)
	}

	// 5. Cancel OAuth session
	cancelURL := fmt.Sprintf("%s/omc/api/v1/management/oauth/session?session_id=%s", baseURL, startRes.SessionID)
	resp, _ = doJSON(t, client, http.MethodDelete, cancelURL, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("cancel status = %d", resp.StatusCode)
	}
	state.mu.Lock()
	cancelledID := state.cancelled
	state.mu.Unlock()
	if cancelledID != startRes.SessionID {
		t.Fatalf("CPA cancel session mismatch: %s vs %s", cancelledID, startRes.SessionID)
	}

	// 6. Verify audit records
	events, err := repo.ListAuditEvents(context.Background(), 10)
	if err != nil || len(events) == 0 {
		t.Fatalf("audit events missing: %v", err)
	}
	actions := make(map[string]bool)
	for _, e := range events {
		actions[e.Action] = true
	}
	for _, act := range []string{"oauth.start", "oauth.callback", "oauth.cancel"} {
		if !actions[act] {
			t.Errorf("expected audit action %s, got %#v", act, events)
		}
	}
}

func TestQuotaOverviewAndReset(t *testing.T) {
	client, baseURL, state, repo := startOAuthTestServer(t)

	// 1. GET quota overview
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/quota")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get quota status = %d body %s", resp.StatusCode, payload)
	}
	var qRes struct {
		Quotas []QuotaItemDTO `json:"quotas"`
		Total  int            `json:"total"`
	}
	if err := json.Unmarshal(payload, &qRes); err != nil || len(qRes.Quotas) != 1 {
		t.Fatalf("unexpected quota overview: %s", payload)
	}
	item := qRes.Quotas[0]
	if item.AuthIndex != "cpa-auth-idx-1" || item.Quota == nil {
		t.Fatalf("quota item mismatch: %#v", item)
	}

	// 2. POST reset-quota with valid auth_index
	resetBody := `{"auth_index":"cpa-auth-idx-1"}`
	resp, _ = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/quota/reset", resetBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reset quota status = %d", resp.StatusCode)
	}
	state.mu.Lock()
	resetAuth := state.resetIndex
	state.mu.Unlock()
	if resetAuth != "cpa-auth-idx-1" {
		t.Fatalf("CPA received wrong auth_index for reset: %s", resetAuth)
	}

	// 3. POST reset-quota with empty auth_index must return 400
	resp, _ = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/quota/reset", `{"auth_index":""}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty auth_index, got %d", resp.StatusCode)
	}

	// 4. Verify audit for quota.reset
	events, err := repo.ListAuditEvents(context.Background(), 5)
	if err != nil {
		t.Fatal(err)
	}
	foundReset := false
	for _, e := range events {
		if e.Action == "quota.reset" && e.TargetID == "cpa-auth-idx-1" {
			foundReset = true
			break
		}
	}
	if !foundReset {
		t.Fatalf("expected audit for quota.reset, got %#v", events)
	}
}
