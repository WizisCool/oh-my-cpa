package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/applog"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type serviceLogResponse struct {
	Capturing bool                  `json:"capturing"`
	Records   []serviceLogRecordDTO `json:"records"`
	LatestSeq uint64                `json:"latest_seq"`
	Gap       bool                  `json:"gap"`
}

func readServiceLogs(t *testing.T, handler *Handler, query string) (int, serviceLogResponse) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.serviceLogs(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/management/service-logs"+query, nil))
	var body serviceLogResponse
	if recorder.Code == http.StatusOK {
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder.Code, body
}

func TestServiceLogsResumeFromTheLastSequence(t *testing.T) {
	buffer := applog.NewBuffer(10)
	logger := slog.New(applog.NewHandler(slog.NewJSONHandler(io.Discard, nil), buffer))
	handler := NewHandler(config.Config{}, nil, nil, logger, nil)

	logger.Info("first", "management_key", "plain-secret-value")
	logger.Warn("second")
	status, page := readServiceLogs(t, handler, "")
	if status != http.StatusOK || !page.Capturing || len(page.Records) != 2 || page.LatestSeq != 2 {
		t.Fatalf("first read = %d %#v", status, page)
	}
	if strings.Contains(page.Records[0].Attrs[0].Value, "plain-secret-value") {
		t.Fatalf("a credential-named field reached the console: %#v", page.Records[0].Attrs)
	}

	logger.Error("third")
	_, page = readServiceLogs(t, handler, "?after=2")
	if len(page.Records) != 1 || page.Records[0].Message != "third" || page.Records[0].Level != "error" {
		t.Fatalf("resumed read = %#v, want only the new error", page.Records)
	}

	if status, _ := readServiceLogs(t, handler, "?after=-1"); status != http.StatusBadRequest {
		t.Fatalf("negative cursor answered %d, want 400", status)
	}
}

func TestServiceLogsWithoutCaptureIsAStateNotAnError(t *testing.T) {
	handler := NewHandler(config.Config{}, nil, nil, slog.New(slog.NewJSONHandler(io.Discard, nil)), nil)
	status, page := readServiceLogs(t, handler, "")
	if status != http.StatusOK || page.Capturing || len(page.Records) != 0 {
		t.Fatalf("uncaptured read = %d %#v", status, page)
	}
}

func TestParseAuditQueryRejectsWhatItCannotHonour(t *testing.T) {
	parse := func(query string) (repository.AuditQuery, error) {
		return parseAuditQuery(httptest.NewRequest(http.MethodGet, "/x"+query, nil), auditListPageMax, true)
	}
	query, err := parse("?limit=9999&category=provider,api_key&outcome=failed&q=%20gem%20&before=1700000000000_42")
	if err != nil {
		t.Fatalf("valid query refused: %v", err)
	}
	if query.Limit != auditListPageMax || len(query.Categories) != 2 || query.Outcome != "failed" ||
		query.Search != "gem" || query.Before.ID != 42 || !query.FoldAttempts {
		t.Fatalf("parsed = %#v", query)
	}
	if query, _ := parse("?fold=0"); query.FoldAttempts {
		t.Fatal("fold=0 still folded attempts")
	}
	for _, bad := range []string{"?category=api%25", "?outcome=maybe", "?before=42", "?limit=0", "?fold=sometimes", "?q=" + strings.Repeat("x", 200)} {
		if _, err := parse(bad); err == nil {
			t.Fatalf("%s was accepted", bad)
		}
	}
}

func TestAssignRequestIDGivesOneIDPerRequest(t *testing.T) {
	var first, second string
	handler := assignRequestID(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		first = getOrGenerateRequestID(request)
		second = getOrGenerateRequestID(request)
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/management/providers", nil))
	if first == "" || first != second {
		t.Fatalf("audit calls in one request got ids %q and %q; the trail pairs rows by one id", first, second)
	}
	if recorder.Header().Get("X-Request-ID") != first {
		t.Fatalf("response id = %q, want %q", recorder.Header().Get("X-Request-ID"), first)
	}

	// A caller's own id is correlation, not the pairing key: two requests that reuse one
	// value must still get distinct ids, or one's outcome would fold the other's attempt.
	var ids []string
	reusing := assignRequestID(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		ids = append(ids, getOrGenerateRequestID(request))
		if clientRequestID(request) != "caller-7" {
			t.Fatalf("client id = %q, want it kept for correlation", clientRequestID(request))
		}
	}))
	for i := 0; i < 2; i++ {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/management/providers", nil)
		request.Header.Set("X-Request-ID", "caller-7")
		reusing.ServeHTTP(httptest.NewRecorder(), request)
	}
	if len(ids) != 2 || ids[0] == ids[1] || ids[0] == "caller-7" {
		t.Fatalf("ids for two requests reusing one client id = %v, want two distinct server ids", ids)
	}
}
