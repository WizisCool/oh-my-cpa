package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func startSystemTestServer(t *testing.T) (*http.Client, string, *repository.Repository) {
	t.Helper()

	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("X-CPA-Version", "7.2.146-test")
		if request.URL.Path == "/v0/management/latest-version" {
			_, _ = writer.Write([]byte(`{"latest-version":"7.2.147"}`))
			return
		}
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	}))
	t.Cleanup(cpaServer.Close)

	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_sys_%d?mode=memory&cache=shared", time.Now().UnixNano()))
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
		Version:  "v0.1.0-sys-test",
		Usage: config.UsageConfig{
			Enabled: true,
			Mode:    "auto",
		},
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

	return client, appServer.URL, repo
}

func TestSystemInfoEndpoint(t *testing.T) {
	client, baseURL, _ := startSystemTestServer(t)

	req, _ := http.NewRequest(http.MethodGet, baseURL+"/omc/api/v1/management/system", nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("get system info: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("system info status = %d, expected 200", resp.StatusCode)
	}

	var data SystemInfoDTO
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		t.Fatalf("decode system info: %v", err)
	}

	if data.OMCVersion != "v0.1.0-sys-test" {
		t.Errorf("expected OMCVersion v0.1.0-sys-test, got %s", data.OMCVersion)
	}
	if data.CPAVersion != "7.2.146-test" {
		t.Errorf("expected CPAVersion 7.2.146-test, got %s", data.CPAVersion)
	}
	if data.LatestVersion != "7.2.147" {
		t.Errorf("expected LatestVersion 7.2.147, got %s", data.LatestVersion)
	}
	if !data.UpdateAvailable {
		t.Errorf("expected UpdateAvailable true")
	}
	if data.Database.Status != "ok" {
		t.Errorf("expected Database.Status ok, got %s", data.Database.Status)
	}
	if data.Collector.Status != "active" {
		t.Errorf("expected Collector.Status active, got %s", data.Collector.Status)
	}
	if data.Runtime.GoVersion == "" {
		t.Errorf("expected non-empty GoVersion")
	}
}

func TestSystemDiagnosticsEndpoint(t *testing.T) {
	client, baseURL, repo := startSystemTestServer(t)

	req, _ := http.NewRequest(http.MethodGet, baseURL+"/omc/api/v1/management/system/diagnostics", nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("get diagnostics: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("diagnostics status = %d, expected 200", resp.StatusCode)
	}

	disposition := resp.Header.Get("Content-Disposition")
	if disposition == "" || !contains(disposition, "attachment; filename=") {
		t.Errorf("expected attachment disposition, got %s", disposition)
	}

	var bundle map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&bundle); err != nil {
		t.Fatalf("decode diagnostics json: %v", err)
	}

	if bundle["omc_version"] != "v0.1.0-sys-test" {
		t.Errorf("expected omc_version in bundle, got %v", bundle["omc_version"])
	}

	// Verify audit was recorded
	events, err := repo.ListAuditEvents(context.Background(), 10)
	if err != nil || len(events) == 0 {
		t.Fatalf("expected audit event recorded for diagnostics, got err=%v, count=%d", err, len(events))
	}
	if events[0].Action != "system.diagnostics" {
		t.Errorf("expected audit action system.diagnostics, got %s", events[0].Action)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 || (len(s) > 0 && len(substr) > 0 && stringContains(s, substr)))
}

func stringContains(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
