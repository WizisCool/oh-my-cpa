package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type playgroundRequest struct {
	RecoveryTurn         json.RawMessage   `json:"recovery_turn,omitempty"`
	ClientKeyFingerprint string            `json:"client_key_fingerprint"`
	Model                string            `json:"model"`
	SystemPrompt         string            `json:"system_prompt,omitempty"`
	Messages             []gateway.Message `json:"messages"`
	Temperature          *float64          `json:"temperature,omitempty"`
	TopP                 *float64          `json:"top_p,omitempty"`
	MaxTokens            *int              `json:"max_tokens,omitempty"`
	ReasoningEffort      *string           `json:"reasoning_effort,omitempty"`
	UserAgent            string            `json:"user_agent,omitempty"`
	CustomBody           json.RawMessage   `json:"custom_body,omitempty"`
}

// operatorUserAgent resolves the outbound User-Agent: the operator's value when they set
// one, otherwise the running build's own token.
func operatorUserAgent(requested, version string) string {
	if trimmed := strings.TrimSpace(requested); trimmed != "" {
		return trimmed
	}
	return gateway.UserAgentForVersion(version)
}

func writePlaygroundError(writer http.ResponseWriter, status int, code string) {
	writeJSON(writer, status, map[string]string{"code": code})
}

// clientKeyForResolution returns the plaintext of the one key a fingerprint names.
//
// This is the only place the fingerprint-to-key join runs, so CPA's key list is fetched once
// per API request rather than once per layer that needs the answer.
func (h *Handler) clientKeyForResolution(ctx context.Context, client *management.Client, fingerprint string) (string, error) {
	keys, err := client.ClientAPIKeys(ctx)
	if err != nil {
		return "", err
	}
	for _, key := range keys {
		key = strings.TrimSpace(key)
		identity, err := h.repo.UsageClientKeyFingerprint(key)
		if err != nil {
			return "", err
		}
		if identity == fingerprint {
			return key, nil
		}
	}
	return "", errClientKeyMissing
}

// errClientKeyMissing separates "no such key" from "the gateway could not be reached".
//
// The first is an operator's stale selection and the second is an outage; they ask for
// different things, and a console answering both with one failure cannot say which.
var errClientKeyMissing = errors.New("client_key_missing")

