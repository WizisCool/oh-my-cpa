package warmup

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type recordingCaller struct {
	request  management.ApiCallRequest
	response management.ApiCallResponse
	err      error
}

func (caller *recordingCaller) ApiCall(_ context.Context, request management.ApiCallRequest) (management.ApiCallResponse, error) {
	caller.request = request
	return caller.response, caller.err
}
func TestAdaptersFixedTargetAndCompletion(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			body := `{"type":"message","stop_reason":"end_turn","content":[{"type":"text","text":"OK"}],"usage":{"input_tokens":4,"output_tokens":1}}`
			if provider == "codex" {
				body = "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\"}],\"usage\":{\"input_tokens\":4,\"output_tokens\":1}}}\n\n"
			}
			encoded, _ := json.Marshal(body)
			caller := &recordingCaller{response: management.ApiCallResponse{StatusCode: 200, Body: encoded}}
			outcome := Send(context.Background(), caller, management.AuthFile{AuthIndex: "exact-target"}, provider, "selected-model")
			if outcome.Status != "pending" || outcome.InputTokens == nil || *outcome.OutputTokens != 1 {
				t.Fatalf("%+v", outcome)
			}
			expected := CLAUDE_ENDPOINT
			if provider == "codex" {
				expected = CODEX_ENDPOINT
			}
			if caller.request.AuthIndex != "exact-target" || caller.request.URL != expected || caller.request.Method != "POST" || caller.request.Header["Authorization"] != "Bearer $TOKEN$" {
				t.Fatalf("wrong target: %+v", caller.request)
			}
			var payload map[string]any
			if json.Unmarshal([]byte(caller.request.Data), &payload) != nil || payload["model"] != "selected-model" {
				t.Fatal("model not explicit")
			}
			if len(payload["tools"].([]any)) != 0 || strings.Contains(caller.request.Data, "reset-credit") {
				t.Fatal("unexpected side effect")
			}
		})
	}
}
func TestHTTPAndTerminalFailuresDoNotClaimActivation(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		response management.ApiCallResponse
		err      error
		status   string
	}{
		{"transport", management.ApiCallResponse{}, errors.New("secret-token"), "uncertain"},
		{"server", management.ApiCallResponse{StatusCode: 500}, nil, "uncertain"},
		{"rejected", management.ApiCallResponse{StatusCode: 429}, nil, "failed"},
		{"empty2xx", management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{}`)}, nil, "uncertain"},
		{"broken", management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`"data: {}\n\n"`)}, nil, "uncertain"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			caller := &recordingCaller{response: scenario.response, err: scenario.err}
			outcome := Send(context.Background(), caller, management.AuthFile{AuthIndex: "target"}, "codex", "model")
			if outcome.Status != scenario.status || strings.Contains(outcome.Reason, "secret") {
				t.Fatalf("%+v", outcome)
			}
		})
	}
}
