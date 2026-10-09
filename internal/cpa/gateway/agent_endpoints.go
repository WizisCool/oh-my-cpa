package gateway

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

// AgentRequest is one round of the Agent loop: the conversation so far, the tools the model
// may call, and which of CPA's endpoints the round is sent to.
type AgentRequest struct {
	Endpoint        Endpoint
	Model           string
	ReasoningEffort string
	Messages        []AgentMessage
	Tools           []AgentTool
}

// ThinkingBlock is a block of reasoning a Messages reply opened with, kept as it was signed.
// The schema requires it back, unchanged, ahead of the tool calls of the same reply when the
// conversation continues, so it travels with the assistant message until the turn ends.
type ThinkingBlock struct {
	Type      string `json:"type"`
	Thinking  string `json:"thinking,omitempty"`
	Signature string `json:"signature,omitempty"`
	Data      string `json:"data,omitempty"`
}

// AGENT_MESSAGES_MAX_TOKENS is the limit a Messages round states, which the schema requires.
// It leaves room for a drawn interface and its reasoning in one reply.
const AGENT_MESSAGES_MAX_TOKENS = 16384

func agentPayload(request AgentRequest) map[string]any {
	effort := strings.TrimSpace(request.ReasoningEffort)
	switch request.Endpoint {
	case EndpointResponses:
		return agentResponsesPayload(request, effort)
	case EndpointMessages:
		return agentMessagesPayload(request, effort)
	}
	wire, _ := agentWireMessages(request.Messages)
	payload := map[string]any{"model": request.Model, "messages": wire, "tools": request.Tools, "tool_choice": "auto", "stream": true, "stream_options": map[string]any{"include_usage": true}}
	if effort != "" {
		payload["reasoning_effort"] = effort
	}
	return payload
}

