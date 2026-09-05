package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type recordedCPARequest struct {
	Method string
	Path   string
	Query  string
	Body   string
}

type cpaRecorder struct {
	mu       sync.Mutex
	requests []recordedCPARequest
}

func (r *cpaRecorder) record(request *http.Request) {
	body, _ := io.ReadAll(request.Body)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests = append(r.requests, recordedCPARequest{
		Method: request.Method,
		Path:   request.URL.Path,
		Query:  request.URL.RawQuery,
		Body:   string(body),
	})
}

func (r *cpaRecorder) all() []recordedCPARequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recordedCPARequest(nil), r.requests...)
}

func (r *cpaRecorder) last(t *testing.T, method, path string) recordedCPARequest {
	t.Helper()
	var found *recordedCPARequest
	for index := range r.requests {
		if r.requests[index].Method == method && r.requests[index].Path == path {
			candidate := r.requests[index]
			found = &candidate
		}
	}
	if found == nil {
		t.Fatalf("no CPA %s %s recorded in %#v", method, path, r.requests)
	}
	return *found
}

// startAuthFilesTestServer wires the real router to a fake CPA Management API
// through a configured default instance, exactly as the running product does.
func startAuthFilesTestServer(t *testing.T, managementKey string, handler func(http.ResponseWriter, *http.Request)) (*http.Client, string, *cpaRecorder) {
	t.Helper()
	recorder := &cpaRecorder{}
	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		if managementKey != "" && request.Header.Get("Authorization") != "Bearer "+managementKey {
			writer.WriteHeader(http.StatusUnauthorized)
			_, _ = writer.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		handler(writer, request)
	}))
	t.Cleanup(cpaServer.Close)

	db, err := repository.Open(context.Background(), authFilesMemoryDSN("auth_files_facade"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("management-secret-value"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID: "default", Name: "Test CPA", BaseURL: cpaServer.URL,
		ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	authManager, err := auth.New("management-secret-value", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	appHandler := NewHandler(config.Config{BasePath: "/omc", Version: "test", RequestTimeout: 5 * time.Second}, repo, cipher, nil, authManager)
	server := httptest.NewServer(appHandler.Router())
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	login, err := client.Post(server.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret-value"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	if login.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d", login.StatusCode)
	}
	return client, server.URL, recorder
}

func doJSON(t *testing.T, client *http.Client, method, url, body string) (*http.Response, []byte) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = bytes.NewBufferString(body)
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, raw
}

var authFilesDBCounter int

func authFilesMemoryDSN(purpose string) string {
	authFilesDBCounter++
	return fmt.Sprintf("file:memdb_%s_%d?mode=memory&cache=shared", purpose, authFilesDBCounter)
}

func TestManagementAuthFilesFacadeProjectsAndForwards(t *testing.T) {
	const refreshToken = "super-secret-refresh-token"
	const filesFixture = `{"files":[
	{"id":"claude-id","name":"claude.json","auth_index":"idx-1","type":"claude","provider":"claude","status":"ok","email":"owner@example.test","success":10,"failed":2,
	"models":[{"id":"claude-sonnet","display_name":"Sonnet"}],"recent_requests":[{"time":"2026-01-01T00:00:00Z","success":3,"failed":1}],
	"quota":{"observed_at":"2026-01-01T00:00:00Z","signals":{"state":"ok"}},"model_quotas":{"claude-sonnet":{"signals":{"state":"throttled"}}},
	"priority":5,"weight":3,"note":"primary","created_at":"2026-01-01T00:00:00Z","updated_at":1767225600,"last_refresh":null,
	"path":"/var/cpa/secrets/claude.json","account":"REFRESH_TOKEN_SECRET","metadata":{"refresh_token":"REFRESH_TOKEN_SECRET"}},
	{"name":"a-missing.json","provider":"gemini","status":"failed","runtime_only":true}]}`

	handler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.URL.Path == "/v0/management/auth-files/models":
			_, _ = writer.Write([]byte(`{"models":[{"id":"gemini-pro","display_name":"Gemini Pro"},{"id":"","display_name":"skip me"}]}`))
		case request.URL.Path == "/v0/management/auth-files/download":
			_, _ = writer.Write([]byte(`{"refresh_token":"` + refreshToken + `"}`))
		case request.URL.Path == "/v0/management/auth-files/status",
			request.URL.Path == "/v0/management/auth-files/fields":
			_, _ = writer.Write([]byte(`{"status":"success"}`))
		case request.URL.Path == "/v0/management/auth-files" && request.Method == http.MethodGet:
			_, _ = writer.Write([]byte(filesFixture))
		default:
			_, _ = writer.Write([]byte(`{"status":"success"}`))
		}
	}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", handler)
	base := baseURL + "/omc/api/v1/management/auth-files"

	response, raw := doJSON(t, client, http.MethodGet, base, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d body = %s", response.StatusCode, raw)
	}
	var listed managementAuthFilesResponse
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if listed.Total != 2 || len(listed.Files) != 2 {
		t.Fatalf("listed = %#v", listed)
	}
	if listed.Files[0].Name != "a-missing.json" || !listed.Files[0].RuntimeOnly {
		t.Fatalf("first file = %#v", listed.Files[0])
	}
	claude := listed.Files[1]
	if claude.Name != "claude.json" || claude.AuthIndex != "idx-1" || claude.Type != "claude" || claude.Email != "owner@example.test" {
		t.Fatalf("projection = %#v", claude)
	}
	if claude.Success != 10 || claude.Failed != 2 || claude.Priority != 5 || claude.Weight != 3 || claude.Note != "primary" {
		t.Fatalf("stats projection = %#v", claude)
	}
	if len(claude.RecentRequests) != 1 || claude.RecentRequests[0].Success != 3 || claude.RecentRequests[0].Failed != 1 {
		t.Fatalf("recent requests = %#v", claude.RecentRequests)
	}
	if claude.Quota == nil || claude.Quota.Signals["state"] != "ok" {
		t.Fatalf("quota = %#v", claude.Quota)
	}
	if claude.ModelQuotas["claude-sonnet"].Signals["state"] != "throttled" {
		t.Fatalf("model quotas = %#v", claude.ModelQuotas)
	}
	if len(claude.Models) != 1 || claude.Models[0].ID != "claude-sonnet" {
		t.Fatalf("models = %#v", claude.Models)
	}
	for _, secret := range []string{"REFRESH_TOKEN_SECRET", "management-secret-value", "/var/cpa", `"path"`, `"metadata"`} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("auth-files list leaked %q: %s", secret, raw)
		}
	}

	response, raw = doJSON(t, client, http.MethodGet, base+"?name=claude.json", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("filtered list status = %d body = %s", response.StatusCode, raw)
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if listed.Total != 1 || listed.Files[0].Name != "claude.json" {
		t.Fatalf("filtered list = %#v", listed)
	}

	response, raw = doJSON(t, client, http.MethodGet, base+"?auth_index=idx-1", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("auth index filter status = %d body = %s", response.StatusCode, raw)
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if listed.Total != 1 || listed.Files[0].AuthIndex != "idx-1" {
		t.Fatalf("auth index filter = %#v", listed)
	}

	response, raw = doJSON(t, client, http.MethodPatch, base+"/status", `{"name":"claude.json","auth_index":"idx-1","disabled":true}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status patch = %d body = %s", response.StatusCode, raw)
	}
	var forwardedStatus map[string]any
	if err := json.Unmarshal([]byte(recorder.last(t, http.MethodPatch, "/v0/management/auth-files/status").Body), &forwardedStatus); err != nil {
		t.Fatal(err)
	}
	if forwardedStatus["name"] != "claude.json" || forwardedStatus["auth_index"] != "idx-1" || forwardedStatus["disabled"] != true {
		t.Fatalf("forwarded status body = %#v", forwardedStatus)
	}

	response, raw = doJSON(t, client, http.MethodPatch, base+"/fields", `{"name":"claude.json","priority":10,"websockets":false,"note":"renamed","excluded_models":["x"],"proxy_url":"","using-api":true}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("fields patch = %d body = %s", response.StatusCode, raw)
	}
	var forwardedFields map[string]any
	if err := json.Unmarshal([]byte(recorder.last(t, http.MethodPatch, "/v0/management/auth-files/fields").Body), &forwardedFields); err != nil {
		t.Fatal(err)
	}
	if forwardedFields["name"] != "claude.json" || forwardedFields["priority"] != float64(10) || forwardedFields["note"] != "renamed" {
		t.Fatalf("forwarded fields body = %#v", forwardedFields)
	}
	if _, exists := forwardedFields["using-api"]; exists {
		t.Fatalf("kebab-case alias was not canonicalised: %#v", forwardedFields)
	}
	if forwardedFields["using_api"] != true {
		t.Fatalf("using_api alias = %#v", forwardedFields["using_api"])
	}

	response, raw = doJSON(t, client, http.MethodPost, base+"?name=uploaded.json", `{"type":"gemini","token":"secret-token"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("raw upload = %d body = %s", response.StatusCode, raw)
	}
	upload := recorder.last(t, http.MethodPost, "/v0/management/auth-files")
	if !strings.Contains(upload.Query, "name=uploaded.json") {
		t.Fatalf("upload query = %q", upload.Query)
	}
	if !strings.Contains(upload.Body, "secret-token") {
		t.Fatalf("upload body was not forwarded verbatim: %q", upload.Body)
	}

	uploadBody := &bytes.Buffer{}
	form := multipart.NewWriter(uploadBody)
	part, err := form.CreateFormFile("file", "good.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(`{"type":"claude"}`)); err != nil {
		t.Fatal(err)
	}
	part, err = form.CreateFormFile("file", "bad.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(`["not an object"]`)); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	multipartRequest, err := http.NewRequest(http.MethodPost, base, uploadBody)
	if err != nil {
		t.Fatal(err)
	}
	multipartRequest.Header.Set("Content-Type", form.FormDataContentType())
	multipartResponse, err := client.Do(multipartRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer multipartResponse.Body.Close()
	multipartRaw, err := io.ReadAll(multipartResponse.Body)
	if err != nil {
		t.Fatal(err)
	}
	if multipartResponse.StatusCode != http.StatusMultiStatus {
		t.Fatalf("multipart upload status = %d body = %s", multipartResponse.StatusCode, multipartRaw)
	}
	var partial map[string]any
	if err := json.Unmarshal(multipartRaw, &partial); err != nil {
		t.Fatal(err)
	}
	if partial["uploaded"] != float64(1) {
		t.Fatalf("multipart result = %#v", partial)
	}
	if failed, ok := partial["failed"].([]any); !ok || len(failed) != 1 {
		t.Fatalf("multipart failures = %#v", partial["failed"])
	}

	response, raw = doJSON(t, client, http.MethodDelete, base, `{"name":"claude.json","names":["claude.json","second.json"]}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d body = %s", response.StatusCode, raw)
	}
	var forwardedDelete struct {
		Names []string `json:"names"`
	}
	if err := json.Unmarshal([]byte(recorder.last(t, http.MethodDelete, "/v0/management/auth-files").Body), &forwardedDelete); err != nil {
		t.Fatal(err)
	}
	if len(forwardedDelete.Names) != 2 || forwardedDelete.Names[0] != "claude.json" || forwardedDelete.Names[1] != "second.json" {
		t.Fatalf("forwarded delete names = %#v", forwardedDelete.Names)
	}

	downloadResponse, err := client.Get(base + "/download?name=claude.json")
	if err != nil {
		t.Fatal(err)
	}
	downloadRaw, err := io.ReadAll(downloadResponse.Body)
	downloadResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if downloadResponse.StatusCode != http.StatusOK {
		t.Fatalf("download status = %d body = %s", downloadResponse.StatusCode, downloadRaw)
	}
	if downloadResponse.Header.Get("Content-Disposition") != `attachment; filename="claude.json"` {
		t.Fatalf("download disposition = %q", downloadResponse.Header.Get("Content-Disposition"))
	}
	if downloadResponse.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("download cache-control = %q", downloadResponse.Header.Get("Cache-Control"))
	}
	if !strings.Contains(string(downloadRaw), refreshToken) {
		t.Fatalf("download should return the raw auth file for the admin: %s", downloadRaw)
	}

	response, raw = doJSON(t, client, http.MethodGet, base+"/models?name=a-missing.json", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("models = %d body = %s", response.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "gemini-pro") || strings.Contains(string(raw), "skip me") {
		t.Fatalf("models projection = %s", raw)
	}
}

func TestManagementAuthFilesFacadeGuardrails(t *testing.T) {
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(request.URL.Path, "/models") {
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"error":"not found"}`))
			return
		}
		_, _ = writer.Write([]byte(`{"files":[]}`))
	})
	base := baseURL + "/omc/api/v1/management/auth-files"

	for _, probe := range []struct {
		method, url, body string
		want              int
	}{
		{http.MethodGet, base + "/models?name=..%2Fescape.json", "", http.StatusBadRequest},
		{http.MethodGet, base + "/models?name=a%5Cb.json", "", http.StatusBadRequest},
		{http.MethodPost, base + "?name=notes.txt", `{"a":1}`, http.StatusBadRequest},
		{http.MethodPost, base + "?name=valid.json", `[1,2]`, http.StatusBadRequest},
		{http.MethodPost, base + "?name=valid.json", `null`, http.StatusBadRequest},
		{http.MethodPatch, base + "/fields", `{"name":"a.json","api_key":"nope"}`, http.StatusBadRequest},
		{http.MethodPatch, base + "/fields", `{"name":"a.json","priority":"fast"}`, http.StatusBadRequest},
		{http.MethodPatch, base + "/fields", `{"name":"a.json","note":123}`, http.StatusBadRequest},
		{http.MethodPatch, base + "/fields", `{"name":"a.json"}`, http.StatusBadRequest},
		{http.MethodPatch, base + "/status", `{"name":"a.json"}`, http.StatusBadRequest},
		{http.MethodPatch, base + "/status", `{"name":"..","disabled":true}`, http.StatusBadRequest},
		{http.MethodDelete, base, `{"names":[]}`, http.StatusBadRequest},
		{http.MethodGet, base + "/download?name=notes.txt", "", http.StatusBadRequest},
	} {
		response, raw := doJSON(t, client, probe.method, probe.url, probe.body)
		if response.StatusCode != probe.want {
			t.Fatalf("%s %s status = %d want %d body = %s", probe.method, probe.url, response.StatusCode, probe.want, raw)
		}
	}

	// A missing CPA capability must not be reported as an empty list.
	response, raw := doJSON(t, client, http.MethodGet, base+"/models?name=a.json", "")
	if response.StatusCode != http.StatusNotImplemented {
		t.Fatalf("capability status = %d body = %s", response.StatusCode, raw)
	}
	var failure map[string]string
	if err := json.Unmarshal(raw, &failure); err != nil {
		t.Fatal(err)
	}
	if failure["code"] != "capability_missing" {
		t.Fatalf("capability failure = %#v", failure)
	}

	// An unconfigured instance must be reported explicitly rather than empty.
	db, err := repository.Open(context.Background(), authFilesMemoryDSN("auth_files_facade"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	authManager, err := auth.New("management-secret-value", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	emptyHandler := NewHandler(config.Config{BasePath: "/omc", Version: "test", RequestTimeout: time.Second}, repository.New(db), cipher, nil, authManager)
	emptyServer := httptest.NewServer(emptyHandler.Router())
	defer emptyServer.Close()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	emptyClient := &http.Client{Jar: jar}
	login, err := emptyClient.Post(emptyServer.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret-value"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	unconfigured, raw := doJSON(t, emptyClient, http.MethodGet, emptyServer.URL+"/omc/api/v1/management/auth-files", "")
	if unconfigured.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured status = %d body = %s", unconfigured.StatusCode, raw)
	}

	unauthenticated, err := http.Get(emptyServer.URL + "/omc/api/v1/management/auth-files")
	if err != nil {
		t.Fatal(err)
	}
	unauthenticated.Body.Close()
	if unauthenticated.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", unauthenticated.StatusCode)
	}
}

func TestManagementAuthFileListProjectionSurvivesUnexpectedTimeFormats(t *testing.T) {
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"files":[
			{"name":"string-time.json","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z","last_refresh":"2026-01-03T00:00:00Z"},
			{"name":"number-time.json","created_at":1767225600,"updated_at":1767225600.5,"last_refresh":null},
			{"name":"absent-time.json"}
		]}`))
	})
	response, raw := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/auth-files", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.StatusCode, raw)
	}
	var listed managementAuthFilesResponse
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if listed.Total != 3 {
		t.Fatalf("files = %#v", listed.Files)
	}
	if listed.Files[0].Name != "absent-time.json" || listed.Files[2].Name != "string-time.json" {
		t.Fatalf("unexpected ordering: %#v", listed.Files)
	}
}

