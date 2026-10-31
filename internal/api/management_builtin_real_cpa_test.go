//go:build cpa_integration

package api

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Run in a fresh network namespace with loopback only. These explicit inputs
// point at disposable downloaded test artifacts, never an installed CPA service.
func TestBuiltinRealCPAInstallAndSourceMigration(t *testing.T) {
	binary, artifact := os.Getenv("OMCPA_TEST_CPA_BINARY"), os.Getenv("OMCPA_TEST_PLUGIN_ZIP")
	if binary == "" || artifact == "" {
		t.Fatal("set OMCPA_TEST_CPA_BINARY and OMCPA_TEST_PLUGIN_ZIP for this isolated integration test")
	}
	artifactBytes, err := os.ReadFile(artifact)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(artifactBytes)
	var downloads atomic.Int32
	artifactServer := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/omc-zcode-oauth.zip" {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
			t.Error("credentials sent to artifact source")
		}
		downloads.Add(1)
		writer.Header().Set("Content-Type", "application/zip")
		_, _ = writer.Write(artifactBytes)
	}))
	defer artifactServer.Close()
	directory := t.TempDir()
	trust := filepath.Join(directory, "fixture-ca.pem")
	if err := os.WriteFile(trust, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: artifactServer.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	cipher, err := appcrypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	dataDirectory := filepath.Join(directory, "omc-data")
	if err := os.MkdirAll(dataDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	databasePath := filepath.Join(dataDirectory, "oh-my-cpa.db")
	db, err := repository.Open(context.Background(), databasePath, repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)
	manager, err := auth.New("synthetic-integration-only", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{BasePath: "/omc", RequestTimeout: 30 * time.Second}, repo, cipher, nil, manager)
	omc := httptest.NewServer(handler.Router())
	defer omc.Close()
	handler.cfg.BuiltinRegistryOrigin = omc.URL
	sourceURL, _ := handler.builtinRegistryURL()
	handler.builtins.catalog = pluginregistry.NewCatalog(repo)
	manifest := pluginregistry.Manifest{SchemaVersion: 2, Plugins: []pluginregistry.Plugin{{ID: "omc-zcode-oauth", Name: "ZCode OAuth", Description: "Synthetic integration release", Author: "OMC", Version: "0.1.4", Repository: "https://github.com/WizisCool/omc-zcode-oauth", Install: pluginregistry.Install{Type: "direct", Artifacts: []pluginregistry.Artifact{{GOOS: runtime.GOOS, GOARCH: runtime.GOARCH, URL: artifactServer.URL + "/omc-zcode-oauth.zip", SHA256: hex.EncodeToString(digest[:]), Size: int64(len(artifactBytes))}}}}}}
	envelope, _ := json.Marshal(manifest)
	if err := handler.builtinCatalog().Accept(context.Background(), envelope); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	pluginDirectory := filepath.Join(directory, "plugins")
	if err := os.MkdirAll(pluginDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "config.yaml")
	raw := fmt.Sprintf(`config-version: 8
server:
  host: 127.0.0.1
  port: %d
  discovery:
    enabled: false
management:
  allow-remote: false
  secret-key: synthetic-integration-only
  disable-control-panel: true
  disable-auto-update-panel: true
access:
  api-keys: []
oauth:
  auth-dir: %s
plugins:
  enabled: true
  dir: %s
  store-sources:
    - %s
`, port, filepath.Join(directory, "auths"), pluginDirectory, sourceURL)
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "-config", path, "-local-model")
	command.Dir = directory
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + directory, "LANG=C.UTF-8", "TZ=UTC", "SSL_CERT_FILE=" + trust}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = command.Stdout
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	scanDone := make(chan struct{})
	var started atomic.Bool
	go func() {
		defer close(scanDone)
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "API server started successfully on:") {
				if started.CompareAndSwap(false, true) {
					close(ready)
				}
			}
		}
	}()
	stopped := make(chan error, 1)
	go func() { stopped <- command.Wait() }()
	defer func() {
		_ = command.Process.Signal(syscall.SIGTERM)
		select {
		case <-stopped:
		case <-time.After(10 * time.Second):
			_ = command.Process.Kill()
			<-stopped
		}
		<-scanDone
	}()
	select {
	case <-ready:
	case err := <-stopped:
		t.Fatalf("CPA exited before readiness: %v", err)
	case <-time.After(30 * time.Second):
		t.Fatal("CPA did not report listener readiness")
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("synthetic-integration-only"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{ID: "default", Name: "Isolated CPA", BaseURL: fmt.Sprintf("http://127.0.0.1:%d", port), ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	instance, err := repo.GetInstance(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	diagnosticClient, diagnosticErr := handler.clientForInstance(ctx, instance)
	if diagnosticErr != nil {
		t.Fatal(diagnosticErr)
	}
	beforeInstall, _ := diagnosticClient.StoredConfigYAML(ctx)
	if err := handler.runBuiltinReconcile(ctx, instance); err != nil {
		afterInstall, _ := diagnosticClient.StoredConfigYAML(ctx)
		evidenceDir := os.Getenv("OMCPA_TEST_EVIDENCE_DIR")
		if evidenceDir != "" {
			_ = os.MkdirAll(evidenceDir, 0700)
			_ = os.WriteFile(filepath.Join(evidenceDir, "before-install.yaml"), []byte(beforeInstall), 0600)
			_ = os.WriteFile(filepath.Join(evidenceDir, "after-install.yaml"), []byte(afterInstall), 0600)
		}
		t.Fatalf("real CPA installation: %v", err)
	}
	policy, err := repo.BuiltinPolicy(ctx, instance)
	if err != nil {
		t.Fatal(err)
	}
	outcome := policy.Operations["omc-zcode-oauth"]
	if outcome.State != "running" {
		t.Fatalf("real CPA runtime not confirmed: %+v", outcome)
	}
	if downloads.Load() != 1 {
		t.Fatalf("artifact downloads=%d", downloads.Load())
	}
	nativeClient, err := handler.clientForInstance(ctx, instance)
	if err != nil {
		t.Fatal(err)
	}
	native, err := nativeClient.PluginList(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var loaded bool
	for _, entry := range native.Plugins {
		if entry.ID == "omc-zcode-oauth" {
			loaded = entry.Registered && entry.EffectiveEnabled && entry.DisplayVersion() == "0.1.4"
		}
	}
	if !loaded {
		t.Fatal("native registration/version/effective enablement are not all true")
	}
	descriptor, err := nativeClient.PluginDescription(ctx, "omc-zcode-oauth")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pluginregistry.ParseDescription(descriptor, "omc-zcode-oauth", "0.1.4"); err != nil {
		t.Fatal(err)
	}
	backups, err := handler.configBackupStore().List(ctx)
	if err != nil || len(backups) == 0 {
		t.Fatalf("encrypted prewrite backups missing: %d %v", len(backups), err)
	}
	// Synthesize an equivalent old direct source record with exactly the same
	// approved version/artifact. Never modify the target version or uninstall.
	oldURL := legacyZCodeRegistryURLs[0]
	prefix := []string{"plugins", "configs", "omc-zcode-oauth", "store"}
	if err := nativeClient.ApplyConfigChanges(ctx, []management.ConfigChange{{Path: append(append([]string(nil), prefix...), "repository"), Value: "https://github.com/WizisCool/omc-zcode-oauth"}, {Path: append(append([]string(nil), prefix...), "source-id"), Value: pluginregistry.SourceID(oldURL)}, {Path: append(append([]string(nil), prefix...), "source-url"), Value: oldURL}, {Path: append(append([]string(nil), prefix...), "source-name"), Value: "raw.githubusercontent.com"}}); err != nil {
		t.Fatal(err)
	}
	before, err := nativeClient.ConfigYAML(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := handler.runBuiltinReconcile(ctx, instance); err != nil {
		t.Fatalf("real CPA source migration: %v", err)
	}
	after, err := nativeClient.ConfigYAML(ctx)
	if err != nil {
		t.Fatal(err)
	}
	normalize := strings.NewReplacer(pluginregistry.SourceID(oldURL), pluginregistry.SourceID(sourceURL), oldURL, sourceURL, "source-name: raw.githubusercontent.com", "source-name: Oh My CPA", `source-name: "raw.githubusercontent.com"`, `source-name: "Oh My CPA"`)
	if normalize.Replace(before) != after {
		evidenceDir := os.Getenv("OMCPA_TEST_EVIDENCE_DIR")
		if evidenceDir != "" {
			_ = os.WriteFile(filepath.Join(evidenceDir, "before-migration.yaml"), []byte(before), 0600)
			_ = os.WriteFile(filepath.Join(evidenceDir, "after-migration.yaml"), []byte(after), 0600)
		}
		t.Fatal("source migration changed fields beyond source id/url/name")
	}
	if downloads.Load() != 1 {
		t.Fatal("source migration downloaded or reinstalled the plugin")
	}
	records, err := readPluginInstallRecords(ctx, nativeClient)
	if err != nil {
		t.Fatal(err)
	}
	if records["omc-zcode-oauth"].Version != "0.1.4" || records["omc-zcode-oauth"].SourceURL != sourceURL {
		t.Fatalf("migrated provenance = %+v", records)
	}
	if err := handler.runBuiltinReconcile(ctx, instance); err != nil {
		t.Fatal(err)
	}
	if downloads.Load() != 1 {
		t.Fatal("converged reconciliation was not idempotent")
	}
	response, err := http.Get(omc.URL + "/omc" + pluginregistry.PublicRegistryPath)
	if err != nil {
		t.Fatal(err)
	}
	publicBytes, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || strings.Contains(string(publicBytes), "synthetic-integration-only") {
		t.Fatal("public registry is not a public-data-only snapshot")
	}
	t.Logf("real CPA evidence: runtime=registered/version=0.1.4/effective_enabled, direct_zip_sha256=%x, downloads=%d, descriptor_sha256=%x, encrypted_backups=%d, source_migration=three_fields_only, namespace=loopback_only", digest, downloads.Load(), sha256.Sum256(descriptor), len(backups))
	// A genuine OMC executable now reopens the same on-disk WAL database. The
	// process reads the persisted fixture snapshot. Join the prior reader before
	// reopening the same database.
	omc.Close()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(directory, "oh-my-cpa-fixture")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", executable, "./cmd/oh-my-cpa")
	_, sourceFile, _, _ := runtime.Caller(0)
	build.Dir = filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", ".."))
	build.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=sum.golang.org")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build isolated OMC: %v %s", err, output)
	}
	for _, state := range []string{"disabled"} {
		currentDB, err := repository.Open(context.Background(), databasePath, repository.WithCipher(cipher))
		if err != nil {
			t.Fatal(err)
		}
		currentRepo := repository.New(currentDB)
		currentInstance, err := currentRepo.GetInstance(context.Background(), "default")
		if err != nil {
			t.Fatal(err)
		}
		currentPolicy, err := currentRepo.BuiltinPolicy(context.Background(), currentInstance)
		if err != nil {
			t.Fatal(err)
		}
		override := repository.BuiltinPluginPolicy{State: state}
		if err := currentRepo.SaveBuiltinPolicy(context.Background(), currentInstance, currentPolicy, currentPolicy.Revision, "omc-zcode-oauth", &override); err != nil {
			t.Fatal(err)
		}
		currentDB.Close()
		for boot := 0; boot < 2; boot++ {
			runIsolatedOMCOverride(t, executable, dataDirectory, omc.URL, instance.BaseURL, state, downloads.Load())
			if downloads.Load() != 1 {
				t.Fatalf("OMC restart ignored %s override, downloads=%d", state, downloads.Load())
			}
		}
	}
	t.Log("real OMC process restart evidence: the per-plugin disabled switch persisted across two boots; approved snapshot remained ready; no additional artifact download or install")
	evidence := map[string]any{"artifact_sha256": hex.EncodeToString(digest[:]), "descriptor_sha256": fmt.Sprintf("%x", sha256.Sum256(descriptor)), "artifact_downloads": downloads.Load(), "runtime_registered": true, "runtime_version": "0.1.4", "runtime_effective_enabled": true, "migration": "three source fields only, no reinstall", "omc_process_restarts": 2, "persisted_overrides": []string{"disabled"}, "encrypted_prewrite_backups": len(backups), "network": "unshare network namespace; loopback only", "production_services_touched": false}
	if evidenceDir := os.Getenv("OMCPA_TEST_EVIDENCE_DIR"); evidenceDir != "" {
		_ = os.MkdirAll(evidenceDir, 0700)
		encoded, _ := json.MarshalIndent(evidence, "", "  ")
		if err := os.WriteFile(filepath.Join(evidenceDir, "evidence.json"), encoded, 0600); err != nil {
			t.Fatal(err)
		}
	}

}

func runIsolatedOMCOverride(t *testing.T, binary, dataDirectory, origin, cpaURL, state string, downloads int32) {
	t.Helper()
	address := strings.TrimPrefix(origin, "http://")
	command := exec.Command(binary)
	command.Dir = dataDirectory
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dataDirectory, "LANG=C.UTF-8", "TZ=UTC", "OMCPA_LISTEN_ADDR=" + address, "OMCPA_BASE_PATH=/omc", "OMCPA_DATA_DIR=" + dataDirectory, "OMCPA_CPA_BASE_URL=" + cpaURL, "OMCPA_CPA_MANAGEMENT_KEY=synthetic-integration-only", "OMCPA_MASTER_KEY=01234567890123456789012345678901", "OMCPA_BUILTIN_REGISTRY_ORIGIN=" + origin, "OMCPA_USAGE_INGEST_MODE=off", "OMCPA_UPDATE_CHECK_ENABLED=false", "OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=false", "OMCPA_UPDATER_ENABLED=false"}
	pipe, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = command.Stdout
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	reconciled := make(chan struct{})
	scanDone := make(chan struct{})
	var completed atomic.Bool
	go func() {
		defer close(scanDone)
		scanner := bufio.NewScanner(pipe)
		for scanner.Scan() {
			if (strings.Contains(scanner.Text(), "builtin reconciliation complete") || strings.Contains(scanner.Text(), "builtin reconciliation skipped: release refresh failed")) && completed.CompareAndSwap(false, true) {
				close(reconciled)
			}
		}
	}()
	stopped := make(chan error, 1)
	go func() { stopped <- command.Wait() }()
	defer func() {
		_ = command.Process.Signal(syscall.SIGTERM)
		select {
		case <-stopped:
		case <-time.After(15 * time.Second):
			_ = command.Process.Kill()
			<-stopped
		}
		<-scanDone
	}()
	select {
	case <-reconciled:
	case err := <-stopped:
		t.Fatalf("OMC exited during %s restart: %v", state, err)
	case <-time.After(45 * time.Second):
		t.Fatalf("OMC %s restart did not finish builtin reconciliation", state)
	}
	client := signedInClient(t, origin+"/omc/api/auth/login", "synthetic-integration-only")
	response, body := getJSON(t, client, origin+"/omc/api/v1/management/builtin-plugins")
	if response.StatusCode != 200 {
		t.Fatalf("restarted OMC state=%s status=%d %s", state, response.StatusCode, body)
	}
	var dto BuiltinPluginsDTO
	if err := json.Unmarshal(body, &dto); err != nil {
		t.Fatal(err)
	}
	if dto.Catalog.Status != "ready" || !dto.Policy.Enabled || len(dto.Plugins) != 1 || dto.Plugins[0].Policy.Enabled != (state != "disabled") {
		t.Fatalf("restart lost approved policy state=%s dto=%s", state, body)
	}
	_ = downloads
}
