package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestHealthzLivenessAndReadinessPartitioning(t *testing.T) {
	cpaOnline := true
	fakeCPA := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !cpaOnline {
			writer.WriteHeader(http.StatusBadGateway)
			return
		}
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	}))
	defer fakeCPA.Close()

	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_health_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-secret"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 fakeCPA.URL,
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}

	handler := NewHandler(config.Config{BasePath: "", Version: "v0.1.0-test"}, repo, cipher, nil, nil)
	server := httptest.NewServer(handler.Router())
	defer server.Close()

	// 1. Fully healthy
	resp, err := http.Get(server.URL + "/api/healthz")
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if body["status"] != "ok" || body["database_status"] != "ok" || body["cpa_connected"] != true {
		t.Fatalf("unexpected healthy payload: %#v", body)
	}
	// Assert cpa_base_url is NOT leaked in public healthz
	if _, exists := body["cpa_base_url"]; exists {
		t.Fatalf("cpa_base_url must not be exposed in public healthz: %#v", body)
	}

	// 2. CPA disconnected (degraded, but process is alive)
	cpaOnline = false
	resp2, err := http.Get(server.URL + "/api/healthz")
	if err != nil {
		t.Fatal(err)
	}
	var body2 map[string]any
	_ = json.NewDecoder(resp2.Body).Decode(&body2)
	resp2.Body.Close()

	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for degraded, got %d", resp2.StatusCode)
	}
	if body2["status"] != "degraded" || body2["cpa_connected"] != false || body2["database_status"] != "ok" {
		t.Fatalf("unexpected degraded payload: %#v", body2)
	}

	// 3. Database down (fatal readiness failure -> 503)
	_ = db.Close()
	resp3, err := http.Get(server.URL + "/api/healthz")
	if err != nil {
		t.Fatal(err)
	}
	var body3 map[string]any
	_ = json.NewDecoder(resp3.Body).Decode(&body3)
	resp3.Body.Close()

	if resp3.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 for database down, got %d", resp3.StatusCode)
	}
	if body3["status"] != "error" || body3["database_status"] != "error" {
		t.Fatalf("unexpected error payload: %#v", body3)
	}
}
