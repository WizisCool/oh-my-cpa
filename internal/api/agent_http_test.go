package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/agent"
	"github.com/oh-my-cpa/oh-my-cpa/internal/agui"
	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

func TestAgentHTTPManagementKeyAndCapabilityBoundary(t *testing.T) {
	fixture := newProviderTestFixture(t)
	response, body := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/capabilities")
	if response.StatusCode != 200 || !strings.Contains(string(body), "usage_aggregate") {
		t.Fatalf("catalog %d %s", response.StatusCode, body)
	}
	response, body = getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/agent/session")
	if response.StatusCode != 200 || !strings.Contains(string(body), `"turns":[]`) {
		t.Fatalf("session %d %s", response.StatusCode, body)
	}
	// An image is served only while the current conversation references it.
	response, body = getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/agent/images/not-referenced")
	if response.StatusCode != 404 || !strings.Contains(string(body), "resource_not_found") {
		t.Fatalf("unreferenced image %d %s", response.StatusCode, body)
	}
	external := &http.Client{}
	call := func(method, path, payload, key string) (int, []byte) {
		request, _ := http.NewRequest(method, fixture.baseURL+"/omc/api/v1"+path, strings.NewReader(payload))
		request.Header.Set("Authorization", "Bearer "+key)
		response, err := external.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, body
	}
	status, _ := call("GET", "/capabilities", "", "incorrect")
	if status != 401 {
		t.Fatal("invalid management key accepted")
	}
	status, body = call("GET", "/capabilities", "", "management-secret-value")
	if status != 200 || !strings.Contains(string(body), "keys_list") {
		t.Fatalf("catalog %d %s", status, body)
	}
	for _, path := range []string{"/management/client-api-keys", "/agent/session", "/agent/images/any", "/agent/runs/active", "/playground/runs/active", "/agent/runs/private-run", "/playground/runs/private-run"} {
		status, _ = call("GET", path, "", "management-secret-value")
		if status != 401 {
			t.Fatalf("bearer accepted outside capability API: %s %d", path, status)
		}
	}
	status, body = call("POST", "/capabilities/invoke", `{"name":"keys_list","arguments":{}}`, "management-secret-value")
	if status != 200 || !strings.Contains(string(body), `"status":"success"`) {
		t.Fatalf("read %d %s", status, body)
	}
	fixture.state.mu.Lock()
	keys := append([]string{}, fixture.state.clientKeys...)
	fixture.state.mu.Unlock()
	for _, key := range append(keys, "management-secret-value") {
		if strings.Contains(string(body), key) {
			t.Fatal("key leaked")
		}
	}
	status, body = call("POST", "/capabilities/invoke", `{"name":"keys_create","arguments":{}}`, "management-secret-value")
	if status != 200 || !strings.Contains(string(body), `"status":"pending"`) {
		t.Fatalf("prepare %d %s", status, body)
	}
	var receipt capability.Result
	if err := json.Unmarshal(body, &receipt); err != nil {
		t.Fatal(err)
	}
	status, _ = call("POST", "/agent/operations/"+receipt.OperationID+"/decision", `{"approve":true,"secret":"not-allowed"}`, "management-secret-value")
	if status != 401 {
		t.Fatal("MCP bearer approved its own operation")
	}
	previousIdentity := fixture.handler.auth.CapabilityIdentity()
	rotated, err := auth.New("rotated-management-value", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	fixture.handler.auth = rotated
	status, _ = call("GET", "/capabilities", "", "management-secret-value")
	if status != 401 {
		t.Fatal("old management key accepted")
	}
	if fixture.handler.agent.executor.Authorize(context.Background(), previousIdentity, "keys_create") {
		t.Fatal("old authority operation survived rotation")
	}
}

// Catalogue compactness is a regression assertion, never a limit on a running task.
func TestAgentCatalogueFitsTheSchemaBudget(t *testing.T) {
	fixture := newProviderTestFixture(t)
	if err := fixture.handler.ensureAgent(); err != nil {
		t.Fatal(err)
	}
	definitions := fixture.handler.agent.executor.Registry.List(agent.PRINCIPAL)
	if len(definitions) < 20 {
		t.Fatalf("registry looks truncated: %d definitions", len(definitions))
	}
	// The whole catalogue a console-declared run can offer: every capability plus the display tools.
	raw, err := json.Marshal(append(agent.ToolDeclarations(definitions), agent.DisplayToolDeclarations([]string{agent.RENDER_UI, agent.SUGGEST_NEXT})...))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > 64<<10 {
		t.Fatalf("tool catalogue is %d bytes against a %d budget; trim a description deliberately and say why", len(raw), 64<<10)
	}
}

func TestAgentApprovalRequiresBrowserOrigin(t *testing.T) {
	fixture := newProviderTestFixture(t)
	response, _ := doJSON(t, fixture.client, "POST", fixture.baseURL+"/omc/api/v1/agent/operations/unknown/decision", `{"approve":true}`)
	if response.StatusCode != 403 {
		t.Fatalf("originless approval: %d", response.StatusCode)
	}
	if err := fixture.handler.ensureAgent(); err != nil {
		t.Fatal(err)
	}
	result, err := fixture.handler.agent.executor.Invoke(context.Background(), capability.Principal{ID: "administrator", Adapter: "agent", IsAdmin: true}, "keys_create", json.RawMessage(`{}`), "")
	if err != nil || result.Status != "pending" {
		t.Fatalf("prepare %v %+v", err, result)
	}
	request, _ := http.NewRequest("POST", fixture.baseURL+"/omc/api/v1/agent/operations/"+result.OperationID+"/decision", strings.NewReader(`{"approve":true,"secret":"agent-private-key-marker"}`))
	request.Header.Set("Origin", fixture.baseURL)
	response, err = fixture.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || strings.Contains(string(body), "agent-private-key-marker") || !strings.Contains(string(body), `"status":"success"`) {
		t.Fatalf("approval %d %s", response.StatusCode, body)
	}
	events, err := fixture.handler.repo.ListAuditEvents(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(events)
	if strings.Contains(string(raw), "agent-private-key-marker") {
		t.Fatal("audit secret leak")
	}
}

// TestAgentRunSpeaksAGUI covers the run endpoint's two refusals. A malformed request is a plain 400;
// a well-formed one the runtime refuses before persisting anything is an event stream that never
// says RUN_STARTED, which is how the browser knows to hand the message back to the operator.
func TestAgentRunSpeaksAGUI(t *testing.T) {
	fixture := newProviderTestFixture(t)
	url := fixture.baseURL + "/omc/api/v1/agent/run"
	for _, body := range []string{
		`{"conversation_id":"","revision":0,"message":"hi","model":"m","client_key_fingerprint":"f"}`,
		`{"threadId":"","runId":"r1","protocolVersion":"1.0","messages":[{"id":"m1","role":"user","content":"hi"}],"forwardedProps":{"revision":0,"model":"m","client_key_fingerprint":"f","extra":1}}`,
		`{"threadId":"","runId":"r1","protocolVersion":"1.0","messages":[{"id":"m1","role":"user","content":"hi"}]}`,
		`{"threadId":"","runId":"r1","protocolVersion":"1.0","messages":[{"id":"m1","role":"user","content":"hi"}],"tools":[{"name":"keys_delete","description":"x"}],"forwardedProps":{"revision":0,"model":"m","client_key_fingerprint":"f"}}`,
		// A display tool the server has withdrawn is not one a console may declare.
		`{"threadId":"","runId":"r1","protocolVersion":"1.0","messages":[{"id":"m1","role":"user","content":"hi"}],"tools":[{"name":"render_chart","description":"x"}],"forwardedProps":{"revision":0,"model":"m","client_key_fingerprint":"f"}}`,
		// An image arrives as bytes; a URL would make the server fetch on the model's behalf.
		`{"threadId":"","runId":"r1","protocolVersion":"1.0","messages":[{"id":"m1","role":"user","content":[{"type":"binary","mimeType":"image/png","url":"https://example.test/a.png"}]}],"forwardedProps":{"revision":0,"model":"m","client_key_fingerprint":"f"}}`,
		`{"threadId":"","runId":"r1","protocolVersion":"1.0","messages":[{"id":"m1","role":"user","content":"hi"}],"context":[{"description":"console_page","value":"dashboard"}],"forwardedProps":{"revision":0,"model":"m","client_key_fingerprint":"f"}}`,
	} {
		response, payload := doJSON(t, fixture.client, "POST", url, body)
		if response.StatusCode != 400 || !strings.Contains(string(payload), "invalid_parameters") {
			t.Fatalf("accepted %s: %d %s", body, response.StatusCode, payload)
		}
	}
	response, payload := doJSON(t, fixture.client, "POST", url, `{"threadId":"","runId":"r1","protocolVersion":"1.0","messages":[{"id":"m1","role":"user","content":"hi"}],"tools":[{"name":"render_ui","description":"interactive UI"}],"context":[{"description":"console_language","value":"en"},{"description":"console_token_style","value":"zh"}],"forwardedProps":{"revision":99,"model":"m","client_key_fingerprint":"f","present":"ui"}}`)
	if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("stale run %d %s", response.StatusCode, payload)
	}
	if strings.Contains(string(payload), "RUN_STARTED") || !strings.Contains(string(payload), `"type":"RUN_ERROR"`) || !strings.Contains(string(payload), `"code":"agent_revision_conflict"`) {
		t.Fatalf("stale run stream %s", payload)
	}
}

// TestAgentEventsTranslateToInterrupts: a turn that stops on the operator ends its run with an
// interrupt naming the operation, the call it belongs to and its kind; a failed turn ends in
// RUN_ERROR after its snapshot, never in a successful finish.
func TestAgentEventsTranslateToInterrupts(t *testing.T) {
	var events []agui.Event
	translator := agui.NewTranslator("run", func(event agui.Event) error {
		events = append(events, event)
		return nil
	})
	pending := &agent.Conversation{ID: "c", Turns: []agent.Turn{{ID: "t", Status: "pending", Usage: &agent.Usage{TotalTokens: 7}}}}
	if err := translateAgentEvent(translator, "m", agent.Event{Type: "finished", Conversation: pending, Interrupts: []agent.Interrupt{{OperationID: "op", TraceID: "call", Reason: "secret", Capability: "provider_key_add", Permission: "write", ExpiresAtMS: 1}}}); err != nil {
		t.Fatal(err)
	}
	finish := events[len(events)-1]
	if finish.Type != agui.RUN_FINISHED || finish.Outcome.Type != "interrupt" || finish.Outcome.Interrupts[0].ID != "op" || finish.Outcome.Interrupts[0].Reason != "secret" || finish.Outcome.Interrupts[0].ToolCallID != "call" || finish.Outcome.Interrupts[0].ExpiresAt == "" || finish.Usage[0].TotalTokens != 7 || finish.Usage[0].Model != "m" {
		t.Fatalf("finish %+v", finish)
	}
	events = nil
	failed := &agent.Conversation{ID: "c", Turns: []agent.Turn{{ID: "t", Status: "error", Code: "budget_exceeded"}}}
	if err := translateAgentEvent(translator, "m", agent.Event{Type: "finished", Conversation: failed}); err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Type != agui.STATE_SNAPSHOT || events[1].Type != agui.RUN_ERROR || events[1].Code != "budget_exceeded" {
		t.Fatalf("failed turn %+v", events)
	}
}
