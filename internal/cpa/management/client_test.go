package management

import (
	"context"
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
	response, err := client.CodexAPIKeys(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Entries) != 1 || response.Entries[0].AuthIndex != "a1" {
		t.Fatalf("decoded response = %#v", response)
	}
	if !client.ManagementKeyPresent() {
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
