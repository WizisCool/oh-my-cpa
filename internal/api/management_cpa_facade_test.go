package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// The editors key their recovery on the facade's code: a write CPA refused
// because another writer saved first reads as the revision conflict they
// already reload on, unless part of the change set had landed; a body CPA
// caps is named as such instead of a generic upstream failure.
func TestWriteCPAFacadeErrorNamesConfigConflictsAndBodyLimits(t *testing.T) {
	precondition := &management.HTTPError{StatusCode: http.StatusPreconditionFailed, Body: `{"error":"precondition_failed"}`}
	changed := fmt.Errorf("%w: %w", management.ErrConfigChanged, precondition)
	for _, testCase := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "conflict", err: changed, status: http.StatusConflict, code: "config_conflict"},
		{name: "conflict after a landed request", err: fmt.Errorf("%w: %w", management.ErrConfigPartiallyApplied, changed), status: http.StatusBadGateway, code: "config_partially_applied"},
		{name: "body limit", err: &management.HTTPError{StatusCode: http.StatusRequestEntityTooLarge, Body: `{"error":"http: request body too large"}`}, status: http.StatusRequestEntityTooLarge, code: "cpa_request_too_large"},
		{name: "local yaml limit", err: management.ErrConfigYAMLTooLarge, status: http.StatusRequestEntityTooLarge, code: requestTooLargeCode},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			writeCPAFacadeError(recorder, testCase.err)
			var body map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if recorder.Code != testCase.status || body["code"] != testCase.code {
				t.Fatalf("status %d code %q, want %d %q", recorder.Code, body["code"], testCase.status, testCase.code)
			}
		})
	}
}

func TestDecodeManagementJSONDistinguishesTooLargeFromMalformed(t *testing.T) {
	type sample struct {
		Value string `json:"value"`
	}
	assert413 := func(t *testing.T, body string, limit int64) {
		t.Helper()
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(body))
		var out sample
		if err := decodeManagementJSON(recorder, request, limit, &out); err == nil {
			t.Fatal("expected error for oversized body")
		}
		if recorder.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d body = %s, want 413", recorder.Code, recorder.Body.String())
		}
		var errBody ErrorResponseDTO
		if err := json.Unmarshal(recorder.Body.Bytes(), &errBody); err != nil {
			t.Fatalf("decode error payload: %v", err)
		}
		if errBody.Code != requestTooLargeCode || !strings.Contains(errBody.Error, fmt.Sprintf("%d", limit)) {
			t.Fatalf("413 payload = %+v", errBody)
		}
	}

	t.Run("overflow during primary decode", func(t *testing.T) {
		assert413(t, `{"value":"`+strings.Repeat("a", 64)+`"}`, 32)
	})

	t.Run("overflow during trailing bytes check", func(t *testing.T) {
		assert413(t, `{"value":"ok"}`+strings.Repeat(" ", 64), 32)
	})

	t.Run("malformed JSON still returns 400", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(`{"value":`))
		var out sample
		if err := decodeManagementJSON(recorder, request, 1024, &out); err == nil {
			t.Fatal("expected error for malformed JSON")
		}
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("status = %d body = %s, want 400", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("multiple JSON values still returns 400", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(`{"value":"a"}{"value":"b"}`))
		var out sample
		if err := decodeManagementJSON(recorder, request, 1024, &out); err == nil {
			t.Fatal("expected error for trailing JSON value")
		}
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("status = %d body = %s, want 400", recorder.Code, recorder.Body.String())
		}
	})
}

type failingReader struct{ err error }

func (f failingReader) Read([]byte) (int, error) { return 0, f.err }

