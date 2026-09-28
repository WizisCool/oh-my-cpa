package gateway

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testRequest() ChatRequest {
	request := ChatRequest{Model: "test-model", Messages: []Message{{Role: "user", Content: []Content{{Type: "text", Text: "hello"}}}}, Stream: true}
	request.StreamOptions.IncludeUsage = true
	return request
}

// streamTestRequest sends a request the way the handler does: compose the body, validate
// the composed body, then hand that same map to Stream. Going through both steps here
// keeps the tests honest about the contract the handler relies on.
func streamTestRequest(t *testing.T, client *Client, ctx context.Context, request ChatRequest, emit func(Event) error) error {
	t.Helper()
	payload, err := BuildPayload(request)
	if err != nil {
		t.Fatalf("build payload: %v", err)
	}
	if err := ValidatePayload(payload, request.UserAgent); err != nil {
		t.Fatalf("validate payload: %v", err)
	}
	return client.Stream(ctx, request, payload, emit)
}
func makeClient(t *testing.T, handle http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handle)
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "fixture-client-value", false)
	if err != nil {
		t.Fatal(err)
	}
	return client
}
func TestListModelsProjectionAndClientAuthentication(t *testing.T) {
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/models" || request.Header.Get("Authorization") != "Bearer fixture-client-value" {
			t.Error("wrong operation or authentication")
		}
		io.WriteString(writer, `{"data":[{"id":"second","api_key":"do-not-forward","capabilities":{"vision":true}},{"id":"first"},{"id":"first"}]}`)
	})
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(models)
	if string(encoded) != `[{"id":"first","call_point":"first","vision":"unknown"},{"id":"second","call_point":"second","vision":"unknown"}]` {
		t.Fatalf("unexpected projection %s", encoded)
	}
}
func TestStreamProjectionAndFragmentedUTF8(t *testing.T) {
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/chat/completions" || request.Header.Get("Authorization") != "Bearer fixture-client-value" {
			t.Error("wrong inference request")
		}
		var input ChatRequest
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil || !input.Stream || !input.StreamOptions.IncludeUsage {
			t.Error("missing streaming usage")
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		body := ": heartbeat\r\n\r\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\",\"api_key\":\"do-not-forward\"}}]}\r\n\r\n" +
			"data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
			"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6,\"secret\":\"do-not-forward\"}}\n\n" + "data: [DONE]\n\n"
		for _, value := range []byte(body) {
			writer.Write([]byte{value})
			writer.(http.Flusher).Flush()
		}
	})
	var events []Event
	err := streamTestRequest(t, client, context.Background(), testRequest(), func(event Event) error { events = append(events, event); return nil })
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(events)
	if len(events) != 3 || events[0].Content != "你好" || events[2].Type != "done" || strings.Contains(string(encoded), "do-not-forward") {
		t.Fatalf("unexpected stream %s", encoded)
	}
}
func TestStreamAcceptsEmptyToolCallArray(t *testing.T) {
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(writer, `data: {"choices":[{"delta":{"content":"hello","tool_calls":[]},"finish_reason":"stop"}]}`+"\n\n"+`data: [DONE]`+"\n\n")
	})
	var events []Event
	if err := streamTestRequest(t, client, context.Background(), testRequest(), func(event Event) error { events = append(events, event); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Content != "hello" || events[1].Type != "done" {
		t.Fatalf("empty tool-call array was treated as output: %#v", events)
	}
}

func TestStreamFailureModes(t *testing.T) {
	for _, test := range []struct{ name, body, code string }{
		{"incomplete", `data: {"choices":[{"delta":{"content":"partial"}}]}` + "\n\n", "stream_incomplete"},
		{"invalid", "data: {\n\n", "invalid_gateway_response"},
		{"early-done", "data: [DONE]\n\n", "stream_incomplete"},
		{"error", `data: {"error":{"message":"secret-key"}}` + "\n\n", "upstream_rejected"},
		{"negative-usage", `data: {"usage":{"total_tokens":-1}}` + "\n\n", "invalid_gateway_response"},
		{"tool", `data: {"choices":[{"finish_reason":"tool_calls"}]}` + "\n\n", "unsupported_output"},
		{"tool-delta", `data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1"}]}}]}` + "\n\n", "unsupported_output"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(writer, test.body)
			})
			err := streamTestRequest(t, client, context.Background(), testRequest(), func(Event) error { return nil })
			if err == nil || ErrorEvent(err).Code != test.code {
				t.Fatalf("error %v, wanted %s", err, test.code)
			}
		})
	}
}
func TestUpstreamErrorNeverIncludesBody(t *testing.T) {
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(401)
		io.WriteString(writer, `{"error":{"message":"fixture-client-value upstream-secret","code":"fixture-client-value","param":"upstream-secret"}}`)
	})
	err := streamTestRequest(t, client, context.Background(), testRequest(), func(Event) error { return nil })
	event := ErrorEvent(err)
	encoded, _ := json.Marshal(event)
	if event.Code != "gateway_auth_failed" || event.UpstreamStatus != 401 || strings.Contains(string(encoded), "secret") || strings.Contains(string(encoded), "fixture-client-value") {
		t.Fatalf("unsafe error %s", encoded)
	}
}
func TestRedirectIsNeverFollowed(t *testing.T) {
	var calls atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer target.Close()
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, target.URL, 307)
	})
	if _, err := client.ListModels(context.Background()); err == nil || calls.Load() != 0 {
		t.Fatal("redirect followed")
	}
}
func TestCancellationAndIdleTimeoutCloseUpstream(t *testing.T) {
	for _, shouldCancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "timeout", true: "cancel"}[shouldCancel], func(t *testing.T) {
			observed := make(chan struct{})
			began := make(chan struct{})
			client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "text/event-stream")
				writer.(http.Flusher).Flush()
				close(began)
				<-request.Context().Done()
				close(observed)
			})
			client.idleTimeout = 100 * time.Millisecond
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if shouldCancel {
				go func() { <-began; cancel() }()
			}
			err := streamTestRequest(t, client, ctx, testRequest(), func(Event) error { return nil })
			if shouldCancel && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancel error %v", err)
			}
			if !shouldCancel && ErrorEvent(err).Code != "upstream_timeout" {
				t.Fatalf("timeout error %v", err)
			}
			select {
			case <-observed:
			case <-time.After(time.Second):
				t.Fatal("upstream not cancelled")
			}
		})
	}
}
func TestRequestValidation(t *testing.T) {
	var encoded bytes.Buffer
	png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	validImage := "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
	for _, test := range []struct {
		name    string
		edit    func(*ChatRequest)
		isValid bool
	}{
		{"text", func(*ChatRequest) {}, true},
		{"image", func(request *ChatRequest) {
			request.Messages[0].Content = []Content{{Type: "image_url", ImageURL: &ImageURL{URL: validImage}}}
		}, true},
		{"remote", func(request *ChatRequest) {
			request.Messages[0].Content = []Content{{Type: "image_url", ImageURL: &ImageURL{URL: "http://127.0.0.1/private"}}}
		}, false},
		{"spoofed", func(request *ChatRequest) {
			request.Messages[0].Content = []Content{{Type: "image_url", ImageURL: &ImageURL{URL: strings.Replace(validImage, "image/png", "image/jpeg", 1)}}}
		}, false},
		{"bad-base64", func(request *ChatRequest) {
			request.Messages[0].Content = []Content{{Type: "image_url", ImageURL: &ImageURL{URL: "data:image/png;base64,invalid"}}}
		}, false},
		{"five-images", func(request *ChatRequest) {
			for i := 0; i < 5; i++ {
				request.Messages[0].Content = append(request.Messages[0].Content, Content{Type: "image_url", ImageURL: &ImageURL{URL: validImage}})
			}
		}, false},
		{"parameter", func(request *ChatRequest) { value := 3.0; request.Temperature = &value }, false},
		{"reasoning-effort", func(request *ChatRequest) { value := "high"; request.ReasoningEffort = &value }, true},
		{"reasoning-effort-ultra", func(request *ChatRequest) { value := "ultra"; request.ReasoningEffort = &value }, true},
		{"reasoning-effort-custom", func(request *ChatRequest) { value := "custom_effort_1"; request.ReasoningEffort = &value }, true},
		{"bad-reasoning-effort-control", func(request *ChatRequest) { value := "bad\neffort"; request.ReasoningEffort = &value }, false},
		{"bad-reasoning-effort-empty", func(request *ChatRequest) { value := "   "; request.ReasoningEffort = &value }, false},
		{"custom-body-valid", func(request *ChatRequest) { request.CustomBody = []byte(`{"seed":42}`) }, true},
		{"custom-body-invalid", func(request *ChatRequest) { request.CustomBody = []byte(`"not-an-object"`) }, false},
		{"role", func(request *ChatRequest) { request.Messages[0].Role = "tool" }, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := testRequest()
			test.edit(&request)
			if err := Validate(request); (err == nil) != test.isValid {
				t.Fatalf("validation %v", err)
			}
		})
	}
}

