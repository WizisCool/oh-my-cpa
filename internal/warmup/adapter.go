package warmup

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

const (
	CODEX_ENDPOINT     = "https://chatgpt.com/backend-api/codex/responses"
	CLAUDE_ENDPOINT    = "https://api.anthropic.com/v1/messages"
	MAX_RESPONSE_BYTES = 1024 * 1024
)

type Caller interface {
	ApiCall(context.Context, management.ApiCallRequest) (management.ApiCallResponse, error)
}
type Outcome struct {
	Status       string
	Reason       string
	InputTokens  *int64
	OutputTokens *int64
}

// Send never accepts a destination, prompt, credential secret or caller headers.
// CPA substitutes the selected credential; ordinary inference routing is bypassed.
func Send(ctx context.Context, caller Caller, file management.AuthFile, provider, model string) Outcome {
	if !IsProvider(provider) || model == "" || file.AuthIndex == "" {
		return Outcome{Status: "failed", Reason: "invalid_parameters"}
	}
	headers := management.WithQuotaCredential(map[string]string{"Content-Type": "application/json", "Accept": "application/json"})
	var body map[string]any
	endpoint := CLAUDE_ENDPOINT
	if provider == "codex" {
		endpoint = CODEX_ENDPOINT
		headers["Accept"] = "text/event-stream"
		headers["User-Agent"] = "codex-tui/0.149.1"
		headers["Originator"] = "codex_cli_rs"
		if accountID := file.CodexChatgptAccountID(); accountID != "" {
			headers["Chatgpt-Account-Id"] = accountID
		}
		body = map[string]any{"model": model, "instructions": "Reply with OK.", "input": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "hi"}}}}, "store": false, "stream": true, "tools": []any{}, "reasoning": map[string]any{"effort": "low"}, "text": map[string]any{"verbosity": "low"}}
	} else {
		headers["anthropic-version"] = "2023-06-01"
		headers["anthropic-beta"] = "oauth-2025-04-20"
		headers["x-app"] = "cli"
		headers["User-Agent"] = "claude-cli/2.1.0 (external, cli)"
		body = map[string]any{"model": model, "max_tokens": 8, "stream": false, "system": "You are Claude Code, Anthropic's official CLI for Claude.", "messages": []any{map[string]any{"role": "user", "content": "Reply with OK."}}, "tools": []any{}, "thinking": map[string]any{"type": "disabled"}}
	}
	payload, _ := json.Marshal(body)
	response, err := caller.ApiCall(ctx, management.ApiCallRequest{AuthIndex: file.AuthIndex, Method: http.MethodPost, URL: endpoint, Header: headers, Data: string(payload)})
	if err != nil {
		return Outcome{Status: "uncertain", Reason: "outcome_unknown"}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		switch response.StatusCode {
		case 400, 404, 422:
			return Outcome{Status: "failed", Reason: "protocol_unsupported"}
		case 401, 403:
			return Outcome{Status: "failed", Reason: "needs_reauth"}
		case 429:
			return Outcome{Status: "failed", Reason: "rate_limited"}
		default:
			return Outcome{Status: "uncertain", Reason: "outcome_unknown"}
		}
	}
	raw, err := response.NormalizedBody()
	if err != nil || len(raw) > MAX_RESPONSE_BYTES {
		return Outcome{Status: "uncertain", Reason: "outcome_unknown"}
	}
	if provider == "claude" {
		return parseClaudeCompletion(raw)
	}
	return parseCodexCompletion(raw)
}
func parseClaudeCompletion(raw []byte) Outcome {
	var message struct {
		Type       string `json:"type"`
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type string `json:"type"`
		} `json:"content"`
		Usage struct {
			InputTokens  *int64 `json:"input_tokens"`
			OutputTokens *int64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(raw, &message) != nil || message.Type != "message" || (message.StopReason != "end_turn" && message.StopReason != "max_tokens") || len(message.Content) == 0 {
		return Outcome{Status: "uncertain", Reason: "outcome_unknown"}
	}
	for _, content := range message.Content {
		if content.Type != "text" {
			return Outcome{Status: "uncertain", Reason: "unexpected_tool"}
		}
	}
	return Outcome{Status: "pending", Reason: "activation_pending", InputTokens: message.Usage.InputTokens, OutputTokens: message.Usage.OutputTokens}
}

// The Codex backend streams each output item in response.output_item.done and
// routinely leaves response.completed.output empty (CPA backfills it for the
// same reason), so completion is judged from both. A completed response proves
// the request was accepted and metered; only window evidence proves activation.
func parseCodexCompletion(raw []byte) Outcome {
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 4096), MAX_RESPONSE_BYTES)
	itemTypes := []string{}
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var event struct {
			Type string `json:"type"`
			Item struct {
				Type string `json:"type"`
			} `json:"item"`
			Response struct {
				Status string `json:"status"`
				Output []struct {
					Type string `json:"type"`
				} `json:"output"`
				Usage struct {
					InputTokens  *int64 `json:"input_tokens"`
					OutputTokens *int64 `json:"output_tokens"`
				} `json:"usage"`
			} `json:"response"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &event) != nil {
			continue
		}
		switch event.Type {
		case "response.failed", "error":
			return Outcome{Status: "uncertain", Reason: "outcome_unknown"}
		case "response.output_item.done":
			itemTypes = append(itemTypes, event.Item.Type)
		case "response.completed":
			if event.Response.Status != "completed" {
				continue
			}
			for _, output := range event.Response.Output {
				itemTypes = append(itemTypes, output.Type)
			}
			for _, itemType := range itemTypes {
				if itemType != "message" && itemType != "reasoning" {
					return Outcome{Status: "uncertain", Reason: "unexpected_tool"}
				}
			}
			return Outcome{Status: "pending", Reason: "activation_pending", InputTokens: event.Response.Usage.InputTokens, OutputTokens: event.Response.Usage.OutputTokens}
		}
	}
	return Outcome{Status: "uncertain", Reason: "outcome_unknown"}
}

var ErrBusy = errors.New("warmup_busy")
