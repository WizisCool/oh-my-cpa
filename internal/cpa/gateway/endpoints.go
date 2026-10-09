package gateway

import (
	"encoding/json"
	"strings"
)

// Endpoint names one of the inference surfaces CPA serves a client key on. The same
// conversation can be sent to any of them; what differs is the body CPA is given and the
// stream it answers with, so each endpoint has its own payload and its own decoder here
// while the console's request and the events it reads stay one shape.
type Endpoint string

const (
	EndpointChat      Endpoint = "chat"
	EndpointResponses Endpoint = "responses"
	EndpointMessages  Endpoint = "messages"
)

// MESSAGES_VERSION is the `anthropic-version` a Messages request states.
const MESSAGES_VERSION = "2023-06-01"

// DEFAULT_MESSAGES_MAX_TOKENS is sent when the operator set no limit. The Messages schema
// requires the field, so "leave it to the model" cannot be expressed by omitting it.
const DEFAULT_MESSAGES_MAX_TOKENS = 4096

// ParseEndpoint reads the console's wire name. Blank is Chat Completions, which is what a
// request stored before the endpoint could be chosen was sent to.
func ParseEndpoint(value string) (Endpoint, bool) {
	switch Endpoint(value) {
	case "", EndpointChat:
		return EndpointChat, true
	case EndpointResponses:
		return EndpointResponses, true
	case EndpointMessages:
		return EndpointMessages, true
	}
	return "", false
}

// Path is fixed per endpoint: the operator chooses among CPA's surfaces, never a URL.
func (endpoint Endpoint) Path() string {
	switch endpoint {
	case EndpointResponses:
		return "/v1/responses"
	case EndpointMessages:
		return "/v1/messages"
	}
	return "/v1/chat/completions"
}

// contentKey is the body field that carries the conversation on an endpoint other than
// Chat Completions. `custom_body` may not replace it: the image checks run on the console's
// own messages, and this console does not model the endpoint's content schema well enough to
// run them again on an operator's replacement.
func (endpoint Endpoint) contentKey() string {
	if endpoint == EndpointResponses {
		return "input"
	}
	return "messages"
}

// splitSystem separates the leading system message both non-chat schemas carry as a field
// of its own.
func splitSystem(messages []Message) (string, []Message) {
	if len(messages) == 0 || messages[0].Role != "system" {
		return "", messages
	}
	var text []string
	for _, part := range messages[0].Content {
		if part.Type == "text" {
			text = append(text, part.Text)
		}
	}
	return strings.Join(text, "\n"), messages[1:]
}

func responsesPayload(request ChatRequest) map[string]any {
	instructions, messages := splitSystem(request.Messages)
	input := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		textType := "input_text"
		if message.Role == "assistant" {
			textType = "output_text"
		}
		content := make([]map[string]any, 0, len(message.Content))
		for _, part := range message.Content {
			if part.Type == "image_url" && part.ImageURL != nil {
				content = append(content, map[string]any{"type": "input_image", "image_url": part.ImageURL.URL})
				continue
			}
			content = append(content, map[string]any{"type": textType, "text": part.Text})
		}
		input = append(input, map[string]any{"type": "message", "role": message.Role, "content": content})
	}
	payload := map[string]any{"model": request.Model, "input": input, "stream": true}
	if instructions != "" {
		payload["instructions"] = instructions
	}
	if request.Temperature != nil {
		payload["temperature"] = *request.Temperature
	}
	if request.TopP != nil {
		payload["top_p"] = *request.TopP
	}
	if request.MaxTokens != nil {
		payload["max_output_tokens"] = *request.MaxTokens
	}
	if request.ReasoningEffort != nil {
		// A summary is asked for with the effort: without one the stream carries no reasoning
		// text, and the operator who raised the effort would see nothing for it.
		payload["reasoning"] = map[string]any{"effort": *request.ReasoningEffort, "summary": "auto"}
	}
	return payload
}

