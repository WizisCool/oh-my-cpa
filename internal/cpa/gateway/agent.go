package gateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}
type ToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}
type AgentMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}
type AgentTool struct {
	Type     string         `json:"type"`
	Function ToolDefinition `json:"function"`
}
type ToolDefinition struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"`
}
type AgentReply struct {
	Content string
	Calls   []ToolCall
	Usage   *Usage
}

// ValidReasoningEffort reports whether an effort level may be forwarded upstream: the same rule
// the playground applies, so both surfaces accept exactly the same values.
func ValidReasoningEffort(value string) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && len(trimmed) <= 64 && isPrintableASCII(trimmed)
}

// MAX_AGENT_REQUEST_BYTES is the largest body StreamAgent sends. The runtime sizes a request to
// the model's context window; this is the ceiling above that, for a caller that did not.
const MAX_AGENT_REQUEST_BYTES = 1 << 20

// StreamAgent accepts only server-constructed messages and definitions. Incomplete tool
// arguments never leave this method as executable calls.
//
// Reasoning the model streams (`reasoning_content`, or `reasoning` on providers that name it so)
// is emitted as `thought` events and never enters the reply, so it can be shown as reasoning
// without becoming part of the conversation the next round is built from.
func (client *Client) StreamAgent(ctx context.Context, model string, reasoningEffort string, messages []AgentMessage, tools []AgentTool, emit func(Event) error) (AgentReply, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	payload := map[string]any{"model": model, "messages": messages, "tools": tools, "tool_choice": "auto", "stream": true, "stream_options": map[string]any{"include_usage": true}}
	if effort := strings.TrimSpace(reasoningEffort); effort != "" {
		if !ValidReasoningEffort(effort) {
			return AgentReply{}, errors.New("invalid_parameters")
		}
		payload["reasoning_effort"] = effort
	}
	raw, err := json.Marshal(payload)
	if err != nil || len(raw) > MAX_AGENT_REQUEST_BYTES {
		return AgentReply{}, errors.New("context_budget_exceeded")
	}
	response, err := client.request(ctx, http.MethodPost, "/v1/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return AgentReply{}, err
	}
	defer response.Body.Close()
	if !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		return AgentReply{}, &Error{Code: "invalid_gateway_response"}
	}
	timer := time.AfterFunc(client.idleTimeout, cancel)
	defer timer.Stop()
	scanner := bufio.NewScanner(activityReader{reader: response.Body, touch: func() { timer.Reset(client.idleTimeout) }})
	scanner.Buffer(make([]byte, 4096), 1<<20)
	result := AgentReply{}
	calls := map[int]*ToolCall{}
	total := 0
	finish := ""
	var data []string
	isDone := false
	dispatch := func() error {
		if len(data) == 0 {
			return nil
		}
		text := strings.Join(data, "\n")
		data = nil
		if text == "[DONE]" {
			isDone = true
			return nil
		}
		var chunk struct {
			Choices []struct {
				Index int `json:"index"`
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
					Reasoning        string `json:"reasoning"`
					ToolCalls        []struct {
						Index    int          `json:"index"`
						ID       string       `json:"id"`
						Type     string       `json:"type"`
						Function ToolFunction `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Usage *Usage          `json:"usage"`
			Error json.RawMessage `json:"error"`
		}
		if json.Unmarshal([]byte(text), &chunk) != nil || len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return &Error{Code: "invalid_gateway_response"}
		}
		for _, choice := range chunk.Choices {
			if choice.Index != 0 {
				continue
			}
			if finish != "" && (choice.Delta.Content != "" || len(choice.Delta.ToolCalls) > 0) {
				return &Error{Code: "invalid_gateway_response"}
			}
			thought := choice.Delta.ReasoningContent
			if thought == "" {
				thought = choice.Delta.Reasoning
			}
			if thought != "" {
				if err := emit(Event{Type: "thought", Content: thought}); err != nil {
					return err
				}
			}
			if choice.Delta.Content != "" {
				result.Content += choice.Delta.Content
				if err := emit(Event{Type: "delta", Content: choice.Delta.Content}); err != nil {
					return err
				}
			}
			for _, delta := range choice.Delta.ToolCalls {
				if delta.Index < 0 || delta.Index >= 24 {
					return errors.New("tool_budget_exceeded")
				}
				call := calls[delta.Index]
				if call == nil {
					call = &ToolCall{Type: "function"}
					calls[delta.Index] = call
				}
				call.ID += delta.ID
				call.Function.Name += delta.Function.Name
				call.Function.Arguments += delta.Function.Arguments
				if delta.Type != "" && delta.Type != "function" {
					return &Error{Code: "unsupported_output"}
				}
				if len(call.ID) > 256 || len(call.Function.Name) > 64 || len(call.Function.Arguments) > 32<<10 {
					return errors.New("tool_input_too_large")
				}
			}
			if choice.FinishReason != nil {
				finish = *choice.FinishReason
			}
		}
		if chunk.Usage != nil {
			result.Usage = chunk.Usage
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		total += len(line)
		if total > MaxResponseBytes {
			return result, &Error{Code: "response_too_large"}
		}
		if line == "" {
			if err := dispatch(); err != nil {
				return result, err
			}
			if isDone {
				break
			}
		} else if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return result, &Error{Code: "stream_incomplete"}
	}
	if !isDone || finish == "" {
		return result, &Error{Code: "stream_incomplete"}
	}
	if len(calls) > 0 {
		if finish != "tool_calls" {
			return result, &Error{Code: "stream_incomplete"}
		}
		seen := map[string]bool{}
		for index := 0; index < len(calls); index++ {
			call := calls[index]
			if call == nil || call.ID == "" || seen[call.ID] || call.Function.Name == "" || !json.Valid([]byte(call.Function.Arguments)) {
				return result, &Error{Code: "invalid_gateway_response"}
			}
			seen[call.ID] = true
			result.Calls = append(result.Calls, *call)
		}
	} else if finish != "stop" {
		return result, &Error{Code: "unsupported_output"}
	}
	return result, nil
}
