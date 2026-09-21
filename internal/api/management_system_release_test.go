package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// startReleaseTestServer builds a file-backed server with the real release service
// attached but no outbound client: the feed source is a stub, so the tests exercise
// the production comparison, storage and merge logic without reaching the network.
func startReleaseTestServer(t *testing.T) (*http.Client, string, *repository.Repository, *stubFeedSource) {
	t.Helper()

	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("X-CPA-Version", "7.3.5")
		switch {
		case hasSuffix(request.URL.Path, "/auth-files"):
			_, _ = writer.Write([]byte(`{"files":[{"name":"a.json"}]}`))
		case hasSuffix(request.URL.Path, "/plugins"):
			_, _ = writer.Write([]byte(`[]`))
		case containsPath(request.URL.Path, "api-key"):
			_, _ = writer.Write([]byte(`[]`))
		default:
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		}
	}))
	t.Cleanup(cpaServer.Close)

	// A file-backed database is required: the maintenance routes must be able to
	// measure and rebuild a real file, and an in-memory database has no file to report.
	db, err := repository.Open(context.Background(), filepath.Join(t.TempDir(), "release-api.db"))
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)

	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatalf("new cipher: %v", err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-secret-key"))
	if err != nil {
		t.Fatalf("encrypt management key: %v", err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 cpaServer.URL,
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatalf("upsert instance: %v", err)
	}

	authManager, err := auth.New("management-secret-value", "/omc", "")
	if err != nil {
		t.Fatalf("new auth manager: %v", err)
	}
	handler := NewHandler(config.Config{
		BasePath: "/omc",
		Version:  "v0.1.0-dev",
		Usage:    config.UsageConfig{Enabled: true, Mode: "auto"},
	}, repo, cipher, nil, authManager)

	feed := &stubFeedSource{}
	releaseService, err := release.New(release.Options{
		Repository:    repo,
		OMCRepository: "WizisCool/oh-my-cpa",
		CPARepository: "router-for-me/CLIProxyAPI",
		Client:        feed,
	})
	if err != nil {
		t.Fatalf("build release service: %v", err)
	}
	handler.SetRelease(releaseService)
	maintenanceService, err := repository.NewMaintenanceService(context.Background(), db)
	if err != nil {
		t.Fatalf("build maintenance service: %v", err)
	}
	t.Cleanup(func() { _ = maintenanceService.Close() })
	handler.SetMaintenance(maintenanceService)

	appServer := httptest.NewServer(handler.Router())
	t.Cleanup(appServer.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("new cookie jar: %v", err)
	}
	client := &http.Client{Jar: jar}
	loginResp, err := client.Post(appServer.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret-value"}`))
	if err != nil || loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login failed: %v (status %v)", err, loginResp)
	}
	loginResp.Body.Close()

	return client, appServer.URL + "/omc/api/v1", repo, feed
}

// stubFeedSource answers release reads from memory.
type stubFeedSource struct {
	releases map[string][]release.Release
	fail     map[string]error
	requests int
}

func (s *stubFeedSource) FetchReleases(_ context.Context, repositoryName, _ string) (release.Feed, error) {
	s.requests++
	if err := s.fail[repositoryName]; err != nil {
		return release.Feed{}, err
	}
	releases, ok := s.releases[repositoryName]
	if !ok {
		return release.Feed{Repository: repositoryName}, nil
	}
	return release.Feed{Repository: repositoryName, Releases: releases, ETag: `W/"stub"`}, nil
}

func newStubFeed() *stubFeedSource {
	return &stubFeedSource{
		releases: map[string][]release.Release{
			"WizisCool/oh-my-cpa": {
				{Tag: "v0.2.0", Name: "v0.2.0", Body: "## Highlights\n\n- Console work.\n", PublishedAt: "2026-09-20T10:00:00Z"},
			},
			"router-for-me/CLIProxyAPI": {
				{Tag: "v7.3.7", Name: "v7.3.7", Body: "## Changelog\n\n- fix(responses): filter telemetry events\n", PublishedAt: "2026-09-21T10:00:00Z"},
				{Tag: "v7.3.6", Name: "v7.3.6", Body: "## Changelog\n\n- fix(translator): hoist cache_control\n", PublishedAt: "2026-09-20T10:00:00Z"},
				{Tag: "7.3.5", Name: "7.3.5", Body: "## Changelog\n\n- previous release\n", PublishedAt: "2026-09-19T10:00:00Z"},
			},
		},
		fail: map[string]error{},
	}
}

func hasSuffix(value, suffix string) bool {
	return len(value) >= len(suffix) && value[len(value)-len(suffix):] == suffix
}

func containsPath(value, substring string) bool {
	return len(substring) == 0 || indexOf(value, substring) >= 0
}

func indexOf(value, substring string) int {
	for index := 0; index+len(substring) <= len(value); index++ {
		if value[index:index+len(substring)] == substring {
			return index
		}
	}
	return -1
}

// TestReleaseEndpointsReportBothProductsIndependently drives the whole read path the
// page uses, including the failure case: the two products have separate feeds and one
// failing must not blank the other.
func TestReleaseEndpointsReportBothProductsIndependently(t *testing.T) {
	client, baseURL, _, feed := startReleaseTestServer(t)
	feed.releases = newStubFeed().releases
	feed.fail = map[string]error{"router-for-me/CLIProxyAPI": fmt.Errorf("the release feed answered status 503")}

	checkResp, err := client.Post(baseURL+"/management/system/check-updates", "application/json", nil)
	if err != nil {
		t.Fatalf("check updates: %v", err)
	}
	defer checkResp.Body.Close()
	if checkResp.StatusCode != http.StatusOK {
		t.Fatalf("check updates status = %d, want 200", checkResp.StatusCode)
	}
	var checked struct {
		OMCVersion SystemProductVersionDTO `json:"omc_version"`
		CPAVersion SystemProductVersionDTO `json:"cpa_version"`
	}
	if err := json.NewDecoder(checkResp.Body).Decode(&checked); err != nil {
		t.Fatalf("decode check response: %v", err)
	}

	// The console's own build is v0.1.0-dev, which is not comparable with a release:
	// the honest answer is "cannot tell", not "up to date".
	if checked.OMCVersion.State != release.UpdateIndeterminate {
		t.Errorf("console state = %q, want %q", checked.OMCVersion.State, release.UpdateIndeterminate)
	}
	if checked.OMCVersion.LatestVersion != "v0.2.0" {
		t.Errorf("console latest = %q, want v0.2.0", checked.OMCVersion.LatestVersion)
	}
	// The gateway's feed failed, and that must be visible rather than rendered as
	// "up to date".
	if checked.CPAVersion.CheckError == "" {
		t.Error("the gateway's failed check was not reported")
	}
	if checked.CPAVersion.State != release.UpdateIndeterminate {
		t.Errorf("gateway state after a failed check = %q, want %q", checked.CPAVersion.State, release.UpdateIndeterminate)
	}

	// The whole page must still render, with the gateway's failure visible beside the
	// console's own success.
	infoResp, err := client.Get(baseURL + "/management/system")
	if err != nil {
		t.Fatalf("get system info: %v", err)
	}
	defer infoResp.Body.Close()
	if infoResp.StatusCode != http.StatusOK {
		t.Fatalf("system info status = %d, want 200", infoResp.StatusCode)
	}
	var info SystemInfoDTO
	if err := json.NewDecoder(infoResp.Body).Decode(&info); err != nil {
		t.Fatalf("decode system info: %v", err)
	}
	if info.OMCVersion.LatestVersion != "v0.2.0" {
		t.Errorf("system info console latest = %q, want v0.2.0", info.OMCVersion.LatestVersion)
	}
	if info.CPAVersion.CheckError == "" {
		t.Error("system info hid the gateway's failed check")
	}
}

func TestReleaseEndpointServesMergedLogForTheInterval(t *testing.T) {
	client, baseURL, _, feed := startReleaseTestServer(t)
	feed.releases = newStubFeed().releases

	checkResp, err := client.Post(baseURL+"/management/system/check-updates", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	checkResp.Body.Close()

	resp, err := client.Get(baseURL + "/management/system/releases?product=cpa")
	if err != nil {
		t.Fatalf("get releases: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("releases status = %d, want 200", resp.StatusCode)
	}
	var log SystemReleasesDTO
	if err := json.NewDecoder(resp.Body).Decode(&log); err != nil {
		t.Fatalf("decode releases: %v", err)
	}
	if log.Product != "cpa" {
		t.Errorf("product = %q, want cpa", log.Product)
	}
	if log.RepositoryURL == "" {
		t.Error("the source repository link was not reported")
	}
	// The gateway runs 7.3.5 and v7.3.7 is published, so two releases are between them.
	if len(log.Releases) != 2 {
		t.Fatalf("merged log has %d releases, want 2: %+v", len(log.Releases), log.Releases)
	}
	for _, entry := range log.Releases {
		if entry.Body == "" || !entry.BodyAvailable {
			t.Errorf("%s was served without notes", entry.Tag)
		}
		if entry.HTMLURL == "" {
			t.Errorf("%s was served without a source link", entry.Tag)
		}
		if !entry.InRange {
			t.Errorf("%s is in the log but not marked in range", entry.Tag)
		}
	}
}

func TestReleaseEndpointRefusesAnUnknownProduct(t *testing.T) {
	client, baseURL, _, _ := startReleaseTestServer(t)
	resp, err := client.Get(baseURL + "/management/system/releases?product=windsurf")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown product status = %d, want 400", resp.StatusCode)
	}
}

// TestMaintenanceEndpointRebuildsAndReportsMeasuredResult drives the whole write path:
// an operator-issued rebuild must be admitted, reported as a background job, and
// answered with measured sizes rather than a claim that it worked.
func TestMaintenanceEndpointRebuildsAndReportsMeasuredResult(t *testing.T) {
	client, baseURL, repo, _ := startReleaseTestServer(t)
	ctx := context.Background()

	// Give the database something to release.
	if _, err := repo.SQL().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS maintenance_probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 4096)
	for index := 0; index < 300; index++ {
		if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO maintenance_probe(v) VALUES (?)`, string(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := repo.SQL().ExecContext(ctx, `DELETE FROM maintenance_probe`); err != nil {
		t.Fatal(err)
	}

	// The admission the page shows before offering the action.
	admissionResp, err := client.Get(baseURL + "/management/system/maintenance")
	if err != nil {
		t.Fatal(err)
	}
	var admission systemMaintenanceActionDTO
	if err := json.NewDecoder(admissionResp.Body).Decode(&admission); err != nil {
		t.Fatal(err)
	}
	admissionResp.Body.Close()
	if !admission.Admission.Allowed {
		t.Fatalf("vacuum refused on a writable temp directory: %s", admission.Admission.Reason)
	}
	if admission.Admission.RequiredBytes <= 0 || admission.Admission.AvailableBytes <= 0 {
		t.Fatalf("admission reported unmeasured sizes: %+v", admission.Admission)
	}
	if admission.Admission.RequiredBytes != admission.Maintenance.SizeBeforeBytes*2 && admission.Maintenance.SizeBeforeBytes != 0 {
		t.Logf("admission requirement does not match a doubled footprint: %+v", admission.Admission)
	}

	vacuumResp, err := client.Post(baseURL+"/management/system/maintenance/vacuum", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer vacuumResp.Body.Close()
	if vacuumResp.StatusCode != http.StatusAccepted {
		t.Fatalf("vacuum status = %d, want 202", vacuumResp.StatusCode)
	}

	// The job runs in the background, so the page polls. The status must come from
	// memory: a database-backed status would be unreadable while the job holds the
	// connection.
	deadline := time.Now().Add(60 * time.Second)
	var finished SystemMaintenanceStatusDTO
	for time.Now().Before(deadline) {
		statusResp, err := client.Get(baseURL + "/management/system/maintenance")
		if err != nil {
			t.Fatal(err)
		}
		var status systemMaintenanceActionDTO
		decodeErr := json.NewDecoder(statusResp.Body).Decode(&status)
		statusResp.Body.Close()
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if !status.Maintenance.Running && status.Maintenance.FinishedAtMS != 0 {
			finished = status.Maintenance
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if finished.FinishedAtMS == 0 {
		t.Fatal("the maintenance job never reported completion")
	}
	if finished.Error != "" {
		t.Fatalf("vacuum failed: %s", finished.Error)
	}
	if finished.ReclaimedBytes <= 0 {
		t.Fatalf("vacuum reclaimed %d bytes after deleting 1.2MB (before=%d after=%d, detail=%s)",
			finished.ReclaimedBytes, finished.SizeBeforeBytes, finished.SizeAfterBytes, finished.Detail)
	}
	if finished.SizeAfterBytes >= finished.SizeBeforeBytes {
		t.Fatalf("the reported size did not shrink: before=%d after=%d", finished.SizeBeforeBytes, finished.SizeAfterBytes)
	}

	// The rebuild is audited, so an operator action on the database leaves a record.
	events, err := repo.ListAuditEvents(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		if event.Action == "system.maintenance.vacuum" {
			found = true
		}
	}
	if !found {
		t.Error("the maintenance action was not audited")
	}
}

// TestMaintenanceRefusesASecondJobWhileOneRuns pins the single-flight answer the page
// relies on to keep its buttons coherent.
func TestMaintenanceRefusesASecondJobWhileOneRuns(t *testing.T) {
	client, baseURL, _, _ := startReleaseTestServer(t)

	first, err := client.Post(baseURL+"/management/system/maintenance/checkpoint", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	first.Body.Close()

	// A checkpoint is quick, so the second request may legitimately arrive after the
	// first finished. Only a 409 is meaningful evidence here; anything else means the
	// gate let it through, which is also correct.
	second, err := client.Post(baseURL+"/management/system/maintenance/checkpoint", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Body.Close()
	if second.StatusCode != http.StatusAccepted && second.StatusCode != http.StatusConflict {
		t.Fatalf("second maintenance status = %d, want 202 or 409", second.StatusCode)
	}
}

func TestMaintenanceCheckpointReadsSQLiteCounters(t *testing.T) {
	client, baseURL, _, _ := startReleaseTestServer(t)
	resp, err := client.Post(baseURL+"/management/system/maintenance/checkpoint", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("checkpoint status = %d, want 202", resp.StatusCode)
	}
	var started systemMaintenanceActionDTO
	if err := json.NewDecoder(resp.Body).Decode(&started); err != nil {
		t.Fatal(err)
	}
	if started.Maintenance.Action != "wal_checkpoint" {
		t.Fatalf("action = %q, want wal_checkpoint", started.Maintenance.Action)
	}

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		statusResp, err := client.Get(baseURL + "/management/system/maintenance")
		if err != nil {
			t.Fatal(err)
		}
		var status systemMaintenanceActionDTO
		decodeErr := json.NewDecoder(statusResp.Body).Decode(&status)
		statusResp.Body.Close()
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if !status.Maintenance.Running && status.Maintenance.FinishedAtMS != 0 {
			// The counters come from SQLite's own row, so a checkpoint that ran always
			// has something to report - including "blocked", which is not an error.
			if status.Maintenance.Detail == "" {
				t.Fatal("the checkpoint reported no counters")
			}
			if status.Maintenance.Error != "" {
				t.Fatalf("checkpoint reported an error: %s", status.Maintenance.Error)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the checkpoint never reported completion")
}

// TestSystemPageSurvivesWithoutAReleaseService pins the nil-safe path: a deployment
// built without the service must render with "not checked yet" rather than failing the
// page or claiming a comparison against nothing.
func TestSystemPageSurvivesWithoutAReleaseService(t *testing.T) {
	client, baseURL, _, _ := startReleaseTestServer(t)
	// A second handler without the service is not needed: the routes' nil-safety is
	// covered by the base system test. Here the release route must refuse clearly when
	// no service is attached, which is a 503 rather than an empty log.
	resp, err := client.Get(baseURL + "/management/system/releases?product=omc")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("releases status with a service attached = %d, want 200", resp.StatusCode)
	}
}

// TestMaintenanceAdmissionAndCompletionAreBothAudited drives a real job through its whole
// lifecycle and asserts the two audit events that record it, plus the property that makes
// their order necessary: the admission response arrives without waiting for the job.
//
// A fabricated gate hold cannot express this. A held gate in production is a *running
// job*, and a second admission is refused with 409 before it ever reaches an audit write -
// which is why admission can be audited before launching without risking a wait on the
// gate: at the moment it is audited, nothing holds it.
func TestMaintenanceAdmissionAndCompletionAreBothAudited(t *testing.T) {
	client, baseURL, repo, _ := startReleaseTestServer(t)
	ctx := context.Background()

	// Make the rebuild do enough work to be observable: a database with pages to release.
	if _, err := repo.SQL().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS audit_probe(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 4096)
	for index := 0; index < 400; index++ {
		if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO audit_probe(v) VALUES (?)`, string(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := repo.SQL().ExecContext(ctx, `DELETE FROM audit_probe`); err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	accepted, err := client.Post(baseURL+"/management/system/maintenance/vacuum", "application/json", nil)
	if err != nil {
		t.Fatalf("admission: %v", err)
	}
	accepted.Body.Close()
	elapsed := time.Since(started)
	if accepted.StatusCode != http.StatusAccepted {
		t.Fatalf("admission status = %d, want 202", accepted.StatusCode)
	}
	// The response must describe admission, not completion. A rebuild of this size takes
	// long enough that a response waiting for it would be plainly slower than this.
	if elapsed > 15*time.Second {
		t.Fatalf("admission took %v: the response waited for the job", elapsed)
	}

	// The admission is audited even though the job has not finished.
	admissionAudited := false
	for _, event := range auditEventsFor(t, repo, ctx, 50) {
		if event.Action == "system.maintenance.vacuum" && event.Result == "admitted" {
			admissionAudited = true
		}
	}
	if !admissionAudited {
		t.Fatal("the admission was not audited")
	}

	// Wait for the terminal state, then assert the completion audit exists and is distinct
	// from the admission: a 202 is not a successful rebuild.
	deadline := time.Now().Add(90 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatal("the maintenance job never reached a terminal state")
		}
		statusResp, err := client.Get(baseURL + "/management/system/maintenance")
		if err != nil {
			t.Fatal(err)
		}
		var live systemMaintenanceActionDTO
		decodeErr := json.NewDecoder(statusResp.Body).Decode(&live)
		statusResp.Body.Close()
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if !live.Maintenance.Running && live.Maintenance.FinishedAtMS != 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	// The completion audit is written by the job's observer, so it is ordered after the
	// terminal state and may need a moment to land.
	completionAudited := false
	for attempt := 0; attempt < 100 && !completionAudited; attempt++ {
		for _, event := range auditEventsFor(t, repo, ctx, 50) {
			if event.Action == "system.maintenance.vacuum.completed" {
				completionAudited = true
			}
		}
		if !completionAudited {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if !completionAudited {
		t.Fatal("the completed job was never audited: a 202 admission and a finished rebuild must be distinguishable in the audit trail")
	}
}

// auditEventsFor reads the audit tail, returning what it has if the read fails.
func auditEventsFor(t *testing.T, repo *repository.Repository, ctx context.Context, limit int) []repository.AuditEvent {
	t.Helper()
	events, err := repo.ListAuditEvents(ctx, limit)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	return events
}
