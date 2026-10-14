package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

const (
	OMC_REPOSITORY = "wiziscool/oh-my-cpa"
	TEST_DIGEST    = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
	MASTER_KEY     = "test-master-key"
)

func testTiming() Timing {
	return Timing{PollInterval: time.Millisecond, HealthTimeout: 5 * time.Second, StableWindow: 0, StopGrace: time.Second}
}

type signer struct {
	publicKey  string
	privateKey ed25519.PrivateKey
}

func newSigner(t *testing.T) signer {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return signer{publicKey: base64.StdEncoding.EncodeToString(publicKey), privateKey: privateKey}
}

func (s signer) manifest(version, repository, digest string) ([]byte, string) {
	manifest := []byte(fmt.Sprintf(`{"schema":1,"version":%q,"image":{"repository":%q,"digest":%q}}`, version, repository, digest))
	return manifest, base64.StdEncoding.EncodeToString(ed25519.Sign(s.privateKey, manifest))
}

// deployment is a console at v1.0.0 with an updater beside it and v1.1.0 published.
type deployment struct {
	daemon  *fakeDaemon
	service *Service
	signer  signer
}

func newDeployment(t *testing.T, consoleImage string) deployment {
	t.Helper()
	daemon, engine := newFakeDaemon(t)
	keys := newSigner(t)
	daemon.addImage(consoleImage, "sha256:old", "v1.0.0", "PATH=/bin")
	if consoleImage != OMC_REPOSITORY+":latest" {
		daemon.addImage(OMC_REPOSITORY+":latest", "sha256:old", "v1.0.0", "PATH=/bin")
	}
	daemon.publish(OMC_REPOSITORY+"@"+TEST_DIGEST, "sha256:new", "v1.1.0", "PATH=/bin:/new")
	daemon.addContainer(containerSpec{
		name:        "oh-my-cpa",
		image:       consoleImage,
		environment: []string{"OMCPA_MASTER_KEY=" + MASTER_KEY, "OMCPA_CPA_BASE_URL=http://cli-proxy-api:8317"},
		networks:    map[string][]string{"stack": {"oh-my-cpa"}},
	})
	updater := daemon.addContainer(containerSpec{name: SIDECAR_NAME, image: OMC_REPOSITORY + ":latest", command: []string{ROLE_COMMAND, "serve"}})
	service := NewService(Options{Engine: engine, Timing: testTiming(), PublicKey: keys.publicKey, SelfID: updater.ID})
	return deployment{daemon: daemon, service: service, signer: keys}
}

func awaitJob(t *testing.T, service *Service) Job {
	t.Helper()
	service.jobs.Wait()
	job := service.LastJob()
	if job == nil || !job.IsFinished() {
		t.Fatalf("the job did not finish: %+v", job)
	}
	return *job
}

func TestParseReferenceAndPinning(t *testing.T) {
	cases := []struct {
		raw        string
		repository string
		tag        string
		isPinned   bool
	}{
		{"wiziscool/oh-my-cpa", "wiziscool/oh-my-cpa", "latest", false},
		{"wiziscool/oh-my-cpa:latest", "wiziscool/oh-my-cpa", "latest", false},
		{"wiziscool/oh-my-cpa:v0.2.9", "wiziscool/oh-my-cpa", "v0.2.9", true},
		{"eceasy/cli-proxy-api:8.0.16", "eceasy/cli-proxy-api", "8.0.16", true},
		// A registry port is not a tag.
		{"registry.example:5000/team/app", "registry.example:5000/team/app", "latest", false},
		{"registry.example:5000/team/app:edge", "registry.example:5000/team/app", "edge", false},
		{"wiziscool/oh-my-cpa@" + TEST_DIGEST, "wiziscool/oh-my-cpa", "latest", true},
		{"wiziscool/oh-my-cpa:latest@" + TEST_DIGEST, "wiziscool/oh-my-cpa", "latest", true},
	}
	for _, testCase := range cases {
		reference := ParseReference(testCase.raw)
		if reference.Repository != testCase.repository || reference.EffectiveTag() != testCase.tag || reference.IsPinned() != testCase.isPinned {
			t.Errorf("%s: got repository=%q tag=%q pinned=%v", testCase.raw, reference.Repository, reference.EffectiveTag(), reference.IsPinned())
		}
	}
	if CanonicalRepository("docker.io/Wiziscool/oh-my-cpa") != OMC_REPOSITORY {
		t.Errorf("Docker Hub spellings must compare equal")
	}
}

