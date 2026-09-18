package api

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

var dashboardDSNCounter atomic.Uint64

func dashboardMemoryDSN(purpose string) string {
	return fmt.Sprintf("file:memdb_%s_%d?mode=memory&cache=shared", purpose, dashboardDSNCounter.Add(1))
}

// startDashboardTestServer wires the real router over a fake CPA so dashboard
// and request-event endpoints are exercised exactly as the product runs them.
func startDashboardTestServer(t *testing.T, handler func(http.ResponseWriter, *http.Request), hooks ...func(*Handler)) (*http.Client, string, *repository.Repository) {
	t.Helper()
	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer management-secret-value" {
			writer.WriteHeader(http.StatusUnauthorized)
			_, _ = writer.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		if handler != nil {
			handler(writer, request)
			return
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(cpaServer.Close)

	// The cipher is created first so the repository can be opened with it. Caller
	// key identity is a keyed fingerprint, so a repository without the cipher
	// degrades every identity to the shared redaction marker and key aliases cannot
	// be exercised at all.
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	db, err := repository.Open(context.Background(), dashboardMemoryDSN("dashboard"), repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	ciphertext, nonce, err := cipher.Encrypt([]byte("management-secret-value"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID: "default", Name: "Test CPA", BaseURL: cpaServer.URL,
		ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	authManager, err := auth.New("management-secret-value", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	appHandler := NewHandler(config.Config{BasePath: "/omc", Version: "test", RequestTimeout: 5 * time.Second}, repo, cipher, nil, authManager)
	// Optional per-test wiring (e.g. attaching the pricing service) happens
	// before the router serves; it mirrors the app construction order.
	for _, hook := range hooks {
		hook(appHandler)
	}
	server := httptest.NewServer(appHandler.Router())
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	login, err := client.Post(server.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret-value"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	if login.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d", login.StatusCode)
	}
	return client, server.URL, repo
}

func getJSON(t *testing.T, client *http.Client, url string) (*http.Response, []byte) {
	t.Helper()
	response, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, payload
}

// seedEvents stores request records the way the pipeline would.
func seedEvents(t *testing.T, repo *repository.Repository, base time.Time, specs []repository.UsageDecoded) {
	t.Helper()
	if _, err := repo.InsertUsageEvents(context.Background(), decodeSpecs(specs)); err != nil {
		t.Fatal(err)
	}
}

func decodeSpecs(specs []repository.UsageDecoded) []usage.Event {
	events := make([]usage.Event, 0, len(specs))
	for _, spec := range specs {
		events = append(events, spec.Event)
	}
	return events
}

func eventFor(id string, at time.Time, tokens usage.TokenStats, failed bool) usage.Event {
	return usage.Event{
		InstanceID: "default", EventKey: id, RequestID: id, APIGroupKey: "sk-group",
		Model: "gemini-2.5-pro", AuthIndex: "auth-1", AuthType: "oauth",
		Provider: "gemini", Source: "client-a", TimestampMS: at.UnixMilli(),
		Failed: failed, Generate: true, LatencyMS: 250,
		InputTokens: tokens.InputTokens, OutputTokens: tokens.OutputTokens,
		ReasoningTokens: tokens.ReasoningTokens, CachedTokens: tokens.CachedTokens,
		CacheReadTokens: tokens.CacheReadTokens, CacheCreationTokens: tokens.CacheCreationTokens,
		TotalTokens: tokens.TotalTokens,
	}
}

func postJSON(t *testing.T, client *http.Client, url string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The router refuses a state-changing call without a same-origin header.
	request.Header.Set("Origin", strings.TrimSuffix(url, "/omc/api/v1/usage/ingest/refresh"))
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, payload
}
