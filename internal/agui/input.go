// Package agui is OMC's AG-UI 1.0 wire layer: the subset of the protocol's events the console
// consumes, a strict decoder for the run request, a translator from a run's semantic steps to
// events, and the server-sent-events framing.
//
// It depends on nothing else in OMC. The agent runtime stays transport-independent and the API
// layer is the only place that knows both, so replacing the wire protocol touches this package and
// one handler, never the runtime or the capability boundary.
package agui

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// PROTOCOL_VERSION is the AG-UI version both directions declare. A request stating another
// version is refused rather than read loosely: an event this build does not know would be dropped
// silently, and a dropped interrupt is a change the operator never saw.
const PROTOCOL_VERSION = "1.0"

const (
	MAX_ID_CHARS         = 128
	MAX_MESSAGE_BYTES    = 48 << 10
	MAX_TOOLS            = 8
	MAX_CONTEXT_ENTRIES  = 4
	MAX_CONTEXT_VALUE    = 128
	MAX_RESUME_ENTRIES   = 4
	MAX_FORWARDED_BYTES  = 4 << 10
	MAX_TOOL_DESCRIPTION = 1 << 10
)

// ErrInvalidInput is the one refusal the decoder reports. The caller maps it to the console's
// `invalid_parameters` code; which rule failed is not something a browser can act on differently.
var ErrInvalidInput = errors.New("invalid_parameters")

// ResumeEntry answers one interrupt of the previous run. Only its identity and status are read:
// the decision itself went through the console's own decision endpoint, so no secret or answer
// ever rides on a run request.
type ResumeEntry struct {
	InterruptID string `json:"interruptId"`
	Status      string `json:"status"`
}

// RunInput is a decoded, bounded AG-UI `RunAgentInput`.
type RunInput struct {
	ThreadID string
	RunID    string
	// Message is the one new user message, empty when the run resumes an interrupted one.
	Message string
	// Tools names the frontend tools the client can render, each drawn from the allowed set.
	Tools []string
	// Context holds the allowed context entries by description.
	Context map[string]string
	// ForwardedProps is left raw for the caller's own strict decoding.
	ForwardedProps json.RawMessage
	Resume         []ResumeEntry
}

// Limits is what the caller allows a run request to carry beyond the envelope.
type Limits struct {
	// Tools is the set of frontend tool names the server knows how to serve.
	Tools map[string]bool
	// Context is the set of context descriptions the server reads.
	Context map[string]bool
}

type wireMessage struct {
	ID      string          `json:"id"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type wireTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

type wireContext struct {
	Description string `json:"description"`
	Value       string `json:"value"`
}

type wireInput struct {
	ThreadID        string          `json:"threadId"`
	RunID           string          `json:"runId"`
	ProtocolVersion string          `json:"protocolVersion"`
	State           json.RawMessage `json:"state"`
	Messages        []wireMessage   `json:"messages"`
	Tools           []wireTool      `json:"tools"`
	Context         []wireContext   `json:"context"`
	ForwardedProps  json.RawMessage `json:"forwardedProps"`
	Resume          []ResumeEntry   `json:"resume"`
}

// DecodeRunInput reads one run request and refuses anything that would let the client speak for
// the server.
//
// The conversation is the server's: a client may add at most one new user message, and may not
// send history, tool results or state, because accepting them would let a page - or anything that
// can post to it - rewrite what the model believes happened. Tools are names only; the schema the
// model sees is the server's own, so a client cannot widen a tool by describing it differently.
func DecodeRunInput(reader io.Reader, limits Limits) (RunInput, error) {
	var wire wireInput
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&wire) != nil || decoder.Decode(new(any)) != io.EOF {
		return RunInput{}, ErrInvalidInput
	}
	if wire.ProtocolVersion != PROTOCOL_VERSION || !isIdentifier(wire.RunID) || len(wire.ThreadID) > MAX_ID_CHARS {
		return RunInput{}, ErrInvalidInput
	}
	if !isEmptyJSON(wire.State) {
		return RunInput{}, ErrInvalidInput
	}
	input := RunInput{ThreadID: wire.ThreadID, RunID: wire.RunID, Context: map[string]string{}}
	if len(wire.Messages) > 1 {
		return RunInput{}, ErrInvalidInput
	}
	for _, message := range wire.Messages {
		var content string
		if message.Role != "user" || !isIdentifier(message.ID) || json.Unmarshal(message.Content, &content) != nil {
			return RunInput{}, ErrInvalidInput
		}
		if strings.TrimSpace(content) == "" || len(content) > MAX_MESSAGE_BYTES {
			return RunInput{}, ErrInvalidInput
		}
		input.Message = content
	}
	if len(wire.Tools) > MAX_TOOLS {
		return RunInput{}, ErrInvalidInput
	}
	seen := map[string]bool{}
	for _, tool := range wire.Tools {
		if !limits.Tools[tool.Name] || seen[tool.Name] || len(tool.Description) > MAX_TOOL_DESCRIPTION {
			return RunInput{}, ErrInvalidInput
		}
		seen[tool.Name] = true
		input.Tools = append(input.Tools, tool.Name)
	}
	if len(wire.Context) > MAX_CONTEXT_ENTRIES {
		return RunInput{}, ErrInvalidInput
	}
	for _, entry := range wire.Context {
		if !limits.Context[entry.Description] || len(entry.Value) > MAX_CONTEXT_VALUE {
			return RunInput{}, ErrInvalidInput
		}
		if _, exists := input.Context[entry.Description]; exists {
			return RunInput{}, ErrInvalidInput
		}
		input.Context[entry.Description] = entry.Value
	}
	if len(wire.ForwardedProps) > MAX_FORWARDED_BYTES {
		return RunInput{}, ErrInvalidInput
	}
	input.ForwardedProps = wire.ForwardedProps
	// A run either says something new or continues an interrupted one; doing both at once would
	// leave it unclear which the model's next round answers.
	if len(wire.Resume) > MAX_RESUME_ENTRIES || len(wire.Resume) > 0 && input.Message != "" || len(wire.Resume) == 0 && input.Message == "" {
		return RunInput{}, ErrInvalidInput
	}
	for _, entry := range wire.Resume {
		if !isIdentifier(entry.InterruptID) || entry.Status != "resolved" && entry.Status != "cancelled" {
			return RunInput{}, ErrInvalidInput
		}
		input.Resume = append(input.Resume, entry)
	}
	return input, nil
}

func isIdentifier(value string) bool {
	if value == "" || len(value) > MAX_ID_CHARS {
		return false
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_' || char == '.' || char == ':') {
			return false
		}
	}
	return true
}

// isEmptyJSON accepts the shapes a client uses for "no state": absent, null, or an empty object.
func isEmptyJSON(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || string(trimmed) == "null" || string(trimmed) == "{}"
}
