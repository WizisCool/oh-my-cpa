package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// agentRound is a second round of a tool loop: the model called a tool, the tool answered, and
// the conversation goes back with both.
func agentRound(endpoint Endpoint) AgentRequest {
	return AgentRequest{Endpoint: endpoint, Model: "model", ReasoningEffort: "high", Messages: []AgentMessage{
		{Role: "system", Content: "Be brief."},
		{Role: "user", Content: "count the providers", Images: []AgentImage{{ID: "a", MediaType: "image/png", URL: "data:image/png;base64,AAAA"}, {ID: "b", MediaType: "image/png"}}},
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "call-1", Type: "function", Function: ToolFunction{Name: "providers_list", Arguments: `{"limit":2}`}}, {ID: "call-2", Type: "function", Function: ToolFunction{Name: "keys_list", Arguments: `{}`}}},
			Thinking: []ThinkingBlock{{Type: "thinking", Thinking: "look first", Signature: "sig"}}},
		{Role: "tool", ToolCallID: "call-1", Content: `{"providers":2}`},
		{Role: "tool", ToolCallID: "call-2", Content: `{"keys":1}`},
	}, Tools: []AgentTool{{Type: "function", Function: ToolDefinition{Name: "providers_list", Description: "List providers.", Parameters: map[string]any{"type": "object"}}}}}
}

func streamAgentRound(t *testing.T, endpoint Endpoint, wantPath, body string) (AgentReply, []Event, map[string]any, error) {
	t.Helper()
	var sent map[string]any
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != wantPath {
			t.Errorf("round sent to %s, wanted %s", request.URL.Path, wantPath)
		}
		json.NewDecoder(request.Body).Decode(&sent)
		writer.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(writer, body)
	})
	var events []Event
	reply, err := client.StreamAgent(context.Background(), agentRound(endpoint), func(event Event) error { events = append(events, event); return nil })
	return reply, events, sent, err
}

func TestAgentChatRoundNeverCarriesAnotherEndpointsReasoning(t *testing.T) {
	_, _, sent, err := streamAgentRound(t, EndpointChat, "/v1/chat/completions",
		"data: {\"choices\":[{\"delta\":{\"content\":\"two\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	if err != nil {
		t.Fatal(err)
	}
	if encoded := mustJSON(t, sent); strings.Contains(encoded, "look first") || strings.Contains(encoded, `"thinking"`) || sent["reasoning_effort"] != "high" {
		t.Fatalf("chat round carried signed reasoning: %s", encoded)
	}
}

func TestAgentResponsesRound(t *testing.T) {
	body := "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"reasoning\"}}\n\n" +
		"data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"thinking\"}\n\n" +
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"checking\"}\n\n" +
		"data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call-3\",\"name\":\"providers_list\"}}\n\n" +
		"data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"lim\"}\n\n" +
		"data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call-3\",\"name\":\"providers_list\",\"arguments\":\"{\\\"limit\\\":5}\"}}\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":3,\"total_tokens\":12}}}\n\n"
	reply, events, sent, err := streamAgentRound(t, EndpointResponses, "/v1/responses", body)
	if err != nil {
		t.Fatal(err)
	}
	if reply.Content != "checking" || len(reply.Calls) != 1 || reply.Calls[0].ID != "call-3" || reply.Calls[0].Function.Arguments != `{"limit":5}` || *reply.Usage.TotalTokens != 12 || len(events) != 2 || events[0].Type != "thought" {
		t.Fatalf("unexpected reply %#v %#v", reply, events)
	}
	var wire struct {
		Instructions string
		Reasoning    struct{ Effort string }
		Tools        []struct{ Type, Name string }
		Input        []struct {
			Type, Role, Name, Arguments, Output string
			CallID                              string `json:"call_id"`
			Content                             []struct{ Type, Text string }
		}
	}
	json.Unmarshal([]byte(mustJSON(t, sent)), &wire)
	if wire.Instructions != "Be brief." || wire.Reasoning.Effort != "high" || len(wire.Tools) != 1 || wire.Tools[0].Name != "providers_list" || len(wire.Input) != 5 ||
		wire.Input[0].Content[1].Type != "input_image" || wire.Input[0].Content[2].Text != IMAGE_UNAVAILABLE ||
		wire.Input[1].Type != "function_call" || wire.Input[1].CallID != "call-1" || wire.Input[3].Type != "function_call_output" || wire.Input[3].Output != `{"providers":2}` {
		t.Fatalf("unexpected body %s", mustJSON(t, sent))
	}
	for name, test := range map[string]struct{ body, code string }{
		"truncated": {`data: {"type":"response.incomplete","response":{}}` + "\n\n", "unsupported_output"},
		"failed":    {`data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"secret"}}}` + "\n\n", "context_length_exceeded"},
		"error":     {`data: {"type":"error","code":"rate_limit_error","message":"secret"}` + "\n\n", "upstream_rejected"},
		"partial":   {`data: {"type":"response.output_text.delta","delta":"partial"}` + "\n\n", "stream_incomplete"},
		"bad-args":  {`data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c","name":"n","arguments":"{"}}` + "\n\n" + `data: {"type":"response.completed","response":{}}` + "\n\n", "invalid_gateway_response"},
		"other":     {`data: {"type":"response.output_item.added","item":{"type":"web_search_call"}}` + "\n\n", "unsupported_output"},
	} {
		if _, _, _, err := streamAgentRound(t, EndpointResponses, "/v1/responses", test.body); err == nil || ErrorEvent(err).Code != test.code {
			t.Errorf("%s: error %v, wanted %s", name, err, test.code)
		}
	}
}

