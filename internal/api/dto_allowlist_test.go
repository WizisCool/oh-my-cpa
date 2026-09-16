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
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/discovery"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func TestBrowserDTOAllowlistAndSecretExclusion(t *testing.T) {
	fixtureSecrets := []string{
		"sk-super-secret-key-12345678",
		"sk-auth-file-account-secret",
		"super-secret-user:super-secret-pass",
		"secret-bearer-token-12345678",
		"secret-query-param=confidential",
	}

	fakeCPA := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		path := request.URL.Path
		switch {
		case strings.HasPrefix(path, "/v0/management/auth-files"):
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{
				"files": [{
					"id": "af-1",
					"auth_index": "idx-1",
					"name": "openai-1.json",
					"provider": "openai",
					"email": "user@example.test",
					"account_type": "api_key",
					"account": "sk-auth-file-account-secret",
					"token": "secret-bearer-token-12345678",
					"raw_content": "{\"secret\":\"secret-bearer-token-12345678\"}",
					"path": "/etc/secrets/openai-1.json",
					"metadata": {"token": "secret-bearer-token-12345678"},
					"status": "ready"
				}]
			}`))
		case strings.HasPrefix(path, "/v0/management/config"):
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{
				"config": {
					"debug": false,
					"request_log": true,
					"proxy_url": "https://super-secret-user:super-secret-pass@proxy.example.test:8080?secret-query-param=confidential"
				}
			}`))
		default:
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(fakeCPA.Close)

	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_dto_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}

	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-management-secret"))
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

	// Insert resource discovered from auth file with secret account
	discoverer := discovery.NewDiscoverer(cipher)
	cpaClient, err := management.NewClient(fakeCPA.URL, "cpa-management-secret", 5*time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	resources, _, err := discoverer.Discover(context.Background(), cpaClient, "default")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.UpsertDiscoveredResources(context.Background(), "default", resources, now, true); err != nil {
		t.Fatal(err)
	}

	// Insert usage event with potential secret
	eventID, err := repo.InsertUsageEvents(context.Background(), []usage.Event{{
		InstanceID:    "default",
		EventKey:      "req-1",
		RequestID:     "req-1",
		APIGroupKey:   "sk-super-secret-key-12345678",
		APIGroupLabel: "api_key",
		Provider:      "openai",
		Endpoint:      "https://super-secret-user:super-secret-pass@example.test/v1?token=secret#frag",
		AuthType:      "apikey",
		TimestampMS:   time.Now().UnixMilli(),
		Source:        "sk-super-secret-key-12345678",
		AuthIndex:     "idx-1",
		Model:         "gpt-4",
		InputTokens:   10,
		OutputTokens:  10,
		TotalTokens:   20,
	}})
	if err != nil {
		t.Fatal(err)
	}

	// Insert correlated error event
	if err := repo.InsertErrorEvent(context.Background(), usage.ErrorEvent{
		InstanceID:  "default",
		EventKey:    "err-1",
		AuthIndex:   "idx-1",
		StatusCode:  400,
		Body:        "invalid key sk-super-secret-key-12345678 in header Authorization: Bearer secret-bearer-token-12345678",
		TimestampMS: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}

	authManager, err := auth.New("app-admin-secret", "", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{BasePath: "", Version: "v0.1.0-test", CPA: config.CPAConfig{BaseURL: fakeCPA.URL, ManagementKey: "app-admin-secret"}}, repo, cipher, nil, authManager)
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
	loginResp.Body.Close()

	// Endpoints to check
	endpoints := []string{
		"/api/healthz",
		"/api/v1/resources",
		"/api/v1/management/auth-files",
		"/api/v1/management/auth-files/model-aliases",
		"/api/v1/management/config",
		"/api/v1/usage/events",
		fmt.Sprintf("/api/v1/usage/events/%d", eventID),
		"/api/v1/management/dashboard?preset=1h",
		// The per-model breakdown. It is a window over stored request history like the dashboard, so it
		// must clear the same secret-leakage assertions.
		"/api/v1/management/dashboard/models?preset=1h",
	}

	for _, endpoint := range endpoints {
		resp, err := client.Get(appServer.URL + endpoint)
		if err != nil {
			t.Fatalf("GET %s failed: %v", endpoint, err)
		}
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		resp.Body.Close()
		bodyText := buf.String()

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d, body = %s", endpoint, resp.StatusCode, bodyText)
		}

		for _, secret := range fixtureSecrets {
			if strings.Contains(bodyText, secret) {
				t.Fatalf("endpoint %s exposed fixture secret %q in body: %s", endpoint, secret, bodyText)
			}
		}

		// Specifically verify DTO shape for /management/auth-files:
		// Account, path, token, metadata, and raw_content must NOT be present as JSON keys
		if endpoint == "/api/v1/management/auth-files" {
			var parsed struct {
				Files []map[string]any `json:"files"`
			}
			if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
				t.Fatalf("parse auth-files: %v", err)
			}
			for _, file := range parsed.Files {
				for _, forbidden := range []string{"account", "path", "token", "metadata", "raw_content"} {
					if _, exists := file[forbidden]; exists {
						t.Fatalf("auth-files DTO exposed forbidden field %q: %#v", forbidden, file)
					}
				}
			}
		}

		// Specifically verify DTO shape for /resources:
		// Details must not expose raw account or sensitive fields
		if endpoint == "/api/v1/resources" {
			var parsed struct {
				Resources []map[string]any `json:"resources"`
			}
			if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
				t.Fatalf("parse resources: %v", err)
			}
			for _, res := range parsed.Resources {
				if details, ok := res["details"].(map[string]any); ok {
					if _, exists := details["account"]; exists {
						t.Fatalf("resources DTO details exposed account: %#v", details)
					}
					if extra, ok := details["extra"].(map[string]any); ok {
						if _, exists := extra["account"]; exists {
							t.Fatalf("resources DTO details.extra exposed account: %#v", extra)
						}
					}
				}
			}
		}
	}
}
