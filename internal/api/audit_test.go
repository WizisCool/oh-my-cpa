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
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func startAuditTestEnvironment(t *testing.T) (*http.Client, string, *repository.Repository, *repository.DB) {
	t.Helper()
	fakeCPA := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		path := request.URL.Path
		switch {
		case strings.HasPrefix(path, "/v0/management/auth-files/download"):
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"account":"secret-downloaded-token","provider":"openai"}`))
		case strings.HasPrefix(path, "/v0/management/auth-files") && request.Method == http.MethodDelete:
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case strings.HasPrefix(path, "/v0/management/logs") && request.Method == http.MethodDelete:
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{"status":"cleared"}`))
		case strings.HasPrefix(path, "/v0/management/config/source") && request.Method == http.MethodGet:
			writer.Header().Set("Content-Type", "text/plain")
			_, _ = writer.Write([]byte("api_key: secret-config-yaml\n"))
		case strings.HasPrefix(path, "/v0/management/config/source") && request.Method == http.MethodPut:
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case strings.HasPrefix(path, "/v0/management/config") && request.Method == http.MethodPut:
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case strings.HasPrefix(path, "/v0/management/request-error-logs/"):
			writer.Header().Set("Content-Type", "text/plain")
			_, _ = writer.Write([]byte("log error payload with Authorization: Bearer secret-err-log"))
		case strings.HasPrefix(path, "/v0/management/request-log"):
			writer.Header().Set("Content-Type", "text/plain")
			_, _ = writer.Write([]byte("request log payload with secret-request-log"))
		default:
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(fakeCPA.Close)

	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_audit_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}

	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-admin-secret"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 fakeCPA.URL,
		UsageAddr:               strings.TrimPrefix(fakeCPA.URL, "http://"),
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}

	authManager, err := auth.New("app-admin-secret", "", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{BasePath: "", Version: "test", CPA: config.CPAConfig{ManagementKey: "app-admin-secret"}}, repo, cipher, nil, authManager)
	appServer := httptest.NewServer(handler.Router())
	t.Cleanup(appServer.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}

	// Login
	loginResp, err := client.Post(appServer.URL+"/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"app-admin-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	if loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login failed: %d", loginResp.StatusCode)
	}
	loginResp.Body.Close()

	return client, appServer.URL, repo, db
}