func agentResponsesPayload(request AgentRequest, effort string) map[string]any {
	input := []any{}
	var instructions []string
	for _, message := range request.Messages {
		switch message.Role {
		case "system":
			instructions = append(instructions, message.Content)
		case "tool":
			input = append(input, map[string]any{"type": "function_call_output", "call_id": message.ToolCallID, "output": message.Content})
		case "assistant":
			if strings.TrimSpace(message.Content) != "" {
				input = append(input, map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": message.Content}}})
			}
			for _, call := range message.ToolCalls {
				input = append(input, map[string]any{"type": "function_call", "call_id": call.ID, "name": call.Function.Name, "arguments": call.Function.Arguments})
			}
		default:
			content := []any{}
			if strings.TrimSpace(message.Content) != "" {
				content = append(content, map[string]any{"type": "input_text", "text": message.Content})
			}
			for _, image := range message.Images {
				if image.URL == "" {
					content = append(content, map[string]any{"type": "input_text", "text": IMAGE_UNAVAILABLE})
					continue
				}
				content = append(content, map[string]any{"type": "input_image", "image_url": image.URL})
			}
			input = append(input, map[string]any{"type": "message", "role": "user", "content": content})
		}
	}
	payload := map[string]any{"model": request.Model, "input": input, "stream": true}
	if len(instructions) > 0 {
		payload["instructions"] = strings.Join(instructions, "\n\n")
	}
	if len(request.Tools) > 0 {
		tools := make([]any, 0, len(request.Tools))
		for _, tool := range request.Tools {
			tools = append(tools, map[string]any{"type": "function", "name": tool.Function.Name, "description": tool.Function.Description, "parameters": tool.Function.Parameters})
		}
		payload["tools"] = tools
		payload["tool_choice"] = "auto"
	}
	if effort != "" {
		payload["reasoning"] = map[string]any{"effort": effort, "summary": "auto"}
	}
	return payload
}

func agentMessagesPayload(request AgentRequest, effort string) map[string]any {
	messages := []map[string]any{}
	var system []string
	// Every result of one reply's calls goes back in a single user message, as the schema asks.
	isCollectingResults := false
	for _, message := range request.Messages {
		if message.Role == "tool" {
			result := map[string]any{"type": "tool_result", "tool_use_id": message.ToolCallID, "content": message.Content}
			if isCollectingResults {
				last := messages[len(messages)-1]
				last["content"] = append(last["content"].([]any), result)
			} else {
				messages = append(messages, map[string]any{"role": "user", "content": []any{result}})
			}
			isCollectingResults = true
			continue
		}
		isCollectingResults = false
		content := []any{}
		switch message.Role {
		case "system":
			system = append(system, message.Content)
			continue
		case "assistant":
			for _, block := range message.Thinking {
				content = append(content, block)
			}
			if strings.TrimSpace(message.Content) != "" {
				content = append(content, map[string]any{"type": "text", "text": message.Content})
			}
			for _, call := range message.ToolCalls {
				arguments := json.RawMessage(call.Function.Arguments)
				if !json.Valid(arguments) {
					arguments = json.RawMessage("{}")
				}
				content = append(content, map[string]any{"type": "tool_use", "id": call.ID, "name": call.Function.Name, "input": arguments})
			}
		default:
			if strings.TrimSpace(message.Content) != "" {
				content = append(content, map[string]any{"type": "text", "text": message.Content})
			}
			for _, image := range message.Images {
				if image.URL == "" {
					content = append(content, map[string]any{"type": "text", "text": IMAGE_UNAVAILABLE})
					continue
				}
				_, data, _ := strings.Cut(image.URL, ",")
				content = append(content, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": image.MediaType, "data": data}})
			}
		}
		if len(content) > 0 {
			messages = append(messages, map[string]any{"role": message.Role, "content": content})
		}
	}
	payload := map[string]any{"model": request.Model, "messages": messages, "max_tokens": AGENT_MESSAGES_MAX_TOKENS, "stream": true}
	if len(system) > 0 {
		payload["system"] = strings.Join(system, "\n\n")
	}
	if len(request.Tools) > 0 {
		tools := make([]any, 0, len(request.Tools))
		for _, tool := range request.Tools {
			tools = append(tools, map[string]any{"name": tool.Function.Name, "description": tool.Function.Description, "input_schema": tool.Function.Parameters})
		}
		payload["tools"] = tools
		payload["tool_choice"] = map[string]any{"type": "auto"}
	}
	if effort == "none" {
		payload["thinking"] = map[string]any{"type": "disabled"}
	} else if effort != "" {
		payload["thinking"] = map[string]any{"type": "adaptive"}
		payload["output_config"] = map[string]any{"effort": effort}
	}
	return payload
}

// agentStream is what one round's stream has said so far, in the one shape the three
// endpoints are read into. finish is "stop" or "tool_calls" for a reply the loop can act on;
// any other value is a reply that ended some way this console does not continue from.
type agentStream struct {
	endpoint Endpoint
	reply    AgentReply
	calls    map[int]*ToolCall
	finish   string
	isDone   bool
	// Messages only: reasoning blocks and tool calls by the content block that carries them,
	// and the prompt tokens the opening frame reported.
	thinking     map[int]*ThinkingBlock
	blockCalls   map[int]*ToolCall
	promptTokens *int64
}

func newAgentStream(endpoint Endpoint) *agentStream {
	return &agentStream{endpoint: endpoint, calls: map[int]*ToolCall{}, thinking: map[int]*ThinkingBlock{}, blockCalls: map[int]*ToolCall{}}
}

func (stream *agentStream) decode(data string, emit func(Event) error) error {
	switch stream.endpoint {
	case EndpointResponses:
		return stream.decodeResponses(data, emit)
	case EndpointMessages:
		return stream.decodeMessages(data, emit)
	}
	return stream.decodeChat(data, emit)
}

func checkCallSize(call *ToolCall) error {
	if len(call.ID) > 256 || len(call.Function.Name) > 64 || len(call.Function.Arguments) > 128<<10 {
		return errors.New("tool_input_too_large")
	}
	return nil
}

func (stream *agentStream) text(content string, emit func(Event) error) error {
	stream.reply.Content += content
	return emit(Event{Type: "delta", Content: content})
}

func (stream *agentStream) decodeChat(text string, emit func(Event) error) error {
	if text == "[DONE]" {
		stream.isDone = true
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
		if stream.finish != "" && (choice.Delta.Content != "" || len(choice.Delta.ToolCalls) > 0) {
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
			if err := stream.text(choice.Delta.Content, emit); err != nil {
				return err
			}
		}
		for _, delta := range choice.Delta.ToolCalls {
			if delta.Index < 0 {
				return &Error{Code: "invalid_gateway_response"}
			}
			call := stream.calls[delta.Index]
			if call == nil {
				call = &ToolCall{Type: "function"}
				stream.calls[delta.Index] = call
			}
			call.ID += delta.ID
			call.Function.Name += delta.Function.Name
			call.Function.Arguments += delta.Function.Arguments
			if delta.Type != "" && delta.Type != "function" {
				return &Error{Code: "unsupported_output"}
			}
			if err := checkCallSize(call); err != nil {
				return err
			}
		}
		if choice.FinishReason != nil {
			stream.finish = *choice.FinishReason
		}
	}
	if chunk.Usage != nil {
		stream.reply.Usage = chunk.Usage
	}
	return nil
}

func (stream *agentStream) decodeResponses(text string, emit func(Event) error) error {
	if text == "[DONE]" {
		return nil
	}
	var frame struct {
		Type  string `json:"type"`
		Delta string `json:"delta"`
		Item  struct {
			Type      string `json:"type"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"item"`
		Response struct {
			Usage *struct {
				InputTokens  *int64 `json:"input_tokens"`
				OutputTokens *int64 `json:"output_tokens"`
				TotalTokens  *int64 `json:"total_tokens"`
			} `json:"usage"`
			Error json.RawMessage `json:"error"`
		} `json:"response"`
	}
	if json.Unmarshal([]byte(text), &frame) != nil {
		return &Error{Code: "invalid_gateway_response"}
	}
	end := func(finish string) {
		if usage := frame.Response.Usage; usage != nil {
			stream.reply.Usage = &Usage{PromptTokens: usage.InputTokens, CompletionTokens: usage.OutputTokens, TotalTokens: usage.TotalTokens}
		}
		stream.finish, stream.isDone = finish, true
	}
	switch frame.Type {
	case "response.output_text.delta":
		if frame.Delta != "" {
			return stream.text(frame.Delta, emit)
		}
	case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
		if frame.Delta != "" {
			return emit(Event{Type: "thought", Content: frame.Delta})
		}
	case "response.output_item.added":
		switch frame.Item.Type {
		case "message", "reasoning", "function_call":
		default:
			return &Error{Code: "unsupported_output"}
		}
	case "response.output_item.done":
		// A call is taken whole, from the frame that closes it: its argument deltas are the
		// same text arriving early, and nothing is executed from a part.
		if frame.Item.Type == "function_call" {
			call := &ToolCall{ID: frame.Item.CallID, Type: "function", Function: ToolFunction{Name: frame.Item.Name, Arguments: frame.Item.Arguments}}
			if err := checkCallSize(call); err != nil {
				return err
			}
			stream.calls[len(stream.calls)] = call
		}
	case "response.completed":
		if len(stream.calls) > 0 {
			end("tool_calls")
		} else {
			end("stop")
		}
	case "response.incomplete":
		end("length")
	case "response.failed":
		if len(frame.Response.Error) > 0 && string(frame.Response.Error) != "null" {
			return decodeAgentStreamError(frame.Response.Error)
		}
		return &Error{Code: "upstream_stream_rejected"}
	case "error":
		// The frame is the error: its code and parameter sit beside its type.
		return decodeAgentStreamError(json.RawMessage(text))
	}
	return nil
}

func (stream *agentStream) decodeMessages(text string, emit func(Event) error) error {
	var frame struct {
		Type    string `json:"type"`
		Index   int    `json:"index"`
		Message struct {
			Usage *messagesUsage `json:"usage"`
		} `json:"message"`
		ContentBlock struct {
			Type string `json:"type"`
			ID   string `json:"id"`
			Name string `json:"name"`
			Data string `json:"data"`
		} `json:"content_block"`
		Delta struct {
			Type        string  `json:"type"`
			Text        string  `json:"text"`
			Thinking    string  `json:"thinking"`
			Signature   string  `json:"signature"`
			PartialJSON string  `json:"partial_json"`
			StopReason  *string `json:"stop_reason"`
		} `json:"delta"`
		Usage *messagesUsage  `json:"usage"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal([]byte(text), &frame) != nil {
		return &Error{Code: "invalid_gateway_response"}
	}
	switch frame.Type {
	case "message_start":
		if frame.Message.Usage != nil {
			stream.promptTokens = frame.Message.Usage.prompt()
		}
	case "content_block_start":
		switch frame.ContentBlock.Type {
		case "text":
		case "thinking":
			stream.thinking[frame.Index] = &ThinkingBlock{Type: "thinking"}
		case "redacted_thinking":
			stream.thinking[frame.Index] = &ThinkingBlock{Type: "redacted_thinking", Data: frame.ContentBlock.Data}
		case "tool_use":
			call := &ToolCall{ID: frame.ContentBlock.ID, Type: "function", Function: ToolFunction{Name: frame.ContentBlock.Name}}
			stream.blockCalls[frame.Index] = call
			stream.calls[len(stream.calls)] = call
		default:
			return &Error{Code: "unsupported_output"}
		}
	case "content_block_delta":
		switch frame.Delta.Type {
		case "text_delta":
			if frame.Delta.Text != "" {
				return stream.text(frame.Delta.Text, emit)
			}
		case "thinking_delta":
			if block := stream.thinking[frame.Index]; block != nil {
				block.Thinking += frame.Delta.Thinking
			}
			if frame.Delta.Thinking != "" {
				return emit(Event{Type: "thought", Content: frame.Delta.Thinking})
			}
		case "signature_delta":
			if block := stream.thinking[frame.Index]; block != nil {
				block.Signature += frame.Delta.Signature
			}
		case "input_json_delta":
			call := stream.blockCalls[frame.Index]
			if call == nil {
				return &Error{Code: "invalid_gateway_response"}
			}
			call.Function.Arguments += frame.Delta.PartialJSON
			return checkCallSize(call)
		}
	case "message_delta":
		if frame.Delta.StopReason != nil {
			switch *frame.Delta.StopReason {
			case "end_turn", "stop_sequence":
				stream.finish = "stop"
			case "tool_use":
				stream.finish = "tool_calls"
			default:
				stream.finish = *frame.Delta.StopReason
			}
		}
		if frame.Usage != nil {
			if prompt := frame.Usage.prompt(); prompt != nil {
				stream.promptTokens = prompt
			}
			usage := &Usage{PromptTokens: stream.promptTokens, CompletionTokens: frame.Usage.OutputTokens}
			if usage.PromptTokens != nil && usage.CompletionTokens != nil {
				total := *usage.PromptTokens + *usage.CompletionTokens
				usage.TotalTokens = &total
			}
			stream.reply.Usage = usage
		}
	case "message_stop":
		// A call with no parameters streams no argument text; its input is the empty object.
		for _, call := range stream.calls {
			if call.Function.Arguments == "" {
				call.Function.Arguments = "{}"
			}
		}
		indexes := make([]int, 0, len(stream.thinking))
		for index := range stream.thinking {
			indexes = append(indexes, index)
		}
		sort.Ints(indexes)
		for _, index := range indexes {
			stream.reply.Thinking = append(stream.reply.Thinking, *stream.thinking[index])
		}
		stream.isDone = true
	case "error":
		if len(frame.Error) > 0 && string(frame.Error) != "null" {
			return decodeAgentStreamError(frame.Error)
		}
		return &Error{Code: "upstream_stream_rejected"}
	}
	return nil
}
