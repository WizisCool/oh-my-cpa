package management

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestSIWCClientProjectsSummariesAndPreservesCallbackConflict(t *testing.T) {
	const callback = "http://127.0.0.1:1455/auth/callback?state=fixture&code=SYNTHETIC-CODE&client_id=issued&extra=a%2Bb"
	server := newV8Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v8/management/credentials":
			fmt.Fprint(w, `{"files":[{"name":"codex.json","siwc_bind_supported":true,"use_siwc":true,"siwc_status":"invalid","siwc_bound":true,"siwc_expires_at":"2026-10-21T00:00:00Z"},{"name":"older.json"}]}`)
		case "/v8/management/oauth/siwc/bind":
			if r.Method != "POST" {
				t.Error("bind method")
			}
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body) != 1 || body["name"] != "managed-id" {
				t.Errorf("body: %#v", body)
			}
			fmt.Fprint(w, `{"url":"https://auth.openai.com/api/accounts/authorize","state":"fixture","flow":"siwc_bind","expires_in":300}`)
		case "/v8/management/oauth/callback":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["redirect_url"] != callback || body["provider"] != "codex" {
				t.Errorf("callback changed: %#v", body)
			}
			w.WriteHeader(409)
			fmt.Fprint(w, `{"error":"duplicate callback"}`)
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "synthetic-management", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	files, err := client.AuthFiles(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if files.Files[0].SafeSIWCSummary().SIWCStatus != "invalid" || files.Files[1].SafeSIWCSummary().SIWCStatus != "" || !files.Files[0].SIWCBindSupported || !files.Files[0].UseSIWC || !files.Files[0].SIWCBound || files.Files[0].SIWCExpiresAt == "" || files.Files[1].SIWCBindSupported {
		t.Fatalf("summaries: %#v", files)
	}
	result, err := client.BindSIWC(context.Background(), "managed-id")
	if err != nil || result.Flow != "siwc_bind" || result.ExpiresIn != 300 {
		t.Fatalf("start: %+v %v", result, err)
	}
	if err := client.SubmitSIWCCallback(context.Background(), callback); err == nil || !strings.Contains(err.Error(), "409") {
		t.Fatalf("conflict lost: %v", err)
	}
}