func TestAgentMessagesRound(t *testing.T) {
	body := "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9}}}\n\n" +
		"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"plan\"}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"signed\"}}\n\n" +
		"data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\"}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"checking\"}}\n\n" +
		"data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call-3\",\"name\":\"providers_list\"}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"limit\\\"\"}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\":5}\"}}\n\n" +
		"data: {\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call-4\",\"name\":\"keys_list\"}}\n\n" +
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":3}}\n\n" +
		"data: {\"type\":\"message_stop\"}\n\n"
	reply, events, sent, err := streamAgentRound(t, EndpointMessages, "/v1/messages", body)
	if err != nil {
		t.Fatal(err)
	}
	if reply.Content != "checking" || len(reply.Calls) != 2 || reply.Calls[0].Function.Arguments != `{"limit":5}` || reply.Calls[1].Function.Arguments != "{}" || *reply.Usage.TotalTokens != 12 ||
		len(reply.Thinking) != 1 || reply.Thinking[0].Thinking != "plan" || reply.Thinking[0].Signature != "signed" || len(events) != 2 || events[0].Type != "thought" {
		t.Fatalf("unexpected reply %#v %#v", reply, events)
	}
	var wire struct {
		System       string
		MaxTokens    int `json:"max_tokens"`
		Thinking     struct{ Type string }
		OutputConfig struct{ Effort string } `json:"output_config"`
		Tools        []struct {
			Name        string
			InputSchema map[string]any `json:"input_schema"`
		}
		Messages []struct {
			Role    string
			Content []struct {
				Type, Text, Thinking, Signature, ID, Name, Content string
				ToolUseID                                          string `json:"tool_use_id"`
				Input                                              map[string]any
			}
		}
	}
	json.Unmarshal([]byte(mustJSON(t, sent)), &wire)
	if wire.System != "Be brief." || wire.MaxTokens != AGENT_MESSAGES_MAX_TOKENS || wire.Thinking.Type != "adaptive" || wire.OutputConfig.Effort != "high" || wire.Tools[0].InputSchema["type"] != "object" || len(wire.Messages) != 3 {
		t.Fatalf("unexpected body %s", mustJSON(t, sent))
	}
	assistant, results := wire.Messages[1], wire.Messages[2]
	// The signed reasoning leads the reply it belonged to, and both results return in one message.
	if assistant.Content[0].Type != "thinking" || assistant.Content[0].Signature != "sig" || assistant.Content[1].Type != "tool_use" || assistant.Content[1].Input["limit"] != float64(2) ||
		results.Role != "user" || len(results.Content) != 2 || results.Content[1].ToolUseID != "call-2" || results.Content[0].Content != `{"providers":2}` {
		t.Fatalf("unexpected messages %s", mustJSON(t, sent["messages"]))
	}
	for name, test := range map[string]struct{ body, code string }{
		"truncated": {`data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}` + "\n\n" + `data: {"type":"message_stop"}` + "\n\n", "unsupported_output"},
		"error":     {`data: {"type":"error","error":{"type":"overloaded_error","message":"secret"}}` + "\n\n", "upstream_rejected"},
		"partial":   {`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}` + "\n\n", "stream_incomplete"},
		"orphan":    {`data: {"type":"content_block_delta","index":4,"delta":{"type":"input_json_delta","partial_json":"{}"}}` + "\n\n", "invalid_gateway_response"},
		"other":     {`data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use"}}` + "\n\n", "unsupported_output"},
	} {
		if _, _, _, err := streamAgentRound(t, EndpointMessages, "/v1/messages", test.body); err == nil || ErrorEvent(err).Code != test.code {
			t.Errorf("%s: error %v, wanted %s", name, err, test.code)
		}
	}
}
