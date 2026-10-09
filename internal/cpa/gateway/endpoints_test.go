package gateway

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"
)

func inlinePNG() string {
	var encoded bytes.Buffer
	png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
}

func endpointRequest(endpoint Endpoint) ChatRequest {
	effort, maxTokens := "high", 512
	request := ChatRequest{Endpoint: endpoint, Model: "test-model", ReasoningEffort: &effort, MaxTokens: &maxTokens, Messages: []Message{
		{Role: "system", Content: []Content{{Type: "text", Text: "Be brief."}}},
		{Role: "user", Content: []Content{{Type: "text", Text: "hello"}, {Type: "image_url", ImageURL: &ImageURL{URL: inlinePNG()}}}},
		{Role: "assistant", Content: []Content{{Type: "text", Text: "hi"}}},
		{Role: "user", Content: []Content{{Type: "text", Text: "again"}}},
	}}
	return request
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestParseEndpointDefaultsToChatAndRefusesTheUnknown(t *testing.T) {
	for value, want := range map[string]Endpoint{"": EndpointChat, "chat": EndpointChat, "responses": EndpointResponses, "messages": EndpointMessages} {
		if got, ok := ParseEndpoint(value); !ok || got != want {
			t.Errorf("ParseEndpoint(%q) = %q, %v", value, got, ok)
		}
	}
	if _, ok := ParseEndpoint("/v1/embeddings"); ok {
		t.Error("an endpoint outside the three was accepted")
	}
}

func TestResponsesPayloadCarriesTheConversationInItsOwnSchema(t *testing.T) {
	request := endpointRequest(EndpointResponses)
	payload, err := BuildPayload(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateRequest(request, payload); err != nil {
		t.Fatalf("validate: %v", err)
	}
	var body struct {
		Instructions    string `json:"instructions"`
		MaxOutputTokens int    `json:"max_output_tokens"`
		Stream          bool   `json:"stream"`
		Reasoning       struct{ Effort, Summary string }
		Input           []struct {
			Role    string
			Content []struct {
				Type     string
				Text     string
				ImageURL string `json:"image_url"`
			}
		}
		Messages json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal([]byte(mustJSON(t, payload)), &body); err != nil {
		t.Fatal(err)
	}
	if body.Instructions != "Be brief." || body.MaxOutputTokens != 512 || !body.Stream || body.Reasoning.Effort != "high" || body.Reasoning.Summary != "auto" || body.Messages != nil {
		t.Fatalf("unexpected fields: %s", mustJSON(t, payload))
	}
	if len(body.Input) != 3 || body.Input[0].Content[0].Type != "input_text" || body.Input[0].Content[1].Type != "input_image" || body.Input[0].Content[1].ImageURL == "" || body.Input[1].Content[0].Type != "output_text" {
		t.Fatalf("unexpected input: %s", mustJSON(t, payload["input"]))
	}
}

func TestMessagesPayloadCarriesTheConversationInItsOwnSchema(t *testing.T) {
	request := endpointRequest(EndpointMessages)
	payload, err := BuildPayload(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateRequest(request, payload); err != nil {
		t.Fatalf("validate: %v", err)
	}
	var body struct {
		System       string
		MaxTokens    int `json:"max_tokens"`
		Thinking     struct{ Type string }
		OutputConfig struct{ Effort string } `json:"output_config"`
		Messages     []struct {
			Role    string
			Content []struct {
				Type   string
				Source struct {
					Type      string
					MediaType string `json:"media_type"`
					Data      string
				}
			}
		}
	}
	if err := json.Unmarshal([]byte(mustJSON(t, payload)), &body); err != nil {
		t.Fatal(err)
	}
	image := body.Messages[0].Content[1]
	if body.System != "Be brief." || body.MaxTokens != 512 || body.Thinking.Type != "adaptive" || body.OutputConfig.Effort != "high" || len(body.Messages) != 3 ||
		image.Type != "image" || image.Source.Type != "base64" || image.Source.MediaType != "image/png" || image.Source.Data == "" {
		t.Fatalf("unexpected body: %s", mustJSON(t, payload))
	}

	request.MaxTokens = nil
	none := "none"
	request.ReasoningEffort = &none
	payload, _ = BuildPayload(request)
	if payload["max_tokens"] != DEFAULT_MESSAGES_MAX_TOKENS || payload["output_config"] != nil || mustJSON(t, payload["thinking"]) != `{"type":"disabled"}` {
		t.Fatalf("unset limit or disabled thinking is wrong: %s", mustJSON(t, payload))
	}
}

func TestOtherEndpointsRefuseAnOverrideOfTheConversation(t *testing.T) {
	for endpoint, body := range map[Endpoint]string{
		EndpointResponses: `{"input":[{"role":"user","content":[{"type":"input_image","image_url":"https://example.invalid/x.png"}]}]}`,
		EndpointMessages:  `{"messages":[{"role":"user","content":"replaced"}]}`,
	} {
		request := endpointRequest(endpoint)
		request.CustomBody = json.RawMessage(body)
		payload, err := BuildPayload(request)
		if err != nil {
			t.Fatal(err)
		}
		err = ValidateRequest(request, payload)
		event := ErrorEvent(err)
		if err == nil || event.Code != "unsupported_parameter" || event.Parameter != endpoint.contentKey() {
			t.Errorf("%s: override of the conversation gave %v", endpoint, err)
		}
		request.CustomBody = json.RawMessage(`{"stream":false}`)
		payload, _ = BuildPayload(request)
		if err := ValidateRequest(request, payload); err == nil || ErrorEvent(err).Parameter != "stream" {
			t.Errorf("%s: a non-streamed body gave %v", endpoint, err)
		}
		request.CustomBody = json.RawMessage(`{"metadata":{"trace":"a"}}`)
		payload, _ = BuildPayload(request)
		if err := ValidateRequest(request, payload); err != nil || payload["metadata"] == nil {
			t.Errorf("%s: an unrelated override gave %v", endpoint, err)
		}
	}
	// The console's own messages are still checked before they are converted.
	request := endpointRequest(EndpointMessages)
	request.Messages[1].Content[1].ImageURL.URL = "https://example.invalid/x.png"
	payload, _ := BuildPayload(request)
	if err := ValidateRequest(request, payload); err == nil || err.Error() != "invalid_image" {
		t.Errorf("a remote image reached the Messages endpoint: %v", err)
	}
}

func streamEndpoint(t *testing.T, endpoint Endpoint, wantPath, body string, inspect func(*http.Request)) ([]Event, error) {
	t.Helper()
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != wantPath || request.Header.Get("Authorization") != "Bearer fixture-client-value" {
			t.Errorf("wrong inference request: %s", request.URL.Path)
		}
		if inspect != nil {
			inspect(request)
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(writer, body)
	})
	request := endpointRequest(endpoint)
	payload, err := BuildPayload(request)
	if err != nil {
		t.Fatal(err)
	}
	var events []Event
	err = client.Stream(context.Background(), request, payload, func(event Event) error { events = append(events, event); return nil })
	return events, err
}

func TestResponsesStreamProjection(t *testing.T) {
	body := "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n" +
		"data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"reasoning\"}}\n\n" +
		"data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"thinking\"}\n\n" +
		"data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"message\"}}\n\n" +
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\",\"api_key\":\"do-not-forward\"}\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":4,\"output_tokens\":2,\"total_tokens\":6}}}\n\n"
	events, err := streamEndpoint(t, EndpointResponses, "/v1/responses", body, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded := mustJSON(t, events)
	if len(events) != 4 || events[0].Type != "thought" || events[1].Content != "你好" || events[2].Type != "usage" || *events[2].Usage.TotalTokens != 6 || events[3].Type != "done" || events[3].FinishReason != "stop" {
		t.Fatalf("unexpected stream %s", encoded)
	}
	for name, test := range map[string]struct{ body, code, finish string }{
		"length":     {`data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}` + "\n\n", "", "length"},
		"filter":     {`data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}` + "\n\n", "", "content_filter"},
		"failed":     {`data: {"type":"response.failed","response":{"error":{"message":"secret"}}}` + "\n\n", "upstream_rejected", ""},
		"tool":       {`data: {"type":"response.output_item.added","item":{"type":"function_call"}}` + "\n\n", "unsupported_output", ""},
		"incomplete": {`data: {"type":"response.output_text.delta","delta":"partial"}` + "\n\n", "stream_incomplete", ""},
		"early-done": {"data: [DONE]\n\n", "stream_incomplete", ""},
		"invalid":    {"data: {\n\n", "invalid_gateway_response", ""},
	} {
		events, err := streamEndpoint(t, EndpointResponses, "/v1/responses", test.body, nil)
		if test.code != "" {
			if err == nil || ErrorEvent(err).Code != test.code {
				t.Errorf("%s: error %v, wanted %s", name, err, test.code)
			}
		} else if err != nil || events[len(events)-1].FinishReason != test.finish {
			t.Errorf("%s: %v %s", name, err, mustJSON(t, events))
		}
	}
}

func TestMessagesStreamProjection(t *testing.T) {
	body := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":4,\"cache_read_input_tokens\":10,\"output_tokens\":1}}}\n\n" +
		"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"thinking\"}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"do-not-forward\"}}\n\n" +
		"data: {\"type\":\"ping\"}\n\n" +
		"data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\"}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}\n\n" +
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n" +
		"data: {\"type\":\"message_stop\"}\n\n"
	events, err := streamEndpoint(t, EndpointMessages, "/v1/messages", body, func(request *http.Request) {
		if request.Header.Get("anthropic-version") != MESSAGES_VERSION {
			t.Error("a Messages request did not state its version")
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded := mustJSON(t, events)
	if len(events) != 4 || events[0].Type != "thought" || events[1].Content != "你好" || *events[2].Usage.PromptTokens != 14 || *events[2].Usage.CompletionTokens != 2 || *events[2].Usage.TotalTokens != 16 ||
		events[3].Type != "done" || events[3].FinishReason != "stop" || strings.Contains(encoded, "do-not-forward") {
		t.Fatalf("unexpected stream %s", encoded)
	}
	for name, test := range map[string]struct{ body, code, finish string }{
		"length":     {`data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}` + "\n\n" + `data: {"type":"message_stop"}` + "\n\n", "", "length"},
		"refusal":    {`data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}` + "\n\n" + `data: {"type":"message_stop"}` + "\n\n", "", "content_filter"},
		"error":      {`data: {"type":"error","error":{"type":"overloaded_error","message":"secret"}}` + "\n\n", "upstream_rejected", ""},
		"tool-block": {`data: {"type":"content_block_start","content_block":{"type":"tool_use"}}` + "\n\n", "unsupported_output", ""},
		"tool-stop":  {`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}` + "\n\n", "unsupported_output", ""},
		"early-stop": {`data: {"type":"message_stop"}` + "\n\n", "stream_incomplete", ""},
		"incomplete": {`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}` + "\n\n", "stream_incomplete", ""},
		"negative":   {`data: {"type":"message_delta","delta":{},"usage":{"output_tokens":-1}}` + "\n\n", "invalid_gateway_response", ""},
	} {
		events, err := streamEndpoint(t, EndpointMessages, "/v1/messages", test.body, nil)
		if test.code != "" {
			if err == nil || ErrorEvent(err).Code != test.code {
				t.Errorf("%s: error %v, wanted %s", name, err, test.code)
			}
		} else if err != nil || events[len(events)-1].FinishReason != test.finish {
			t.Errorf("%s: %v %s", name, err, mustJSON(t, events))
		}
	}
}
