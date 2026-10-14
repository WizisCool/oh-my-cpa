package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/updater"
)

// fakeUpdater is the sidecar as the handler sees it. beforeUpdate runs when an update
// arrives, which is where a test observes what was already on record.
type fakeUpdater struct {
	mu           sync.Mutex
	status       updater.StatusResponse
	statusErr    error
	updateErr    error
	updates      []updater.UpdateRequest
	beforeUpdate func()
	// answers, when set, scripts the status reads: each read takes the next answer the
	// test hands over, so a test steps through a job without waiting for a fixed time.
	answers chan statusAnswer
}

type statusAnswer struct {
	status updater.StatusResponse
	err    error
}

func (f *fakeUpdater) Status(context.Context) (updater.StatusResponse, error) {
	if f.answers != nil {
		answer := <-f.answers
		return answer.status, answer.err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status, f.statusErr
}

func (f *fakeUpdater) Update(_ context.Context, request updater.UpdateRequest) (updater.Job, error) {
	if f.beforeUpdate != nil {
		f.beforeUpdate()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.updateErr != nil {
		return updater.Job{}, f.updateErr
	}
	f.updates = append(f.updates, request)
	job := updater.Job{ID: request.Product + "-1", Product: request.Product, Stage: updater.StagePulling}
	f.status.Job = &job
	return job, nil
}

func (f *fakeUpdater) finish(stage, failure string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	finished := *f.status.Job
	finished.Stage, finished.Error, finished.ToVersion = stage, failure, "v9.9.9"
	f.status.Job = &finished
}

func (f *fakeUpdater) updateCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.updates)
}

type fakeManifests struct {
	err        error
	repository string
	tag        string
}

func (f *fakeManifests) FetchManifest(_ context.Context, repository, tag string) ([]byte, string, error) {
	f.repository, f.tag = repository, tag
	if f.err != nil {
		return nil, "", f.err
	}
	return []byte(`{"schema":1}` + "\n"), "c2lnbmF0dXJl", nil
}

type updaterFixture struct {
	handler   *Handler
	sidecar   *fakeUpdater
	manifests *fakeManifests
	repo      *repository.Repository
}

func newUpdaterFixture(t *testing.T) updaterFixture {
	t.Helper()
	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_updater_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatalf("open memory repo: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	sidecar := &fakeUpdater{status: updater.StatusResponse{Products: []updater.Target{
		{Product: updater.ProductOMC, Image: "wiziscool/oh-my-cpa:latest", Action: updater.ActionAvailable},
		{Product: updater.ProductCPA, Image: "eceasy/cli-proxy-api:8.0.1", Action: updater.ActionUnavailable, Reason: updater.ReasonPinned},
	}}}
	manifests := &fakeManifests{}
	handler := &Handler{
		cfg:                config.Config{Version: "v1.0.0", Updater: config.UpdaterConfig{Enabled: true}},
		repo:               repo,
		logger:             slog.Default(),
		updatePollInterval: time.Millisecond,
		release:            &storedRelease{runningVersions: map[string]string{}},
	}
	handler.SetUpdater(sidecar, manifests, true)
	return updaterFixture{handler: handler, sidecar: sidecar, manifests: manifests, repo: repo}
}

func (f updaterFixture) apply(t *testing.T, product string) (int, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/omc/api/v1/management/system/updater/apply", strings.NewReader(`{"product":"`+product+`"}`))
	// The middleware gives each request one ID; every row it writes carries it.
	request = request.WithContext(context.WithValue(request.Context(), requestIDKey{}, "apply-request"))
	f.handler.postSystemUpdaterApply(recorder, request)
	body := map[string]any{}
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	return recorder.Code, body
}

func (f updaterFixture) audits(t *testing.T, action string) []repository.AuditEvent {
	t.Helper()
	events, err := f.repo.ListAuditEvents(context.Background(), 50)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	matching := make([]repository.AuditEvent, 0)
	for _, event := range events {
		if event.Action == action {
			matching = append(matching, event)
		}
	}
	return matching
}

