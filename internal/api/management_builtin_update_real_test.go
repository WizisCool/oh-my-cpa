//go:build cpa_integration

package api

import (
	"archive/zip"
	"bufio"
	"bytes"
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
	"sync"
	"syscall"
	"testing"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

const updateFixtureID = "omc-zcode-oauth"

// This builds a real OMC command once. A build overlay injects only the private
// ticker factory and a fixed-URL transport mirror; the production worker, verifier,
// public snapshot, backup, audit and native CPA installer remain the tested path.
func TestBuiltinRunningOMCFollowsStableReleaseWithoutHostUpgrade(t *testing.T) {
	cpaBinary := os.Getenv("OMCPA_TEST_CPA_BINARY")
	if cpaBinary == "" {
		t.Fatal("set OMCPA_TEST_CPA_BINARY; run in a loopback-only network namespace")
	}
	directory := t.TempDir()
	evidenceRoot := os.Getenv("OMCPA_TEST_EVIDENCE_DIR")
	if evidenceRoot != "" {
		if err := os.MkdirAll(evidenceRoot, 0700); err != nil {
			t.Fatal(err)
		}
		var err error
		directory, err = os.MkdirTemp(evidenceRoot, "worker-update-")
		if err != nil {
			t.Fatal(err)
		}
	}
	_, sourceFile, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", ".."))
	artifacts := map[string][]byte{}
	digests := map[string]string{}
	for _, version := range []string{"1.0.0", "1.0.1"} {
		library := filepath.Join(directory, updateFixtureID+"-"+version+".so")
		compile := exec.Command("cc", "-shared", "-fPIC", "-O2", `-DFIXTURE_VERSION="`+version+`"`, filepath.Join(root, "internal/api/testdata/builtin-update/plugin.c"), "-o", library)
		if output, err := compile.CombinedOutput(); err != nil {
			t.Fatalf("compile synthetic native fixture: %v %s", err, output)
		}
		raw, err := os.ReadFile(library)
		if err != nil {
			t.Fatal(err)
		}
		var archive bytes.Buffer
		writer := zip.NewWriter(&archive)
		entry, err := writer.Create(updateFixtureID + ".so")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(raw); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		artifacts[version] = archive.Bytes()
		sum := sha256.Sum256(archive.Bytes())
		digests[version] = hex.EncodeToString(sum[:])
		if err := os.WriteFile(filepath.Join(directory, version+"-synthetic.zip"), archive.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var mirrorMu sync.Mutex
	var approval []byte
	approvalStatus := 200
	refreshes := 0
	downloads := map[string]int{}
	mirror := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mirrorMu.Lock()
		defer mirrorMu.Unlock()
		if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
			t.Error("credentials reached public approval/artifact mirror")
		}
		if request.URL.Path == "/releases/latest" {
			refreshes++
			writer.WriteHeader(approvalStatus)
			_, _ = writer.Write(approval)
			return
		}
		version := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, "/artifact-"), ".zip")
		if raw, ok := artifacts[version]; ok {
			downloads[version]++
			writer.Header().Set("Content-Type", "application/zip")
			_, _ = writer.Write(raw)
			return
		}
		http.NotFound(writer, request)
	}))
	defer mirror.Close()
	trust := filepath.Join(directory, "fixture-ca.pem")
	if err := os.WriteFile(trust, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: mirror.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	release := func(version string) []byte {
		var snapshot pluginregistry.Manifest
		_ = json.Unmarshal(builtinSnapshot(t, version, digests[version]), &snapshot)
		for index := range snapshot.Plugins[0].Install.Artifacts {
			snapshot.Plugins[0].Install.Artifacts[index].Size = int64(len(artifacts[version]))
		}
		raw, _ := json.Marshal(snapshot)
		return builtinReleaseJSON(t, raw)
	}
	publish := func(raw []byte, status int) {
		mirrorMu.Lock()
		approval, approvalStatus = raw, status
		mirrorMu.Unlock()
	}
	publish(release("1.0.0"), 200)
	listen := func() (net.Listener, string) {
		t.Helper()
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		return listener, "http://" + listener.Addr().String()
	}
	cpaListener, cpaURL := listen()
	cpaPort := cpaListener.Addr().(*net.TCPAddr).Port
	cpaListener.Close()
	omcListener, omcURL := listen()
	omcAddress := omcListener.Addr().String()
	omcListener.Close()
	sourceURL := omcURL + "/omc" + pluginregistry.PublicRegistryPath
	configPath := filepath.Join(directory, "cpa.synthetic.yaml")
	cpaConfig := fmt.Sprintf("config-version: 8\nserver:\n  host: 127.0.0.1\n  port: %d\n  discovery:\n    enabled: false\nmanagement:\n  allow-remote: false\n  secret-key: synthetic-update-only\n  disable-control-panel: true\n  disable-auto-update-panel: true\naccess:\n  api-keys: []\noauth:\n  auth-dir: %s\nplugins:\n  enabled: true\n  dir: %s\n  store-sources:\n    - %s\n  store-auth:\n    - match: %s\n      type: none\n      apply-to: [registry]\n      allow-insecure: true\n", cpaPort, filepath.Join(directory, "auths"), filepath.Join(directory, "plugins"), sourceURL, sourceURL)
	if err := os.MkdirAll(filepath.Join(directory, "plugins"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte(cpaConfig), 0600); err != nil {
		t.Fatal(err)
	}
	cpaCycles := make(chan string, 32)
	stopCPA := startUpdateFixtureProcess(t, exec.Command(cpaBinary, "-config", configPath, "-local-model"), directory, trust, "cpa.log", cpaCycles)
	defer stopCPA()
	awaitUpdateFixtureEvent(t, cpaCycles, "API server started successfully on:")
	dataDir := filepath.Join(directory, "omc-data")
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		t.Fatal(err)
	}
	cipher, err := appcrypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	db, err := repository.Open(context.Background(), filepath.Join(dataDir, "oh-my-cpa.db"), repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	ciphertext, nonce, err := cipher.Encrypt([]byte("synthetic-update-only"))
	if err != nil {
		t.Fatal(err)
	}
	instance := domain.CPAInstance{ID: "default", BaseURL: cpaURL, ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := repo.UpsertInstance(context.Background(), instance); err != nil {
		t.Fatal(err)
	}
	instance, err = repo.GetInstance(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	clockPath := filepath.Join(directory, "worker-clock.fifo")
	if err := syscall.Mkfifo(clockPath, 0600); err != nil {
		t.Fatal(err)
	}
	overlayPath := buildUpdateFixtureOverlay(t, root, directory, mirror.URL, clockPath)
	executable := filepath.Join(directory, "oh-my-cpa-fixture")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-overlay", overlayPath, "-o", executable, "./cmd/oh-my-cpa")
	build.Dir = root
	build.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=sum.golang.org", "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fixed OMC fixture: %v %s", err, output)
	}
	binaryBefore := updateFixtureFileHash(t, executable)
	command := exec.Command(executable)
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + directory, "LANG=C.UTF-8", "TZ=UTC", "SSL_CERT_FILE=" + trust, "OMCPA_LISTEN_ADDR=" + omcAddress, "OMCPA_BASE_PATH=/omc", "OMCPA_VERSION=fixture-omc-unchanged", "OMCPA_DATA_DIR=" + dataDir, "OMCPA_CPA_BASE_URL=" + cpaURL, "OMCPA_CPA_MANAGEMENT_KEY=synthetic-update-only", "OMCPA_MASTER_KEY=01234567890123456789012345678901", "OMCPA_BUILTIN_REGISTRY_ORIGIN=" + omcURL, "OMCPA_USAGE_INGEST_MODE=off", "OMCPA_UPDATE_CHECK_ENABLED=false", "OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=false", "OMCPA_UPDATER_ENABLED=false"}
	omcConfig := strings.Join(command.Env, "\n")
	configHash := sha256.Sum256([]byte(omcConfig))
	if err := os.WriteFile(filepath.Join(directory, "omc.synthetic.env"), []byte(omcConfig), 0600); err != nil {
		t.Fatal(err)
	}
	events := make(chan string, 64)
	stopOMC := startUpdateFixtureProcess(t, command, directory, trust, "omc.log", events)
	defer stopOMC()
	pid := command.Process.Pid
	opened := make(chan *os.File, 1)
	go func() { file, _ := os.OpenFile(clockPath, os.O_WRONLY, 0600); opened <- file }()
	var clock *os.File
	select {
	case clock = <-opened:
	case <-time.After(30 * time.Second):
		t.Fatal("OMC did not attach its private fixture clock")
	}
	if clock == nil {
		t.Fatal("open fixture clock")
	}
	defer clock.Close()
	awaitUpdateFixtureEvent(t, events, "builtin reconciliation complete")
	client := signedInClient(t, omcURL+"/omc/api/auth/login", "synthetic-update-only")
	readHostVersion := func() string {
		t.Helper()
		response, body := getJSON(t, client, omcURL+"/omc/api/v1/management/system/updates")
		var dto SystemUpdatesDTO
		if err := json.Unmarshal(body, &dto); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK || dto.OMCVersion.RunningVersion != "fixture-omc-unchanged" {
			t.Fatalf("host version changed or unknown: %d %s", response.StatusCode, body)
		}
		return dto.OMCVersion.RunningVersion
	}
	hostVersionBefore := readHostVersion()
	processEnvironmentBefore := updateFixtureFileHash(t, fmt.Sprintf("/proc/%d/environ", pid))
	readState := func(version string) BuiltinPluginsDTO {
		t.Helper()
		response, body := getJSON(t, client, omcURL+"/omc/api/v1/management/builtin-plugins")
		var dto BuiltinPluginsDTO
		if err := json.Unmarshal(body, &dto); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 200 || !dto.Policy.Enabled || len(dto.Plugins) != 1 || dto.Plugins[0].RuntimeVersion != version || !dto.Plugins[0].Registered || !dto.Plugins[0].EffectiveEnabled || dto.Plugins[0].InstalledVersion != version {
			t.Fatalf("runtime version %s not confirmed: %d %s; logs in %s", version, response.StatusCode, body, directory)
		}
		return dto
	}
	initial := readState("1.0.0")
	tick := func(want string) {
		t.Helper()
		if _, err := io.WriteString(clock, "tick\n"); err != nil {
			t.Fatal(err)
		}
		awaitUpdateFixtureEvent(t, events, want)
	}
	// An unavailable or invalid release leaves the running plugin unchanged.
	publish(nil, 503)
	tick("builtin reconciliation skipped: release refresh failed")
	readState("1.0.0")
	bad := strings.ReplaceAll(string(release("1.0.1")), "sha256:"+digests["1.0.1"], "")
	publish([]byte(bad), 200)
	tick("builtin reconciliation skipped: release refresh failed")
	readState("1.0.0")
	publish(release("1.0.1"), 200)
	tick("builtin reconciliation complete")
	final := readState("1.0.1")
	if final.Policy != initial.Policy {
		t.Fatalf("auto update changed builtin switches: before=%+v after=%+v", initial.Policy, final.Policy)
	}
	publish(release("1.0.0"), 200)
	tick("builtin reconciliation skipped: release refresh failed")
	readState("1.0.1")
	publish(release("1.0.1"), 200)
	tick("builtin reconciliation complete")
	readState("1.0.1")
	if command.Process.Pid != pid || readHostVersion() != hostVersionBefore || updateFixtureFileHash(t, fmt.Sprintf("/proc/%d/exe", pid)) != binaryBefore || updateFixtureFileHash(t, executable) != binaryBefore || updateFixtureFileHash(t, fmt.Sprintf("/proc/%d/environ", pid)) != processEnvironmentBefore || updateFixtureFileHash(t, filepath.Join(directory, "omc.synthetic.env")) != fmt.Sprintf("%x", configHash) {
		t.Fatal("host executable, PID or configuration changed")
	}
	if err := command.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("same OMC process is not alive: %v", err)
	}
	mirrorMu.Lock()
	counts := map[string]int{}
	for key, value := range downloads {
		counts[key] = value
	}
	refreshCount := refreshes
	mirrorMu.Unlock()
	if counts["1.0.0"] != 1 || counts["1.0.1"] != 1 || len(counts) != 2 || refreshCount != 6 {
		t.Fatalf("wrong artifact identities or blind repeats: downloads=%v refreshes=%d", counts, refreshCount)
	}
	evidence := map[string]any{"fixture_only": true, "not_a_published_zcode_release": true, "omc_executable_sha256": binaryBefore, "omc_pid_before": pid, "omc_pid_after": command.Process.Pid, "omc_config_sha256": fmt.Sprintf("%x", configHash), "omc_process_environment_sha256": processEnvironmentBefore, "omc_version": "fixture-omc-unchanged", "omc_builds": 1, "omc_restarts": 0, "policy_writes": 0, "policy_before": initial.Policy, "policy_after": final.Policy, "initial_snapshot": initial.Catalog.Revision, "final_snapshot": final.Catalog.Revision, "initial_runtime_version": "1.0.0", "final_runtime_version": "1.0.1", "registered": true, "effective_enabled": true, "artifact_sha256": digests, "artifact_downloads": counts, "release_checks": refreshCount, "trigger": "startup then controlled ticks through the production release-check branch", "refused_refreshes": []string{"HTTP503", "missing checksum", "older stable version"}, "network": "loopback-only namespace", "production_services_touched": false, "fixture_directory": directory}
	encoded, _ := json.MarshalIndent(evidence, "", "  ")
	if err := os.WriteFile(filepath.Join(directory, "evidence.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	if evidenceRoot != "" {
		if err := os.WriteFile(filepath.Join(evidenceRoot, "worker-update-evidence.json"), encoded, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("same OMC pid=%d sha=%s: stable release 1.0.0 -> 1.0.1; exact digest downloads=%v; default-on policy unchanged; evidence=%s", pid, binaryBefore, counts, directory)
}

func buildUpdateFixtureOverlay(t *testing.T, root, directory, mirror, clock string) string {
	t.Helper()
	target := filepath.Join(directory, ".build-overlay")
	if err := os.MkdirAll(target, 0700); err != nil {
		t.Fatal(err)
	}
	handlerPath := filepath.Join(root, "internal/api/handler.go")
	raw, err := os.ReadFile(handlerPath)
	if err != nil {
		t.Fatal(err)
	}
	handler := string(raw)
	handler = strings.Replace(handler, "import (", "import (\n\"bufio\"\n\"os\"", 1)
	handler = strings.Replace(handler, "builtins:           builtinRuntime{catalog: pluginregistry.NewCatalog(repo), queue: make(chan domain.CPAInstance, 16)},", "builtins: builtinRuntime{catalog: pluginregistry.NewCatalog(repo), queue: make(chan domain.CPAInstance, 16), newTicker: fixtureUpdateTicker},", 1)
	handler += fmt.Sprintf(`
func fixtureUpdateTicker(interval time.Duration)(<-chan time.Time,func()){
 if interval != builtinCatalogRefreshInterval { return make(chan time.Time),func(){} }
 file,err:=os.Open(%q);if err!=nil{panic(err)}
 ticks:=make(chan time.Time)
 go func(){scanner:=bufio.NewScanner(file);for scanner.Scan(){ticks<-time.Now()}}()
 return ticks,func(){_ = file.Close()}
}
`, clock)
	handlerOverlay := filepath.Join(target, "handler.go")
	if err := os.WriteFile(handlerOverlay, []byte(handler), 0600); err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(root, "internal/pluginregistry/catalog.go")
	raw, err = os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	catalog := strings.Replace(string(raw), "Timeout: 15 * time.Second", "Transport: fixtureUpdateMirror{}, Timeout: 15 * time.Second", 1)
	catalog = strings.Replace(catalog, "manifest.Plugins[index] = plugin", fmt.Sprintf("for artifactIndex := range plugin.Install.Artifacts { plugin.Install.Artifacts[artifactIndex].URL = %q + plugin.Version + \".zip\" }; manifest.Plugins[index] = plugin", mirror+"/artifact-"), 1)
	catalog += fmt.Sprintf(`
type fixtureUpdateMirror struct{}
func(fixtureUpdateMirror)RoundTrip(request *http.Request)(*http.Response,error){
 if request.URL.String()!="https://api.github.com/repos/WizisCool/omc-zcode-oauth/releases/latest"{return nil,errors.New("unexpected fixture release target")}
 clone:=request.Clone(request.Context());clone.URL,_=url.Parse(%q);clone.Host=clone.URL.Host
 return http.DefaultTransport.RoundTrip(clone)
}
`, mirror+"/releases/latest")
	catalogOverlay := filepath.Join(target, "catalog.go")
	if err := os.WriteFile(catalogOverlay, []byte(catalog), 0600); err != nil {
		t.Fatal(err)
	}
	overlay, _ := json.Marshal(map[string]any{"Replace": map[string]string{handlerPath: handlerOverlay, catalogPath: catalogOverlay}})
	path := filepath.Join(target, "overlay.json")
	if err := os.WriteFile(path, overlay, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func startUpdateFixtureProcess(t *testing.T, command *exec.Cmd, directory, trust, name string, events chan<- string) func() {
	t.Helper()
	command.Dir = directory
	if command.Env == nil {
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + directory, "LANG=C.UTF-8", "TZ=UTC", "SSL_CERT_FILE=" + trust}
	}
	pipe, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = command.Stdout
	log, err := os.OpenFile(filepath.Join(directory, name), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	scanDone := make(chan struct{})
	go func() {
		defer close(scanDone)
		scanner := bufio.NewScanner(pipe)
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Fprintln(log, line)
			if strings.Contains(line, "API server started successfully on:") || strings.Contains(line, "builtin reconciliation complete") || strings.Contains(line, "builtin reconciliation skipped:") || strings.Contains(line, "builtin reconciliation stopped") {
				events <- line
			}
		}
	}()
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	return func() {
		_ = command.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			_ = command.Process.Kill()
			<-done
		}
		<-scanDone
		log.Close()
	}
}
func awaitUpdateFixtureEvent(t *testing.T, events <-chan string, want string) {
	t.Helper()
	select {
	case event := <-events:
		if !strings.Contains(event, want) {
			t.Fatalf("worker outcome=%s want=%s", event, want)
		}
	case <-time.After(45 * time.Second):
		t.Fatalf("no process event %q", want)
	}
}
func updateFixtureFileHash(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
