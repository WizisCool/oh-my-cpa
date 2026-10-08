package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentStreamAssemblesCallsOnlyAfterCompleteFinish(t *testing.T) {
	stream := `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"first","type":"function","function":{"name":"usage_","arguments":"{\"limit\":"}},{"index":1,"id":"second","type":"function","function":{"name":"keys_list","arguments":"{"}}]}}]}` + "\n\n" +
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"aggregate","arguments":"20}"}},{"index":1,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}` + "\n\n" + "data: [DONE]\n\n"
	for _, complete := range []bool{true, false} {
		t.Run(map[bool]string{true: "complete", false: "interrupted"}[complete], func(t *testing.T) {
			client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/v1/chat/completions" {
					t.Fatal("arbitrary endpoint")
				}
				writer.Header().Set("Content-Type", "text/event-stream")
				body := stream
				if !complete {
					body = strings.Split(body, "data: [DONE]")[0]
				}
				io.WriteString(writer, body)
			})
			reply, err := client.StreamAgent(context.Background(), "model", "", []AgentMessage{{Role: "user", Content: "count"}}, nil, func(Event) error { return nil })
			if !complete {
				if err == nil || len(reply.Calls) != 0 {
					t.Fatal("incomplete stream produced executable calls")
				}
				return
			}
			if err != nil || len(reply.Calls) != 2 || reply.Calls[0].Function.Name != "usage_aggregate" || reply.Calls[0].Function.Arguments != `{"limit":20}` {
				t.Fatalf("reply %+v %v", reply, err)
			}
		})
	}
}
func TestAgentRejectsLegacyFunctionsAndMalformedCalls(t *testing.T) {
	for _, delta := range []string{`"function_call":{"name":"shell","arguments":"{}"}`, `"tool_calls":[{"index":0,"id":"x","function":{"name":"keys_list","arguments":"invalid"}}]`} {
		client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(writer, `data: {"choices":[{"index":0,"delta":{`+delta+`},"finish_reason":"function_call"}]}`+"\n\ndata: [DONE]\n\n")
		})
		reply, err := client.StreamAgent(context.Background(), "model", "", nil, nil, func(Event) error { return nil })
		if err == nil || len(reply.Calls) != 0 {
			t.Fatal("unsafe output accepted")
		}
	}
}

// TestAgentStreamSeparatesReasoningAndForwardsEffort pins the two halves of showing reasoning:
// the thought arrives as its own event and never joins the reply the next round is built from,
// and the operator's effort level reaches the upstream body.
func TestAgentStreamSeparatesReasoningAndForwardsEffort(t *testing.T) {
	var body string
	client := makeClient(t, func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		body = string(raw)
		writer.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(writer, `data: {"choices":[{"index":0,"delta":{"reasoning_content":"weigh it"}}]}`+"\n\n"+
			`data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	})
	var thought string
	reply, err := client.StreamAgent(context.Background(), "model", "high", []AgentMessage{{Role: "user", Content: "q"}}, nil, func(event Event) error {
		if event.Type == "thought" {
			thought += event.Content
		}
		return nil
	})
	if err != nil || reply.Content != "answer" || thought != "weigh it" {
		t.Fatalf("reply %+v thought %q err %v", reply, thought, err)
	}
	if !strings.Contains(body, `"reasoning_effort":"high"`) {
		t.Fatalf("effort not forwarded: %s", body)
	}
	if _, err := client.StreamAgent(context.Background(), "model", "bad\neffort", nil, nil, func(Event) error { return nil }); err == nil {
		t.Fatal("a control character in the effort level was accepted")
	}
}

// A message with images is multi-part content; one without stays the plain string every provider
// accepts, and an image no longer loaded is said to be missing rather than silently dropped.
func TestAgentWireMessagesCarryImagesAsParts(t *testing.T) {
	wire, imageBytes := agentWireMessages([]AgentMessage{
		{Role: "system", Content: "s"},
		{Role: "user", Content: "What is this?", Images: []AgentImage{{ID: "a", URL: "data:image/png;base64,AAAA"}, {ID: "b"}}},
	})
	raw, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"role":"system","content":"s"},{"content":[{"type":"text","text":"What is this?"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}},{"type":"text","text":"` + IMAGE_UNAVAILABLE + `"}],"role":"user"}]`
	if string(raw) != want || imageBytes != len("data:image/png;base64,AAAA") {
		t.Fatalf("wire %s (%d image bytes)", raw, imageBytes)
	}
}

func TestAgentContextErrorsInHTTPAndStreamAreStructured(t *testing.T) {
	for _, isStream := range []bool{false, true} {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if isStream {
				writer.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(writer, "data: {\"error\":{\"type\":\"context_window_exceeded\",\"param\":\"messages\",\"message\":\"sensitive prompt excerpt\"}}\n\n")
			} else {
				writer.WriteHeader(400)
				fmt.Fprint(writer, `{"error":{"code":"prompt_too_long","param":"messages","message":"sensitive prompt excerpt"}}`)
			}
		}))
		client, _ := NewClient(server.URL, "key", false)
		_, err := client.StreamAgent(context.Background(), "fixture", "", []AgentMessage{{Role: "user", Content: "q"}}, nil, func(Event) error { return nil })
		var failure *Error
		if !errors.As(err, &failure) || failure.Code != "context_length_exceeded" || failure.Parameter != "messages" || strings.Contains(err.Error(), "sensitive") {
			t.Fatalf("error %+v", err)
		}
		server.Close()
	}
}

// A stream error arrives after the status line, so the frame's own words decide whether another
// attempt can help: a named transient fault is an outage, anything else is a refusal.
func TestAgentStreamSeparatesRefusalsFromOutages(t *testing.T) {
	for _, testCase := range []struct{ name, frame, code string }{
		{name: "unnamed", frame: `{"error":{"message":"sensitive prompt excerpt"}}`, code: "upstream_stream_rejected"},
		{name: "refusal", frame: `{"error":{"type":"invalid_request_error"}}`, code: "upstream_stream_rejected"},
		{name: "outage", frame: `{"error":{"type":"server_error"}}`, code: "upstream_rejected"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(writer, "data: %s\n\n", testCase.frame)
			}))
			client, _ := NewClient(server.URL, "key", false)
			_, err := client.StreamAgent(context.Background(), "fixture", "", []AgentMessage{{Role: "user", Content: "q"}}, nil, func(Event) error { return nil })
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != testCase.code || strings.Contains(err.Error(), "sensitive") {
				t.Fatalf("error %+v", err)
			}
			server.Close()
		})
	}
}

func TestAgentDoesNotSendTokenBudgetsOrCapToolCounts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		for _, name := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
			if _, exists := payload[name]; exists {
				t.Errorf("token budget sent: %s", name)
			}
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		for index := 0; index < 32; index++ {
			fmt.Fprintf(writer, "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":%d,\"id\":\"call-%d\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]}}]}\n\n", index, index)
		}
		fmt.Fprint(writer, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, "key", false)
	reply, err := client.StreamAgent(context.Background(), "fixture", "", []AgentMessage{{Role: "user", Content: strings.Repeat("x", 2<<20)}}, nil, func(Event) error { return nil })
	if err != nil || len(reply.Calls) != 32 {
		t.Fatalf("calls %d err %v", len(reply.Calls), err)
	}
}