// TestCustomBodyOverridesCannotSkipValidation pins the reason validation runs on the
// composed body. `custom_body` is merged last so an override wins, and before that merge
// was validated too, an override of `messages` replaced content the image checks had
// already approved with content they never saw - a remote URL where the console only ever
// accepts an inline data URL. The check is the reason that field is trusted at all, so it
// has to survive the override that outranks it.
func TestCustomBodyOverridesCannotSkipValidation(t *testing.T) {
	var encoded bytes.Buffer
	png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	validImage := "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
	for _, test := range []struct {
		name     string
		body     string
		accepted bool
	}{
		{"override-text", `{"messages":[{"role":"user","content":[{"type":"text","text":"overridden"}]}]}`, true},
		{"override-string-content", `{"messages":[{"role":"user","content":"overridden"}]}`, true},
		{"override-inline-image", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"` + validImage + `"}}]}]}`, true},
		{"override-remote-image", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"http://127.0.0.1/private"}}]}]}`, false},
		{"override-spoofed-image", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"` + strings.Replace(validImage, "image/png", "image/jpeg", 1) + `"}}]}]}`, false},
		{"override-empty-messages", `{"messages":[]}`, false},
		{"override-bad-role", `{"messages":[{"role":"tool","content":[{"type":"text","text":"x"}]}]}`, false},
		{"override-null-messages", `{"messages":null}`, false},
		{"override-blank-model", `{"model":"   "}`, false},
		{"override-bad-temperature", `{"temperature":9}`, false},
		{"override-non-streaming", `{"stream":false}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := testRequest()
			request.CustomBody = json.RawMessage(test.body)
			payload, err := BuildPayload(request)
			if err != nil {
				t.Fatalf("build payload: %v", err)
			}
			if err := ValidatePayload(payload, request.UserAgent); (err == nil) != test.accepted {
				t.Fatalf("validation %v, wanted accepted=%v", err, test.accepted)
			}
		})
	}
}

