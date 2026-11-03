package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/backup"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestDatabaseAutomationHTTPHidesSecretsAndPreservesBlankInputs(t *testing.T) {
	for _, base := range []string{"", "/omc"} {
		t.Run(base, func(t *testing.T) {
			ctx := context.Background()
			cipher, _ := appcrypto.New("automatic-backup-http-key-0123456789abcdef")
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
			authManager, _ := auth.New("automation-http-management-key", base, "")
			var logs bytes.Buffer
			handler := NewHandler(config.Config{BasePath: base}, repository.New(database), cipher, slog.New(slog.NewJSONHandler(&logs, nil)), authManager)
			handler.SetDatabaseBackups(manager)
			server := httptest.NewServer(handler.Router())
			defer server.Close()
			client := signedInClient(t, server.URL+base+"/api/auth/login", "automation-http-management-key")
			endpoint := server.URL + base + "/api/v1/management/system/database-backup-automation"
			response, err := http.Get(endpoint)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 401 {
				t.Fatal("automation settings allowed an unauthenticated read")
			}
			secrets := []string{"automatic backup secret passphrase", "webdav-secret-password", "oauth-test-refresh-value"}
			input := map[string]any{"enabled": true, "interval_hours": 24, "keep_local": 7, "keep_remote": 30, "passphrase": secrets[0], "destinations": []any{map[string]any{"id": "", "name": "Offsite", "provider": "webdav", "root": "backups", "options": map[string]string{"url": "https://example.invalid/dav", "user": "fixture", "pass": secrets[1], "bearer_token": secrets[2]}}}}
			request := func(method string, input any) (int, []byte) {
				t.Helper()
				var content bytes.Buffer
				if input != nil {
					json.NewEncoder(&content).Encode(input)
				}
				req, _ := http.NewRequest(method, endpoint, &content)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", server.URL)
				res, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				body, err := io.ReadAll(res.Body)
				if err != nil {
					t.Fatal(err)
				}
				for _, secret := range secrets {
					if bytes.Contains(body, []byte(secret)) || strings.Contains(logs.String(), secret) {
						t.Fatal("automation DTO or logs exposed a secret")
					}
				}
				if bytes.Contains(body, []byte(`"options"`)) || bytes.Contains(body, []byte(`"ciphertext"`)) {
					t.Fatal("ordinary automation response exposed configuration storage")
				}
				return res.StatusCode, body
			}
			status, body := request("PUT", input)
			if status != 200 {
				t.Fatalf("configure %d: %s", status, body)
			}
			var saved DatabaseBackupAutomationDTO
			if err := json.Unmarshal(body, &saved); err != nil || !saved.HasPassphrase || len(saved.Destinations) != 1 || !saved.Destinations[0].HasConfig || saved.NextRunAtMS == 0 {
				t.Fatalf("safe automation response: %+v %v", saved, err)
			}
			input["passphrase"] = ""
			input["destinations"] = []any{map[string]any{"id": saved.Destinations[0].ID, "name": "Offsite", "provider": "webdav", "root": "backups"}}
			status, body = request("PUT", input)
			if status != 200 {
				t.Fatalf("blank settings %d: %s", status, body)
			}
			stored, err := manager.Automation(ctx)
			if err != nil || stored.Passphrase != secrets[0] || stored.Destinations[0].Options["pass"] != secrets[1] {
				t.Fatal("blank inputs erased existing credentials")
			}
			if _, err := repository.New(database).ReadOnlyQuery(ctx, `SELECT * FROM database_backup_automation`, 1); err == nil {
				t.Fatal("read-only SQL exposed backup credentials")
			}
			input["destinations"] = []any{map[string]any{"id": saved.Destinations[0].ID, "name": "Offsite", "provider": "webdav", "root": "backups", "options": map[string]string{"bearer_token_command": "unsafe command"}}}
			status, _ = request("PUT", input)
			if status != 400 {
				t.Fatal("configuration accepted a command hook")
			}
		})
	}
}
