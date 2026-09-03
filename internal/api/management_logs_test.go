package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// logsFixtureCPA serves the log half of the management API and records the
// query it was called with, so the facade's parameter handling is observable
// rather than assumed.
type logsFixtureCPA struct {
	mu       sync.Mutex
	queries  []string
	methods  []string
	logsBody string
	logsHead int
}

func (f *logsFixtureCPA) serve(writer http.ResponseWriter, request *http.Request) {
	path := strings.TrimPrefix(request.URL.Path, "/v0/management")
	f.mu.Lock()
	f.queries = append(f.queries, path+"?"+request.URL.RawQuery)
	f.methods = append(f.methods, request.Method)
	body := f.logsBody
	f.mu.Unlock()

	switch {
	case path == "/logs" && request.Method == http.MethodGet:
		if body == "" {
			body = `{"lines":["2026-09-01T12:00:00Z INFO one","2026-09-01T12:00:01Z ERROR two"],"latest-timestamp":1788235201,"next-cursor":"c-2"}`
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(body))
	case path == "/logs" && request.Method == http.MethodDelete:
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	case path == "/logs/status":
		writer.WriteHeader(http.StatusNotFound)
	case path == "/config":
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"logging-to-file":true,"request-log":"true","port":8317}`))
	case path == "/request-error-logs":
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"files":[{"name":"request-error-2026-09-01.log","size":2048,"modified":1788235200},{"name":"","size":1}]}`))
	case strings.HasPrefix(path, "/request-error-logs/"):
		writer.Header().Set("Content-Type", "text/plain")
		_, _ = writer.Write([]byte("=== REQUEST INFO ===\nupstream 401\n"))
	default:
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":"not found"}`))
	}
}

func (f *logsFixtureCPA) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.queries...)
}

func TestManagementLogsForwardsPagingContract(t *testing.T) {
	fixture := &logsFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)
	base := baseURL + "/omc/api/v1/management/logs"

	var first struct {
		Lines       []string `json:"lines"`
		LatestAfter int64    `json:"latest_after"`
		NextCursor  string   `json:"next_cursor"`
	}
	response, payload := getJSON(t, client, base)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	if err := json.Unmarshal(payload, &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Lines) != 2 || first.NextCursor != "c-2" || first.LatestAfter != 1788235201 {
		t.Fatalf("tail not surfaced: %s", payload)
	}
	// The facade must not forward an unbounded page.
	if !strings.Contains(fixture.seen()[0], "limit="+strconv.Itoa(management.DefaultLogsLimit)) {
		t.Fatalf("default limit not applied: %s", fixture.seen()[0])
	}

	// A cursor is preferred over a timestamp, and an oversized limit is clamped.
	getJSON(t, client, base+"?cursor=c-2&limit=99999")
	if seen := fixture.seen()[1]; !strings.Contains(seen, "cursor=c-2") || !strings.Contains(seen, "limit="+strconv.Itoa(management.MaxLogsLimit)) {
		t.Fatalf("cursor/limit not forwarded: %s", seen)
	}

	// `after` is re-sent one second back: a second-granularity cut would drop
	// whatever else shares that timestamp.
	getJSON(t, client, base+"?after=1788235201")
	if seen := fixture.seen()[2]; !strings.Contains(seen, "after=1788235200") {
		t.Fatalf("after boundary not widened: %s", seen)
	}

	response, payload = getJSON(t, client, base+"?after=nope")
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad after status = %d body %s", response.StatusCode, payload)
	}
}

func TestManagementLogsReportsCapabilityMissing(t *testing.T) {
	// A CPA build with no /logs answers 404. That is a missing capability, not
	// an empty log, and the UI must be able to tell the two apart.
	fixture := &logsFixtureCPA{logsBody: `NOT JSON`}
	client, baseURL, _ := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":"not found"}`))
	})
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/logs")
	if response.StatusCode != http.StatusNotImplemented {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	if !strings.Contains(string(payload), "capability_missing") {
		t.Fatalf("expected capability_missing: %s", payload)
	}
	_ = fixture
}

func TestManagementLogsMutationsAndDownloads(t *testing.T) {
	fixture := &logsFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)
	api := baseURL + "/omc/api/v1/management"

	response, payload := doJSON(t, client, http.MethodDelete, api+"/logs", "")
	if response.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"cleared":true`) {
		t.Fatalf("clear status = %d body %s", response.StatusCode, payload)
	}
	if got := fixture.seen(); len(got) == 0 || !strings.HasPrefix(got[len(got)-1], "/logs?") {
		t.Fatalf("clear never reached CPA: %v", got)
	}

	_, payload = getJSON(t, client, api+"/request-error-logs")
	var listed struct {
		Files []management.ErrorLogFile `json:"files"`
	}
	if err := json.Unmarshal(payload, &listed); err != nil {
		t.Fatal(err)
	}
	// The blank entry in the fixture must not survive normalisation.
	if len(listed.Files) != 1 || listed.Files[0].Name != "request-error-2026-09-01.log" || listed.Files[0].Size != 2048 {
		t.Fatalf("files not normalised: %s", payload)
	}

	download, err := client.Get(api + "/request-error-logs/request-error-2026-09-01.log")
	if err != nil {
		t.Fatal(err)
	}
	defer download.Body.Close()
	if download.StatusCode != http.StatusOK {
		t.Fatalf("download status = %d", download.StatusCode)
	}
	if got := download.Header.Get("Content-Disposition"); !strings.Contains(got, "request-error-2026-09-01.log") {
		t.Fatalf("download disposition = %q", got)
	}

	// A traversal must be refused before it reaches CPA, not escaped and sent.
	before := len(fixture.seen())
	bad, err := client.Get(api + "/request-error-logs/..%2F..%2Fetc%2Fpasswd")
	if err != nil {
		t.Fatal(err)
	}
	bad.Body.Close()
	if bad.StatusCode != http.StatusBadRequest && bad.StatusCode != http.StatusNotFound {
		t.Fatalf("traversal status = %d", bad.StatusCode)
	}
	for _, entry := range fixture.seen()[before:] {
		if strings.Contains(entry, "..") {
			t.Fatalf("traversal reached CPA: %s", entry)
		}
	}
}

func TestManagementLogsStatusReadsCPASwitches(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, (&logsFixtureCPA{}).serve)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/logs/status")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	// logging-to-file arrives as a bool, request-log as the string "true".
	var status map[string]bool
	if err := json.Unmarshal(payload, &status); err != nil {
		t.Fatal(err)
	}
	if !status["logging_to_file"] || !status["request_log"] {
		t.Fatalf("switches not read from config: %s", payload)
	}
}

// CPA answers 400 when file logging is off. The page must be able to tell that
// apart from a malformed request, because the fix is a switch, not a retry.
func TestManagementLogsReportsFileLoggingDisabled(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusBadRequest)
		_, _ = writer.Write([]byte(`{"error":"logging to file disabled"}`))
	})
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/logs")
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	if !strings.Contains(string(payload), "file_logging_disabled") {
		t.Fatalf("expected file_logging_disabled: %s", payload)
	}
}