func messagesPayload(request ChatRequest) map[string]any {
	system, messages := splitSystem(request.Messages)
	converted := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		content := make([]map[string]any, 0, len(message.Content))
		for _, part := range message.Content {
			if part.Type == "image_url" && part.ImageURL != nil {
				header, data, _ := strings.Cut(part.ImageURL.URL, ",")
				mediaType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
				content = append(content, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": mediaType, "data": data}})
				continue
			}
			content = append(content, map[string]any{"type": "text", "text": part.Text})
		}
		converted = append(converted, map[string]any{"role": message.Role, "content": content})
	}
	maxTokens := DEFAULT_MESSAGES_MAX_TOKENS
	if request.MaxTokens != nil {
		maxTokens = *request.MaxTokens
	}
	payload := map[string]any{"model": request.Model, "messages": converted, "max_tokens": maxTokens, "stream": true}
	if system != "" {
		payload["system"] = system
	}
	if request.Temperature != nil {
		payload["temperature"] = *request.Temperature
	}
	if request.TopP != nil {
		payload["top_p"] = *request.TopP
	}
	if request.ReasoningEffort != nil {
		// The schema has no single effort field: thinking is switched on or off, and how much
		// of it is an output setting. "none" is the one level that means off.
		if effort := strings.TrimSpace(*request.ReasoningEffort); effort == "none" {
			payload["thinking"] = map[string]any{"type": "disabled"}
		} else {
			payload["thinking"] = map[string]any{"type": "adaptive"}
			payload["output_config"] = map[string]any{"effort": effort}
		}
	}
	return payload
}

// validateOverrides checks the merged body of an endpoint other than Chat Completions. The
// console's own messages were validated before they were converted, so what remains is to
// keep `custom_body` from replacing what was checked or from changing what this route can
// read back.
func validateOverrides(endpoint Endpoint, custom map[string]any, payload map[string]any) error {
	if _, isReplaced := custom[endpoint.contentKey()]; isReplaced {
		return &Error{Code: "unsupported_parameter", Parameter: endpoint.contentKey()}
	}
	if isStreaming, isBool := payload["stream"].(bool); !isBool || !isStreaming {
		return &Error{Code: "unsupported_parameter", Parameter: "stream"}
	}
	if model, _ := payload["model"].(string); strings.TrimSpace(model) == "" || len(model) > 512 {
		return &Error{Code: "invalid_request"}
	}
	return nil
}

// streamDecoder turns one endpoint's SSE data frames into the console's events. It reports
// done once the stream has said how the answer ended; a stream that stops before that is
// incomplete whichever endpoint it came from.
type streamDecoder interface {
	decode(data string, emit func(Event) error) (isDone bool, err error)
}

func decoderFor(endpoint Endpoint) streamDecoder {
	switch endpoint {
	case EndpointResponses:
		return &responsesDecoder{}
	case EndpointMessages:
		return &messagesDecoder{}
	}
	return &chatDecoder{}
}

func emitUsage(usage *Usage, emit func(Event) error) error {
	for _, value := range []*int64{usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens} {
		if value != nil && *value < 0 {
			return &Error{Code: "invalid_gateway_response"}
		}
	}
	return emit(Event{Type: "usage", Usage: usage})
}

type chatDecoder struct{ finishReason string }