func TestAuditOperationsAreRecorded(t *testing.T) {
	client, serverURL, repo, _ := startAuditTestEnvironment(t)
	ctx := context.Background()

	// 1. Auth File download
	req, _ := http.NewRequest(http.MethodGet, serverURL+"/api/v1/management/auth-files/download?name=openai.json", nil)
	req.Header.Set("X-Request-ID", "req-test-dl")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("download auth file status = %d", resp.StatusCode)
	}

	// 2. Auth File delete
	delReq, _ := http.NewRequest(http.MethodDelete, serverURL+"/api/v1/management/auth-files?name=openai.json", nil)
	delReq.Header.Set("Origin", serverURL)
	resp, err = client.Do(delReq)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete auth file status = %d", resp.StatusCode)
	}

	// 3. Logs clear
	clearReq, _ := http.NewRequest(http.MethodDelete, serverURL+"/api/v1/management/logs", nil)
	clearReq.Header.Set("Origin", serverURL)
	resp, err = client.Do(clearReq)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("clear logs status = %d", resp.StatusCode)
	}

	// 4. Config scalar save
	scalarReq, _ := http.NewRequest(http.MethodPut, serverURL+"/api/v1/management/config/request_log", bytes.NewBufferString(`{"value":true}`))
	scalarReq.Header.Set("Origin", serverURL)
	scalarReq.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(scalarReq)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("config scalar save status = %d", resp.StatusCode)
	}

	// 5. Config source reveal grant & GET
	grantReq, _ := http.NewRequest(http.MethodPost, serverURL+"/api/v1/management/config/source/grant", bytes.NewBufferString(`{"password":"app-admin-secret"}`))
	grantReq.Header.Set("Origin", serverURL)
	grantReq.Header.Set("Content-Type", "application/json")
	grantResp, err := client.Do(grantReq)
	if err != nil {
		t.Fatal(err)
	}
	var grantData struct {
		GrantToken string `json:"grant_token"`
	}
	_ = json.NewDecoder(grantResp.Body).Decode(&grantData)
	grantResp.Body.Close()

	srcGetReq, _ := http.NewRequest(http.MethodGet, serverURL+"/api/v1/management/config/source", nil)
	srcGetReq.Header.Set("X-Reveal-Grant", grantData.GrantToken)
	resp, err = client.Do(srcGetReq)
	if err != nil {
		t.Fatal(err)
	}
	var srcBody struct {
		Revision string `json:"revision"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&srcBody)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("config source get status = %d", resp.StatusCode)
	}

	// 6. Config source save (PUT)
	putPayload, _ := json.Marshal(map[string]string{"yaml": "proxy_url: test\n", "revision": srcBody.Revision})
	srcPutReq, _ := http.NewRequest(http.MethodPut, serverURL+"/api/v1/management/config/source", bytes.NewBuffer(putPayload))
	srcPutReq.Header.Set("Origin", serverURL)
	srcPutReq.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(srcPutReq)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("config source put status = %d", resp.StatusCode)
	}

	// 7. Request error log download
	errLogReq, _ := http.NewRequest(http.MethodGet, serverURL+"/api/v1/management/request-error-logs/err.log", nil)
	resp, err = client.Do(errLogReq)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("request error log status = %d", resp.StatusCode)
	}

	// 8. Usage event request log download
	eventID, err := repo.InsertUsageEvents(ctx, []usage.Event{{
		InstanceID:  "default",
		EventKey:    "ev-log-1",
		RequestID:   "req-audit-log-1",
		TimestampMS: time.Now().UnixMilli(),
		Model:       "gpt-4",
	}})
	if err != nil {
		t.Fatal(err)
	}
	evLogReq, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/v1/usage/events/%d/request-log", serverURL, eventID), nil)
	resp, err = client.Do(evLogReq)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("usage event request-log status = %d", resp.StatusCode)
	}

	// Verify audit log entries in repository
	events, err := repo.ListAuditEvents(ctx, 50)
	if err != nil {
		t.Fatalf("ListAuditEvents failed: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("no audit events recorded")
	}

	expectedActions := []string{
		"auth_file.download",
		"auth_file.delete",
		"logs.clear",
		"config.save_scalar",
		"config.reveal_source",
		"config.save_source",
		"request_log.download",
	}
	recordedActions := make(map[string]bool)
	for _, ev := range events {
		recordedActions[ev.Action] = true
	}
	for _, act := range expectedActions {
		if !recordedActions[act] {
			t.Errorf("expected action %q to be audited, but was not found in %#v", act, events)
		}
	}
}

func TestAuditFailureFailsClosedWithoutExposingSecrets(t *testing.T) {
	client, serverURL, _, db := startAuditTestEnvironment(t)

	// Drop audit_events table to force audit writes to fail while instance lookup succeeds
	if _, err := db.SQL.Exec("DROP TABLE audit_events"); err != nil {
		t.Fatal(err)
	}

	// 1. Download auth file must fail with 500 and not return content
	req, _ := http.NewRequest(http.MethodGet, serverURL+"/api/v1/management/auth-files/download?name=openai.json", nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500 on audit failure, got %d", resp.StatusCode)
	}
	var payload map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	if errMsg, ok := payload["error"].(string); !ok || !strings.Contains(errMsg, "audit") {
		t.Fatalf("expected audit error message, got %#v", payload)
	}

	// 2. Clear logs must fail with 500
	clearReq, _ := http.NewRequest(http.MethodDelete, serverURL+"/api/v1/management/logs", nil)
	clearReq.Header.Set("Origin", serverURL)
	resp2, err := client.Do(clearReq)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500 on audit failure, got %d", resp2.StatusCode)
	}

	// 3. Config reveal with valid grant must fail with 500 when audit write fails
	grantReq, _ := http.NewRequest(http.MethodPost, serverURL+"/api/v1/management/config/source/grant", bytes.NewBufferString(`{"password":"app-admin-secret"}`))
	grantReq.Header.Set("Origin", serverURL)
	grantReq.Header.Set("Content-Type", "application/json")
	grantResp, _ := client.Do(grantReq)
	var grantData struct {
		GrantToken string `json:"grant_token"`
	}
	_ = json.NewDecoder(grantResp.Body).Decode(&grantData)
	grantResp.Body.Close()

	srcGetReq, _ := http.NewRequest(http.MethodGet, serverURL+"/api/v1/management/config/source", nil)
	srcGetReq.Header.Set("X-Reveal-Grant", grantData.GrantToken)
	resp3, err := client.Do(srcGetReq)
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500 on audit failure, got %d", resp3.StatusCode)
	}
}