func TestPlanReplacementLeavesImageDefaultsToTheNewImage(t *testing.T) {
	previous := Container{ID: "abcdef0123456789", Name: "/console"}
	previous.Config = map[string]any{
		"Image":      "repo:latest",
		"Hostname":   "abcdef012345",
		"Env":        []any{"OPERATOR=1", "PATH=/bin"},
		"Entrypoint": []any{"/usr/local/bin/app"},
		"Cmd":        []any{"custom"},
		"Labels":     map[string]any{"com.docker.compose.project": "stack", "org.opencontainers.image.version": "v1.0.0"},
		"Volumes":    map[string]any{"/data": map[string]any{}},
	}
	previous.HostConfig = map[string]any{"NetworkMode": "stack", "ReadonlyRootfs": true, "Binds": []any{"/host/config:/config"}}
	previous.Mounts = append(previous.Mounts,
		struct {
			Type        string `json:"Type"`
			Name        string `json:"Name"`
			Source      string `json:"Source"`
			Destination string `json:"Destination"`
		}{Type: "volume", Name: "anonymous123", Destination: "/data"},
		struct {
			Type        string `json:"Type"`
			Name        string `json:"Name"`
			Source      string `json:"Source"`
			Destination string `json:"Destination"`
		}{Type: "bind", Source: "/host/config", Destination: "/config"},
	)
	previous.NetworkSettings.Networks = map[string]map[string]any{
		"stack": {"Aliases": []any{"console", "abcdef012345"}, "IPAddress": "172.18.0.2"},
		"extra": {"Aliases": []any{"console"}},
	}
	image := Image{Config: map[string]any{
		"Env":        []any{"PATH=/bin"},
		"Entrypoint": []any{"/usr/local/bin/app"},
		"Labels":     map[string]any{"org.opencontainers.image.version": "v1.0.0"},
		"Volumes":    map[string]any{"/data": map[string]any{}},
	}}

	plan, err := planReplacement(previous, image, "repo:latest")
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	config := plan.payload
	if environment := stringList(toAny(config["Env"].([]string))); !slices.Equal(environment, []string{"OPERATOR=1"}) {
		t.Errorf("the image's own environment must not be frozen into the replacement: %v", environment)
	}
	if _, isKept := config["Entrypoint"]; isKept {
		t.Errorf("an entrypoint equal to the image default must be left to the new image")
	}
	if command := stringList(config["Cmd"]); !slices.Equal(command, []string{"custom"}) {
		t.Errorf("an operator's command must be kept: %v", command)
	}
	labels := config["Labels"].(map[string]any)
	if labels["com.docker.compose.project"] != "stack" || labels["org.opencontainers.image.version"] != nil {
		t.Errorf("operator labels are kept and image labels dropped: %v", labels)
	}
	if _, isKept := config["Hostname"]; isKept {
		t.Errorf("a generated hostname is the old container's identity")
	}
	hostConfig := config["HostConfig"].(map[string]any)
	if binds := hostConfig["Binds"].([]string); !slices.Equal(binds, []string{"/host/config:/config", "anonymous123:/data"}) {
		t.Errorf("an anonymous volume must be carried by name, and a declared bind not repeated: %v", binds)
	}
	if hostConfig["ReadonlyRootfs"] != true {
		t.Errorf("host configuration must be carried unchanged")
	}
	primary := config["NetworkingConfig"].(map[string]any)["EndpointsConfig"].(map[string]any)["stack"].(map[string]any)
	if aliases := primary["Aliases"].([]string); !slices.Equal(aliases, []string{"console"}) || primary["IPAddress"] != nil {
		t.Errorf("the endpoint keeps configured aliases and drops assigned state: %v", primary)
	}
	if _, isExtra := plan.extraNetworks["extra"]; !isExtra || len(plan.extraNetworks) != 1 {
		t.Errorf("every other network is attached after creation: %v", plan.extraNetworks)
	}
}