func TestManagementAuthFilesPartialDeletion(t *testing.T) {
	handler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/v0/management/auth-files" && request.Method == http.MethodDelete {
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{"deleted":1,"files":["ok.json"],"failed":[{"name":"missing.json","error":"file not found","upstream_secret":"LEAK_ME"}]}`))
			return
		}
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"status":"success"}`))
	}
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", handler)
	base := baseURL + "/omc/api/v1/management/auth-files"

	response, raw := doJSON(t, client, http.MethodDelete, base, `{"names":["ok.json","missing.json"]}`)
	if response.StatusCode != http.StatusMultiStatus {
		t.Fatalf("expected status 207, got %d: %s", response.StatusCode, raw)
	}
	var res struct {
		Status  string `json:"status"`
		Deleted int    `json:"deleted"`
		Files   []string `json:"files"`
		Failed  []struct {
			Name  string `json:"name"`
			Error string `json:"error"`
		} `json:"failed"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		t.Fatal(err)
	}
	if res.Status != "partial" {
		t.Fatalf("expected status partial, got %v", res.Status)
	}
	if res.Deleted != 1 {
		t.Fatalf("expected deleted 1, got %v", res.Deleted)
	}
	if len(res.Files) != 1 || res.Files[0] != "ok.json" {
		t.Fatalf("expected files to contain only confirmed deleted ['ok.json'], got %#v", res.Files)
	}
	if len(res.Failed) != 1 || res.Failed[0].Name != "missing.json" {
		t.Fatalf("expected 1 failure for missing.json, got %#v", res.Failed)
	}
	if strings.Contains(string(raw), "LEAK_ME") {
		t.Fatalf("expected deletion response to sanitize arbitrary upstream fields, leaked: %s", raw)
	}
}

func TestManagementAuthFilesAllFailureDeletion(t *testing.T) {
	handler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/v0/management/auth-files" && request.Method == http.MethodDelete {
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{"deleted":0,"files":[],"failed":[{"name":"fail1.json","error":"denied"},{"name":"fail2.json","error":"denied"}]}`))
			return
		}
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"status":"success"}`))
	}
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", handler)
	base := baseURL + "/omc/api/v1/management/auth-files"

	response, raw := doJSON(t, client, http.MethodDelete, base, `{"names":["fail1.json","fail2.json"]}`)
	if response.StatusCode != http.StatusMultiStatus {
		t.Fatalf("expected status 207, got %d: %s", response.StatusCode, raw)
	}
	var res struct {
		Status  string `json:"status"`
		Deleted int    `json:"deleted"`
		Files   []string `json:"files"`
		Failed  []struct {
			Name  string `json:"name"`
			Error string `json:"error"`
		} `json:"failed"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		t.Fatal(err)
	}
	if res.Status != "failure" {
		t.Fatalf("expected status failure, got %v", res.Status)
	}
	if res.Deleted != 0 {
		t.Fatalf("expected deleted 0, got %v", res.Deleted)
	}
	if len(res.Files) != 0 {
		t.Fatalf("expected files to be empty on all failure, got %#v", res.Files)
	}
	if len(res.Failed) != 2 {
		t.Fatalf("expected 2 failures, got %#v", res.Failed)
	}
}
