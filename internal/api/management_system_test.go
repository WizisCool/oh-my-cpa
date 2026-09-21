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
	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func startSystemTestServer(t *testing.T) (*http.Client, string, *repository.Repository) {
	t.Helper()

	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("X-CPA-Version", "7.2.146-test")
		switch {
		case strings.HasSuffix(request.URL.Path, "/auth-files"):
			_, _ = writer.Write([]byte(`{"files":[{"name":"a.json"},{"name":"b.json"}]}`))
		case strings.HasSuffix(request.URL.Path, "/plugins"):
			_, _ = writer.Write([]byte(`[]`))
		case strings.Contains(request.URL.Path, "api-key"):
			_, _ = writer.Write([]byte(`[]`))
		default:
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		}
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

	// Oh My CPA's own build version is reported as-is.
	if data.OMCVersion.RunningVersion != "v0.1.0-sys-test" {
		t.Errorf("running Oh My CPA version = %q, want v0.1.0-sys-test", data.OMCVersion.RunningVersion)
	}
	// The gateway's version is observed from the gateway, independently of any
	// release check - a deployment that cannot reach GitHub must still be able to say
	// which gateway version it runs.
	if data.CPAVersion.RunningVersion != "7.2.146-test" {
		t.Errorf("running gateway version = %q, want 7.2.146-test", data.CPAVersion.RunningVersion)
	}
	// No release service is attached in this test server, so the honest answer is
	// "not checked yet" rather than a comparison against nothing.
	if data.OMCVersion.State != release.UpdateIndeterminate {
		t.Errorf("Oh My CPA state = %q, want %q", data.OMCVersion.State, release.UpdateIndeterminate)
	}
	if data.OMCVersion.Reason != release.ReasonNoData {
		t.Errorf("Oh My CPA reason = %q, want %q", data.OMCVersion.Reason, release.ReasonNoData)
	}

	if data.Database.Status != "ok" {
		t.Errorf("database status = %q, want ok", data.Database.Status)
	}
	// The journal mode is read from the database, and an in-memory database reports
	// its own mode rather than the WAL the file-backed one uses.
	if data.Database.JournalMode == "" {
		t.Error("journal mode was not observed")
	}
	if data.Database.WALMode != (data.Database.JournalMode == "wal") {
		t.Errorf("wal_mode %v disagrees with the observed journal mode %q", data.Database.WALMode, data.Database.JournalMode)
	}
	if data.Database.PageSize <= 0 || data.Database.PageCount <= 0 {
		t.Errorf("page geometry was not read: %+v", data.Database)
	}
	// This server uses a shared-cache in-memory database, so there is genuinely no file
	// to measure. The page must say that rather than reporting a zero-sized file, which
	// is why the "exists" flags are part of the contract.
	if data.Database.Files.MainExists {
		t.Error("an in-memory database reports a main file on disk")
	}
	if data.Database.Files.TotalBytes != 0 {
		t.Errorf("in-memory footprint = %d bytes, want 0", data.Database.Files.TotalBytes)
	}
	if data.Database.Files.TotalBytes != data.Database.Files.MainBytes+data.Database.Files.WALBytes+data.Database.Files.SHMBytes {
		t.Errorf("file total is not the sum of its parts: %+v", data.Database.Files)
	}

	if data.Collector.Status != "active" {
		t.Errorf("collector status = %q, want active", data.Collector.Status)
	}
	if data.Runtime.GoVersion == "" {
		t.Error("Go version was not reported")
	}
	if data.Runtime.PID <= 0 {
		t.Errorf("process id = %d", data.Runtime.PID)
	}
	if data.Runtime.StartedAtMS == 0 {
		t.Error("process start time was not reported")
	}

	// Gateway-side counts come from the fixture; a count that could not be read must be
	// absent rather than zero.
	if data.DataVolumes.Credentials == nil || *data.DataVolumes.Credentials != 2 {
		t.Errorf("credential count = %v, want 2", data.DataVolumes.Credentials)
	}

	// This handler has no maintenance service attached, so the admission states that
	// rather than claiming a requirement of zero bytes.
	if data.MaintenanceAdmission.Allowed {
		t.Error("maintenance was reported as available without a maintenance service")
	}
	if data.MaintenanceAdmission.Reason == "" {
		t.Error("a refusal carried no reason")
	}
	if data.Maintenance.Running {
		t.Error("no maintenance job was started, but one is reported as running")
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

// TestDiagnosticsBundleCarriesWhatThePageStoppedShowing pins the relocation the product
// decision implies: the database's internal geometry and connection settings left the page,
// and the bundle is where they went. Without this, removing them from the page would have
// deleted them rather than moved them, and the failure would only surface when somebody
// needed to diagnose a database.
func TestDiagnosticsBundleCarriesWhatThePageStoppedShowing(t *testing.T) {
	client, baseURL, _ := startSystemTestServer(t)

	resp, err := client.Get(baseURL + "/omc/api/v1/management/system/diagnostics")
	if err != nil {
		t.Fatalf("get diagnostics: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("diagnostics status = %d, want 200", resp.StatusCode)
	}

	var bundle map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&bundle); err != nil {
		t.Fatalf("decode diagnostics: %v", err)
	}
	database, ok := bundle["database"].(map[string]any)
	if !ok {
		t.Fatalf("bundle has no database section: %v", bundle)
	}
	// The facts the page no longer shows.
	for _, key := range []string{
		"schema_version", "page_size", "page_count", "freelist_count",
		"free_page_bytes", "used_bytes", "journal_mode",
	} {
		if _, present := database[key]; !present {
			t.Errorf("the diagnostics bundle is missing %q, which the page no longer reports either", key)
		}
	}
	// A setting a connection declined to answer must be absent, not fabricated as zero.
	for _, key := range []string{"synchronous", "foreign_keys", "busy_timeout_ms"} {
		if value, present := database[key]; present && value == nil {
			t.Errorf("%q is present but null; an unanswered setting should be absent", key)
		}
	}
}