// TestBuildPayloadOverridePriority states the precedence the panel promises: an override
// wins every collision, and parameters the console does not model survive untouched.
func TestBuildPayloadOverridePriority(t *testing.T) {
	request := testRequest()
	request.Model = "selected-model"
	temperature := 0.9
	request.Temperature = &temperature
	request.CustomBody = json.RawMessage(`{"model":"overridden-model","temperature":0.1,"seed":42,"top_k":7}`)
	payload, err := BuildPayload(request)
	if err != nil {
		t.Fatal(err)
	}
	if payload["model"] != "overridden-model" || payload["temperature"] != 0.1 {
		t.Fatalf("override did not win: %v", payload)
	}
	if payload["seed"] != float64(42) || payload["top_k"] != float64(7) {
		t.Fatalf("unmodelled parameters were dropped: %v", payload)
	}
	if payload["stream"] != true {
		t.Fatalf("streaming was not requested: %v", payload["stream"])
	}
	if _, found := payload["client_key_fingerprint"]; found {
		t.Fatal("fingerprint reached the upstream payload")
	}
}

// TestUserAgentResolutionAndValidation covers both halves of the User-Agent contract: the
// default is derived from the running build, and an operator-supplied value is refused
// when it is not a header value. A CR or LF is a request-splitting attempt; refusing it
// here reports `invalid_parameters` instead of letting the send fail as an outage.
func TestUserAgentResolutionAndValidation(t *testing.T) {
	for _, test := range []struct{ version, want string }{
		{"v1.2.3", "Oh-My-CPA/1.2.3"},
		{"1.2.3", "Oh-My-CPA/1.2.3"},
		{"v0.1.0-dev", "Oh-My-CPA/0.1.0-dev"},
		{"v0.1.0-demo", "Oh-My-CPA/0.1.0-demo"},
		{"", DefaultUserAgent},
		{"   ", DefaultUserAgent},
		{"v", DefaultUserAgent},
		{"bad\nvalue", DefaultUserAgent},
	} {
		if got := UserAgentForVersion(test.version); got != test.want {
			t.Errorf("UserAgentForVersion(%q) = %q, want %q", test.version, got, test.want)
		}
	}

	for _, test := range []struct {
		name      string
		userAgent string
		accepted  bool
	}{
		{"absent", "", true},
		{"blank", "   ", true},
		{"ordinary", "AcmeClient/9.9", true},
		{"cron", "acme-cron/1.0 (+https://example.test/bot)", true},
		{"crlf-injection", "Evil/1.0\r\nX-Injected: 1", false},
		{"lf-only", "Evil/1.0\nX-Injected: 1", false},
		{"nul", "Evil/1.0\x00", false},
		{"non-ascii", "Evil/1.0-\u00e9", false},
		{"too-long", strings.Repeat("a", MaxUserAgentBytes+1), false},
		{"at-limit", strings.Repeat("a", MaxUserAgentBytes), true},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := testRequest()
			request.UserAgent = test.userAgent
			if err := Validate(request); (err == nil) != test.accepted {
				t.Fatalf("validation %v, wanted accepted=%v", err, test.accepted)
			}
		})
	}
}

