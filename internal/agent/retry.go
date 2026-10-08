package agent

import (
	"context"
	"errors"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

const UPSTREAM_RETRIES = 3

// NON_RETRYABLE_FAILURES are refusals a repeat cannot repair, so the loop reports them at once
// instead of spending three more paid generations - or, for the ones that only delay, 1.75s of
// backoff - to reach the same answer. Everything else, including rate limits, dropped streams and
// malformed gateway frames, is retried because another attempt can legitimately succeed.
var NON_RETRYABLE_FAILURES = map[string]bool{
	// The request itself is the problem: the same context, parameters, images or target model.
	"context_length_exceeded":   true,
	"request_too_large":         true,
	"invalid_parameters":        true,
	"invalid_image":             true,
	"model_not_found":           true,
	"model_or_endpoint_missing": true,
	// The account or the deployment is the problem, and a repeat reads the same state.
	"gateway_auth_failed":   true,
	"unsupported_parameter": true,
	// The model already streamed this call's arguments; a retry re-generates the whole answer.
	"tool_input_too_large": true,
	// The stream refused the request after the status line had been sent, naming no transient
	// fault: the identical request reaches the same refusal.
	"upstream_stream_rejected": true,
	// The answer ended for a length or content-filter reason, or streamed a call this loop cannot
	// execute: the identical request reaches the same end.
	"unsupported_output": true,
	// Local refusals, not inference failures.
	"resource_conflict":    true,
	"resource_missing":     true,
	"capability_forbidden": true,
}

// RunFailure contains only allowlisted diagnostics, never an upstream body or credentials.
type RunFailure struct {
	Code             string `json:"code"`
	UpstreamStatus   int    `json:"upstream_status,omitempty"`
	Parameter        string `json:"parameter,omitempty"`
	Attempts         int    `json:"attempts,omitempty"`
	IsRetryExhausted bool   `json:"retry_exhausted,omitempty"`
}

type inferenceFailure struct {
	cause    error
	attempts int
}

func (failure *inferenceFailure) Error() string { return failure.cause.Error() }
func (failure *inferenceFailure) Unwrap() error { return failure.cause }

func describeRunFailure(err error) *RunFailure {
	failure := &RunFailure{Code: capability.ErrorCode(err)}
	switch err.Error() {
	case "gateway_unavailable", "gateway_auth_failed", "upstream_rejected", "upstream_rate_limited", "request_too_large", "context_length_exceeded", "model_not_found", "model_or_endpoint_missing", "unsupported_parameter", "invalid_gateway_response", "stream_incomplete", "unsupported_output", "invalid_image":
		failure.Code = err.Error()
	}
	var upstream *gateway.Error
	if errors.As(err, &upstream) {
		// Gateway codes are projected from a closed vocabulary; the body is never copied.
		failure.Code, failure.UpstreamStatus, failure.Parameter = upstream.Code, upstream.Status, upstream.Parameter
	}
	var inference *inferenceFailure
	if errors.As(err, &inference) {
		failure.Attempts = inference.attempts
		failure.IsRetryExhausted = inference.attempts == UPSTREAM_RETRIES+1
	}
	return failure
}

// isTerminalFailure reports whether another attempt could reach a different answer. The gateway's
// generic `upstream_rejected` names no cause of its own: a 4xx status is the provider refusing this
// request, while a 5xx is an outage another attempt can outlast.
func isTerminalFailure(failure *RunFailure) bool {
	if NON_RETRYABLE_FAILURES[failure.Code] {
		return true
	}
	return failure.Code == "upstream_rejected" && failure.UpstreamStatus >= 400 && failure.UpstreamStatus < 500
}

func (r *Runtime) streamWithRetries(ctx context.Context, clients map[string]ModelClient, conversation *Conversation, turn *Turn, messages []gateway.AgentMessage, tools []gateway.AgentTool, emit func(Event) error) (gateway.AgentReply, error) {
	delay := r.RetryDelay
	if delay <= 0 {
		delay = 250 * time.Millisecond
	}
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return gateway.AgentReply{}, err
		}
		savedReply := turn.Reply
		savedParts := append([]Part{}, turn.Parts...)
		client, err := r.modelClient(ctx, clients, conversation.Fingerprint)
		var reply gateway.AgentReply
		var emissionErr error
		if err == nil {
			isNewPart, isFirstText := true, true
			reply, err = client.StreamAgent(ctx, conversation.Model, conversation.ReasoningEffort, messages, tools, func(event gateway.Event) error {
				kind := "text"
				if event.Type == "thought" {
					kind = "thought"
				} else {
					if isFirstText && turn.Reply != "" {
						turn.Reply += "\n\n"
					}
					isFirstText = false
					turn.Reply += event.Content
				}
				turn.appendPart(kind, event.Content, isNewPart)
				isNewPart = false
				emissionErr = emit(Event{Type: kind, Content: event.Content, Round: turn.Rounds})
				return emissionErr
			})
		}
		if reply.Usage != nil {
			if turn.Usage == nil {
				turn.Usage = &Usage{}
			}
			turn.Usage.add(reply.Usage)
		}
		if err == nil {
			return reply, nil
		}
		if emissionErr != nil {
			return reply, emissionErr
		}
		if ctx.Err() != nil {
			return reply, ctx.Err()
		}
		if errors.Is(err, context.Canceled) {
			return reply, err
		}
		failure := describeRunFailure(err)
		if isTerminalFailure(failure) {
			return reply, &inferenceFailure{cause: err, attempts: attempt + 1}
		}
		if attempt == UPSTREAM_RETRIES {
			return reply, &inferenceFailure{cause: err, attempts: attempt + 1}
		}
		turn.Reply, turn.Parts = savedReply, savedParts
		if err := emit(Event{Type: "retry", Round: turn.Rounds, Failure: failure, Attempt: attempt + 1, Conversation: conversation}); err != nil {
			return reply, err
		}
		timer := time.NewTimer(delay << attempt)
		select {
		case <-ctx.Done():
			timer.Stop()
			return reply, ctx.Err()
		case <-timer.C:
		}
	}
}