func TestVerifyManifest(t *testing.T) {
	keys := newSigner(t)
	manifest, signature := keys.manifest("v1.1.0", OMC_REPOSITORY, TEST_DIGEST)

	verified, err := VerifyManifest(keys.publicKey, manifest, signature)
	if err != nil || verified.Version != "v1.1.0" || verified.Image.Digest != TEST_DIGEST {
		t.Fatalf("a signed manifest must verify: %+v %v", verified, err)
	}
	tampered := bytes.Replace(manifest, []byte("v1.1.0"), []byte("v9.9.9"), 1)
	if _, err := VerifyManifest(keys.publicKey, tampered, signature); !errors.Is(err, ErrSignature) {
		t.Errorf("an altered manifest must be refused: %v", err)
	}
	if _, err := VerifyManifest(newSigner(t).publicKey, manifest, signature); !errors.Is(err, ErrSignature) {
		t.Errorf("another key's signature must be refused: %v", err)
	}
	if _, err := VerifyManifest("", manifest, signature); !errors.Is(err, ErrSignature) {
		t.Errorf("a build without a release key verifies nothing: %v", err)
	}
	unpinned, unpinnedSignature := keys.manifest("v1.1.0", OMC_REPOSITORY, "latest")
	if _, err := VerifyManifest(keys.publicKey, unpinned, unpinnedSignature); err == nil {
		t.Errorf("a manifest must name a digest, even when it is signed")
	}
}

// The release workflow signs with Node and the updater verifies with Go; this vector
// was produced by scripts/sign-release-manifest.mjs.
func TestVerifyManifestAcceptsTheReleaseScriptsSignature(t *testing.T) {
	publicKey := "tnEjBVLjIWZZqc5M7Au8EHXqH2pRDHM/r6dTl2zArvE="
	manifest := "{\n  \"schema\": 1,\n  \"version\": \"v1.2.3\",\n  \"image\": {\n    \"repository\": \"wiziscool/oh-my-cpa\",\n    \"digest\": \"sha256:abababababababababababababababababababababababababababababababab\"\n  }\n}\n"
	signature := "5cSe9MESI6GouSjcbFWf9lrrQa1jn4VKC+mpcA6yqYv1sT0ZAz/oA1GjCNfZv1ntprWwr6vU4cDQEGY10OAuAA=="
	verified, err := VerifyManifest(publicKey, []byte(manifest), signature)
	if err != nil || verified.Version != "v1.2.3" {
		t.Fatalf("verify: %+v %v", verified, err)
	}
}

func TestControlTokenMatchesAnIndependentHMAC(t *testing.T) {
	// openssl dgst -sha256 -hmac "test-master-key" over TOKEN_LABEL.
	const expected = "e5945dfa257b16d7adcc8773bc911ada3f24a24093de91929867ea9a07b46c32"
	if token := ControlToken("  " + MASTER_KEY + "\n"); token != expected {
		t.Errorf("token = %s", token)
	}
	if ControlToken("") != "" {
		t.Errorf("an empty master key must not yield a usable token")
	}
}

