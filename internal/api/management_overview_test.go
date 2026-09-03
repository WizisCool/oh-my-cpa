package api

import (
	"bytes"
	"context"
	"encoding/json"
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
)

func TestManagementOverviewRequiresAuthentication(t *testing.T) {
	handler := testHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()
	response, err := http.Get(server.URL + "/omc/api/v1/management/overview")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.StatusCode)
	}
}

func TestManagementOverviewUnconfiguredReportsNullCounts(t *testing.T) {
	handler := testHandler(t, "/omc")
	server := httptest.NewServer(handler.Router())
	defer server.Close()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	login, err := client.Post(server.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	response, err := client.Get(server.URL + "/omc/api/v1/management/overview")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("unconfigured overview cache-control = %q", response.Header.Get("Cache-Control"))
	}
	var payload managementOverviewResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Status != "unconfigured" || payload.CPAConnected {
		t.Fatalf("payload = %#v", payload)
	}
	if payload.Counts.Credentials != nil || payload.Counts.ProviderKeys != nil || payload.Counts.ManagementKeys != nil || payload.Counts.Models != nil {
		t.Fatalf("unconfigured counts must be null, not zero: %#v", payload.Counts)
	}
	if payload.Traffic != nil {
		t.Fatalf("unconfigured traffic must be null: %#v", payload.Traffic)
	}
	if len(payload.Providers) != 0 || payload.Providers == nil {
		t.Fatalf("unconfigured providers = %#v", payload.Providers)
	}
	if len(payload.PartialErrors) == 0 {
		t.Fatal("unconfigured overview must explain the missing instance")
	}
}

func TestManagementOverviewAggregatesWithoutSecrets(t *testing.T) {
	const managementKey = "management-secret"
	const apiKey = "provider-secret"
	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+managementKey {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("X-CPA-Version", "7.1.2")
		switch request.URL.Path {
		case "/v0/management/config":
			_, _ = writer.Write([]byte(`{"api-keys":["management-client"],"codex-api-key":[{"api-key":"` + apiKey + `"}],"openai-compatibility":[{"name":"relay","api-key-entries":[{"api-key":"other-secret"},{"api-key":"third-secret"}]}]}`))
		case "/v0/management/auth-files":
			_, _ = writer.Write([]byte(`{"files":[{"id":"auth-1","auth_index":"a1","type":"gemini","provider":"gemini","status":"ok","success":100,"failed":40,"recent_requests":[{"time":"now","success":4,"failed":1}],"account_type":"oauth","email":"owner@example.test"}]}`))
		case "/v0/management/api-key-usage":
			_, _ = writer.Write([]byte(`{"codex":{"https://provider.test|` + apiKey + `":{"success":2,"failed":0,"recent_requests":[{"time":"now","success":2,"failed":0}]}}}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer cpaServer.Close()

	db, err := repository.Open(context.Background(), "file::memory:?cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte(managementKey))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID: "default", Name: "Test CPA", BaseURL: cpaServer.URL, UsageAddr: "",
		ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce,
		Status: "unknown", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	authManager, err := auth.New("management-secret", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{BasePath: "/omc", Version: "test-version", RequestTimeout: time.Second}, repo, cipher, nil, authManager)
	server := httptest.NewServer(handler.Router())
	defer server.Close()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	login, err := client.Post(server.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	if login.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d", login.StatusCode)
	}
	response, err := client.Get(server.URL + "/omc/api/v1/management/overview")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("overview status = %d", response.StatusCode)
	}
	var payload managementOverviewResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Status != "connected" || !payload.CPAConnected {
		t.Fatalf("connection status = %#v", payload)
	}
	if payload.CPAVersion != "7.1.2" {
		t.Fatalf("cpa_version = %q, want the X-CPA-Version header value", payload.CPAVersion)
	}
	if payload.CPAInstanceID != "default" || payload.CPAInstance != "Test CPA" || payload.CPABaseURL != cpaServer.URL {
		t.Fatalf("instance projection = %#v", payload)
	}
	if payload.OMCVersion != "test-version" {
		t.Fatalf("omc_version = %q", payload.OMCVersion)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("overview cache-control = %q", response.Header.Get("Cache-Control"))
	}
	if payload.Counts.ManagementKeys == nil || *payload.Counts.ManagementKeys != 1 {
		t.Fatalf("management key count = %#v", payload.Counts.ManagementKeys)
	}
	if payload.Counts.ProviderKeys == nil || *payload.Counts.ProviderKeys != 2 {
		t.Fatalf("provider key count = %#v", payload.Counts.ProviderKeys)
	}
	if payload.Counts.Credentials == nil || *payload.Counts.Credentials != 1 {
		t.Fatalf("credential count = %#v", payload.Counts.Credentials)
	}
	if payload.Traffic == nil || payload.Traffic.Total != 7 || payload.Traffic.TotalSuccess != 6 || payload.Traffic.TotalFailure != 1 {
		t.Fatalf("traffic = %#v", payload.Traffic)
	}
	if len(payload.Providers) != 2 {
		t.Fatalf("providers = %#v", payload.Providers)
	}
	serialized, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	text := string(serialized)
	for _, secret := range []string{managementKey, apiKey, "other-secret", "third-secret"} {
		if strings.Contains(text, secret) {
			t.Fatalf("overview contains secret %q: %s", secret, text)
		}
	}
}

func TestManagementOverviewPartialFailureAndNullCounts(t *testing.T) {
	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v0/management/config":
			writer.WriteHeader(http.StatusUnauthorized)
			_, _ = writer.Write([]byte(`{"error":"bad management key"}`))
		case "/v0/management/auth-files":
			_, _ = writer.Write([]byte(`{"files":[]}`))
		case "/v0/management/api-key-usage":
			writer.WriteHeader(http.StatusNotFound)
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer cpaServer.Close()

	db, err := repository.Open(context.Background(), "file::memory:?cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("key"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{ID: "default", Name: "Test", BaseURL: cpaServer.URL, ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	authManager, err := auth.New("management-secret", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{BasePath: "/omc", Version: "test", RequestTimeout: time.Second}, repo, cipher, nil, authManager)
	server := httptest.NewServer(handler.Router())
	defer server.Close()
	client := &http.Client{}
	login, err := client.Post(server.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	// Attach the session manually because this test does not use a cookie jar.
	request, err := http.NewRequest(http.MethodGet, server.URL+"/omc/api/v1/management/overview", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Cookie", login.Header.Get("Set-Cookie"))
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("overview status = %d", response.StatusCode)
	}
	var payload managementOverviewResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Status != "degraded" || !payload.CPAConnected {
		t.Fatalf("status = %#v", payload)
	}
	if payload.Counts.ManagementKeys != nil || payload.Counts.ProviderKeys != nil {
		t.Fatalf("failed config counts should be null: %#v", payload.Counts)
	}
	if len(payload.PartialErrors) != 2 {
		t.Fatalf("partial errors = %#v", payload.PartialErrors)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("overview cache-control = %q", response.Header.Get("Cache-Control"))
	}
	if payload.Traffic == nil {
		t.Fatal("traffic should remain available from successful auth-files endpoint")
	}
}
