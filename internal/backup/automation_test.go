package backup

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	pkgsftp "github.com/pkg/sftp"
	"github.com/rclone/rclone/lib/oauthutil"
	"golang.org/x/crypto/ssh"
	"golang.org/x/net/webdav"
	"golang.org/x/oauth2"
)

func testWebDAV(t *testing.T) (string, string) {
	t.Helper()
	directory := t.TempDir()
	handler := &webdav.Handler{FileSystem: webdav.Dir(directory), LockSystem: webdav.NewMemLS()}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "backup-operator" || password != "cloud-backup-test-password" {
			w.WriteHeader(401)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	return server.URL, directory
}
func testAutomation(destination DestinationConfig) Automation {
	return Automation{Enabled: true, IntervalHours: 24, KeepLocal: 1, KeepRemote: 1, Passphrase: "automatic backup test passphrase", Destinations: []DestinationConfig{destination}}
}
func TestAutomaticBackupVerifiesRetentionAndDisasterRecoveryWithoutDatabase(t *testing.T) {
	ctx := context.Background()
	url, remoteDirectory := testWebDAV(t)
	manager, database := backupTestManager(t)
	config := DestinationConfig{ID: newID(), Name: "Disaster copy", Provider: "webdav", Root: "backups", Options: map[string]string{"url": url, "user": "backup-operator", "pass": "cloud-backup-test-password"}}
	settings := testAutomation(config)
	if err := manager.ConfigureAutomation(ctx, settings); err != nil {
		t.Fatal(err)
	}
	var ciphertext []byte
	if err := database.SQL.QueryRow(`SELECT ciphertext FROM database_backup_automation`).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{settings.Passphrase, config.Options["pass"]} {
		if bytes.Contains(ciphertext, []byte(secret)) {
			t.Fatal("automatic backup secret stored as plaintext")
		}
	}
	for index := range 2 {
		setBackupTestValue(t, database, fmt.Sprintf("snapshot-%d", index))
		job, err := manager.RunAutomatic()
		if err != nil {
			t.Fatal(err)
		}
		manager.workers.Wait()
		completed, err := manager.Get(job.ID)
		if err != nil || completed.State != "ready" {
			t.Fatalf("automatic backup: %+v %v", completed, err)
		}
		if index == 0 {
			foreign := fmt.Sprintf("omc-%s-%013d-%s.omcbackup", newID(), time.Now().UnixMilli(), newID())
			if err := os.WriteFile(filepath.Join(remoteDirectory, "backups", foreign), []byte("another installation"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(remoteDirectory, "backups", "unrelated.txt"), []byte("keep"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	local, err := manager.ListArchives(ctx, "")
	if err != nil || len(local) != 1 {
		t.Fatalf("local retention: %+v %v", local, err)
	}
	remote, err := manager.ListArchives(ctx, config.ID)
	if err != nil || len(remote) != 2 {
		t.Fatalf("remote retention or foreign backup: %+v %v", remote, err)
	}
	if _, err := os.Stat(filepath.Join(remoteDirectory, "backups", "unrelated.txt")); err != nil {
		t.Fatal("retention removed unrelated files")
	}
	state, err := manager.Automation(ctx)
	if err != nil || state.LastSuccessAtMS == 0 || state.LastError != "" {
		t.Fatalf("automatic outcome: %+v %v", state, err)
	}
	var profile bytes.Buffer
	if err := manager.WriteRecoveryProfile(ctx, &profile); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(profile.Bytes(), []byte(config.Options["pass"])) {
		t.Fatal("recovery profile exposed credentials")
	}
	if _, err := readRecoveryProfile(bytes.NewReader(profile.Bytes()), "wrong passphrase"); !errors.Is(err, ErrInvalidArtifact) {
		t.Fatalf("profile accepted wrong passphrase: %v", err)
	}
	recoveryDirectory := t.TempDir()
	profilePath := filepath.Join(recoveryDirectory, "omc.omcrecovery")
	passwordPath := filepath.Join(recoveryDirectory, "passphrase")
	os.WriteFile(profilePath, profile.Bytes(), 0o600)
	os.WriteFile(passwordPath, []byte(settings.Passphrase), 0o600)
	manager.Close()
	database.Close()
	if err := os.RemoveAll(filepath.Dir(manager.options.DatabasePath)); err != nil {
		t.Fatal(err)
	}
	missingDatabase := filepath.Join(recoveryDirectory, "nonexistent", "omc.db")
	var output bytes.Buffer
	if err := RunCommand(ctx, missingDatabase, "", "test", []string{"remote-list", "--profile", profilePath, "--passphrase-file", passwordPath, "--destination", config.ID}, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), local[0].Key) {
		t.Fatal("remote recovery did not list the retained backup")
	}
	if _, err := os.Stat(filepath.Dir(missingDatabase)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("remote recovery touched the target database directory")
	}
	archivePath := filepath.Join(recoveryDirectory, "retrieved.omcbackup")
	if err := RunCommand(ctx, missingDatabase, "", "test", []string{"fetch", "--profile", profilePath, "--passphrase-file", passwordPath, "--destination", config.ID, "--object", local[0].Key, "--output", archivePath}, &output); err != nil {
		t.Fatal(err)
	}
	targetMaster := "recovered-deployment-key-0123456789abcdef"
	if err := RunCommand(ctx, missingDatabase, targetMaster, "test", []string{"restore", "--file", archivePath, "--passphrase-file", passwordPath, "--confirm"}, &output); err != nil {
		t.Fatal(err)
	}
	wrapping, _ := appcrypto.New(targetMaster)
	cipher, err := ResolveCipher(missingDatabase, wrapping)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := repository.Open(ctx, missingDatabase, repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	if backupTestValue(t, recovered) != "snapshot-1" {
		t.Fatal("disaster restore lost retained data")
	}
	recoveredManager, err := NewManager(ctx, Options{Database: recovered, DatabasePath: missingDatabase, Cipher: cipher, WrappingCipher: wrapping})
	if err != nil {
		t.Fatal(err)
	}
	defer recoveredManager.Close()
	recoveredSettings, err := recoveredManager.Automation(ctx)
	if err != nil || recoveredSettings.Passphrase != settings.Passphrase || recoveredSettings.Destinations[0].Options["pass"] != config.Options["pass"] {
		t.Fatal("restored backup settings could not be decrypted")
	}
	if recoveredSettings.Enabled || recoveredSettings.NextRunAtMS != 0 || !validID(recoveredSettings.ID) || recoveredSettings.ID == state.ID {
		t.Fatal("restored schedule can run with the source retention namespace")
	}
	recoveredManager.codec.workFactor = 10
	if _, err := recoveredManager.RunAutomatic(); err != nil {
		t.Fatal(err)
	}
	recoveredManager.workers.Wait()
	if _, err := os.Stat(filepath.Join(remoteDirectory, "backups", local[0].Key)); err != nil {
		t.Fatal("recovery drill pruned the source installation backup")
	}

	for _, secret := range []string{settings.Passphrase, config.Options["pass"], targetMaster} {
		if strings.Contains(output.String(), secret) {
			t.Fatal("remote recovery command exposed a secret")
		}
	}
}

type failingDestination struct {
	uploads int
	deletes int
	fail    bool
	items   []ObjectRef
}

func (d *failingDestination) Probe(context.Context) error { return nil }
func (d *failingDestination) Put(_ context.Context, ref ObjectRef, _ ArtifactSource) (Receipt, error) {
	d.uploads++
	if d.fail {
		return Receipt{}, ErrDestinationFailed
	}
	d.items = append(d.items, ref)
	return Receipt{Object: ref}, nil
}
func (d *failingDestination) List(context.Context, string) (ObjectPage, error) {
	return ObjectPage{Items: d.items}, nil
}
func (d *failingDestination) Open(context.Context, ObjectRef) (io.ReadCloser, error) {
	return nil, ErrNotFound
}
func (d *failingDestination) Delete(_ context.Context, ref ObjectRef) error {
	d.deletes++
	for index, item := range d.items {
		if item.Key == ref.Key {
			d.items = append(d.items[:index], d.items[index+1:]...)
			break
		}
	}
	return nil
}
func (d *failingDestination) Capabilities() Capabilities { return Capabilities{} }
func (d *failingDestination) Close() error               { return nil }

func TestAutomaticBackupFailureKeepsLocalAndDoesNotPruneCloud(t *testing.T) {
	manager, database := backupTestManager(t)
	ctx := context.Background()
	destination := &failingDestination{}
	manager.options.DestinationFactory = func(context.Context, DestinationConfig, func(map[string]string) error) (Destination, error) {
		return destination, nil
	}
	settings := testAutomation(DestinationConfig{ID: newID(), Name: "Cloud", Provider: "drive", Root: "backups", Options: map[string]string{"token": "{}"}})
	if err := manager.ConfigureAutomation(ctx, settings); err != nil {
		t.Fatal(err)
	}
	for _, fail := range []bool{false, true} {
		destination.fail = fail
		if _, err := manager.RunAutomatic(); err != nil {
			t.Fatal(err)
		}
		manager.workers.Wait()
	}
	state, err := manager.Automation(ctx)
	if err != nil || state.LastSuccessAtMS == 0 || state.LastError == "" {
		t.Fatalf("failure status: %+v %v", state, err)
	}
	local, err := manager.ListArchives(ctx, "")
	if err != nil || len(local) != 1 || len(destination.items) != 1 || destination.deletes != 0 {
		t.Fatalf("failure discarded a recovery copy: local=%d cloud=%d deletes=%d err=%v", len(local), len(destination.items), destination.deletes, err)
	}
	// Credential refresh writes go through the same encrypted store and survive reload.
	configured, _ := manager.Automation(ctx)
	_, err = manager.destination(ctx, configured.Destinations[0])
	if err != nil {
		t.Fatal(err)
	}
	manager.options.DestinationFactory = func(_ context.Context, c DestinationConfig, persist func(map[string]string) error) (Destination, error) {
		mapper := &destinationMapper{values: maps.Clone(c.Options), persist: persist}
		if err := oauthutil.PutToken("test", mapper, &oauth2.Token{AccessToken: "rotated-test-token", RefreshToken: "rotated-refresh-token", Expiry: time.Now().Add(time.Hour)}, false); err != nil {
			return nil, err
		}
		if err := mapper.error(); err != nil {
			return nil, err
		}
		return destination, nil
	}
	if err := manager.ProbeDestination(ctx, settings.Destinations[0].ID); err != nil {
		t.Fatal(err)
	}
	configured, _ = manager.Automation(ctx)
	if !strings.Contains(configured.Destinations[0].Options["token"], "rotated-refresh-token") {
		t.Fatal("credential refresh was not persisted")
	}
	if _, err := database.SQL.Exec(`CREATE TRIGGER reject_credential_save BEFORE UPDATE ON database_backup_automation BEGIN SELECT RAISE(ABORT,'secret store unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	if err := manager.ProbeDestination(ctx, settings.Destinations[0].ID); !errors.Is(err, ErrCredentialPersistence) {
		t.Fatalf("credential persistence failure: %v", err)
	}
	if _, err := database.SQL.Exec(`DROP TRIGGER reject_credential_save`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.Exec(`CREATE TRIGGER reject_automatic_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	if err := manager.ConfigureAutomation(ctx, settings); !errors.Is(err, ErrAudit) {
		t.Fatalf("settings audit: %v", err)
	}
	if _, err := manager.RunAutomatic(); !errors.Is(err, ErrAudit) {
		t.Fatalf("run audit: %v", err)
	}
	if destination.uploads != 2 {
		t.Fatal("cloud delivery ran without audit admission")
	}
}

func TestAutomaticBackupCoalescesOverdueRunAfterRestart(t *testing.T) {
	ctx := context.Background()
	manager, _ := backupTestManager(t)
	settings := testAutomation(DestinationConfig{ID: newID(), Name: "Cloud", Provider: "webdav", Options: map[string]string{"url": "https://example.invalid"}})
	settings.Destinations = nil
	if err := manager.ConfigureAutomation(ctx, settings); err != nil {
		t.Fatal(err)
	}
	state, _ := manager.Automation(ctx)
	state.NextRunAtMS = time.Now().Add(-72 * time.Hour).UnixMilli()
	if err := manager.saveAutomation(ctx, state); err != nil {
		t.Fatal(err)
	}
	manager.Close()
	restarted, err := NewManager(ctx, manager.options)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	now := time.Now()
	job, err := restarted.runAutomatic(now, true)
	if err != nil || job.ID == "" {
		t.Fatalf("overdue run: %v", err)
	}
	if again, err := restarted.runAutomatic(now, true); err != nil || again.ID != "" {
		t.Fatalf("downtime replayed several backups: %+v %v", again, err)
	}
	restarted.workers.Wait()
	state, _ = restarted.Automation(ctx)
	if state.NextRunAtMS != now.Add(24*time.Hour).UnixMilli() {
		t.Fatal("next due time was not persisted")
	}
}

func TestRcloneDestinationRejectsCommandsAndCancelsTransfer(t *testing.T) {
	config := DestinationConfig{ID: newID(), Name: "Remote", Provider: "webdav", Options: map[string]string{"bearer_token_command": "untrusted command"}}
	if _, err := newRcloneDestination(context.Background(), config, nil); !errors.Is(err, ErrDestinationConfig) {
		t.Fatalf("command hook accepted: %v", err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			// Consume the request like a real upload endpoint so net/http can
			// observe the client disconnect while we delay its response.
			io.Copy(io.Discard, r.Body)
			close(started)
			select {
			case <-r.Context().Done():
			case <-release:
			}
			return
		}
		if r.Method == "MKCOL" {
			w.WriteHeader(201)
			return
		}
		w.WriteHeader(404)
	}))
	defer server.Close()
	defer close(release)
	config.Options = map[string]string{"url": server.URL}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	destination, err := newRcloneDestination(ctx, config, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	path := filepath.Join(t.TempDir(), "encrypted-fixture")
	os.WriteFile(path, []byte("synthetic encrypted transport fixture"), 0o600)
	digest, size, err := fileDigest(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := destination.Put(ctx, ObjectRef{Key: fmt.Sprintf("omc-%s-%013d-%s.omcbackup", newID(), time.Now().UnixMilli(), newID())}, artifactFile{path, size, digest})
		result <- err
	}()
	select {
	case <-started:
		cancel()
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not reach the server")
	}
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("transfer ignored cancellation")
	}
}

func TestRcloneDestinationRejectsCorruptedReadback(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	handler := &webdav.Handler{FileSystem: webdav.Dir(directory), LockSystem: webdav.NewMemLS()}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
		if r.Method == "PUT" {
			path := filepath.Join(directory, filepath.Base(r.URL.Path))
			content, err := os.ReadFile(path)
			if err != nil || len(content) == 0 {
				return
			}
			content[0] ^= 0xff
			os.WriteFile(path, content, 0o600)
		}
	}))
	defer server.Close()
	destination, err := newRcloneDestination(ctx, DestinationConfig{ID: newID(), Name: "Readback", Provider: "webdav", Options: map[string]string{"url": server.URL}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	path := filepath.Join(t.TempDir(), "encrypted-fixture")
	os.WriteFile(path, []byte("synthetic encrypted backup transport fixture"), 0o600)
	digest, size, err := fileDigest(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	key := fmt.Sprintf("omc-%s-%013d-%s.omcbackup", newID(), time.Now().UnixMilli(), newID())
	if _, err := destination.Put(ctx, ObjectRef{Key: key}, artifactFile{path, size, digest}); !errors.Is(err, ErrInvalidArtifact) {
		t.Fatalf("corrupted remote readback accepted: %v", err)
	}
}

func TestRcloneSFTPTransfersWithoutShellAndChecksHostKey(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{PasswordCallback: func(_ ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
		if string(password) != "sftp-synthetic-password" {
			return nil, errors.New("invalid test password")
		}
		return nil, nil
	}}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var shellRequests atomic.Int32
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				connection, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					return
				}
				defer connection.Close()
				go ssh.DiscardRequests(requests)
				for incoming := range channels {
					if incoming.ChannelType() != "session" {
						incoming.Reject(ssh.UnknownChannelType, "unsupported")
						continue
					}
					channel, requests, err := incoming.Accept()
					if err != nil {
						return
					}
					go func() {
						defer channel.Close()
						for request := range requests {
							if request.Type == "exec" {
								shellRequests.Add(1)
								request.Reply(false, nil)
								continue
							}
							var subsystem struct{ Name string }
							if request.Type != "subsystem" || ssh.Unmarshal(request.Payload, &subsystem) != nil || subsystem.Name != "sftp" {
								request.Reply(false, nil)
								continue
							}
							server, err := pkgsftp.NewServer(channel)
							if err != nil {
								request.Reply(false, nil)
								return
							}
							request.Reply(true, nil)
							server.Serve()
							server.Close()
							return
						}
					}()
				}
			}()
		}
	}()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	destinationConfig := DestinationConfig{ID: newID(), Name: "SFTP", Provider: "sftp", Root: t.TempDir(), Options: map[string]string{"host": host, "port": port, "user": "fixture", "pass": "sftp-synthetic-password", "host_keys": strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))}}
	destination, err := newRcloneDestination(context.Background(), destinationConfig, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	path := filepath.Join(t.TempDir(), "encrypted-fixture")
	os.WriteFile(path, []byte("synthetic encrypted sftp transport fixture"), 0o600)
	digest, size, _ := fileDigest(context.Background(), path)
	key := fmt.Sprintf("omc-%s-%013d-%s.omcbackup", newID(), time.Now().UnixMilli(), newID())
	if _, err := destination.Put(context.Background(), ObjectRef{Key: key}, artifactFile{path, size, digest}); err != nil {
		t.Fatal(err)
	}
	if shellRequests.Load() != 0 {
		t.Fatal("SFTP attempted a remote shell command")
	}
	_, otherPrivate, _ := ed25519.GenerateKey(rand.Reader)
	otherSigner, _ := ssh.NewSignerFromKey(otherPrivate)
	destinationConfig.Options["host_keys"] = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(otherSigner.PublicKey())))
	if other, err := newRcloneDestination(context.Background(), destinationConfig, nil); err == nil {
		other.Close()
		t.Fatal("SFTP accepted an untrusted server host key")
	}
}