func TestSignedUpdateReplacesTheConsoleAndRetagsItsImage(t *testing.T) {
	stack := newDeployment(t, OMC_REPOSITORY+":latest")
	manifest, signature := stack.signer.manifest("v1.1.0", OMC_REPOSITORY, TEST_DIGEST)
	before := stack.daemon.named("oh-my-cpa")

	if _, err := stack.service.Start(context.Background(), ProductOMC, manifest, signature); err != nil {
		t.Fatalf("start: %v", err)
	}
	job := awaitJob(t, stack.service)
	if job.Stage != StageDone || job.FromVersion != "v1.0.0" || job.ToVersion != "v1.1.0" {
		t.Fatalf("job = %+v", job)
	}
	after := stack.daemon.named("oh-my-cpa")
	if after.ID == before.ID || after.ImageID != "sha256:new" || !after.IsRunning {
		t.Fatalf("the console must be a new running container on the new image: %+v", after)
	}
	if stack.daemon.named("oh-my-cpa"+PREVIOUS_SUFFIX) != nil {
		t.Errorf("the previous container must be removed once the replacement is up")
	}
	if !slices.Contains(stringList(after.Config["Env"]), "OMCPA_MASTER_KEY="+MASTER_KEY) {
		t.Errorf("the operator's environment must survive: %v", after.Config["Env"])
	}
	if slices.Contains(stringList(after.Config["Env"]), "PATH=/bin") {
		t.Errorf("the old image's environment must not survive: %v", after.Config["Env"])
	}
	if _, isAttached := after.Networks["stack"]; !isAttached {
		t.Errorf("the replacement must stay on the console's network: %v", after.Networks)
	}
	stack.daemon.mu.Lock()
	tagged := stack.daemon.images[OMC_REPOSITORY+":latest"].ID
	stack.daemon.mu.Unlock()
	if tagged != "sha256:new" {
		t.Errorf("the configured tag must point at the verified image, or Compose would recreate the container: %s", tagged)
	}
}

func TestUpdateHandsTheFinishedJobToTheUpdatersSuccessor(t *testing.T) {
	stack := newDeployment(t, OMC_REPOSITORY+":latest")
	manifest, signature := stack.signer.manifest("v1.1.0", OMC_REPOSITORY, TEST_DIGEST)
	predecessor := stack.daemon.named(SIDECAR_NAME)
	if _, err := stack.service.Start(context.Background(), ProductOMC, manifest, signature); err != nil {
		t.Fatalf("start: %v", err)
	}
	awaitJob(t, stack.service)

	successor := stack.daemon.named(SIDECAR_NAME)
	if successor == nil || successor.ID == predecessor.ID || successor.ImageID != "sha256:new" {
		t.Fatalf("the updater must start a successor on the new image: %+v", successor)
	}
	inherited := ""
	for _, entry := range stringList(successor.Config["Env"]) {
		if value, found := strings.CutPrefix(entry, ENV_LAST_JOB+"="); found {
			inherited = value
		}
	}
	restored := NewService(Options{Engine: stack.service.options.Engine})
	restored.RestoreJob(inherited)
	if job := restored.LastJob(); job == nil || job.Stage != StageDone || job.ToVersion != "v1.1.0" {
		t.Fatalf("the successor must report the job its predecessor finished: %q", inherited)
	}

	// The successor's start-up removes the predecessor it replaced, before its own health
	// check has passed.
	successor.Health = "starting"
	successorService := NewService(Options{Engine: stack.service.options.Engine, SelfID: successor.ID})
	if err := successorService.Reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if stack.daemon.named(SIDECAR_NAME+PREVIOUS_SUFFIX) != nil {
		t.Errorf("the predecessor must be removed")
	}
	if kept := stack.daemon.named(SIDECAR_NAME); kept == nil || kept.ID != successor.ID {
		t.Errorf("the successor must keep the name: %+v", kept)
	}
}