func readUpdater(t *testing.T, handler *Handler) SystemUpdaterDTO {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.getSystemUpdater(recorder, httptest.NewRequest(http.MethodGet, "/omc/api/v1/management/system/updater", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: an absent updater is a state, not a failure", recorder.Code)
	}
	var dto SystemUpdaterDTO
	if err := json.Unmarshal(recorder.Body.Bytes(), &dto); err != nil {
		t.Fatal(err)
	}
	return dto
}

func TestSystemUpdaterNamesEveryWayOfNotHavingOne(t *testing.T) {
	if state := readUpdater(t, &Handler{}).State; state != updaterDisabled {
		t.Errorf("no client: %q", state)
	}
	fixture := newUpdaterFixture(t)

	fixture.handler.isContainerised = false
	if state := readUpdater(t, fixture.handler).State; state != updaterNotContainerised {
		t.Errorf("a native install has nothing to replace: %q", state)
	}
	fixture.handler.isContainerised = true

	fixture.sidecar.statusErr = updater.ErrUnreachable
	if state := readUpdater(t, fixture.handler).State; state != updaterNotInstalled {
		t.Errorf("an unreachable sidecar is one the operator can install: %q", state)
	}
	fixture.sidecar.statusErr = &updater.RefusedError{Status: http.StatusUnauthorized, Code: "unauthorized"}
	if state := readUpdater(t, fixture.handler).State; state != updaterRejected {
		t.Errorf("a sidecar that refuses this console's token: %q", state)
	}
	fixture.sidecar.statusErr = nil

	fixture.handler.cfg.Updater.Enabled = false
	if state := readUpdater(t, fixture.handler).State; state != updaterDisabled {
		t.Errorf("switched off by the operator: %q", state)
	}
	fixture.handler.cfg.Updater.Enabled = true

	fixture.sidecar.status.Job = &updater.Job{ID: "cpa-1", Product: updater.ProductCPA, Stage: updater.StageFailed, Error: "pull failed: Authorization: Bearer sk-live-0123456789abcdef0123"}
	dto := readUpdater(t, fixture.handler)
	if dto.State != updaterReady || len(dto.Products) != 2 || dto.Products[1].Reason != updater.ReasonPinned {
		t.Fatalf("ready = %+v", dto)
	}
	if dto.Job == nil || !dto.Job.Finished || strings.Contains(dto.Job.Error, "sk-live-0123456789abcdef0123") {
		t.Errorf("a job's error is remote text and must be redacted: %+v", dto.Job)
	}
}

func TestApplyRecordsAdmissionBeforeTheSidecarIsAsked(t *testing.T) {
	fixture := newUpdaterFixture(t)
	recordedFirst := 0
	fixture.sidecar.beforeUpdate = func() { recordedFirst = len(fixture.audits(t, "system.update.apply")) }

	status, body := fixture.apply(t, updater.ProductOMC)
	if status != http.StatusAccepted {
		t.Fatalf("status = %d %v", status, body)
	}
	if recordedFirst != 1 {
		t.Fatalf("the admission must be on record before a container is touched, found %d records", recordedFirst)
	}
	admission := fixture.audits(t, "system.update.apply")[0]
	if admission.Result != "admitted" || admission.TargetID != updater.ProductOMC || admission.Details["target_version"] != "v9.9.9" {
		t.Errorf("admission = %+v", admission)
	}
	sent := fixture.sidecar.updates[0]
	if sent.Manifest != `{"schema":1}`+"\n" || sent.Signature != "c2lnbmF0dXJl" {
		t.Errorf("the manifest must reach the sidecar byte for byte: %+v", sent)
	}
	if fixture.manifests.tag != "v9.9.9" {
		t.Errorf("only the offered release's manifest is fetched, got %q", fixture.manifests.tag)
	}
}

func TestApplyIsRefusedWhenItCannotBeRecorded(t *testing.T) {
	fixture := newUpdaterFixture(t)
	if _, err := fixture.repo.SQL().Exec("DROP TABLE audit_events"); err != nil {
		t.Fatalf("drop audit_events: %v", err)
	}
	status, body := fixture.apply(t, updater.ProductOMC)
	if status != http.StatusInternalServerError || body["code"] != auditWriteFailedCode {
		t.Fatalf("status = %d %v", status, body)
	}
	if fixture.sidecar.updateCount() != 0 {
		t.Fatalf("an update that left no record must not run")
	}
}

func TestApplyRefusesWithoutAskingTheSidecar(t *testing.T) {
	t.Run("a product the sidecar reports unavailable", func(t *testing.T) {
		fixture := newUpdaterFixture(t)
		status, body := fixture.apply(t, updater.ProductCPA)
		if status != http.StatusConflict || body["code"] != updater.ReasonPinned || fixture.sidecar.updateCount() != 0 {
			t.Fatalf("status = %d %v", status, body)
		}
		if audits := fixture.audits(t, "system.update.apply"); len(audits) != 1 || audits[0].Result != "rejected" {
			t.Errorf("a refusal is recorded as one: %+v", audits)
		}
	})
	t.Run("a console already on the newest release", func(t *testing.T) {
		fixture := newUpdaterFixture(t)
		fixture.handler.release = &upToDateRelease{}
		status, body := fixture.apply(t, updater.ProductOMC)
		if status != http.StatusConflict || body["code"] != "no_update_available" || fixture.sidecar.updateCount() != 0 {
			t.Fatalf("status = %d %v", status, body)
		}
		if fixture.manifests.tag != "" {
			t.Errorf("no manifest is fetched when there is nothing to install")
		}
	})
	t.Run("a release without a signed manifest", func(t *testing.T) {
		fixture := newUpdaterFixture(t)
		fixture.manifests.err = release.ErrManifestMissing
		status, body := fixture.apply(t, updater.ProductOMC)
		if status != http.StatusBadGateway || body["code"] != "manifest_missing" || fixture.sidecar.updateCount() != 0 {
			t.Fatalf("status = %d %v", status, body)
		}
	})
	t.Run("no sidecar", func(t *testing.T) {
		fixture := newUpdaterFixture(t)
		fixture.sidecar.statusErr = updater.ErrUnreachable
		status, body := fixture.apply(t, updater.ProductOMC)
		if status != http.StatusConflict || body["code"] != "updater_"+updaterNotInstalled {
			t.Fatalf("status = %d %v", status, body)
		}
	})
	t.Run("a name that is not a product", func(t *testing.T) {
		fixture := newUpdaterFixture(t)
		if status, _ := fixture.apply(t, "oh-my-cpa"); status != http.StatusBadRequest {
			t.Fatalf("status = %d", status)
		}
	})
}

type upToDateRelease struct{ ReleaseManager }

func (upToDateRelease) Status(_ context.Context, product, _ string) (release.ProductStatus, error) {
	return release.ProductStatus{Product: product, Comparison: release.Comparison{State: release.UpToDate}}, nil
}

func TestUpdateOutcomeIsRecordedOnceEvenAcrossARestart(t *testing.T) {
	fixture := newUpdaterFixture(t)
	if status, body := fixture.apply(t, updater.ProductOMC); status != http.StatusAccepted {
		t.Fatalf("status = %d %v", status, body)
	}
	fixture.sidecar.finish(updater.StageRolledBack, "the replacement exited after starting")

	fixture.handler.updateWatchers.Wait()
	outcomes := fixture.audits(t, "system.update.completed")
	if len(outcomes) != 1 || outcomes[0].Result != "failure" || outcomes[0].Details["stage"] != updater.StageRolledBack {
		t.Fatalf("a rolled-back job is a failure on record: %+v", outcomes)
	}

	// The replacement process asks the sidecar what happened; the outcome is there
	// already, so nothing is written twice.
	fixture.handler.RecordInterruptedUpdate(context.Background())
	if again := fixture.audits(t, "system.update.completed"); len(again) != 1 {
		t.Fatalf("the same job must not be recorded twice: %d", len(again))
	}
}

func TestInterruptedConsoleUpdateIsRecordedByTheNextProcess(t *testing.T) {
	fixture := newUpdaterFixture(t)
	fixture.sidecar.answers = make(chan statusAnswer)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		fixture.handler.RecordInterruptedUpdate(context.Background())
	}()
	answer := func(stage string, err error) {
		t.Helper()
		job := updater.Job{ID: "omc-7", Product: updater.ProductOMC, Stage: stage, FromVersion: "v1.0.0", ToVersion: "v1.1.0"}
		select {
		case fixture.sidecar.answers <- statusAnswer{status: updater.StatusResponse{Job: &job}, err: err}:
		case <-finished:
			t.Fatal("the outcome must be waited for until the job finishes")
		}
	}

	// The process that replaced the console starts while the update is still verifying
	// it, and the sidecar then replaces itself, so it is briefly unreachable.
	answer(updater.StageVerifying, nil)
	answer("", errors.New("dial tcp: lookup oh-my-cpa-updater: no such host"))
	answer(updater.StageVerifying, nil)
	if recorded := fixture.audits(t, "system.update.completed"); len(recorded) != 0 {
		t.Fatalf("an unfinished job has no outcome yet: %+v", recorded)
	}
	answer(updater.StageDone, nil)
	<-finished

	outcomes := fixture.audits(t, "system.update.completed")
	if len(outcomes) != 1 || outcomes[0].Result != "success" || outcomes[0].Details["job_id"] != "omc-7" || outcomes[0].Details["to_version"] != "v1.1.0" {
		t.Fatalf("the process that replaced the console records the outcome: %+v", outcomes)
	}
}

