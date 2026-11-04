package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/backup"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestBackupAuthorizationHTTPUsesPrivateSessionsAndMountAwareCallback(t *testing.T) {
	for _, base := range []string{"", "/omc"} {
		t.Run(base, func(t *testing.T) {
			ctx := context.Background()
			cipher, _ := appcrypto.New("oauth-http-fixture-master-0123456789abcdef")
			path := filepath.Join(t.TempDir(), "omc.db")
			database, err := repository.Open(ctx, path, repository.WithCipher(cipher))
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()
			manager, err := backup.NewManager(ctx, backup.Options{Database: database, DatabasePath: path, Cipher: cipher, WrappingCipher: cipher})
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close()
			authManager, _ := auth.New("oauth-http-fixture-management", base, "")
			var logs bytes.Buffer
			handler := NewHandler(config.Config{BasePath: base}, repository.New(database), cipher, slog.New(slog.NewJSONHandler(&logs, nil)), authManager)
			handler.SetDatabaseBackups(manager)
			server := httptest.NewServer(handler.Router())
			defer server.Close()
			client := signedInClient(t, server.URL+base+"/api/auth/login", "oauth-http-fixture-management")
			endpoint := server.URL + base + "/api/v1/management/system/database-backup-authorization"
			request := func(client *http.Client, method, endpoint string, input any, origin string) (int, []byte) {
				t.Helper()
				var body bytes.Buffer
				if input != nil {
					json.NewEncoder(&body).Encode(input)
				}
				req, _ := http.NewRequest(method, endpoint, &body)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", origin)
				response, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				content, _ := io.ReadAll(response.Body)
				return response.StatusCode, content
			}
			input := map[string]any{"provider": "drive", "client_id": "fixture-own-app", "client_secret": "fixture-private-client-secret", "automatic_callback": true}
			status, _ := request(http.DefaultClient, "POST", endpoint, input, server.URL)
			if status != 401 {
				t.Fatalf("unauthenticated start: %d", status)
			}
			status, _ = request(client, "POST", endpoint, input, "https://foreign.example")
			if status != 403 {
				t.Fatalf("foreign origin start: %d", status)
			}
			status, _ = request(client, "POST", endpoint, input, "")
			if status != 400 {
				t.Fatalf("automatic authorization without browser origin: %d", status)
			}
			status, body := request(client, "POST", endpoint, input, server.URL)
			if status != 201 {
				t.Fatalf("start: %d %s", status, body)
			}
			var view DatabaseBackupOAuthDTO
			if err := json.Unmarshal(body, &view); err != nil {
				t.Fatal(err)
			}
			target, _ := url.Parse(view.AuthorizationURL)
			if target.Query().Get("redirect_uri") != server.URL+base+"/api/auth/database-backup/callback" {
				t.Fatal("automatic callback lost console mount")
			}
			if strings.Contains(string(body), "fixture-private-client-secret") || strings.Contains(logs.String(), "fixture-private-client-secret") {
				t.Fatal("authorization secret exposed")
			}
			status, body = request(client, "GET", endpoint+"/"+view.ID, nil, server.URL)
			if status != 200 || bytes.Contains(body, []byte("authorization_url")) {
				t.Fatalf("status leaked authorization details: %d %s", status, body)
			}
			status, body = request(client, "POST", endpoint+"/"+view.ID+"/complete", map[string]string{"callback_url": "http://localhost/?state=wrong&code=not-a-real-code"}, server.URL)
			if status != 422 || !bytes.Contains(body, []byte("database_backup_oauth")) {
				t.Fatalf("callback validation: %d %s", status, body)
			}
			status, _ = request(http.DefaultClient, "GET", server.URL+base+"/api/auth/database-backup/callback?state=unregistered&code=not-a-real-code", nil, "")
			if status != 422 {
				t.Fatalf("unguarded callback: %d", status)
			}
			previousTransport := http.DefaultTransport
			tokenCalls := 0
			http.DefaultTransport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.URL.Host != "oauth2.googleapis.com" {
					return previousTransport.RoundTrip(request)
				}
				tokenCalls++
				if err := request.ParseForm(); err != nil {
					t.Error(err)
				}
				if request.Form.Get("code") != "fixture-approved-code" || request.Form.Get("code_verifier") == "" {
					t.Error("callback lost authorization code or PKCE")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"access_token":"server-only-http-access","refresh_token":"server-only-http-refresh","expires_in":3600,"token_type":"Bearer"}`)), Request: request}, nil
			})
			defer func() { http.DefaultTransport = previousTransport }()
			noRedirects := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			callback := server.URL + base + "/api/auth/database-backup/callback?" + url.Values{"state": {target.Query().Get("state")}, "code": {"fixture-approved-code"}}.Encode()
			status, body = request(noRedirects, "GET", callback, nil, "")
			if status != http.StatusSeeOther || tokenCalls != 1 {
				t.Fatalf("automatic callback: %d %s calls=%d", status, body, tokenCalls)
			}
			status, body = request(client, "GET", endpoint+"/"+view.ID, nil, server.URL)
			if status != 200 || !bytes.Contains(body, []byte(`"status":"connected"`)) || bytes.Contains(body, []byte("server-only-http")) {
				t.Fatalf("callback result: %d %s", status, body)
			}
			status, _ = request(noRedirects, "GET", callback, nil, "")
			if status != 422 || tokenCalls != 1 {
				t.Fatal("automatic callback replay reached provider")
			}
			status, _ = request(client, "DELETE", endpoint+"/"+view.ID, nil, server.URL)
			if status != 204 {
				t.Fatal("cancel failed")
			}
			status, _ = request(client, "GET", endpoint+"/"+view.ID, nil, server.URL)
			if status != 422 {
				t.Fatal("cancelled session remained readable")
			}
		})
	}
}
