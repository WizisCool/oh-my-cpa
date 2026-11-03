package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

func TestCloudAuthorizationExchangesCodeAndKeepsTokensOnServer(t *testing.T) {
	for _, provider := range []string{"drive", "onedrive"} {
		t.Run(provider, func(t *testing.T) {
			manager, database := backupTestManager(t)
			tokenCalls := 0
			tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				tokenCalls++
				if err := r.ParseForm(); err != nil {
					t.Error(err)
				}
				if r.Form.Get("code") != "one-time-code" || r.Form.Get("code_verifier") == "" {
					t.Error("code exchange omitted authorization code or PKCE")
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"access_token":"server-only-access","refresh_token":"server-only-refresh","expires_in":3600,"token_type":"Bearer"}`)
			}))
			defer tokenServer.Close()
			manager.oauth.config = func(_ context.Context, input OAuthStart) (*oauth2.Config, error) {
				return &oauth2.Config{ClientID: "fixture-app", ClientSecret: "server-only-client-secret", Endpoint: oauth2.Endpoint{AuthURL: "https://provider.example/authorize", TokenURL: tokenServer.URL, AuthStyle: oauth2.AuthStyleInParams}, RedirectURL: "http://localhost:53682/", Scopes: []string{"files"}}, nil
			}
			manager.oauth.drive = func(_ context.Context, _ *oauth2.Config, token *oauth2.Token) (string, string, error) {
				if token.AccessToken != "server-only-access" {
					t.Error("lookup lost authorization token")
				}
				return "detected-drive", "personal", nil
			}
			ctx := context.Background()
			started, err := manager.StartOAuth(ctx, OAuthStart{Provider: provider})
			if err != nil {
				t.Fatal(err)
			}
			authURL, _ := url.Parse(started.AuthorizationURL)
			if authURL.Query().Get("code_challenge_method") != "S256" || authURL.Query().Get("state") == "" {
				t.Fatal("authorization did not use state and PKCE")
			}
			status, err := manager.OAuthStatus(started.ID)
			if err != nil || status.Status != "waiting" || status.AuthorizationURL != "" {
				t.Fatalf("public status: %+v %v", status, err)
			}
			callback := &url.URL{Scheme: "http", Host: "localhost:53682", Path: "/", RawQuery: url.Values{"state": {authURL.Query().Get("state")}, "code": {"one-time-code"}}.Encode()}
			wrong := *callback
			wrong.Host = "other.example"
			if err := manager.CompleteOAuth(ctx, started.ID, wrong.String()); !errors.Is(err, ErrOAuth) {
				t.Fatal("foreign callback accepted")
			}
			wrong = *callback
			wrong.RawQuery = "state=wrong&code=one-time-code"
			if err := manager.CompleteOAuth(ctx, started.ID, wrong.String()); !errors.Is(err, ErrOAuth) {
				t.Fatal("wrong state accepted")
			}
			if tokenCalls != 0 {
				t.Fatal("invalid callback reached provider")
			}
			if err := manager.CompleteOAuth(ctx, started.ID, callback.String()); err != nil {
				t.Fatal(err)
			}
			if err := manager.CompleteOAuth(ctx, started.ID, callback.String()); !errors.Is(err, ErrOAuth) {
				t.Fatal("authorization code replay accepted")
			}
			status, err = manager.OAuthStatus(started.ID)
			if err != nil || status.Status != "connected" {
				t.Fatalf("connection status: %+v %v", status, err)
			}
			encoded, _ := json.Marshal(status)
			for _, secret := range []string{"server-only-access", "server-only-refresh", "server-only-client-secret", "one-time-code"} {
				if strings.Contains(string(encoded), secret) {
					t.Fatal("credential leaked through status")
				}
			}
			settings := testAutomation(DestinationConfig{Name: "Authorized cloud", Provider: provider, Root: "OMC Backups", AuthorizationID: started.ID})
			if err := manager.ConfigureAutomation(ctx, settings); err != nil {
				t.Fatal(err)
			}
			saved, err := manager.Automation(ctx)
			if err != nil {
				t.Fatal(err)
			}
			destination := saved.Destinations[0]
			if destination.AuthorizationID != "" || !strings.Contains(destination.Options["token"], "server-only-refresh") {
				t.Fatal("authorization was not consumed into encrypted configuration")
			}
			if provider == "onedrive" && destination.Options["drive_id"] != "detected-drive" {
				t.Fatal("drive discovery not saved")
			}
			if _, err := manager.OAuthStatus(started.ID); !errors.Is(err, ErrOAuth) {
				t.Fatal("saved session retained")
			}
			var ciphertext []byte
			if err := database.SQL.QueryRow(`SELECT ciphertext FROM database_backup_automation`).Scan(&ciphertext); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(ciphertext), "server-only-refresh") {
				t.Fatal("token persisted in plaintext")
			}
		})
	}
}
func TestCloudAuthorizationExpiresCancelsAndRequiresAudit(t *testing.T) {
	manager, database := backupTestManager(t)
	ctx := context.Background()
	value, err := manager.StartOAuth(ctx, OAuthStart{Provider: "drive"})
	if err != nil {
		t.Fatal(err)
	}
	manager.oauth.mutex.Lock()
	manager.oauth.sessions[value.ID].ExpiresAtMS = time.Now().Add(-time.Second).UnixMilli()
	manager.oauth.mutex.Unlock()
	if _, err := manager.OAuthStatus(value.ID); !errors.Is(err, ErrOAuth) {
		t.Fatal("expired session accepted")
	}
	value, err = manager.StartOAuth(ctx, OAuthStart{Provider: "onedrive"})
	if err != nil {
		t.Fatal(err)
	}
	manager.CancelOAuth(value.ID)
	if _, err := manager.OAuthStatus(value.ID); !errors.Is(err, ErrOAuth) {
		t.Fatal("cancelled session accepted")
	}
	if _, err := manager.StartOAuth(ctx, OAuthStart{Provider: "webdav"}); !errors.Is(err, ErrDestinationConfig) {
		t.Fatal("unsupported provider authorized")
	}
	if _, err := manager.StartOAuth(ctx, OAuthStart{Provider: "drive", RedirectURL: "https://omc.example/callback"}); !errors.Is(err, ErrDestinationConfig) {
		t.Fatal("shared app accepted an unregistered callback")
	}
	if _, err := database.SQL.Exec(`CREATE TRIGGER reject_oauth_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.StartOAuth(ctx, OAuthStart{Provider: "drive"}); !errors.Is(err, ErrAudit) {
		t.Fatal("authorization started without audit")
	}
}
func TestProviderOAuthConfigurationUsesRegisteredIdentityAndScopedAccess(t *testing.T) {
	for _, provider := range []string{"drive", "onedrive"} {
		config, err := providerOAuthConfig(context.Background(), OAuthStart{Provider: provider})
		if err != nil {
			t.Fatal(err)
		}
		if config.ClientID == "" || config.Endpoint.AuthURL == "" || config.Endpoint.TokenURL == "" {
			t.Fatal("backend authorization configuration incomplete")
		}
		custom, err := providerOAuthConfig(context.Background(), OAuthStart{Provider: provider, ClientID: "own-app", ClientSecret: "own-secret", RedirectURL: "https://omc.example/omc/api/auth/database-backup/callback"})
		if err != nil {
			t.Fatal(err)
		}
		if custom.ClientID != "own-app" || custom.RedirectURL != "https://omc.example/omc/api/auth/database-backup/callback" {
			t.Fatal("custom authorization configuration not applied")
		}
	}
}

type oauthRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn oauthRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestOneDriveAuthorizationDiscoversDefaultDriveWithoutExposingToken(t *testing.T) {
	for _, body := range []string{`{"id":"default-drive","driveType":"personal"}`, `{"id":"default-drive","driveType":"business"}`, `{"id":"default-drive","driveType":"documentLibrary"}`, `{"driveType":"personal"}`, `{"id":"default-drive","driveType":"other"}`} {
		client := &http.Client{Transport: oauthRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.String() != "https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType" || request.Header.Get("Authorization") != "Bearer private-fixture-token" {
				t.Error("drive discovery used unexpected endpoint or credential")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
		})}
		ctx := context.WithValue(context.Background(), oauth2.HTTPClient, client)
		id, kind, err := lookupOneDrive(ctx, &oauth2.Config{}, &oauth2.Token{AccessToken: "private-fixture-token", Expiry: time.Now().Add(time.Hour)})
		if strings.Contains(body, `"id":`) && !strings.Contains(body, `"other"`) {
			if err != nil || id != "default-drive" || kind == "" {
				t.Fatalf("default drive not discovered: %v", err)
			}
		} else if !errors.Is(err, ErrOAuth) {
			t.Fatal("invalid drive descriptor accepted")
		}
	}
}

func TestFailedAutomaticAuthorizationStopsWaitingAndKeepsItsError(t *testing.T) {
	for _, failure := range []string{"audit", "exchange", "drive"} {
		t.Run(failure, func(t *testing.T) {
			ctx := context.Background()
			manager, database := backupTestManager(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if failure == "exchange" {
					w.WriteHeader(400)
					fmt.Fprint(w, `{"error":"invalid_grant"}`)
					return
				}
				fmt.Fprint(w, `{"access_token":"private-access","refresh_token":"private-refresh","token_type":"Bearer","expires_in":3600}`)
			}))
			defer server.Close()
			manager.oauth.config = func(context.Context, OAuthStart) (*oauth2.Config, error) {
				return &oauth2.Config{ClientID: "fixture", RedirectURL: "https://console.example/callback", Endpoint: oauth2.Endpoint{AuthURL: "https://provider.example/authorize", TokenURL: server.URL, AuthStyle: oauth2.AuthStyleInParams}}, nil
			}
			manager.oauth.drive = func(context.Context, *oauth2.Config, *oauth2.Token) (string, string, error) {
				return "", "", ErrDestinationFailed
			}
			started, err := manager.StartOAuth(ctx, OAuthStart{Provider: "onedrive"})
			if err != nil {
				t.Fatal(err)
			}
			target, _ := url.Parse(started.AuthorizationURL)
			if failure == "audit" {
				if _, err := database.SQL.Exec(`CREATE TRIGGER reject_completion_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`); err != nil {
					t.Fatal(err)
				}
			}
			err = manager.OAuthCallback(ctx, target.Query().Get("state"), "fixture-code", "")
			expected := ErrOAuth
			if failure == "audit" {
				expected = ErrAudit
			}
			if !errors.Is(err, expected) {
				t.Fatalf("callback failure lost error classification: %v", err)
			}
			status, err := manager.OAuthStatus(started.ID)
			if err != nil || status.Status != "denied" {
				t.Fatalf("failed callback kept waiting: %+v %v", status, err)
			}
		})
	}
}
