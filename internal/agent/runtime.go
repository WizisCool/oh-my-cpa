// Package agent owns model orchestration, never business authority.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Trace is one capability or display call of a turn: what the model asked for, when it ran, and
// what came back. Arguments are the model's own text, kept so the operator can audit exactly what
// was requested; they never carry a secret, because secrets reach the executor through the
// console's private decision endpoint rather than through the model.
type Trace struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Arguments string            `json:"arguments,omitempty"`
	Result    capability.Result `json:"result"`
	StartedMS int64             `json:"started_at_ms,omitempty"`
	EndedMS   int64             `json:"ended_at_ms,omitempty"`
	// View is a display call's frozen dataset (ADR 0042); capability calls have none.
	View json.RawMessage `json:"view,omitempty"`
}

// Usage is a turn's token counts, summed over its model rounds as the gateway reported them. A
// round whose gateway reported nothing adds nothing, so the sum is a lower bound and is labelled
// as what the gateway reported, not as what the turn cost.
type Usage struct {
	InputTokens  int64 `json:"input_tokens,omitempty"`
	OutputTokens int64 `json:"output_tokens,omitempty"`
	TotalTokens  int64 `json:"total_tokens,omitempty"`
}

func (usage *Usage) add(reported *gateway.Usage) {
	if reported == nil {
		return
	}
	if reported.PromptTokens != nil {
		usage.InputTokens += *reported.PromptTokens
	}
	if reported.CompletionTokens != nil {
		usage.OutputTokens += *reported.CompletionTokens
	}
	if reported.TotalTokens != nil {
		usage.TotalTokens += *reported.TotalTokens
	} else if reported.PromptTokens != nil || reported.CompletionTokens != nil {
		usage.TotalTokens += valueOf(reported.PromptTokens) + valueOf(reported.CompletionTokens)
	}
}

