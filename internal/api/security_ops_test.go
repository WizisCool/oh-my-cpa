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
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestSecurityHeadersApplied(t *testing.T) {
	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_sec_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)

	cipher, _ := crypto.New("01234567890123456789012345678901")
	authManager, _ := auth.New("test-key", "/omc", "")
	h := NewHandler(config.Config{BasePath: "/omc"}, repo, cipher, nil, authManager)

	ts := httptest.NewServer(h.Router())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/omc/api/healthz", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("expected nosniff, got %s", resp.Header.Get("X-Content-Type-Options"))
	}
	if resp.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("expected no-referrer, got %s", resp.Header.Get("Referrer-Policy"))
	}
	if resp.Header.Get("X-Frame-Options") != "SAMEORIGIN" {
		t.Errorf("expected SAMEORIGIN, got %s", resp.Header.Get("X-Frame-Options"))
	}
	if resp.Header.Get("Permissions-Policy") == "" {
		t.Errorf("expected Permissions-Policy header")
	}
	if resp.Header.Get("Content-Security-Policy-Report-Only") == "" {
		t.Errorf("expected Content-Security-Policy-Report-Only header")
	}
}

func TestLoginRateLimiterLockout(t *testing.T) {
	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_limiter_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)

	cipher, _ := crypto.New("01234567890123456789012345678901")
	authManager, _ := auth.New("correct-secret-password", "/omc", "")
	h := NewHandler(config.Config{BasePath: "/omc"}, repo, cipher, nil, authManager)

	ts := httptest.NewServer(h.Router())
	defer ts.Close()

	// 1. Attempt 4 failures - should return 401
	for i := 0; i < 4; i++ {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/omc/api/auth/login", bytes.NewBufferString(`{"password":"wrong-password"}`))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected 401, got %d", i+1, resp.StatusCode)
		}
		resp.Body.Close()
	}

	// 2. 5th failure triggers lockout
	req5, _ := http.NewRequest(http.MethodPost, ts.URL+"/omc/api/auth/login", bytes.NewBufferString(`{"password":"wrong-password"}`))
	req5.Header.Set("Content-Type", "application/json")
	resp5, err := http.DefaultClient.Do(req5)
	if err != nil {
		t.Fatal(err)
	}
	if resp5.StatusCode != http.StatusUnauthorized {
		t.Fatalf("attempt 5: expected 401, got %d", resp5.StatusCode)
	}
	resp5.Body.Close()

	// 3. 6th attempt while locked should return 429 Too Many Requests (even with correct password!)
	req6, _ := http.NewRequest(http.MethodPost, ts.URL+"/omc/api/auth/login", bytes.NewBufferString(`{"password":"correct-secret-password"}`))
	req6.Header.Set("Content-Type", "application/json")
	resp6, err := http.DefaultClient.Do(req6)
	if err != nil {
		t.Fatal(err)
	}
	defer resp6.Body.Close()
	if resp6.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("attempt 6 while locked: expected 429 Too Many Requests, got %d", resp6.StatusCode)
	}
}

func TestAuditEventsEndpoints(t *testing.T) {
	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_audit_ep_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)

	cipher, _ := crypto.New("01234567890123456789012345678901")
	authManager, _ := auth.New("test-key", "/omc", "")
	h := NewHandler(config.Config{BasePath: "/omc"}, repo, cipher, nil, authManager)

	// Record a couple of audit events directly
	_, _ = repo.RecordAuditEvent(context.Background(), repository.AuditEvent{
		Action:     "config.test",
		TargetType: "config",
		TargetID:   "proxy",
		Result:     "success",
	})

	ts := httptest.NewServer(h.Router())
	defer ts.Close()

	jar, _ := cookiejar.New(nil)
	cli := &http.Client{Jar: jar}

	// Login
	loginResp, err := cli.Post(ts.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"test-key"}`))
	if err != nil || loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login failed: %v", err)
	}

	// 1. List audit events
	listResp, err := cli.Get(ts.URL + "/omc/api/v1/management/audit/events")
	if err != nil || listResp.StatusCode != http.StatusOK {
		t.Fatalf("list audit events failed: %v, status: %d", err, listResp.StatusCode)
	}
	var listData struct {
		Events []repository.AuditEvent `json:"events"`
		Total  int                     `json:"total"`
	}
	_ = json.NewDecoder(listResp.Body).Decode(&listData)
	listResp.Body.Close()
	if listData.Total < 1 {
		t.Errorf("expected at least 1 audit event, got %d", listData.Total)
	}

	// 2. Export audit events
	exportResp, err := cli.Get(ts.URL + "/omc/api/v1/management/audit/export")
	if err != nil || exportResp.StatusCode != http.StatusOK {
		t.Fatalf("export audit events failed: %v, status: %d", err, exportResp.StatusCode)
	}
	defer exportResp.Body.Close()
	if exportResp.Header.Get("Content-Disposition") == "" {
		t.Errorf("expected attachment Content-Disposition on audit export")
	}
}