func TestFailedReplacementRestoresThePreviousContainerAndTag(t *testing.T) {
	stack := newDeployment(t, OMC_REPOSITORY+":latest")
	stack.daemon.crashing["sha256:new"] = true
	manifest, signature := stack.signer.manifest("v1.1.0", OMC_REPOSITORY, TEST_DIGEST)
	before := stack.daemon.named("oh-my-cpa")

	if _, err := stack.service.Start(context.Background(), ProductOMC, manifest, signature); err != nil {
		t.Fatalf("start: %v", err)
	}
	job := awaitJob(t, stack.service)
	if job.Stage != StageRolledBack || job.Error == "" {
		t.Fatalf("job = %+v", job)
	}
	after := stack.daemon.named("oh-my-cpa")
	if after == nil || after.ID != before.ID || !after.IsRunning {
		t.Fatalf("the previous container must hold its name and run again: %+v", after)
	}
	stack.daemon.mu.Lock()
	tagged := stack.daemon.images[OMC_REPOSITORY+":latest"].ID
	containers := len(stack.daemon.containers)
	stack.daemon.mu.Unlock()
	if tagged != "sha256:old" {
		t.Errorf("the tag must return to the image that works: %s", tagged)
	}
	if containers != 2 {
		t.Errorf("the failed replacement must be removed, leaving the console and the updater: %d", containers)
	}
}

