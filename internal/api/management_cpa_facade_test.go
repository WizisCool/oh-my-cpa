package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
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
