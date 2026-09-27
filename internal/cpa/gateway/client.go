package gateway

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

var transports = [2]*http.Transport{newTransport(false), newTransport(true)}

func newTransport(isInsecure bool) *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: isInsecure} // #nosec G402 -- explicit operator opt-in.
	transport.ResponseHeaderTimeout = 120 * time.Second
	return transport
}

type Client struct {
	baseURL     string
	clientKey   string
	httpClient  *http.Client
	idleTimeout time.Duration
}

func NewClient(baseURL, clientKey string, isInsecure bool) (*Client, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || strings.TrimSpace(clientKey) == "" {
		return nil, &Error{Code: "gateway_unavailable"}
	}
	transport := transports[0]
	if isInsecure {
		transport = transports[1]
	}
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), clientKey: clientKey, idleTimeout: 120 * time.Second, httpClient: &http.Client{
		Transport: transport,
		// Even a same-origin redirect can change the operation: inference endpoints are fixed.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}
func (client *Client) request(ctx context.Context, method, endpoint string, body io.Reader) (*http.Response, error) {
	return client.requestWithUA(ctx, method, endpoint, body, DefaultUserAgent)
}

func (client *Client) requestWithUA(ctx context.Context, method, endpoint string, body io.Reader, userAgent string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, client.baseURL+endpoint, body)
	if err != nil {
		return nil, &Error{Code: "gateway_unavailable"}
	}
	request.Header.Set("Authorization", "Bearer "+client.clientKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	ua := strings.TrimSpace(userAgent)
	if ua == "" {
		ua = DefaultUserAgent
	}
	request.Header.Set("User-Agent", ua)
	response, err := client.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &Error{Code: "gateway_unavailable"}
	}
	if response.StatusCode != http.StatusOK {
		defer response.Body.Close()
		return nil, readError(response)
	}
	return response, nil
}
func readError(response *http.Response) *Error {
	failure := &Error{Code: "upstream_rejected", Status: response.StatusCode}
	switch response.StatusCode {
	case 401, 403:
		failure.Code = "gateway_auth_failed"
	case 404:
		failure.Code = "model_or_endpoint_missing"
	case 429:
		failure.Code = "upstream_rate_limited"
	}
	var payload struct {
		Error struct {
			Code  string `json:"code"`
			Param string `json:"param"`
		} `json:"error"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&payload) == nil {
		switch payload.Error.Code {
		case "context_length_exceeded", "model_not_found", "unsupported_parameter", "invalid_image":
			failure.Code = payload.Error.Code
		}
		switch payload.Error.Param {
		case "temperature", "top_p", "max_tokens", "reasoning_effort", "model", "messages":
			failure.Parameter = payload.Error.Param
		}
	}
	return failure
}
func (client *Client) ListModels(ctx context.Context) ([]Model, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	response, err := client.request(ctx, http.MethodGet, "/v1/models", nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&payload); err != nil {
		return nil, &Error{Code: "invalid_gateway_response"}
	}
	models := make([]Model, 0, len(payload.Data))
	seen := map[string]bool{}
	for _, item := range payload.Data {
		if item.ID != "" && len(item.ID) <= 512 && !seen[item.ID] && !strings.Contains(item.ID, client.clientKey) {
			models = append(models, Model{ID: item.ID, CallPoint: item.ID, Vision: "unknown"})
			seen[item.ID] = true
		}
	}
	sort.Slice(models, func(left, right int) bool { return models[left].ID < models[right].ID })
	return models, nil
}

type activityReader struct {
	reader io.Reader
	touch  func()
}

func (reader activityReader) Read(buffer []byte) (int, error) {
	count, err := reader.reader.Read(buffer)
	if count > 0 {
		reader.touch()
	}
	return count, err
}

// hasJSONValue distinguishes an absent/null field from a tool payload. A tool
// call is not text this page can render or execute, even when its finish reason
// arrives separately or not at all.
func hasJSONValue(value json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(value))
	return trimmed != "" && trimmed != "null" && trimmed != "[]" && trimmed != "{}"
}

// Stream owns the upstream body. Cancellation closes it even when no SSE frame is
// arriving. The sink is synchronous, providing backpressure rather than an event queue.
//
// The caller supplies the payload, because it must be the same map that was validated:
// composing it here as well would give validation and transmission two chances to
// disagree, which is exactly how an override used to slip past the image checks.
func (client *Client) Stream(ctx context.Context, request ChatRequest, payload map[string]any, emit func(Event) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	body, err := json.Marshal(payload)
	if err != nil {
		return &Error{Code: "invalid_request"}
	}
	var hasTimedOut atomic.Bool
	timer := time.AfterFunc(client.idleTimeout, func() { hasTimedOut.Store(true); cancel() })
	defer timer.Stop()
	response, err := client.requestWithUA(ctx, http.MethodPost, "/v1/chat/completions", bytes.NewReader(body), request.UserAgent)
	if err != nil {
		if hasTimedOut.Load() {
			return &Error{Code: "upstream_timeout"}
		}
		return err
	}
	defer response.Body.Close()
	if !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		return &Error{Code: "invalid_gateway_response"}
	}
	scanner := bufio.NewScanner(activityReader{reader: response.Body, touch: func() { timer.Reset(client.idleTimeout) }})
	scanner.Buffer(make([]byte, 4096), 1<<20)
	var data []string
	totalBytes := 0
	finishReason := ""
	dispatch := func() (bool, error) {
		if len(data) == 0 {
			return false, nil
		}
		joined := strings.Join(data, "\n")
		data = nil
		if joined == "[DONE]" {
			if finishReason == "" {
				return false, &Error{Code: "stream_incomplete"}
			}
			return true, emit(Event{Type: "done", FinishReason: finishReason})
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
		if json.Unmarshal([]byte(joined), &chunk) != nil {
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
					finishReason = *choice.FinishReason
				case "tool_calls", "function_call":
					return false, &Error{Code: "unsupported_output"}
				default:
					return false, &Error{Code: "invalid_gateway_response"}
				}
			}
		}
		if chunk.Usage != nil {
			for _, value := range []*int64{chunk.Usage.PromptTokens, chunk.Usage.CompletionTokens, chunk.Usage.TotalTokens} {
				if value != nil && *value < 0 {
					return false, &Error{Code: "invalid_gateway_response"}
				}
			}
			if err := emit(Event{Type: "usage", Usage: chunk.Usage}); err != nil {
				return false, err
			}
		}
		return false, nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		totalBytes += len(line)
		if totalBytes > MaxResponseBytes {
			return &Error{Code: "response_too_large"}
		}
		if line == "" {
			isDone, err := dispatch()
			if err != nil {
				return err
			}
			if isDone {
				return nil
			}
		} else if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if hasTimedOut.Load() {
		return &Error{Code: "upstream_timeout"}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if scanner.Err() != nil {
		return &Error{Code: "stream_incomplete"}
	}
	if len(data) > 0 {
		isDone, err := dispatch()
		if err != nil {
			return err
		}
		if isDone {
			return nil
		}
	}
	return &Error{Code: "stream_incomplete"}
}

func ErrorEvent(err error) Event {
	event := Event{Type: "error", Code: "gateway_unavailable"}
	var failure *Error
	if errors.As(err, &failure) {
		event.Code = failure.Code
		event.UpstreamStatus = failure.Status
		event.Parameter = failure.Parameter
	}
	if errors.Is(err, context.DeadlineExceeded) {
		event.Code = "upstream_timeout"
	}
	return event
}