func (h *Handler) playgroundClient(writer http.ResponseWriter, request *http.Request, fingerprint string) (*gateway.Client, bool) {
	if fingerprint == "" || len(fingerprint) > 256 {
		writePlaygroundError(writer, 400, "client_key_required")
		return nil, false
	}
	managementClient, ok := h.managementClientOrError(writer, request)
	if !ok {
		return nil, false
	}
	key, err := h.clientKeyForResolution(request.Context(), managementClient, fingerprint)
	if errors.Is(err, errClientKeyMissing) {
		writePlaygroundError(writer, 409, "client_key_missing")
		return nil, false
	}
	if err != nil {
		writePlaygroundError(writer, 502, "gateway_unavailable")
		return nil, false
	}
	client, err := gateway.NewClient(managementClient.BaseURL(), key, h.cfg.TLSSkipVerify)
	if err != nil {
		writePlaygroundError(writer, 502, "gateway_unavailable")
		return nil, false
	}
	return client, true
}
func (h *Handler) listPlaygroundModels(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.playgroundClient(writer, request, request.URL.Query().Get("client_key_fingerprint"))
	if !ok {
		return
	}
	models, err := client.ListModels(request.Context())
	if err != nil {
		writeJSON(writer, 502, gateway.ErrorEvent(err))
		return
	}
	writeJSON(writer, 200, map[string]any{"models": models})
}
func (h *Handler) chatPlayground(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	// Admission includes validation and key resolution: concurrent large bodies must
	// not consume unbounded memory before reaching the inference semaphore.
	select {
	case h.playgroundSlots <- struct{}{}:
		defer func() { <-h.playgroundSlots }()
	default:
		writePlaygroundError(writer, 429, "playground_busy")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, gateway.MaxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input playgroundRequest
	if err := decoder.Decode(&input); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writePlaygroundError(writer, 413, "request_too_large")
		} else {
			writePlaygroundError(writer, 400, "invalid_request")
		}
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writePlaygroundError(writer, 413, "request_too_large")
		} else {
			writePlaygroundError(writer, 400, "invalid_request")
		}
		return
	}
	for _, message := range input.Messages {
		if message.Role != "user" && message.Role != "assistant" {
			writePlaygroundError(writer, 400, "invalid_request")
			return
		}
	}
	messages := input.Messages
	if input.SystemPrompt != "" {
		messages = append([]gateway.Message{{Role: "system", Content: []gateway.Content{{Type: "text", Text: input.SystemPrompt}}}}, messages...)
	}
	upstream := gateway.ChatRequest{
		Model:           input.Model,
		Messages:        messages,
		Temperature:     input.Temperature,
		TopP:            input.TopP,
		MaxTokens:       input.MaxTokens,
		ReasoningEffort: input.ReasoningEffort,
		// The deployment's own build version names the default, so a gateway sees which
		// build called it. An operator-supplied value replaces it wholesale; blank means
		// the default, resolved here rather than in the client so one value is in force.
		UserAgent:  operatorUserAgent(input.UserAgent, h.cfg.Version),
		CustomBody: input.CustomBody,
		Stream:     true,
	}
	upstream.StreamOptions.IncludeUsage = true
	// The body is composed once, here, and validated as the body it will be: merging
	// `custom_body` last lets an override replace `messages`, so validating the typed
	// request instead would let overridden content skip the image checks.
	payload, err := gateway.BuildPayload(upstream)
	if err != nil {
		writePlaygroundError(writer, 400, err.Error())
		return
	}
	if err := gateway.ValidatePayload(payload, upstream.UserAgent); err != nil {
		writePlaygroundError(writer, 400, err.Error())
		return
	}
	client, ok := h.playgroundClient(writer, request, input.ClientKeyFingerprint)
	if !ok {
		return
	}
	controller := http.NewResponseController(writer)
	// Ordinary endpoints keep the server's 30-second deadline. Only this bounded
	// streaming route extends it, and each flush still has a slow-reader deadline.
	if err := controller.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
		writePlaygroundError(writer, 500, "streaming_unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 10*time.Minute)
	defer cancel()
	writer.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	writer.Header().Set("X-Accel-Buffering", "no")
	started := time.Now()
	var firstContentMS *int64
	var outputMu sync.Mutex
	send := func(event string, value any) error {
		outputMu.Lock()
		defer outputMu.Unlock()
		if err := controller.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
			return err
		}
		body, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if _, err = io.WriteString(writer, "event: "+event+"\ndata: "+string(body)+"\n\n"); err != nil {
			return err
		}
		return controller.Flush()
	}
	// The effective model, not the selected one: `custom_body` may have overridden `model`,
	// and the panel labels the turn with this value - reporting the selection would name a
	// model the request never used.
	effectiveModel, _ := payload["model"].(string)
	if effectiveModel == "" {
		effectiveModel = input.Model
	}
	if err := send("meta", map[string]any{"model": effectiveModel, "started_at_ms": started.UnixMilli()}); err != nil {
		return
	}
	// A single writer lock covers heartbeats and events. The goroutine is joined
	// before returning so it cannot touch a recycled ResponseWriter.
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				outputMu.Lock()
				_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
				_, err := io.WriteString(writer, ": heartbeat\n\n")
				if err == nil {
					err = controller.Flush()
				}
				outputMu.Unlock()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	if err = client.Stream(ctx, upstream, payload, func(event gateway.Event) error {
		if event.Type == "delta" && firstContentMS == nil {
			elapsed := time.Since(started).Milliseconds()
			firstContentMS = &elapsed
		}
		if event.Type == "done" {
			return send("done", map[string]any{"finish_reason": event.FinishReason, "duration_ms": time.Since(started).Milliseconds(), "first_content_ms": firstContentMS})
		}
		event.FirstContentMS = firstContentMS
		return send(event.Type, event)
	}); err != nil {
		failure := gateway.ErrorEvent(err)
		if errors.Is(err, context.Canceled) {
			failure.Code = "cancelled"
		}
		failure.FirstContentMS = firstContentMS
		elapsed := time.Since(started).Milliseconds()
		failure.DurationMS = &elapsed
		_ = send("error", failure)
	}
	cancel()
	<-finished
}
