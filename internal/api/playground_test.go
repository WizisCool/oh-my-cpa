package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

func TestPlaygroundUsesStableKeyAndProjectsModels(t *testing.T) {
	fixture := newProviderTestFixture(t)
	var keyMu sync.Mutex
	keys := []string{"playground-fixture-first", "playground-fixture-second"}
	var authValue string
	upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		keyMu.Lock()
		defer keyMu.Unlock()
		switch request.URL.Path {
		case "/v0/management/api-keys":
			json.NewEncoder(writer).Encode(map[string]any{"api-keys": keys})
		case "/v1/models":
			authValue = request.Header.Get("Authorization")
			io.WriteString(writer, `{"data":[{"id":"model-alias","secret":"omit-me"}]}`)
		default:
			t.Errorf("unexpected path %s", request.URL.Path)
		}
	}))
	defer upstream.Close()
	pointPlaygroundAt(t, fixture.handler, upstream.URL)
	fingerprint, err := fixture.handler.repo.UsageClientKeyFingerprint(keys[0])
	if err != nil {
		t.Fatal(err)
	}
	path := fixture.baseURL + "/omc/api/v1/playground/models?client_key_fingerprint=" + fingerprint
	response, body := getJSON(t, fixture.client, path)
	if response.StatusCode != 200 || !strings.Contains(string(body), "model-alias") || !strings.Contains(string(body), "call_point") || strings.Contains(string(body), "omit-me") {
		t.Fatalf("models %d %s", response.StatusCode, body)
	}
	keyMu.Lock()
	keys[0], keys[1] = keys[1], keys[0]
	keyMu.Unlock()
	response, _ = getJSON(t, fixture.client, path)
	keyMu.Lock()
	selectedAuth := authValue
	keys = keys[:1]
	keyMu.Unlock()
	if response.StatusCode != 200 || selectedAuth != "Bearer playground-fixture-first" {
		t.Fatal("reordering changed identity")
	}
	response, body = getJSON(t, fixture.client, path)
	if response.StatusCode != 409 || !strings.Contains(string(body), "client_key_missing") {
		t.Fatalf("deleted key %d %s", response.StatusCode, body)
	}
}
func pointPlaygroundAt(t *testing.T, handler *Handler, baseURL string) {
	t.Helper()
	instance, err := handler.repo.GetInstance(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	instance.BaseURL = baseURL
	if err := handler.repo.UpsertInstance(context.Background(), instance); err != nil {
		t.Fatal(err)
	}
}
func TestPlaygroundStreamDeadlineContextAndCancellation(t *testing.T) {
	fixture := newProviderTestFixture(t)
	var calls atomic.Int64
	upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v0/management/api-keys" {
			io.WriteString(writer, `{"api-keys":["playground-fixture"]}`)
			return
		}
		if request.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected operation %s", request.URL.Path)
			return
		}
		calls.Add(1)
		if request.Header.Get("Authorization") != "Bearer playground-fixture" {
			t.Error("wrong credential")
		}
		// The default names this deployment's build, not a constant.
		if ua, want := request.Header.Get("User-Agent"), gateway.UserAgentForVersion(fixture.handler.cfg.Version); ua != want {
			t.Errorf("default user agent = %q, want %q", ua, want)
		}
		var payload map[string]any
		json.NewDecoder(request.Body).Decode(&payload)
		if _, found := payload["client_key_fingerprint"]; found {
			t.Error("fingerprint sent to CPA")
		}
		if payload["reasoning_effort"] != "ultra" {
			t.Errorf("reasoning_effort %v", payload["reasoning_effort"])
		}
		if payload["custom_field"] != "custom_val" {
			t.Errorf("custom_field %v", payload["custom_field"])
		}
		messages := payload["messages"].([]any)
		if len(messages) != 4 || messages[0].(map[string]any)["role"] != "system" {
			t.Errorf("context projection %v", messages)
		}
		writer.Header().Set(gateway.TraceIDHeader, "20260928183000-1a2b3c-0000002a")
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.(http.Flusher).Flush()
		// Scale the ordinary deadline down, not the special route's deadline. This
		// exercises the actual net/http server without adding 30 seconds to every suite.
		time.Sleep(120 * time.Millisecond)
		io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	pointPlaygroundAt(t, fixture.handler, upstream.URL)
	server := httptest.NewUnstartedServer(fixture.handler.Router())
	server.Config.WriteTimeout = 60 * time.Millisecond
	server.Start()
	defer server.Close()
	fingerprint, _ := fixture.handler.repo.UsageClientKeyFingerprint("playground-fixture")
	body := `{"client_key_fingerprint":"` + fingerprint + `","model":"model-alias","system_prompt":"system","reasoning_effort":"ultra","custom_body":{"custom_field":"custom_val"},"messages":[{"role":"user","content":[{"type":"text","text":"first"}]},{"role":"assistant","content":[{"type":"text","text":"answer"}]},{"role":"user","content":[{"type":"text","text":"second"}]}]}`
	response, err := fixture.client.Post(server.URL+"/omc/api/v1/playground/chat", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 || !strings.Contains(string(data), "event: done") || !strings.Contains(string(data), "event: thought") || !strings.Contains(string(data), "answer") || strings.Contains(string(data), "playground-fixture") {
		t.Fatalf("stream %d %s %v", response.StatusCode, data, err)
	}
	if calls.Load() != 1 {
		t.Fatalf("paid calls %d", calls.Load())
	}
	// CPA's id reaches the console before the answer, so the turn can name its record early.
	announced := strings.Index(string(data), "event: request\ndata: {\"request_id\":\"0000002a\"}")
	if announced < 0 || announced > strings.Index(string(data), "event: thought") {
		t.Fatalf("request id not announced before the answer: %s", data)
	}
}
func TestPlaygroundValidationAndAdmissionBeforeInference(t *testing.T) {
	fixture := newProviderTestFixture(t)
	for _, body := range []string{
		`{"url":"https://example.invalid"}`, `{"model":"m","messages":[{"role":"system","content":[{"type":"text","text":"s"}]}]}`,
		`{"model":"m","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"http://localhost/private"}}]}]}`,
		`{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hello","unknown":"secret"}]}]}`,
	} {
		response, err := fixture.client.Post(fixture.baseURL+"/omc/api/v1/playground/chat", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatalf("validation status %d", response.StatusCode)
		}
	}
	for i := 0; i < cap(fixture.handler.playgroundSlots); i++ {
		fixture.handler.playgroundSlots <- struct{}{}
	}
	response, err := fixture.client.Post(fixture.baseURL+"/omc/api/v1/playground/chat", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 429 {
		t.Fatalf("admission status %d", response.StatusCode)
	}
	for i := 0; i < cap(fixture.handler.playgroundSlots); i++ {
		<-fixture.handler.playgroundSlots
	}
}

func TestPlaygroundCustomUAAndCustomBodyPriority(t *testing.T) {
	fixture := newProviderTestFixture(t)
	// The upstream capture is written by the server's handler goroutine and read by the
	// test, so it is behind a mutex rather than read hopefully; `-race` is what caught the
	// unsynchronised version.
	var captureMu sync.Mutex
	var observedUA string
	var observedPayload map[string]any
	upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v0/management/api-keys" {
			io.WriteString(writer, `{"api-keys":["playground-fixture"]}`)
			return
		}
		var payload map[string]any
		json.NewDecoder(request.Body).Decode(&payload)
		captureMu.Lock()
		observedUA = request.Header.Get("User-Agent")
		observedPayload = payload
		captureMu.Unlock()
		// A complete, successful stream: the assertion below is that this request
		// succeeds, so a fixture that could only ever produce `stream_incomplete` would
		// have made the test pass while proving nothing.
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.(http.Flusher).Flush()
		io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	pointPlaygroundAt(t, fixture.handler, upstream.URL)
	server := httptest.NewServer(fixture.handler.Router())
	defer server.Close()
	fingerprint, _ := fixture.handler.repo.UsageClientKeyFingerprint("playground-fixture")

	stream := func(body string) string {
		t.Helper()
		response, err := fixture.client.Post(server.URL+"/omc/api/v1/playground/chat", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 200 {
			t.Fatalf("status %d %s", response.StatusCode, data)
		}
		return string(data)
	}

	body := `{"client_key_fingerprint":"` + fingerprint + `","model":"original-model","temperature":0.9,"user_agent":"CustomClient/2.0","custom_body":{"model":"overridden-model","temperature":0.1,"seed":42},"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`
	data := stream(body)
	if !strings.Contains(data, "event: done") || strings.Contains(data, "event: error") {
		t.Fatalf("stream did not complete cleanly: %s", data)
	}
	captureMu.Lock()
	gotUA, gotPayload := observedUA, observedPayload
	captureMu.Unlock()
	if gotUA != "CustomClient/2.0" {
		t.Errorf("observed UA = %q, want CustomClient/2.0", gotUA)
	}
	// The override outranks the selected model, and a parameter the console does not
	// model survives - which is the reason the payload is a map and not ChatRequest.
	if gotPayload["model"] != "overridden-model" || gotPayload["temperature"] != 0.1 || gotPayload["seed"] != float64(42) {
		t.Errorf("override precedence = %v", gotPayload)
	}
	if _, found := gotPayload["client_key_fingerprint"]; found {
		t.Error("fingerprint reached CPA")
	}
	// The turn labels itself with the effective model, not the selected one.
	if !strings.Contains(data, `"model":"overridden-model"`) {
		t.Errorf("meta reported the wrong model: %s", data)
	}

	// A blank parameter means the deployment's own build token, naming this version.
	data = stream(`{"client_key_fingerprint":"` + fingerprint + `","model":"original-model","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`)
	captureMu.Lock()
	gotUA = observedUA
	captureMu.Unlock()
	if want := gateway.UserAgentForVersion(fixture.handler.cfg.Version); gotUA != want {
		t.Errorf("default UA = %q, want %q", gotUA, want)
	}
	if !strings.Contains(data, "event: done") {
		t.Fatalf("default-UA stream did not complete: %s", data)
	}

	// A CR or LF in the parameter is a header-splitting attempt, refused before inference.
	for _, bad := range []string{"Evil/1.0\\r\\nX-Injected: 1", "Evil/1.0\\nX-Injected: 1"} {
		response, err := fixture.client.Post(server.URL+"/omc/api/v1/playground/chat", "application/json",
			strings.NewReader(`{"client_key_fingerprint":"`+fingerprint+`","model":"original-model","user_agent":"`+bad+`","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 400 {
			t.Errorf("user-agent %q accepted with status %d", bad, response.StatusCode)
		}
	}
}