func TestARefusalAfterAdmissionIsThatAdmissionsOutcome(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantResult string
		wantReason string
	}{
		{"refused", &updater.RefusedError{Status: http.StatusConflict, Code: "busy", Message: "an update is already running"}, http.StatusConflict, "rejected", "busy"},
		{"unreachable", updater.ErrUnreachable, http.StatusBadGateway, "failure", "updater_unreachable"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newUpdaterFixture(t)
			fixture.sidecar.updateErr = testCase.err
			if status, body := fixture.apply(t, updater.ProductOMC); status != testCase.wantStatus {
				t.Fatalf("status = %d %v", status, body)
			}
			// One attempt is one apply row; what the updater did with it is its outcome.
			applies := fixture.audits(t, "system.update.apply")
			if len(applies) != 1 || applies[0].Result != "admitted" {
				t.Fatalf("one attempt, one admission: %+v", applies)
			}
			outcomes := fixture.audits(t, "system.update.completed")
			if len(outcomes) != 1 || outcomes[0].Result != testCase.wantResult || outcomes[0].Details["reason"] != testCase.wantReason || outcomes[0].RequestID != applies[0].RequestID {
				t.Fatalf("the refusal is the admission's outcome, on the same request: %+v", outcomes)
			}
		})
	}
}

func TestAnOutcomeOlderThanOneAuditPageIsStillFound(t *testing.T) {
	fixture := newUpdaterFixture(t)
	job := updater.Job{ID: "omc-7", Product: updater.ProductOMC, Stage: updater.StageDone}
	fixture.handler.auditUpdateOutcome(job)
	for i := 0; i < repository.AuditPageMax; i++ {
		fixture.handler.auditUpdateOutcome(updater.Job{ID: fmt.Sprintf("cpa-%d", i), Product: updater.ProductCPA, Stage: updater.StageDone})
	}

	if !fixture.handler.isUpdateOutcomeRecorded(context.Background(), job.ID) {
		t.Fatal("an outcome a full page back is on record and must not be written again")
	}
	if fixture.handler.isUpdateOutcomeRecorded(context.Background(), "omc-unknown") {
		t.Fatal("a job with no outcome row is not on record")
	}
}

