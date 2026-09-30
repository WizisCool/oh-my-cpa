package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/agent"
	"github.com/oh-my-cpa/oh-my-cpa/internal/agui"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

func queryProjectionFixture() agent.Conversation {
	return agent.Conversation{ID: "conversation", Model: "fixture", Turns: []agent.Turn{{
		ID: "turn", User: "Summarise the query", Reply: "One request", Status: "success",
		Parts: []agent.Part{{Type: "tool", TraceID: "query"}, {Type: "text", Content: "One request"}},
		Traces: []agent.Trace{
			{ID: "query", Name: "database_query", Arguments: `{"sql":"select provider from usage_events"}`, StartedMS: 1, EndedMS: 2,
				Result: capability.Result{Status: "success", Data: json.RawMessage(`{"columns":["provider"],"rows":[["private-query-cell"]]}`)}},
			{ID: "usage", Name: "usage_aggregate", Result: capability.Result{Status: "success", Data: json.RawMessage(`{"requests":1}`)}},
			{ID: "display", Name: "render_table", Result: capability.Result{Status: "success", Data: json.RawMessage(`{"rendered":true,"rows":1}`)},
				View: json.RawMessage(`{"kind":"table","title":"Summary","columns":["requests"],"rows":[{"requests":1}]}`)},
		},
		Messages: []gateway.AgentMessage{{Role: "tool", ToolCallID: "query", Content: "private-query-cell"}},
		Pending:  []gateway.ToolCall{{ID: "internal-pending"}},
	}}}
}

func assertConsoleQueryProjection(t *testing.T, raw []byte) {
	t.Helper()
	for _, private := range []string{"private-query-cell", `"messages"`, `"pending"`} {
		if strings.Contains(string(raw), private) {
			t.Fatalf("console response exposed %s: %s", private, raw)
		}
	}
	var conversation agent.Conversation
	if err := json.Unmarshal(raw, &conversation); err != nil {
		t.Fatal(err)
	}
	turn := conversation.Turns[0]
	if turn.Status != "success" || len(turn.Parts) != 2 || turn.Reply != "One request" || len(turn.Traces) != 3 {
		t.Fatalf("transcript changed: %+v", turn)
	}
	if turn.Traces[0].Result.Data != nil || turn.Traces[0].Result.Status != "success" || turn.Traces[0].EndedMS != 2 {
		t.Fatalf("query receipt: %+v", turn.Traces[0])
	}
	if string(turn.Traces[1].Result.Data) != `{"requests":1}` || len(turn.Traces[2].View) == 0 {
		t.Fatalf("dedicated read or final display lost: %+v", turn.Traces)
	}
}

func TestAgentSessionProjectsStoredQueryResults(t *testing.T) {
	fixture := newProviderTestFixture(t)
	if err := fixture.handler.ensureAgent(); err != nil {
		t.Fatal(err)
	}
	conversation := queryProjectionFixture()
	if _, err := fixture.handler.agent.runtime.Store.Save(context.Background(), "session", "latest", 0, time.Now().Add(time.Hour), &conversation); err != nil {
		t.Fatal(err)
	}
	response, raw := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/agent/session")
	if response.StatusCode != 200 {
		t.Fatalf("session status %d: %s", response.StatusCode, raw)
	}
	assertConsoleQueryProjection(t, raw)
	stored, err := fixture.handler.agent.runtime.Current(context.Background())
	if err != nil || !strings.Contains(string(stored.Turns[0].Traces[0].Result.Data), "private-query-cell") || len(stored.Turns[0].Messages) == 0 {
		t.Fatalf("model data changed: %+v, %v", stored, err)
	}
}

func TestAgentStreamProjectsQueryResultsAndSnapshot(t *testing.T) {
	conversation := queryProjectionFixture()
	original, _ := json.Marshal(conversation)
	var events []agui.Event
	translator := agui.NewTranslator("run", func(event agui.Event) error {
		events = append(events, event)
		return nil
	})
	for _, status := range []string{"success", "error", "pending"} {
		trace := conversation.Turns[0].Traces[0]
		trace.Result.Status = status
		trace.Result.Code = "query_code"
		trace.Result.Detail = "query diagnostic"
		trace.View = json.RawMessage(`{"rows":[["private-query-cell"]]}`)
		content, _ := json.Marshal(trace.Result)
		if err := translateAgentEvent(translator, "fixture", agent.Event{Type: "tool_result", Trace: &trace, Content: string(content)}); err != nil {
			t.Fatal(err)
		}
		resultEvent := events[len(events)-1]
		raw, _ := json.Marshal(resultEvent)
		if resultEvent.Type != agui.TOOL_CALL_RESULT || strings.Contains(string(raw), "private-query-cell") {
			t.Fatalf("query event: %s", raw)
		}
		var receipt capability.Result
		if err := json.Unmarshal([]byte(resultEvent.Content), &receipt); err != nil || receipt.Data != nil || receipt.Status != status || receipt.Code != trace.Result.Code || receipt.Detail != trace.Result.Detail {
			t.Fatalf("query receipt: %+v, %v", receipt, err)
		}
		if resultEvent.Metadata["started_at_ms"] != int64(1) || resultEvent.Metadata["ended_at_ms"] != int64(2) {
			t.Fatalf("query timing lost: %+v", resultEvent.Metadata)
		}
	}
	if err := translateAgentEvent(translator, "fixture", agent.Event{Type: "finished", Conversation: &conversation}); err != nil {
		t.Fatal(err)
	}
	hasSnapshot := false
	for _, event := range events {
		if event.Type == agui.STATE_SNAPSHOT {
			hasSnapshot = true
			raw, err := json.Marshal(event.Snapshot)
			if err != nil {
				t.Fatal(err)
			}
			assertConsoleQueryProjection(t, raw)
		}
	}
	if !hasSnapshot {
		t.Fatal("missing final console snapshot")
	}
	after, _ := json.Marshal(conversation)
	if string(after) != string(original) {
		t.Fatal("console projection mutated model history")
	}
}