func valueOf(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

// Part is one step of a turn, in the order the model produced it: a stretch of reasoning, a
// stretch of answer text, or a capability call (named by its trace). A model may reason, answer,
// call tools and answer again within one turn, and the transcript shows it in that order, so the
// order is recorded rather than reconstructed from the three kinds of content.
type Part struct {
	Type    string `json:"type"`
	Content string `json:"content,omitempty"`
	TraceID string `json:"trace_id,omitempty"`
}

type Turn struct {
	ID        string                 `json:"id"`
	User      string                 `json:"user"`
	Reply     string                 `json:"reply"`
	Parts     []Part                 `json:"parts,omitempty"`
	Status    string                 `json:"status"`
	Code      string                 `json:"code,omitempty"`
	Traces    []Trace                `json:"traces"`
	Messages  []gateway.AgentMessage `json:"messages"`
	Pending   []gateway.ToolCall     `json:"pending,omitempty"`
	Rounds    int                    `json:"rounds"`
	Calls     int                    `json:"calls"`
	StartedMS int64                  `json:"started_at_ms,omitempty"`
	EndedMS   int64                  `json:"ended_at_ms,omitempty"`
	Usage     *Usage                 `json:"usage,omitempty"`
	// PromptVersion is the system prompt the turn's rounds ran with.
	PromptVersion string `json:"prompt_version,omitempty"`
}

// Conversation is the stored session.
//
// Rounds and calls are persisted progress counters, not limits on a task. Request and storage
// budgets still bound resource use, and cancellation is checked between model and tool calls.
//
// There is no per-conversation subset of capabilities to remember: every registered capability
// is declared to the model from the first round, so the model's tool list is the registry itself
// and a resumption reconstructs it rather than restoring it.
const (
	// MAX_CONTEXT_BYTES bounds one model request, and MAX_TOOL_SCHEMA_BYTES bounds the share of
	// it the tool declarations may take. They are separate because the tool catalogue and the
	// conversation grow for different reasons, and a request rejected for "context too large"
	// should not leave an operator guessing which of the two did it.
	MAX_CONTEXT_BYTES     = 128 << 10
	MAX_TOOL_SCHEMA_BYTES = 32 << 10
)

type Conversation struct {
	ID              string `json:"id"`
	Revision        int64  `json:"revision"`
	Fingerprint     string `json:"client_key_fingerprint"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
	Turns           []Turn `json:"turns"`
	Omitted         int    `json:"omitted"`
	AnchorMS        int64  `json:"anchor_ms"`
}

// Input is one run request. There is no consent flag: the page states, beside the composer, that
// a message and the data the agent reads go to the selected CPA model, and sending is the act the
// notice describes (ADR 0027).
//
// A run either carries a new message or resumes the turn that stopped on the operator; Resume then
// names the operations it continues from, which must be exactly the ones the last turn is waiting
// on. Language is the console's reading language, used only as the reply language's default.
// DisplayTools are validated against the server's own set; their schemas are never the client's.
type Input struct {
	ConversationID  string
	Revision        int64
	Message         string
	Fingerprint     string
	Model           string
	ReasoningEffort string
	Resume          []string
	Language        string
	// DisplayTools names the display tools the console can draw for this run (ADR 0042).
	DisplayTools []string
}

// Event is one step of a run as the runtime sees it, independent of any wire protocol: the API
// layer translates it. The types, in the order a run may produce them:
//
//   - started: the turn is persisted; nothing before it was accepted.
//   - round: a model call begins (Round).
//   - thought / text: streamed reasoning or answer text of a round (Content, Round).
//   - tool_call: a call is about to execute (Trace without a result).
//   - tool_result: a call returned (Trace, and Content as the exact JSON the model receives).
//   - finished: the turn is saved (Conversation, and Interrupts when it waits on the operator).
type Event struct {
	Type           string
	Content        string
	Round          int
	ConversationID string
	TurnID         string
	Trace          *Trace
	Conversation   *Conversation
	Interrupts     []Interrupt
}

// Interrupt is a pending operation the turn waits on, described for a client that has to present
// it: why it waits, which call raised it, and until when.
type Interrupt struct {
	OperationID string
	TraceID     string
	Reason      string
	Capability  string
	Permission  string
	ExpiresAtMS int64
}

// LANGUAGES maps the console's reading languages to the names the model is told. The set is closed
// so the prompt never quotes a client-supplied string.
var LANGUAGES = map[string]string{
	"zh":      "Simplified Chinese",
	"zh-Hant": "Traditional Chinese",
	"en":      "English",
	"ms":      "Malay",
}

type ModelClient interface {
	StreamAgent(ctx context.Context, model string, reasoningEffort string, messages []gateway.AgentMessage, tools []gateway.AgentTool, emit func(gateway.Event) error) (gateway.AgentReply, error)
}
type Runtime struct {
	Executor  *capability.Executor
	Store     repository.AgentStore
	Location  func() *time.Location
	Slots     chan struct{}
	Client    func(context.Context, string) (ModelClient, error)
	mu        sync.Mutex
	isRunning atomic.Bool
}

var PRINCIPAL = capability.Principal{ID: "administrator", Adapter: "agent", IsAdmin: true}

func (r *Runtime) Current(ctx context.Context) (Conversation, error) {
	var conversation Conversation
	revision, err := r.Store.Load(ctx, "session", "latest", &conversation)
	if errors.Is(err, repository.ErrNotFound) {
		return Conversation{ID: "", Turns: []Turn{}}, nil
	}
	conversation.Revision = revision
	if !r.isRunning.Load() && len(conversation.Turns) > 0 && conversation.Turns[len(conversation.Turns)-1].Status == "running" {
		conversation.Turns[len(conversation.Turns)-1].Status = "interrupted"
		conversation.Turns[len(conversation.Turns)-1].Code = "operation_outcome_unknown"
	}
	return conversation, err
}
func (r *Runtime) save(ctx context.Context, conversation *Conversation) error {
	for {
		raw, err := json.Marshal(conversation)
		if err != nil {
			return err
		}
		if len(raw) < 900<<10 {
			break
		}
		if len(conversation.Turns) <= 1 || conversation.Turns[len(conversation.Turns)-1].Status == "running" {
			return errors.New("conversation_budget_exceeded")
		}
		conversation.Turns = conversation.Turns[1:]
		conversation.Omitted++
	}
	revision, err := r.Store.Save(ctx, "session", "latest", conversation.Revision, time.Now().AddDate(100, 0, 0), conversation)
	if err == nil {
		conversation.Revision = revision
	}
	return err
}
func (r *Runtime) Reset(ctx context.Context, revision int64) error {
	if !r.mu.TryLock() {
		return errors.New("agent_busy")
	}
	defer r.mu.Unlock()
	current, err := r.Current(ctx)
	if err != nil {
		return err
	}
	if current.Revision != revision {
		return repository.ErrAgentConflict
	}
	for _, turn := range current.Turns {
		for _, trace := range turn.Traces {
			if trace.Result.Status == "pending" {
				if _, err := r.Executor.Decide(ctx, PRINCIPAL, trace.Result.OperationID, false, ""); err != nil {
					return err
				}
			}
		}
	}
	// A new conversation replaces the transcript, not the operator's choice of key, model and
	// effort: those are carried over so the next message goes where the last one did.
	current = Conversation{
		ID:              capability.NewID(),
		Revision:        current.Revision,
		Fingerprint:     current.Fingerprint,
		Model:           current.Model,
		ReasoningEffort: current.ReasoningEffort,
		Turns:           []Turn{},
	}
	return r.save(ctx, &current)
}
func (r *Runtime) Run(ctx context.Context, input Input, emit func(Event) error) error {
	if !r.mu.TryLock() {
		return errors.New("agent_busy")
	}
	defer r.mu.Unlock()
	conversation, err := r.Current(ctx)
	if err != nil {
		return err
	}
	r.isRunning.Store(true)
	defer r.isRunning.Store(false)
	if input.Revision != conversation.Revision || input.ConversationID != conversation.ID {
		return repository.ErrAgentConflict
	}
	if strings.TrimSpace(input.Model) == "" || len(input.Model) > 512 || len(input.Message) > 16<<10 {
		return errors.New("invalid_parameters")
	}
	if input.ReasoningEffort != "" && !gateway.ValidReasoningEffort(input.ReasoningEffort) {
		return errors.New("invalid_parameters")
	}
	if _, ok := LANGUAGES[input.Language]; input.Language != "" && !ok {
		return errors.New("invalid_parameters")
	}
	for _, name := range input.DisplayTools {
		if displayTools[name] == nil {
			return errors.New("invalid_parameters")
		}
	}
	if conversation.ID == "" {
		conversation.ID = capability.NewID()
	}
	if input.Message != "" {
		if len(input.Resume) > 0 {
			return errors.New("invalid_parameters")
		}
		if len(conversation.Turns) > 0 && conversation.Turns[len(conversation.Turns)-1].Status == "pending" {
			return errors.New("confirmation_pending")
		}
		conversation.Fingerprint = input.Fingerprint
		conversation.Model = input.Model
		// A resumption continues the turn with the effort it started with; only a new message
		// takes the operator's current choice.
		conversation.ReasoningEffort = strings.TrimSpace(input.ReasoningEffort)
		conversation.AnchorMS = time.Now().UnixMilli()
		conversation.Turns = append(conversation.Turns, Turn{ID: capability.NewID(), User: input.Message, Status: "running", Traces: []Trace{}, StartedMS: time.Now().UnixMilli(), Messages: []gateway.AgentMessage{{Role: "user", Content: input.Message}}})
	} else {
		if len(conversation.Turns) == 0 {
			return errors.New("invalid_parameters")
		}
		last := conversation.Turns[len(conversation.Turns)-1]
		if last.Status != "pending" {
			return errors.New("invalid_parameters")
		}
		if conversation.Model != input.Model || conversation.Fingerprint != input.Fingerprint {
			return errors.New("resource_conflict")
		}
		if err := r.checkResume(ctx, last, input.Resume); err != nil {
			return err
		}
	}
	turn := &conversation.Turns[len(conversation.Turns)-1]
	turn.Status = "running"
	if err = r.save(ctx, &conversation); err != nil {
		return err
	}
	// Saving may evict older complete turns, invalidating the earlier slice pointer.
	turn = &conversation.Turns[len(conversation.Turns)-1]
	if err := emit(Event{Type: "started", ConversationID: conversation.ID, TurnID: turn.ID}); err != nil {
		return err
	}
	turn.PromptVersion = PROMPT_VERSION
	runErr := r.loop(capability.WithAnchor(ctx, conversation.AnchorMS), &conversation, turn, input, emit)
	turn.EndedMS = time.Now().UnixMilli()
	if runErr != nil {
		turn.Status = "error"
		turn.Code = capability.ErrorCode(runErr)
		if strings.Contains(runErr.Error(), "budget") {
			turn.Code = "budget_exceeded"
		}
	}
	saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err = r.save(saveCtx, &conversation); err != nil {
		return err
	}
	return emit(Event{Type: "finished", Conversation: &conversation, Interrupts: r.interrupts(saveCtx, &conversation.Turns[len(conversation.Turns)-1])})
}

// checkResume admits a resumption only for the operations the turn is actually waiting on, and only
// once the operator has decided every one of them. The decision itself went through the console's
// decision endpoint; a resume request carries no authority of its own, so an operation still
// pending refuses the run rather than letting it proceed on a claim.
func (r *Runtime) checkResume(ctx context.Context, turn Turn, resume []string) error {
	waiting := map[string]bool{}
	for _, trace := range turn.Traces {
		if trace.Result.Status == "pending" && trace.Result.OperationID != "" {
			waiting[trace.Result.OperationID] = true
		}
	}
	named := map[string]bool{}
	for _, id := range resume {
		if !waiting[id] || named[id] {
			return errors.New("invalid_parameters")
		}
		named[id] = true
	}
	if len(named) != len(waiting) {
		return errors.New("invalid_parameters")
	}
	for id := range waiting {
		operation, err := r.Executor.Get(ctx, PRINCIPAL, id)
		if err != nil {
			return err
		}
		if operation.Status == "pending" {
			return errors.New("confirmation_pending")
		}
	}
	return nil
}

// interrupts describes the operations a turn stopped on, reading each one's kind and expiry from
// the executor that owns it rather than from the transcript.
func (r *Runtime) interrupts(ctx context.Context, turn *Turn) []Interrupt {
	if turn.Status != "pending" {
		return nil
	}
	var interrupts []Interrupt
	for _, trace := range turn.Traces {
		if trace.Result.Status != "pending" || trace.Result.OperationID == "" {
			continue
		}
		interrupt := Interrupt{OperationID: trace.Result.OperationID, TraceID: trace.ID, Reason: "approval", Capability: trace.Name}
		if operation, err := r.Executor.Get(ctx, PRINCIPAL, trace.Result.OperationID); err == nil {
			interrupt.Permission = operation.Permission
			interrupt.ExpiresAtMS = operation.ExpiresAtMS
			switch operation.HumanInput {
			case "answer":
				interrupt.Reason = "question"
			case "secret", "oauth":
				interrupt.Reason = operation.HumanInput
			}
		}
		interrupts = append(interrupts, interrupt)
	}
	return interrupts
}
func (r *Runtime) loop(ctx context.Context, conversation *Conversation, turn *Turn, input Input, emit func(Event) error) error {
	// One client per fingerprint for the whole turn. Resolving a fingerprint reads CPA's key
	// list; paying for that lookup on every
	// round buys nothing, because the fingerprint cannot change inside a turn.
	clients := map[string]ModelClient{}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		for len(turn.Pending) > 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
			call := turn.Pending[0]
			index := slices.IndexFunc(turn.Traces, func(trace Trace) bool { return trace.ID == call.ID })
			if index >= 0 {
				// A call the turn already made - the one it stopped on - resolves from the
				// executor's record of the operator's decision rather than running again.
				trace := &turn.Traces[index]
				if trace.Result.Status == "pending" {
					operation, err := r.Executor.Get(ctx, PRINCIPAL, trace.Result.OperationID)
					if err != nil {
						return err
					}
					if operation.Status == "pending" {
						turn.Status = "pending"
						return nil
					}
					if operation.Status == "expired" {
						trace.Result = capability.Result{Status: "expired", Code: "confirmation_expired"}
					} else {
						trace.Result = operation.Result
					}
					trace.EndedMS = time.Now().UnixMilli()
				}
			} else {
				turn.Calls++
				trace := Trace{ID: call.ID, Name: call.Function.Name, Arguments: call.Function.Arguments, StartedMS: time.Now().UnixMilli()}
				// Announced before it runs, so a slow capability is visibly running rather than
				// silently absent until it returns.
				if err := emit(Event{Type: "tool_call", Trace: &trace}); err != nil {
					return err
				}
				// A display tool the console declared is resolved here, against this
				// conversation's own results; everything else is the executor's.
				if contains(input.DisplayTools, call.Function.Name) {
					trace.Result, trace.View = renderDisplay(conversation, call.Function.Name, call.Function.Arguments)
				} else {
					result, err := r.Executor.Invoke(ctx, PRINCIPAL, call.Function.Name, json.RawMessage(call.Function.Arguments), conversation.ID)
					if err != nil {
						result = capability.Result{Status: "error", Code: capability.ErrorCode(err), Detail: capability.ErrorDetail(err)}
					}
					trace.Result = result
				}
				if trace.Result.Status != "pending" {
					trace.EndedMS = time.Now().UnixMilli()
				}
				turn.Traces = append(turn.Traces, trace)
				turn.Parts = append(turn.Parts, Part{Type: "tool", TraceID: call.ID})
				index = len(turn.Traces) - 1
			}
			saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			saveErr := r.save(saveCtx, conversation)
			cancel()
			if saveErr != nil {
				return saveErr
			}
			trace := turn.Traces[index]
			raw, err := json.Marshal(trace.Result)
			if err != nil {
				return err
			}
			if err := emit(Event{Type: "tool_result", Trace: &trace, Content: string(raw)}); err != nil {
				return err
			}
			if trace.Result.Status == "pending" {
				turn.Status = "pending"
				return nil
			}
			turn.Messages = append(turn.Messages, gateway.AgentMessage{Role: "tool", ToolCallID: call.ID, Content: string(raw)})
			turn.Pending = turn.Pending[1:]
		}
		turn.Rounds++
		promptContext := PromptContext{AnchorMS: conversation.AnchorMS, Language: input.Language, DisplayTools: input.DisplayTools}
		if r.Location != nil {
			promptContext.TimeZone = r.Location().String()
		}
		messages := []gateway.AgentMessage{{Role: "system", Content: SystemPrompt(promptContext)}}
		// Include only complete previous turns, newest first within the byte budget; tool/result pairs remain intact.
		var history []gateway.AgentMessage
		used := 0
		currentRaw, _ := json.Marshal(turn.Messages)
		used += len(currentRaw)
		if used > MAX_CONTEXT_BYTES {
			return errors.New("context_budget_exceeded")
		}
		for index := len(conversation.Turns) - 2; index >= 0; index-- {
			previous := conversation.Turns[index]
			if previous.Status != "success" {
				continue
			}
			raw, _ := json.Marshal(previous.Messages)
			if used+len(raw) > MAX_CONTEXT_BYTES {
				break
			}
			used += len(raw)
			history = append(append([]gateway.AgentMessage{}, previous.Messages...), history...)
		}
		messages = append(messages, history...)
		messages = append(messages, turn.Messages...)
		// Every registered capability is declared from the first round. Discovery round-trips cost
		// a whole model call each, and the registry is bounded by construction, so the model is
		// better served by the catalogue than by a search that can only return what it already
		// could have been told.
		tools := append(r.toolDeclarations(), DisplayToolDeclarations(input.DisplayTools)...)
		schemas, _ := json.Marshal(tools)
		if len(schemas) > MAX_TOOL_SCHEMA_BYTES || used+len(schemas) > MAX_CONTEXT_BYTES {
			return errors.New("schema_budget_exceeded")
		}
		if err := r.save(ctx, conversation); err != nil {
			return err
		}
		select {
		case r.Slots <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		default:
			return errors.New("agent_busy")
		}
		client, err := r.modelClient(ctx, clients, conversation.Fingerprint)
		if err != nil {
			<-r.Slots
			return err
		}
		if err := emit(Event{Type: "round", Round: turn.Rounds}); err != nil {
			<-r.Slots
			return err
		}
		// Each round's output is appended to the turn's parts in arrival order, and the events are
		// emitted in that same order, so the browser rebuilding the parts from the stream arrives at
		// exactly what is stored. A new round starts a new part even when its first output is the
		// same kind as the previous round's last, because a capability call sat between them.
		isNewRound := true
		isFirstText := true
		reply, err := client.StreamAgent(ctx, conversation.Model, conversation.ReasoningEffort, messages, tools, func(event gateway.Event) error {
			kind := "text"
			if event.Type == "thought" {
				kind = "thought"
			} else {
				// The reply is every round's text as one document (what "copy answer" takes), so
				// a later round's text starts a new paragraph rather than running on.
				if isFirstText && turn.Reply != "" {
					turn.Reply += "\n\n"
				}
				isFirstText = false
				turn.Reply += event.Content
			}
			turn.appendPart(kind, event.Content, isNewRound)
			isNewRound = false
			return emit(Event{Type: kind, Content: event.Content, Round: turn.Rounds})
		})
		<-r.Slots
		if reply.Usage != nil {
			if turn.Usage == nil {
				turn.Usage = &Usage{}
			}
			turn.Usage.add(reply.Usage)
		}
		if err != nil {
			return err
		}
		turn.Messages = append(turn.Messages, gateway.AgentMessage{Role: "assistant", Content: reply.Content, ToolCalls: reply.Calls})
		if len(reply.Calls) == 0 {
			turn.Status = "success"
			return nil
		}
		turn.Pending = reply.Calls
	}
}

// appendPart extends the turn's last part when it is the same kind of text from the same round,
// and starts a new part otherwise.
func (turn *Turn) appendPart(kind, content string, isNewRound bool) {
	if last := len(turn.Parts) - 1; last >= 0 && !isNewRound && turn.Parts[last].Type == kind {
		turn.Parts[last].Content += content
		return
	}
	turn.Parts = append(turn.Parts, Part{Type: kind, Content: content})
}

// ToolDeclarations projects a registry listing into the model's tool list.
//
// It takes the listing rather than reading the registry so the projection and its budget can be
// asserted against the registry a real deployment builds, not only against a test double.
//
// Ordering is the listing's own (the registry sorts by name), so two turns of a conversation
// describe the same capabilities in the same order - which is what keeps the model's choices
// reproducible and any upstream prompt cache reusable.
func ToolDeclarations(definitions []*capability.Definition) []gateway.AgentTool {
	tools := make([]gateway.AgentTool, 0, len(definitions))
	for _, definition := range definitions {
		tools = append(tools, gateway.AgentTool{Type: "function", Function: gateway.ToolDefinition{
			Name:        definition.Name,
			Description: definition.Description,
			Parameters:  definition.InputSchema,
		}})
	}
	return tools
}

func (r *Runtime) toolDeclarations() []gateway.AgentTool {
	return ToolDeclarations(r.Executor.Registry.List(PRINCIPAL))
}

// modelClient resolves one fingerprint once per turn.
//
// A resolution failure is deliberately not cached: the usual cause is CPA being unreachable or
// the key having been rotated away, and both are worth retrying on the next round rather than
// pinning the turn to a failure that has already passed.
func (r *Runtime) modelClient(ctx context.Context, cache map[string]ModelClient, fingerprint string) (ModelClient, error) {
	if client, ok := cache[fingerprint]; ok {
		return client, nil
	}
	client, err := r.Client(ctx, fingerprint)
	if err != nil {
		return nil, err
	}
	cache[fingerprint] = client
	return client, nil
}
