package gateway

import (
	"context"
	"io"
	"net/http"
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
