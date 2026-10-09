package agui

// The event types OMC emits. The strings are the protocol's own; the constants exist so a typo is
// a compile error rather than an event every consumer silently drops.
const (
	CUSTOM                    = "CUSTOM"
	RUN_STARTED               = "RUN_STARTED"
	RUN_FINISHED              = "RUN_FINISHED"
	RUN_ERROR                 = "RUN_ERROR"
	STEP_STARTED              = "STEP_STARTED"
	STEP_FINISHED             = "STEP_FINISHED"
	TEXT_MESSAGE_START        = "TEXT_MESSAGE_START"
	TEXT_MESSAGE_CONTENT      = "TEXT_MESSAGE_CONTENT"
	TEXT_MESSAGE_END          = "TEXT_MESSAGE_END"
	REASONING_START           = "REASONING_START"
	REASONING_MESSAGE_START   = "REASONING_MESSAGE_START"
	REASONING_MESSAGE_CONTENT = "REASONING_MESSAGE_CONTENT"
	REASONING_MESSAGE_END     = "REASONING_MESSAGE_END"
	REASONING_END             = "REASONING_END"
	TOOL_CALL_START           = "TOOL_CALL_START"
	TOOL_CALL_ARGS            = "TOOL_CALL_ARGS"
	TOOL_CALL_END             = "TOOL_CALL_END"
	TOOL_CALL_RESULT          = "TOOL_CALL_RESULT"
	STATE_SNAPSHOT            = "STATE_SNAPSHOT"
)

// Event is one AG-UI event. The protocol's events share most of their fields, so one struct with
// omitted zero values serialises every event OMC emits without a type per event; the constructor
// methods of Translator are what keep each event's required fields present.
type Event struct {
	Name            string         `json:"name,omitempty"`
	Value           any            `json:"value,omitempty"`
	Type            string         `json:"type"`
	ThreadID        string         `json:"threadId,omitempty"`
	RunID           string         `json:"runId,omitempty"`
	ProtocolVersion string         `json:"protocolVersion,omitempty"`
	MessageID       string         `json:"messageId,omitempty"`
	Role            string         `json:"role,omitempty"`
	Delta           string         `json:"delta,omitempty"`
	StepName        string         `json:"stepName,omitempty"`
	ToolCallID      string         `json:"toolCallId,omitempty"`
	ToolCallName    string         `json:"toolCallName,omitempty"`
	ParentMessageID string         `json:"parentMessageId,omitempty"`
	Content         string         `json:"content,omitempty"`
	Snapshot        any            `json:"snapshot,omitempty"`
	Outcome         *Outcome       `json:"outcome,omitempty"`
	Usage           []TokenUsage   `json:"usage,omitempty"`
	Message         string         `json:"message,omitempty"`
	Code            string         `json:"code,omitempty"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}

// Outcome is why a run that did not fail ended.
type Outcome struct {
	Type       string      `json:"type"`
	Interrupts []Interrupt `json:"interrupts,omitempty"`
}

// Interrupt is something the run needs from the operator before it can continue.
type Interrupt struct {
	ID         string         `json:"id"`
	Reason     string         `json:"reason"`
	ToolCallID string         `json:"toolCallId,omitempty"`
	ExpiresAt  string         `json:"expiresAt,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

// TokenUsage is one model's token counts in the protocol's accounting.
type TokenUsage struct {
	Model        string `json:"model,omitempty"`
	InputTokens  int64  `json:"inputTokens,omitempty"`
	OutputTokens int64  `json:"outputTokens,omitempty"`
	TotalTokens  int64  `json:"totalTokens,omitempty"`
}
