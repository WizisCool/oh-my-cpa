package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/backup"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestDatabaseBackupHTTPPreviewConfirmationAndPrivacy(t *testing.T) {
	for _, base := range []string{"", "/omc"} {
		t.Run("base="+base, func(t *testing.T) {
			ctx := context.Background()
			directory := t.TempDir()
			databasePath := filepath.Join(directory, "omc.db")
			masterKey := "http-backup-test-master-key-0123456789"
			passphrase := "http backup recovery passphrase"
			cipher, err := appcrypto.New(masterKey)
			if err != nil {
				t.Fatal(err)
			}
			database, err := repository.Open(ctx, databasePath, repository.WithCipher(cipher))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := database.SQL.Exec(`INSERT INTO ui_preferences(pref_key,pref_value,updated_at_ms) VALUES('backup-http','original',1)`); err != nil {
				t.Fatal(err)
			}
			database.Close()
			passphraseFile := filepath.Join(directory, "passphrase")
			os.WriteFile(passphraseFile, []byte(passphrase), 0o600)
			artifact := filepath.Join(directory, "backup.omcbackup")
			if err := backup.RunCommand(ctx, databasePath, masterKey, "test", []string{"export", "--output", artifact, "--passphrase-file", passphraseFile}, io.Discard); err != nil {
				t.Fatal(err)
			}
			database, err = repository.Open(ctx, databasePath, repository.WithCipher(cipher))
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()
			manager, err := backup.NewManager(ctx, backup.Options{Database: database, DatabasePath: databasePath, Cipher: cipher, WrappingCipher: cipher, Version: "test"})
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close()
			authManager, err := auth.New("backup-management-secret", base, "")
			if err != nil {
				t.Fatal(err)
			}
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			handler := NewHandler(config.Config{BasePath: base}, repository.New(database), cipher, logger, authManager)
			handler.SetDatabaseBackups(manager)
			recorder := httptest.NewRecorder()
			handler.uploadDatabaseRestore(recorder, httptest.NewRequest(http.MethodPost, base+"/api/v1/management/system/database-restores", strings.NewReader("invalid multipart body")))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("invalid upload status: %d", recorder.Code)
			}
			decoder := json.NewDecoder(bytes.NewReader(logs.Bytes()))
			for range 2 {
				var entry struct {
					Level string `json:"level"`
					Error string `json:"error"`
				}
				if err := decoder.Decode(&entry); err != nil || entry.Level != "WARN" || entry.Error == "" {
					t.Fatalf("unavailable transfer deadline was not reported: %+v, %v", entry, err)
				}
			}
			server := httptest.NewServer(handler.Router())
			defer server.Close()
			client := signedInClient(t, server.URL+base+"/api/auth/login", "backup-management-secret")
			prefix := server.URL + base + "/api/v1/management/system"
			response, err := http.Get(prefix + "/database-backups")
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 401 {
				t.Fatalf("unauthenticated status: %d", response.StatusCode)
			}
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			writer.WriteField("passphrase", passphrase)
			part, _ := writer.CreateFormFile("file", "../../backup.omcbackup")
			content, _ := os.ReadFile(artifact)
			part.Write(content)
			writer.Close()
			request, _ := http.NewRequest(http.MethodPost, prefix+"/database-restores", &body)
			request.Header.Set("Content-Type", writer.FormDataContentType())
			request.Header.Set("Origin", server.URL)
			response, err = client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			payload, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != 201 {
				t.Fatalf("upload status %d: %s", response.StatusCode, payload)
			}
			for _, secret := range []string{masterKey, passphrase, "key_proof", "ciphertext", directory} {
				if bytes.Contains(payload, []byte(secret)) {
					t.Fatalf("preview leaked %q", secret)
				}
			}
			var job DatabaseBackupJobDTO
			if err := json.Unmarshal(payload, &job); err != nil {
				t.Fatal(err)
			}
			if job.State != "ready" || job.Kind != "import" || job.Digest == "" {
				t.Fatalf("preview: %+v", job)
			}
			if response, payload := doJSON(t, client, http.MethodPost, prefix+"/database-restores/"+job.ID+"/apply", `{"digest":"wrong"}`); response.StatusCode != 409 {
				t.Fatalf("confirmation status %d: %s", response.StatusCode, payload)
			}
			if _, err := database.SQL.Exec(`CREATE TRIGGER reject_http_backup_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`); err != nil {
				t.Fatal(err)
			}
			response, payload = doJSON(t, client, http.MethodPost, prefix+"/database-restores/"+job.ID+"/apply", `{"digest":"`+job.Digest+`"}`)
			if response.StatusCode != 503 || !strings.Contains(string(payload), "database_backup_audit") {
				t.Fatalf("audit refusal %d: %s", response.StatusCode, payload)
			}
			if _, err := database.SQL.Exec(`DROP TRIGGER reject_http_backup_audit`); err != nil {
				t.Fatal(err)
			}
			response, payload = doJSON(t, client, http.MethodPost, prefix+"/database-restores/"+job.ID+"/apply", `{"digest":"`+job.Digest+`"}`)
			if response.StatusCode != 202 || !bytes.Contains(payload, []byte(`"requires_restart":true`)) {
				t.Fatalf("apply status %d: %s", response.StatusCode, payload)
			}
			var value string
			database.SQL.QueryRow(`SELECT pref_value FROM ui_preferences WHERE pref_key='backup-http'`).Scan(&value)
			if value != "original" {
				t.Fatal("confirmation changed the running database")
			}
			response, payload = doJSON(t, client, http.MethodDelete, prefix+"/database-backup-jobs/"+job.ID, "")
			if response.StatusCode != 204 {
				t.Fatalf("cancel status %d: %s", response.StatusCode, payload)
			}
		})
	}
}
