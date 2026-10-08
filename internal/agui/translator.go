package agui

import (
	"strconv"
)

// Translator turns a run's semantic steps into AG-UI events, keeping the bookkeeping the protocol
// requires: which text or reasoning message is open, which step is open, and which tool calls have
// started.
//
// Message boundaries follow the runtime's stored parts exactly: a change of kind or of model round
// closes the open message and starts a new one. A browser that makes one part per message therefore
// arrives at the same parts the server saved, which is what lets the live transcript be replaced by
// the stored one without anything moving.
type Translator struct {
	emit      func(Event) error
	threadID  string
	runID     string
	openKind  string
	openID    string
	openRound int
	step      string
	sequence  int
	started   map[string]bool
}

func NewTranslator(runID string, emit func(Event) error) *Translator {
	return &Translator{emit: emit, runID: runID, started: map[string]bool{}}
}

// Started opens the run. It is sent only once the runtime has persisted the turn, so a client that
// never receives it knows its message was not accepted and can hand it back to the operator.
func (t *Translator) Started(threadID string, metadata map[string]any) error {
	t.threadID = threadID
	return t.emit(Event{Type: RUN_STARTED, ThreadID: threadID, RunID: t.runID, ProtocolVersion: PROTOCOL_VERSION, Metadata: metadata})
}

// Step opens a model round, closing the previous one.
func (t *Translator) Step(round int) error {
	if err := t.closeStep(); err != nil {
		return err
	}
	t.step = "round:" + strconv.Itoa(round)
	return t.emit(Event{Type: STEP_STARTED, StepName: t.step, Metadata: map[string]any{"round": round}})
}

func (t *Translator) Text(round int, delta string) error {
	return t.append("text", round, delta)
}

func (t *Translator) Reasoning(round int, delta string) error {
	return t.append("reasoning", round, delta)
}

func (t *Translator) append(kind string, round int, delta string) error {
	if delta == "" {
		return nil
	}
	if t.openKind != kind || t.openRound != round {
		if err := t.closeMessage(); err != nil {
			return err
		}
		t.sequence++
		t.openKind, t.openRound, t.openID = kind, round, t.runID+":"+strconv.Itoa(t.sequence)
		if kind == "text" {
			if err := t.emit(Event{Type: TEXT_MESSAGE_START, MessageID: t.openID, Role: "assistant"}); err != nil {
				return err
			}
		} else {
			if err := t.emit(Event{Type: REASONING_START, MessageID: t.openID}); err != nil {
				return err
			}
			if err := t.emit(Event{Type: REASONING_MESSAGE_START, MessageID: t.openID, Role: "reasoning"}); err != nil {
				return err
			}
		}
	}
	if kind == "text" {
		return t.emit(Event{Type: TEXT_MESSAGE_CONTENT, MessageID: t.openID, Delta: delta})
	}
	return t.emit(Event{Type: REASONING_MESSAGE_CONTENT, MessageID: t.openID, Delta: delta})
}

func (t *Translator) closeMessage() error {
	defer func() { t.openKind, t.openID = "", "" }()
	switch t.openKind {
	case "text":
		return t.emit(Event{Type: TEXT_MESSAGE_END, MessageID: t.openID})
	case "reasoning":
		if err := t.emit(Event{Type: REASONING_MESSAGE_END, MessageID: t.openID}); err != nil {
			return err
		}
		return t.emit(Event{Type: REASONING_END, MessageID: t.openID})
	}
	return nil
}

func (t *Translator) closeStep() error {
	if err := t.closeMessage(); err != nil {
		return err
	}
	if t.step == "" {
		return nil
	}
	step := t.step
	t.step = ""
	return t.emit(Event{Type: STEP_FINISHED, StepName: step})
}

// ToolCall announces a call before it executes, with its complete arguments: the operator sees
// what is being done while it is being done, not after.
func (t *Translator) ToolCall(id, name, arguments string, metadata map[string]any) error {
	if err := t.closeMessage(); err != nil {
		return err
	}
	t.started[id] = true
	if err := t.emit(Event{Type: TOOL_CALL_START, ToolCallID: id, ToolCallName: name, Metadata: metadata}); err != nil {
		return err
	}
	if arguments != "" {
		if err := t.emit(Event{Type: TOOL_CALL_ARGS, ToolCallID: id, Delta: arguments}); err != nil {
			return err
		}
	}
	return t.emit(Event{Type: TOOL_CALL_END, ToolCallID: id})
}

// ToolResult reports what a call returned, as the exact text the model receives. A resumed run
// reports the result of a call an earlier run started, so a result without a start in this run is
// expected, not an error.
func (t *Translator) ToolResult(id, content string, metadata map[string]any) error {
	if err := t.closeMessage(); err != nil {
		return err
	}
	return t.emit(Event{Type: TOOL_CALL_RESULT, MessageID: "result:" + id, ToolCallID: id, Content: content, Role: "tool", Metadata: metadata})
}

// Snapshot sends the authoritative state the run ended with.
func (t *Translator) Snapshot(state any) error {
	if err := t.closeStep(); err != nil {
		return err
	}
	return t.emit(Event{Type: STATE_SNAPSHOT, Snapshot: state})
}

// Finished closes a run that did not fail: successfully, or paused on interrupts.
func (t *Translator) Finished(interrupts []Interrupt, usage []TokenUsage) error {
	if err := t.closeStep(); err != nil {
		return err
	}
	outcome := &Outcome{Type: "success"}
	if len(interrupts) > 0 {
		outcome = &Outcome{Type: "interrupt", Interrupts: interrupts}
	}
	return t.emit(Event{Type: RUN_FINISHED, ThreadID: t.threadID, RunID: t.runID, Outcome: outcome, Usage: usage})
}

// Error ends a run that failed. The message is the code: the console localises codes, and a
// sentence composed here would be in one language for every reader.
func (t *Translator) Error(code string, usage []TokenUsage) error {
	if err := t.closeStep(); err != nil {
		return err
	}
	return t.emit(Event{Type: RUN_ERROR, Message: code, Code: code, Usage: usage})
}

// Custom carries structured OMC progress without turning a retry into a new logical round.
func (t *Translator) Custom(name string, value any) error {
	if err := t.closeMessage(); err != nil {
		return err
	}
	return t.emit(Event{Type: CUSTOM, Name: name, Value: value})
}