func (decoder *chatDecoder) decode(data string, emit func(Event) error) (bool, error) {
	if data == "[DONE]" {
		if decoder.finishReason == "" {
			return false, &Error{Code: "stream_incomplete"}
		}
		return true, emit(Event{Type: "done", FinishReason: decoder.finishReason})
	}
	var chunk struct {
		Choices []struct {
			Index int `json:"index"`
			Delta struct {
				Content          string          `json:"content"`
				ReasoningContent string          `json:"reasoning_content"`
				Reasoning        string          `json:"reasoning"`
				ToolCalls        json.RawMessage `json:"tool_calls"`
				FunctionCall     json.RawMessage `json:"function_call"`
			} `json:"delta"`
			FinishReason *string `json:"finish_reason"`
		} `json:"choices"`
		Usage *Usage          `json:"usage"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal([]byte(data), &chunk) != nil {
		return false, &Error{Code: "invalid_gateway_response"}
	}
	if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
		return false, &Error{Code: "upstream_rejected"}
	}
	for _, choice := range chunk.Choices {
		if choice.Index != 0 {
			continue
		}
		if hasJSONValue(choice.Delta.ToolCalls) || hasJSONValue(choice.Delta.FunctionCall) {
			return false, &Error{Code: "unsupported_output"}
		}
		thought := choice.Delta.ReasoningContent
		if thought == "" {
			thought = choice.Delta.Reasoning
		}
		if thought != "" {
			if err := emit(Event{Type: "thought", Content: thought}); err != nil {
				return false, err
			}
		}
		if choice.Delta.Content != "" {
			if err := emit(Event{Type: "delta", Content: choice.Delta.Content}); err != nil {
				return false, err
			}
		}
		if choice.FinishReason != nil {
			switch *choice.FinishReason {
			case "stop", "length", "content_filter":
				decoder.finishReason = *choice.FinishReason
			case "tool_calls", "function_call":
				return false, &Error{Code: "unsupported_output"}
			default:
				return false, &Error{Code: "invalid_gateway_response"}
			}
		}
	}
	if chunk.Usage != nil {
		if err := emitUsage(chunk.Usage, emit); err != nil {
			return false, err
		}
	}
	return false, nil
}

// responsesDecoder reads the Responses stream, whose frames name themselves in `type`. The
// terminal frame carries the whole response, usage included, so the answer's end and its
// token counts arrive together.
type responsesDecoder struct{}

func (decoder *responsesDecoder) decode(data string, emit func(Event) error) (bool, error) {
	if data == "[DONE]" {
		// A terminal frame returns before this is read; reaching it means none arrived.
		return false, &Error{Code: "stream_incomplete"}
	}
	var frame struct {
		Type  string `json:"type"`
		Delta string `json:"delta"`
		Item  struct {
			Type string `json:"type"`
		} `json:"item"`
		Response struct {
			Usage *struct {
				InputTokens  *int64 `json:"input_tokens"`
				OutputTokens *int64 `json:"output_tokens"`
				TotalTokens  *int64 `json:"total_tokens"`
			} `json:"usage"`
			IncompleteDetails struct {
				Reason string `json:"reason"`
			} `json:"incomplete_details"`
		} `json:"response"`
	}
	if json.Unmarshal([]byte(data), &frame) != nil {
		return false, &Error{Code: "invalid_gateway_response"}
	}
	finish := func(reason string) (bool, error) {
		if usage := frame.Response.Usage; usage != nil {
			if err := emitUsage(&Usage{PromptTokens: usage.InputTokens, CompletionTokens: usage.OutputTokens, TotalTokens: usage.TotalTokens}, emit); err != nil {
				return false, err
			}
		}
		return true, emit(Event{Type: "done", FinishReason: reason})
	}
	switch frame.Type {
	case "response.output_text.delta":
		if frame.Delta != "" {
			return false, emit(Event{Type: "delta", Content: frame.Delta})
		}
	case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
		if frame.Delta != "" {
			return false, emit(Event{Type: "thought", Content: frame.Delta})
		}
	case "response.output_item.added":
		// Text and reasoning are the two items this page can draw; anything else is a call
		// the page can neither show nor run.
		if frame.Item.Type != "message" && frame.Item.Type != "reasoning" {
			return false, &Error{Code: "unsupported_output"}
		}
	case "response.completed":
		return finish("stop")
	case "response.incomplete":
		if frame.Response.IncompleteDetails.Reason == "content_filter" {
			return finish("content_filter")
		}
		return finish("length")
	case "response.failed", "error":
		return false, &Error{Code: "upstream_rejected"}
	}
	return false, nil
}

// messagesDecoder reads the Messages stream. Its token counts come in two parts - the prompt
// on the opening frame, the output with the stop reason - so the prompt is held until the
// frame that completes the pair.
type messagesDecoder struct {
	promptTokens *int64
	finishReason string
}

type messagesUsage struct {
	InputTokens              *int64 `json:"input_tokens"`
	OutputTokens             *int64 `json:"output_tokens"`
	CacheCreationInputTokens *int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     *int64 `json:"cache_read_input_tokens"`
}

// prompt is every token the model read: the schema reports cached input beside the rest
// rather than inside it.
func (usage *messagesUsage) prompt() *int64 {
	if usage.InputTokens == nil {
		return nil
	}
	total := *usage.InputTokens
	for _, cached := range []*int64{usage.CacheCreationInputTokens, usage.CacheReadInputTokens} {
		if cached != nil {
			total += *cached
		}
	}
	return &total
}

func (decoder *messagesDecoder) decode(data string, emit func(Event) error) (bool, error) {
	var frame struct {
		Type    string `json:"type"`
		Message struct {
			Usage *messagesUsage `json:"usage"`
		} `json:"message"`
		ContentBlock struct {
			Type string `json:"type"`
		} `json:"content_block"`
		Delta struct {
			Type       string  `json:"type"`
			Text       string  `json:"text"`
			Thinking   string  `json:"thinking"`
			StopReason *string `json:"stop_reason"`
		} `json:"delta"`
		Usage *messagesUsage `json:"usage"`
	}
	if json.Unmarshal([]byte(data), &frame) != nil {
		return false, &Error{Code: "invalid_gateway_response"}
	}
	switch frame.Type {
	case "message_start":
		if frame.Message.Usage != nil {
			decoder.promptTokens = frame.Message.Usage.prompt()
		}
	case "content_block_start":
		switch frame.ContentBlock.Type {
		case "text", "thinking", "redacted_thinking":
		default:
			return false, &Error{Code: "unsupported_output"}
		}
	case "content_block_delta":
		if frame.Delta.Type == "thinking_delta" && frame.Delta.Thinking != "" {
			return false, emit(Event{Type: "thought", Content: frame.Delta.Thinking})
		}
		if frame.Delta.Type == "text_delta" && frame.Delta.Text != "" {
			return false, emit(Event{Type: "delta", Content: frame.Delta.Text})
		}
	case "message_delta":
		if frame.Delta.StopReason != nil {
			switch *frame.Delta.StopReason {
			case "end_turn", "stop_sequence", "pause_turn":
				decoder.finishReason = "stop"
			case "max_tokens", "model_context_window_exceeded":
				decoder.finishReason = "length"
			case "refusal":
				decoder.finishReason = "content_filter"
			case "tool_use":
				return false, &Error{Code: "unsupported_output"}
			default:
				return false, &Error{Code: "invalid_gateway_response"}
			}
		}
		if frame.Usage != nil {
			// A closing frame that restates the prompt is the later reading of it.
			if prompt := frame.Usage.prompt(); prompt != nil {
				decoder.promptTokens = prompt
			}
			usage := &Usage{PromptTokens: decoder.promptTokens, CompletionTokens: frame.Usage.OutputTokens}
			if usage.PromptTokens != nil && usage.CompletionTokens != nil {
				total := *usage.PromptTokens + *usage.CompletionTokens
				usage.TotalTokens = &total
			}
			if err := emitUsage(usage, emit); err != nil {
				return false, err
			}
		}
	case "message_stop":
		if decoder.finishReason == "" {
			return false, &Error{Code: "stream_incomplete"}
		}
		return true, emit(Event{Type: "done", FinishReason: decoder.finishReason})
	case "error":
		return false, &Error{Code: "upstream_rejected"}
	}
	return false, nil
}