// TestUserAgentHeaderIsTheDedicatedFieldOnly pins the boundary between the two ways an
// operator can name a user agent. The dedicated field is a transport header; a `user_agent`
// key inside `custom_body` is an ordinary upstream body parameter and must not silently
// become the header, or an override would be controlling transport while looking like it
// only set a body field.
func TestUserAgentHeaderIsTheDedicatedFieldOnly(t *testing.T) {
	var header, bodyValue string
	var inBody bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		header = request.Header.Get("User-Agent")
		raw, _ := io.ReadAll(request.Body)
		var payload map[string]any
		json.Unmarshal(raw, &payload)
		if value, found := payload["user_agent"]; found {
			inBody = true
			bodyValue, _ = value.(string)
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"x\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "fixture-client-value", false)
	if err != nil {
		t.Fatal(err)
	}
	client.httpClient = server.Client()

	request := testRequest()
	request.UserAgent = "HeaderValue/1"
	request.CustomBody = json.RawMessage(`{"user_agent":"BodyValue/2"}`)
	payload, err := BuildPayload(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidatePayload(payload, request.UserAgent); err != nil {
		t.Fatal(err)
	}
	if err := client.Stream(context.Background(), request, payload, func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if header != "HeaderValue/1" {
		t.Errorf("header = %q, want the dedicated field's value", header)
	}
	if !inBody || bodyValue != "BodyValue/2" {
		t.Errorf("custom_body user_agent = %q present=%v, want it passed through as a body parameter", bodyValue, inBody)
	}
}

func TestRequestIDFromTrace(t *testing.T) {
	for _, test := range []struct{ header, want string }{
		{"20260928183000-1a2b3c-0000002a", "0000002a"},
		// An auth index may carry hyphens of its own; the id is always the last segment.
		{"20260928183000-codex-user-1-0000002a", "0000002a"},
		{" 20260928183000-1a2b3c-0000002a ", "0000002a"},
		{"", ""},
		{"0000002a", ""},
		{"20260928183000-1a2b3c-", ""},
		{"20260928183000-1a2b3c-00 2a", ""},
		{"20260928183000-1a2b3c-" + strings.Repeat("a", 65), ""},
	} {
		if got := RequestIDFromTrace(test.header); got != test.want {
			t.Errorf("RequestIDFromTrace(%q) = %q, want %q", test.header, got, test.want)
		}
	}
}

func TestStreamReportsCPARequestIDFirst(t *testing.T) {
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set(TraceIDHeader, "20260928183000-1a2b3c-0000002a")
		writer.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(writer, `data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}`+"\n\n"+`data: [DONE]`+"\n\n")
	})
	var events []Event
	if err := streamTestRequest(t, client, context.Background(), testRequest(), func(event Event) error { events = append(events, event); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].Type != "request" || events[0].RequestID != "0000002a" || events[1].Content != "hello" {
		t.Fatalf("request id was not reported before the answer: %#v", events)
	}
}

func TestStreamWithoutTraceHeaderReportsNoRequestID(t *testing.T) {
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(writer, `data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}`+"\n\n"+`data: [DONE]`+"\n\n")
	})
	var events []Event
	if err := streamTestRequest(t, client, context.Background(), testRequest(), func(event Event) error { events = append(events, event); return nil }); err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Type == "request" || event.RequestID != "" {
			t.Fatalf("an id was invented without a trace header: %#v", events)
		}
	}
}

func TestRejectedRequestCarriesItsRequestID(t *testing.T) {
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set(TraceIDHeader, "20260928183000-1a2b3c-0000002b")
		writer.WriteHeader(429)
		io.WriteString(writer, `{"error":{"message":"slow down"}}`)
	})
	err := streamTestRequest(t, client, context.Background(), testRequest(), func(Event) error { return nil })
	if event := ErrorEvent(err); event.Code != "upstream_rate_limited" || event.RequestID != "0000002b" {
		t.Fatalf("rejected request lost its id: %#v", event)
	}
}