func TestShutdownEndsTheWaitForAnUpdateOutcome(t *testing.T) {
	fixture := newUpdaterFixture(t)
	if status, body := fixture.apply(t, updater.ProductOMC); status != http.StatusAccepted {
		t.Fatalf("status = %d %v", status, body)
	}
	fixture.handler.WatchInterruptedUpdate()

	// The job never finishes; closing must still return, so the database can close
	// after it with no watcher left to write.
	fixture.handler.CloseUpdateWatchers()
	if outcomes := fixture.audits(t, "system.update.completed"); len(outcomes) != 0 {
		t.Fatalf("an unfinished job has no outcome to record: %+v", outcomes)
	}
}

// The mock the browser probes and the typed client's contract suite answer with is
// this corpus; certifying it here is what keeps those layers on the handler's wire.
func TestSystemUpdaterSharedWireContract(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/acceptance/contracts/system-updater.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Version      int             `json:"version"`
		Ready        json.RawMessage `json:"ready"`
		NotInstalled json.RawMessage `json:"not_installed"`
		Accepted     struct {
			Body   json.RawMessage `json:"body"`
			Status int             `json:"status"`
			Job    json.RawMessage `json:"job"`
		} `json:"accepted"`
		Refusals []struct {
			ID       string          `json:"id"`
			Body     json.RawMessage `json:"body"`
			Status   int             `json:"status"`
			Response json.RawMessage `json:"response"`
		} `json:"refusals"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.Version != 1 || len(contract.Refusals) == 0 {
		t.Fatal("unsupported or empty updater contract")
	}
	assertWire := func(name string, actual []byte, expected json.RawMessage) {
		t.Helper()
		var actualValue, expectedValue any
		if err := json.Unmarshal(actual, &actualValue); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := json.Unmarshal(expected, &expectedValue); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !reflect.DeepEqual(actualValue, expectedValue) {
			t.Errorf("%s wire drift:\nactual   %s\nexpected %s", name, actual, expected)
		}
	}
	read := func(handler *Handler) []byte {
		recorder := httptest.NewRecorder()
		handler.getSystemUpdater(recorder, httptest.NewRequest(http.MethodGet, "/omc/api/v1/management/system/updater", nil))
		return recorder.Body.Bytes()
	}
	post := func(handler *Handler, body json.RawMessage) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		handler.postSystemUpdaterApply(recorder, httptest.NewRequest(http.MethodPost, "/omc/api/v1/management/system/updater/apply", bytes.NewReader(body)))
		return recorder
	}

	assertWire("ready", read(newUpdaterFixture(t).handler), contract.Ready)
	absent := newUpdaterFixture(t)
	absent.sidecar.statusErr = updater.ErrUnreachable
	assertWire("not_installed", read(absent.handler), contract.NotInstalled)

	accepted := post(newUpdaterFixture(t).handler, contract.Accepted.Body)
	if accepted.Code != contract.Accepted.Status {
		t.Fatalf("accepted status = %d, want %d", accepted.Code, contract.Accepted.Status)
	}
	var admitted struct {
		Job json.RawMessage `json:"job"`
	}
	if err := json.Unmarshal(accepted.Body.Bytes(), &admitted); err != nil {
		t.Fatal(err)
	}
	assertWire("accepted job", admitted.Job, contract.Accepted.Job)

	for _, refusal := range contract.Refusals {
		response := post(newUpdaterFixture(t).handler, refusal.Body)
		if response.Code != refusal.Status {
			t.Errorf("%s status = %d, want %d", refusal.ID, response.Code, refusal.Status)
		}
		assertWire(refusal.ID, response.Body.Bytes(), refusal.Response)
	}
}
