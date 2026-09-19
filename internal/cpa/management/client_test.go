package management

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientUsesManagementAuthorizationAndDecodesResponses(t *testing.T) {
	const key = "management-secret"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v0/management/codex-api-key" {
			t.Fatalf("request path = %q", request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer "+key {
			t.Fatalf("authorization = %q", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("X-CLIProxyAPI-Version", "7.1.2")
		_, _ = writer.Write([]byte(`{"codex-api-key":[{"api-key":"secret","auth-index":"a1","base-url":"https://api.example.test"}]}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, key, time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := client.ConfigAPIKeys(context.Background(), ConfigFamilyCodex)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].AuthIndex != "a1" {
		t.Fatalf("decoded response = %#v", entries)
	}
	if !client.HasManagementKey() {
		t.Fatal("management key should be present")
	}
}

func TestClientAuthFilesDecodesV7ObservationsAndMetadata(t *testing.T) {
	const key = "management-secret"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v0/management/auth-files" {
			t.Fatalf("request path = %q", request.URL.Path)
		}
		writer.Header().Set("X-CPA-Version", "7.1.2")
		writer.Header().Set("X-CPA-Build-Date", "2025-01-01")
		_, _ = writer.Write([]byte(`{"files":[{"id":"auth-1","auth_index":"a1","type":"gemini","provider":"gemini","success":12,"failed":2,"recent_requests":[{"time":"2025-01-01T00:00:00Z","success":3,"failed":1}],"quota":{"signals":{"remaining":"9"}},"model_quotas":{"gemini-2.0":{"signals":{"remaining":"4"}}},"status":"ok"}]}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, key, time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	files, meta, err := client.AuthFilesWithMeta(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if meta.Header.Get("X-CPA-Version") != "7.1.2" || meta.Header.Get("X-CPA-Build-Date") != "2025-01-01" {
		t.Fatalf("response metadata = %#v", meta.Header)
	}
	if len(files.Files) != 1 {
		t.Fatalf("files = %#v", files.Files)
	}
	file := files.Files[0]
	if file.Type != "gemini" || file.Success != 12 || file.Failed != 2 || len(file.RecentRequests) != 1 || file.Quota["signals"] == nil {
		t.Fatalf("decoded v7 auth file = %#v", file)
	}
}

func TestClientAuthFilesToleratesUnexpectedTimeFieldShapes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"files":[
			{"name":"rfc3339.json","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z","last_refresh":"2026-01-03T00:00:00Z"},
			{"name":"epoch.json","created_at":1767225600,"updated_at":1767225600.5,"last_refresh":null},
			{"name":"object.json","created_at":{"seconds":1},"updated_at":true,"last_refresh":""},
			{"name":"absent.json"}
		]}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	files, err := client.AuthFiles(context.Background())
	if err != nil {
		t.Fatalf("mixed time formats must not fail the whole decode: %v", err)
	}
	if len(files.Files) != 4 {
		t.Fatalf("files = %#v", files.Files)
	}
	if string(files.Files[0].CreatedAt) != `"2026-01-01T00:00:00Z"` {
		t.Fatalf("string time = %s", files.Files[0].CreatedAt)
	}
	if string(files.Files[1].UpdatedAt) != "1767225600.5" || string(files.Files[1].LastRefresh) != "null" {
		t.Fatalf("numeric/null times = %s / %s", files.Files[1].UpdatedAt, files.Files[1].LastRefresh)
	}
	if string(files.Files[2].CreatedAt) != `{"seconds":1}` {
		t.Fatalf("object time = %s", files.Files[2].CreatedAt)
	}
	if len(files.Files[3].CreatedAt) != 0 || files.Files[3].Name != "absent.json" {
		t.Fatalf("absent time = %#v", files.Files[3])
	}
}

func TestClientAuthFileMutationsUseFixedEndpoints(t *testing.T) {
	type observation struct {
		method   string
		path     string
		rawQuery string
		body     string
		ctype    string
	}
	var seen []observation
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		seen = append(seen, observation{method: request.Method, path: request.URL.Path, rawQuery: request.URL.RawQuery, body: string(body), ctype: request.Header.Get("Content-Type")})
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/v0/management/auth-files/download" {
			_, _ = writer.Write([]byte(`{"token":"raw-file-content"}`))
			return
		}
		_, _ = writer.Write([]byte(`{"status":"success"}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := client.PatchAuthFileStatus(ctx, "a b.json", "idx 1", true); err != nil {
		t.Fatal(err)
	}
	if _, err := client.PatchAuthFileFields(ctx, "a b.json", map[string]any{"priority": 10, "note": "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.UploadAuthFile(ctx, "up.json", []byte(`{"type":"gemini"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := client.DeleteAuthFiles(ctx, []string{"a b.json", "c.json"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.DownloadAuthFile(ctx, "a b.json"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.AuthFileModels(ctx, "a b.json"); err != nil {
		t.Fatal(err)
	}

	want := []observation{
		{method: http.MethodPatch, path: "/v0/management/auth-files/status", body: `{"auth_index":"idx 1","disabled":true,"name":"a b.json"}`, ctype: "application/json"},
		{method: http.MethodPatch, path: "/v0/management/auth-files/fields", body: `{"name":"a b.json","note":"x","priority":10}`, ctype: "application/json"},
		{method: http.MethodPost, path: "/v0/management/auth-files", rawQuery: "name=up.json", body: `{"type":"gemini"}`, ctype: "application/json"},
		{method: http.MethodDelete, path: "/v0/management/auth-files", body: `{"names":["a b.json","c.json"]}`, ctype: "application/json"},
		{method: http.MethodGet, path: "/v0/management/auth-files/download", rawQuery: "name=a+b.json"},
		{method: http.MethodGet, path: "/v0/management/auth-files/models", rawQuery: "name=a+b.json"},
	}
	if len(seen) != len(want) {
		t.Fatalf("request count = %d, want %d: %#v", len(seen), len(want), seen)
	}
	for index := range want {
		if seen[index].method != want[index].method || seen[index].path != want[index].path {
			t.Fatalf("request %d = %s %s, want %s %s", index, seen[index].method, seen[index].path, want[index].method, want[index].path)
		}
		if want[index].rawQuery != "" && seen[index].rawQuery != want[index].rawQuery {
			t.Fatalf("request %d query = %q, want %q", index, seen[index].rawQuery, want[index].rawQuery)
		}
		if want[index].body != "" && seen[index].body != want[index].body {
			t.Fatalf("request %d body = %q, want %q", index, seen[index].body, want[index].body)
		}
		if want[index].ctype != "" && seen[index].ctype != want[index].ctype {
			t.Fatalf("request %d content-type = %q, want %q", index, seen[index].ctype, want[index].ctype)
		}
	}
}

func TestClientDoesNotLeakKeyInHTTPError(t *testing.T) {
	const key = "management-secret"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":"management-secret was rejected"}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, key, time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.AuthFiles(context.Background())
	if err == nil {
		t.Fatal("expected authorization error")
	}
	if strings.Contains(err.Error(), key) || !strings.Contains(err.Error(), "[redacted]") {
		t.Fatalf("error leaked management key or failed to redact echo: %v", err)
	}
}

func TestClientApiCall(t *testing.T) {
	const key = "management-secret"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v0/management/api-call" {
			t.Fatalf("request path = %q", request.URL.Path)
		}
		if request.Method != http.MethodPost {
			t.Fatalf("request method = %q", request.Method)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer "+key {
			t.Fatalf("authorization = %q", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status_code":200,"header":{"content-type":["application/json"]},"body":{"plan_type":"pro"}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, key, time.Second, false)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := client.ApiCall(context.Background(), ApiCallRequest{
		AuthIndex: "auth-123",
		Method:    "GET",
		URL:       "https://chatgpt.com/backend-api/wham/usage",
	})
	if err != nil {
		t.Fatalf("ApiCall failed: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
	if !strings.Contains(string(resp.Body), `"plan_type":"pro"`) {
		t.Fatalf("unexpected body: %s", string(resp.Body))
	}
}

func TestClientApiCallNormalizedBody(t *testing.T) {
	// 1. JSON object shape
	respObj := ApiCallResponse{
		StatusCode: 200,
		Body:       json.RawMessage(`{"plan_type":"pro"}`),
	}
	b1, err := respObj.NormalizedBody()
	if err != nil || !strings.Contains(string(b1), `"plan_type":"pro"`) {
		t.Fatalf("NormalizedBody for object failed: %s, err: %v", string(b1), err)
	}

	// 2. JSON-encoded string shape (escaped quotes)
	respStr := ApiCallResponse{
		StatusCode: 200,
		Body:       json.RawMessage(`"{\"plan_type\":\"plus\"}"`),
	}
	b2, err := respStr.NormalizedBody()
	if err != nil || !strings.Contains(string(b2), `"plan_type":"plus"`) {
		t.Fatalf("NormalizedBody for string failed: %s, err: %v", string(b2), err)
	}
}

func TestNewClientValidatesURLAndKey(t *testing.T) {
	for _, test := range []struct {
		name string
		base string
		key  string
	}{
		{name: "missing url", base: "", key: "secret"},
		{name: "bad scheme", base: "ftp://example.test", key: "secret"},
		{name: "userinfo", base: "http://user:password@example.test", key: "secret"},
		{name: "missing key", base: "http://example.test", key: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewClient(test.base, test.key, time.Second, false); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestListAllConfiguredModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v0/management/auth-files":
			_, _ = w.Write([]byte(`{"files":[{"models":[{"id":"claude-3-7-sonnet"}]}]}`))
		case "/v0/management/codex-api-key":
			_, _ = w.Write([]byte(`{"codex-api-key":[{"models":[{"name":"gpt-5","alias":"gpt-5-alias"}]},{"excluded-models":["*"],"models":[{"name":"disabled-codex"}]}]}`))
		case "/v0/management/openai-compatibility":
			_, _ = w.Write([]byte(`{"openai-compatibility":[{"models":[{"name":"deepseek-chat"}]},{"disabled":true,"models":[{"name":"disabled-openai"}]}]}`))
		case "/v0/management/claude-api-key":
			_, _ = w.Write([]byte(`{"claude-api-key":[{"models":[{"name":"claude-3-5-sonnet"}]},{"excluded-models":["*"],"models":[{"name":"disabled-claude"}]}]}`))
		case "/v0/management/gemini-api-key":
			_, _ = w.Write([]byte(`{"gemini-api-key":[{"models":[{"name":"gemini-2.5-flash"}]},{"excluded-models":["*"],"models":[{"name":"disabled-gemini"}]}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "key", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	models, err := client.ListAllConfiguredModels(context.Background())
	if err != nil {
		t.Fatalf("ListAllConfiguredModels failed: %v", err)
	}
	want := []string{"claude-3-5-sonnet", "claude-3-7-sonnet", "deepseek-chat", "gemini-2.5-flash", "gpt-5", "gpt-5-alias"}
	if strings.Join(models, ",") != strings.Join(want, ",") {
		t.Fatalf("models = %v, want %v", models, want)
	}
	catalog, err := client.ListConfiguredModelCatalog(context.Background())
	if err != nil {
		t.Fatalf("ListConfiguredModelCatalog failed: %v", err)
	}
	if catalog["gpt-5-alias"] != "gpt-5" || catalog["gpt-5"] != "gpt-5" {
		t.Fatalf("alias catalog mapping = %v", catalog)
	}
}

// The catalog is read from several sources in one pass, so a gateway that does not
// have one of the endpoints has to stay classifiable as such.
//
// `/auth-files` is the endpoint that makes this concrete: a CPA release that
// predates it answers 404, and the console has to read that as "this gateway cannot
// tell us" rather than as a broken read. The catalog is still refused whole - the
// pricing service replaces its model table from this snapshot, so publishing the
// providers that happened to answer would prune the rates of the ones that did not
// - and the refusal has to keep the original failures reachable for `errors.As`.
func TestConfiguredModelCatalogKeepsItsFailuresTypeable(t *testing.T) {
	// Everything answers, so the aggregate carries exactly the one failure under
	// test rather than a pile of unrelated ones.
	newGateway := func(status int) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			if request.URL.Path == "/v0/management/auth-files" {
				writer.WriteHeader(status)
				_, _ = writer.Write([]byte(`{"error":"cannot list auth files"}`))
				return
			}
			_, _ = writer.Write([]byte(`{}`))
		}))
	}

	for _, testCase := range []struct {
		name      string
		status    int
		isMissing bool
	}{
		{name: "the endpoint is not there", status: http.StatusNotFound, isMissing: true},
		{name: "the gateway failed", status: http.StatusInternalServerError},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := newGateway(testCase.status)
			defer server.Close()
			client, err := NewClient(server.URL, "key", time.Second, false)
			if err != nil {
				t.Fatal(err)
			}

			catalog, err := client.ListConfiguredModelCatalog(context.Background())
			if err == nil {
				t.Fatal("a failed source must fail the catalog")
			}
			if catalog != nil {
				t.Fatalf("a refused catalog must not publish a partial one, got %v", catalog)
			}
			if IsMissingCapability(err) != testCase.isMissing {
				t.Fatalf("IsMissingCapability = %t, want %t (error %v)", IsMissingCapability(err), testCase.isMissing, err)
			}
			// The aggregated message is persisted as the pricing sync's last error and
			// rendered in a one-line strip, and it has to name the source that failed.
			if strings.Contains(err.Error(), "\n") {
				t.Fatalf("the catalog message must stay a single line, got %q", err.Error())
			}
			if !strings.Contains(err.Error(), "auth-files") {
				t.Fatalf("the message must name the source that failed, got %q", err.Error())
			}
		})
	}

	// A gateway that cannot be reached at all is the other half of the
	// classification: every source fails, and none of them is a missing endpoint.
	reachable := newGateway(http.StatusOK)
	url := reachable.URL
	reachable.Close()
	client, err := NewClient(url, "key", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := client.ListConfiguredModelCatalog(context.Background())
	if err == nil {
		t.Fatal("an unreachable gateway must fail the catalog")
	}
	if catalog != nil {
		t.Fatalf("an unreachable gateway must not publish a catalog, got %v", catalog)
	}
	if IsMissingCapability(err) {
		t.Fatalf("a transport failure must not be reported as a missing capability, got %v", err)
	}
}