func TestRequestBodyTooLargeAcrossAdHocHandlers(t *testing.T) {
	fixture := newProviderTestFixture(t)
	h := fixture.handler

	assertTooLarge := func(t *testing.T, recorder *httptest.ResponseRecorder) {
		t.Helper()
		if recorder.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d body = %s, want 413", recorder.Code, recorder.Body.String())
		}
		var errBody ErrorResponseDTO
		if err := json.Unmarshal(recorder.Body.Bytes(), &errBody); err != nil {
			t.Fatalf("unmarshal 413 body: %v (%s)", err, recorder.Body.String())
		}
		if errBody.Code != requestTooLargeCode {
			t.Fatalf("code = %q, want %q (body=%s)", errBody.Code, requestTooLargeCode, recorder.Body.String())
		}
	}

	t.Run("login", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/omc/api/auth/login", strings.NewReader(`{"password":"`+strings.Repeat("k", 9*1024)+`"}`))
		h.login(recorder, req)
		assertTooLarge(t, recorder)
	})

	t.Run("updateResourceOverride", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPatch, "/omc/api/v1/resources/11111111-1111-4111-8111-111111111111/override", strings.NewReader(`{"notes":"`+strings.Repeat("n", 17*1024)+`"}`))
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", "11111111-1111-4111-8111-111111111111")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
		h.updateResourceOverride(recorder, req)
		assertTooLarge(t, recorder)
	})

	t.Run("putPreference", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/omc/api/v1/preferences/omc_provider_names", strings.NewReader(`{"a":"`+strings.Repeat("p", repository.MaxPreferenceValueBytes+64)+`"}`))
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("key", repository.PreferenceProviderNames)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
		h.putPreference(recorder, req)
		assertTooLarge(t, recorder)
	})

	t.Run("deleteManagementAuthFiles", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodDelete, "/omc/api/v1/management/auth-files", strings.NewReader(`{"name":"`+strings.Repeat("f", managementAuthFileRequestLimit+64)+`"}`))
		h.deleteManagementAuthFiles(recorder, req)
		assertTooLarge(t, recorder)
	})

	t.Run("uploadManagementAuthFiles raw JSON", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		body := bytes.NewReader(make([]byte, managementAuthFileUploadLimit+64))
		req := httptest.NewRequest(http.MethodPost, "/omc/api/v1/management/auth-files?name=huge.json", body)
		h.uploadManagementAuthFiles(recorder, req)
		assertTooLarge(t, recorder)
	})

	t.Run("uploadManagementAuthFiles multipart", func(t *testing.T) {
		var buf bytes.Buffer
		writer := multipart.NewWriter(&buf)
		part, err := writer.CreateFormFile("file", "huge.json")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(bytes.Repeat([]byte("a"), managementAuthFileUploadLimit+64))
		_ = writer.Close()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/omc/api/v1/management/auth-files", &buf)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		h.uploadManagementAuthFiles(recorder, req)
		assertTooLarge(t, recorder)
	})

	t.Run("installPlugin", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/omc/api/v1/management/plugin-store/demo/install", strings.NewReader(`{"version":"`+strings.Repeat("v", 5*1024)+`"}`))
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", "demo")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
		h.installPlugin(recorder, req)
		assertTooLarge(t, recorder)
	})

	t.Run("postSystemUpdaterApply", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/omc/api/v1/management/system/updater/apply", strings.NewReader(`{"product":"`+strings.Repeat("x", 5*1024)+`"}`))
		h.postSystemUpdaterApply(recorder, req)
		assertTooLarge(t, recorder)
	})

	t.Run("testGitHubToken", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/omc/api/v1/management/github-token/test", strings.NewReader(`{"token":"`+strings.Repeat("t", 5*1024)+`"}`))
		h.testGitHubToken(recorder, req)
		assertTooLarge(t, recorder)
	})

	t.Run("readAgentInput", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/omc/api/v1/agent/session/reset", strings.NewReader(`{"revision":1}`+strings.Repeat(" ", 65*1024)))
		var out ResetAgentRequestDTO
		if readAgentInput(recorder, req, &out) {
			t.Fatal("expected readAgentInput to refuse oversized body")
		}
		assertTooLarge(t, recorder)
	})

	t.Run("browserRun non-overflow read error returns 400", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/omc/api/v1/playground/chat", failingReader{err: errors.New("connection reset")})
		if run := h.prepareBrowserRun("playground", "run-test-id", func(http.ResponseWriter, *http.Request) {}, recorder, req); run != nil {
			t.Fatal("expected prepareBrowserRun to fail")
		}
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("status = %d body = %s, want 400", recorder.Code, recorder.Body.String())
		}
	})
}