func TestStartRefusesWhatItMustNotInstall(t *testing.T) {
	t.Run("a pinned image", func(t *testing.T) {
		stack := newDeployment(t, OMC_REPOSITORY+":v1.0.0")
		manifest, signature := stack.signer.manifest("v1.1.0", OMC_REPOSITORY, TEST_DIGEST)
		_, err := stack.service.Start(context.Background(), ProductOMC, manifest, signature)
		var unavailable *UnavailableError
		if !errors.As(err, &unavailable) || unavailable.Reason != ReasonPinned {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("a manifest for another repository", func(t *testing.T) {
		stack := newDeployment(t, OMC_REPOSITORY+":latest")
		manifest, signature := stack.signer.manifest("v1.1.0", "someone/else", TEST_DIGEST)
		if _, err := stack.service.Start(context.Background(), ProductOMC, manifest, signature); err == nil {
			t.Fatalf("a validly signed manifest for another image must still be refused")
		}
	})
	t.Run("an older release", func(t *testing.T) {
		stack := newDeployment(t, OMC_REPOSITORY+":latest")
		manifest, signature := stack.signer.manifest("v0.9.0", OMC_REPOSITORY, TEST_DIGEST)
		if _, err := stack.service.Start(context.Background(), ProductOMC, manifest, signature); err == nil {
			t.Fatalf("a downgrade must be refused: migrations only go forward")
		}
	})
	t.Run("an unsigned request", func(t *testing.T) {
		stack := newDeployment(t, OMC_REPOSITORY+":latest")
		manifest, _ := stack.signer.manifest("v1.1.0", OMC_REPOSITORY, TEST_DIGEST)
		if _, err := stack.service.Start(context.Background(), ProductOMC, manifest, ""); !errors.Is(err, ErrSignature) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("an unknown product", func(t *testing.T) {
		stack := newDeployment(t, OMC_REPOSITORY+":latest")
		if _, err := stack.service.Start(context.Background(), "oh-my-cpa", nil, ""); err == nil {
			t.Fatalf("a caller names a product, never a container")
		}
	})
}

func TestGatewayIsFoundByTheAddressTheConsoleUses(t *testing.T) {
	stack := newDeployment(t, OMC_REPOSITORY+":latest")
	target := func(product string) Target {
		for _, target := range stack.service.Targets(context.Background()) {
			if target.Product == product {
				return target
			}
		}
		return Target{}
	}
	if gateway := target(ProductCPA); gateway.Action != ActionUnavailable || gateway.Reason != ReasonNotLocalContainer {
		t.Fatalf("with no gateway container the update is unavailable, not an error: %+v", gateway)
	}

	stack.daemon.mu.Lock()
	stack.daemon.addImage("custom/gateway:stable", "sha256:gateway", "8.0.1")
	stack.daemon.addContainer(containerSpec{name: "gateway-1", image: "custom/gateway:stable", networks: map[string][]string{"stack": {"cli-proxy-api"}}})
	stack.daemon.mu.Unlock()
	if gateway := target(ProductCPA); gateway.Container != "gateway-1" || gateway.Action != ActionAvailable {
		t.Fatalf("the container answering to the console's CPA host is the gateway, whatever its image: %+v", gateway)
	}
	if console := target(ProductOMC); console.Container != "oh-my-cpa" || console.RunningVersion != "v1.0.0" || console.Action != ActionAvailable {
		t.Fatalf("console = %+v", console)
	}
}

func TestGatewayUpdatePullsItsConfiguredTagWithoutAManifest(t *testing.T) {
	stack := newDeployment(t, OMC_REPOSITORY+":latest")
	stack.daemon.mu.Lock()
	stack.daemon.addImage(DEFAULT_CPA_REPOSITORY+":latest", "sha256:gateway-old", "8.0.1")
	stack.daemon.publish(DEFAULT_CPA_REPOSITORY+":latest", "sha256:gateway-new", "8.0.2")
	stack.daemon.addContainer(containerSpec{name: "cli-proxy-api", image: DEFAULT_CPA_REPOSITORY + ":latest"})
	stack.daemon.mu.Unlock()

	if _, err := stack.service.Start(context.Background(), ProductCPA, nil, ""); err != nil {
		t.Fatalf("start: %v", err)
	}
	if job := awaitJob(t, stack.service); job.Stage != StageDone || job.ToVersion != "8.0.2" {
		t.Fatalf("job = %+v", job)
	}
	if gateway := stack.daemon.named("cli-proxy-api"); gateway.ImageID != "sha256:gateway-new" {
		t.Fatalf("gateway = %+v", gateway)
	}
	// The updater replaces itself only after a console update.
	if updater := stack.daemon.named(SIDECAR_NAME + PREVIOUS_SUFFIX); updater != nil {
		t.Errorf("a gateway update must not hand the updater over")
	}

	if _, err := stack.service.Start(context.Background(), ProductCPA, nil, ""); err != nil {
		t.Fatalf("second start: %v", err)
	}
	if job := awaitJob(t, stack.service); job.Stage != StageAlreadyCurrent {
		t.Fatalf("a container already on the newest image is left running: %+v", job)
	}
}

func TestReconcileRestoresAnInterruptedReplacement(t *testing.T) {
	daemon, engine := newFakeDaemon(t)
	daemon.addImage("app:latest", "sha256:app", "v1.0.0")
	interrupted := daemon.addContainer(containerSpec{name: "gateway" + PREVIOUS_SUFFIX, image: "app:latest"})
	interrupted.IsRunning = false

	if err := NewService(Options{Engine: engine}).Reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	restored := daemon.named("gateway")
	if restored == nil || restored.ID != interrupted.ID || !restored.IsRunning {
		t.Fatalf("a container whose replacement never came up must be put back and started: %+v", restored)
	}
}

func TestReconcileKeepsTheRollbackTargetWhileTheReplacementIsUnverified(t *testing.T) {
	for _, health := range []string{"starting", "unhealthy"} {
		t.Run(health, func(t *testing.T) {
			daemon, engine := newFakeDaemon(t)
			daemon.addImage("app:latest", "sha256:app", "v1.0.0")
			previous := daemon.addContainer(containerSpec{name: "gateway" + PREVIOUS_SUFFIX, image: "app:latest"})
			previous.IsRunning = false
			daemon.addContainer(containerSpec{name: "gateway", image: "app:latest"}).Health = health

			if err := NewService(Options{Engine: engine}).Reconcile(context.Background()); err != nil {
				t.Fatalf("reconcile: %v", err)
			}
			restored := daemon.named("gateway")
			if restored == nil || restored.ID != previous.ID || !restored.IsRunning {
				t.Fatalf("an unverified replacement must give way to the previous container: %+v", restored)
			}
		})
	}
}

func TestReconcileRemovesThePreviousContainerOnceTheReplacementIsHealthy(t *testing.T) {
	daemon, engine := newFakeDaemon(t)
	daemon.addImage("app:latest", "sha256:app", "v1.0.0")
	previous := daemon.addContainer(containerSpec{name: "gateway" + PREVIOUS_SUFFIX, image: "app:latest"})
	previous.IsRunning = false
	replacement := daemon.addContainer(containerSpec{name: "gateway", image: "app:latest"})
	replacement.Health = "healthy"

	if err := NewService(Options{Engine: engine}).Reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if daemon.named("gateway"+PREVIOUS_SUFFIX) != nil || daemon.named("gateway").ID != replacement.ID {
		t.Fatalf("a healthy replacement keeps its name and the previous container goes")
	}
}

func TestControlInterfaceRequiresTheDerivedToken(t *testing.T) {
	stack := newDeployment(t, OMC_REPOSITORY+":latest")
	server := httptest.NewServer(stack.service.Handler("v1.0.0"))
	t.Cleanup(server.Close)
	call := func(method, path, token, body string) (int, map[string]any) {
		request, _ := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer response.Body.Close()
		decoded := map[string]any{}
		_ = json.NewDecoder(response.Body).Decode(&decoded)
		return response.StatusCode, decoded
	}
	token := ControlToken(MASTER_KEY)

	if status, _ := call(http.MethodGet, "/v1/status", "", ""); status != http.StatusUnauthorized {
		t.Errorf("no token: %d", status)
	}
	if status, _ := call(http.MethodGet, "/v1/status", ControlToken("another-key"), ""); status != http.StatusUnauthorized {
		t.Errorf("a token from another master key: %d", status)
	}
	if status, _ := call(http.MethodPost, "/v1/update", "", `{"product":"cpa"}`); status != http.StatusUnauthorized {
		t.Errorf("an update without a token: %d", status)
	}
	status, body := call(http.MethodGet, "/v1/status", token, "")
	if status != http.StatusOK || body["updater_version"] != "v1.0.0" || len(body["products"].([]any)) != 2 {
		t.Errorf("status = %d %v", status, body)
	}
	if status, _ := call(http.MethodGet, "/v1/healthz", "", ""); status != http.StatusOK {
		t.Errorf("the container health check has no token: %d", status)
	}

	manifest, _ := stack.signer.manifest("v1.1.0", OMC_REPOSITORY, TEST_DIGEST)
	request, _ := json.Marshal(UpdateRequest{Product: ProductOMC, Manifest: string(manifest), Signature: "AAAA"})
	if status, body := call(http.MethodPost, "/v1/update", token, string(request)); status != http.StatusForbidden || body["code"] != "invalid_signature" {
		t.Errorf("a bad signature: %d %v", status, body)
	}
	if status, body := call(http.MethodPost, "/v1/update", token, `{"product":"cpa"}`); status != http.StatusConflict || body["code"] != ReasonNotLocalContainer {
		t.Errorf("an unavailable product names its reason: %d %v", status, body)
	}
}

func TestInstallAddsTheUpdaterAndUpgradesAnOlderConsole(t *testing.T) {
	daemon, engine := newFakeDaemon(t)
	daemon.addImage(OMC_REPOSITORY+":latest", "sha256:old", "v1.0.0")
	console := daemon.addContainer(containerSpec{
		name:        "stack-oh-my-cpa-1",
		image:       OMC_REPOSITORY + ":latest",
		environment: []string{"OMCPA_MASTER_KEY=" + MASTER_KEY},
		labels:      map[string]string{COMPOSE_PROJECT_LABEL: "stack"},
		networks:    map[string][]string{"stack_default": {"oh-my-cpa"}},
	})
	// The operator pulled the new image to run the installer, moving the tag.
	daemon.addImage(OMC_REPOSITORY+":latest", "sha256:new", "v1.1.0")
	installer := daemon.addContainer(containerSpec{name: "installer", image: OMC_REPOSITORY + ":latest", command: []string{ROLE_COMMAND, "install"}})
	installer.Mounts = []map[string]any{{"Type": "bind", "Source": "/run/user/1000/docker.sock", "Destination": DEFAULT_SOCKET_PATH}}

	var output bytes.Buffer
	err := Install(context.Background(), InstallOptions{Engine: engine, Timing: testTiming(), SelfID: installer.ID, Out: &output})
	if err != nil {
		t.Fatalf("install: %v\n%s", err, output.String())
	}

	sidecar := daemon.named(SIDECAR_NAME)
	if sidecar == nil || !sidecar.IsRunning {
		t.Fatalf("the updater must be running: %+v", sidecar)
	}
	if binds := stringList(sidecar.HostConfig["Binds"]); !slices.Equal(binds, []string{"/run/user/1000/docker.sock:" + DEFAULT_SOCKET_PATH}) {
		t.Errorf("the updater mounts the socket from where it is on the host: %v", binds)
	}
	if sidecar.HostConfig["ReadonlyRootfs"] != true || !slices.Equal(stringList(sidecar.HostConfig["CapDrop"]), []string{"ALL"}) {
		t.Errorf("the updater must be confined: %v", sidecar.HostConfig)
	}
	if sidecar.Config["Labels"].(map[string]any)[COMPOSE_PROJECT_LABEL] != nil {
		t.Errorf("the updater must stay outside the Compose project")
	}
	if _, isOnProjectNetwork := sidecar.Networks["stack_default"]; isOnProjectNetwork {
		t.Errorf("an endpoint on the project network would make `docker compose down` fail")
	}

	upgraded := daemon.named("stack-oh-my-cpa-1")
	if upgraded.ID == console.ID || upgraded.ImageID != "sha256:new" {
		t.Fatalf("an older console on the installer's tag must be upgraded: %+v\n%s", upgraded, output.String())
	}
	for _, network := range []string{"stack_default", LINK_NETWORK} {
		if _, isAttached := upgraded.Networks[network]; !isAttached {
			t.Errorf("the console must be on %s: %v", network, upgraded.Networks)
		}
	}
	if !strings.Contains(output.String(), "docker rm -f "+SIDECAR_NAME) {
		t.Errorf("the installer says how to undo itself:\n%s", output.String())
	}
}

func TestInstallLeavesAPinnedConsoleAlone(t *testing.T) {
	daemon, engine := newFakeDaemon(t)
	daemon.addImage(OMC_REPOSITORY+":v1.0.0", "sha256:old", "v1.0.0")
	daemon.addImage(OMC_REPOSITORY+":latest", "sha256:new", "v1.1.0")
	console := daemon.addContainer(containerSpec{name: "oh-my-cpa", image: OMC_REPOSITORY + ":v1.0.0", networks: map[string][]string{"stack": nil}})
	installer := daemon.addContainer(containerSpec{name: "installer", image: OMC_REPOSITORY + ":latest", command: []string{ROLE_COMMAND, "install"}})
	installer.Mounts = []map[string]any{{"Type": "bind", "Source": DEFAULT_SOCKET_PATH, "Destination": DEFAULT_SOCKET_PATH}}

	var output bytes.Buffer
	if err := Install(context.Background(), InstallOptions{Engine: engine, Timing: testTiming(), SelfID: installer.ID, Out: &output}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if after := daemon.named("oh-my-cpa"); after.ID != console.ID {
		t.Fatalf("a pinned console must not be replaced")
	}
	if !strings.Contains(output.String(), "pinned") {
		t.Errorf("the operator is told why nothing was upgraded:\n%s", output.String())
	}
}
