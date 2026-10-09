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
	// Images are the pictures the operator sent with a user message.
	Images []AgentImage `json:"images,omitempty"`
}

// AgentImage names one image of a message. A stored message keeps the reference only - the
// bytes live beside the conversation, not in it - so URL is filled in for the request being
// built and never serialised with the message.
type AgentImage struct {
	ID        string `json:"id"`
	MediaType string `json:"media_type"`
	Bytes     int    `json:"bytes"`
	// URL is the image as a data URL.
	URL string `json:"-"`
}

// IMAGE_UNAVAILABLE stands where an image was sent earlier in the conversation and is no longer
// part of the request, so the model does not answer as if it could still see it.
const IMAGE_UNAVAILABLE = "[An image the operator attached here is no longer in view. Ask for it again if it is needed.]"

// ValidateImage reports whether a data URL is an image a model may be sent: an allowed type whose
// bytes are that type, within the size and pixel limits the Playground applies.
func ValidateImage(dataURL string) error { return validateImage(dataURL) }

// agentWireMessages is the messages as the gateway takes them, and the bytes of image data among
// them. A message with images becomes multi-part content; every other message stays the plain
// string it always was, which is the form every provider behind the gateway accepts.
func agentWireMessages(messages []AgentMessage) ([]any, int) {
	wire := make([]any, len(messages))
	imageBytes := 0
	for index, message := range messages {
		if len(message.Images) == 0 {
			wire[index] = message
			continue
		}
		parts := []Content{}
		if strings.TrimSpace(message.Content) != "" {
			parts = append(parts, Content{Type: "text", Text: message.Content})
		}
		for _, image := range message.Images {
			if image.URL == "" {
				parts = append(parts, Content{Type: "text", Text: IMAGE_UNAVAILABLE})
				continue
			}
			imageBytes += len(image.URL)
			parts = append(parts, Content{Type: "image_url", ImageURL: &ImageURL{URL: image.URL}})
		}
		wire[index] = map[string]any{"role": message.Role, "content": parts}
	}
	return wire, imageBytes
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

// StreamAgent accepts only server-constructed messages and definitions. Incomplete tool
// arguments never leave this method as executable calls.
//
// Reasoning the model streams (`reasoning_content`, or `reasoning` on providers that name it so)
// is emitted as `thought` events and never enters the reply, so it can be shown as reasoning
// without becoming part of the conversation the next round is built from.
func (client *Client) StreamAgent(ctx context.Context, model string, reasoningEffort string, messages []AgentMessage, tools []AgentTool, emit func(Event) error) (AgentReply, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	wire, _ := agentWireMessages(messages)
	payload := map[string]any{"model": model, "messages": wire, "tools": tools, "tool_choice": "auto", "stream": true, "stream_options": map[string]any{"include_usage": true}}
	if effort := strings.TrimSpace(reasoningEffort); effort != "" {
		if !ValidReasoningEffort(effort) {
			return AgentReply{}, errors.New("invalid_parameters")
		}
		payload["reasoning_effort"] = effort
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return AgentReply{}, err
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
		if json.Unmarshal([]byte(text), &chunk) != nil {
			return &Error{Code: "invalid_gateway_response"}
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return decodeAgentStreamError(chunk.Error)
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
				if delta.Index < 0 {
					return &Error{Code: "invalid_gateway_response"}
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
				if len(call.ID) > 256 || len(call.Function.Name) > 64 || len(call.Function.Arguments) > 128<<10 {
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

// streamFailureCode maps the code or type a stream error frame carries onto the console's own
// vocabulary. The empty string means the frame named nothing this gateway understands, which
// decodeAgentStreamError reads as a refusal of the request.
func streamFailureCode(code string) string {
	switch code {
	case "context_length_exceeded", "context_window_exceeded", "prompt_too_long":
		return "context_length_exceeded"
	case "request_too_large":
		return "request_too_large"
	case "model_not_found", "unsupported_parameter", "invalid_image":
		return code
	case "server_error", "api_error", "internal_error", "overloaded_error", "rate_limit_error", "service_unavailable", "timeout_error":
		// A fault the provider names as transient is an outage, not a verdict on this request.
		return "upstream_rejected"
	}
	return ""
}

// Only structured codes and known parameter names cross the inference boundary. A streaming
// error may contain the same sensitive request excerpts as an HTTP rejection.
//
// The status line that would separate a refusal from an outage was already spent, so the frame's
// own words decide: one that names a transient fault keeps the retryable `upstream_rejected`, and
// one that names a verdict - or nothing this gateway knows - is a refusal another attempt would
// pay for twice.
func decodeAgentStreamError(raw json.RawMessage) *Error {
	failure := &Error{Code: "upstream_stream_rejected"}
	var payload struct {
		Code  string `json:"code"`
		Type  string `json:"type"`
		Param string `json:"param"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return &Error{Code: "invalid_gateway_response"}
	}
	for _, code := range []string{payload.Code, payload.Type} {
		if classified := streamFailureCode(code); classified != "" {
			failure.Code = classified
			break
		}
	}
	switch payload.Param {
	case "temperature", "top_p", "max_tokens", "reasoning_effort", "model", "messages":
		failure.Parameter = payload.Param
	}
	return failure
}
