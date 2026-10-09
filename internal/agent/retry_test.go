package agent

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

func TestInferenceRetriesArePerRequestAndDoNotExecuteFailedCalls(t *testing.T) {
	for _, failures := range []int{1, 3, 4} {
		t.Run(string(rune('0'+failures)), func(t *testing.T) {
			runtime := newTestRuntime(t)
			runtime.RetryDelay = time.Nanosecond
			attempts, retries := 0, 0
			runtime.Client = func(context.Context, string) (ModelClient, error) {
				return modelFunc(func(_ context.Context, _ string, messages []gateway.AgentMessage, _ []gateway.AgentTool, emit func(gateway.Event) error) (gateway.AgentReply, error) {
					attempts++
					if len(messages) != 2 || messages[1].Content != "investigate" {
						t.Fatalf("retry changed request: %+v", messages)
					}
					if attempts <= failures {
						if err := emit(gateway.Event{Type: "delta", Content: "discarded partial"}); err != nil {
							return gateway.AgentReply{}, err
						}
						return gateway.AgentReply{Calls: []gateway.ToolCall{{ID: "never-execute", Type: "function", Function: gateway.ToolFunction{Name: "missing", Arguments: "{}"}}}}, &gateway.Error{Code: "upstream_rate_limited", Status: 429, Parameter: "model"}
					}
					if err := emit(gateway.Event{Type: "delta", Content: "Complete"}); err != nil {
						return gateway.AgentReply{}, err
					}
					return gateway.AgentReply{Content: "Complete"}, nil
				}), nil
			}
			var final *Conversation
			err := runtime.Run(context.Background(), Input{Message: "investigate", Model: "fixture", Fingerprint: "key"}, func(event Event) error {
				if event.Type == "retry" {
					retries++
					if event.Attempt != retries || event.Conversation.Turns[0].Reply != "" {
						t.Fatalf("retry checkpoint: %+v", event)
					}
				}
				if event.Type == "finished" {
					final = event.Conversation
				}
				return nil
			})
			if err != nil || final == nil {
				t.Fatalf("run %v", err)
			}
			turn := final.Turns[0]
			if attempts != min(failures+1, 4) || retries != min(failures, 3) || turn.Rounds != 1 || len(turn.Traces) != 0 || len(runtime.Slots) != 0 {
				t.Fatalf("attempts=%d retries=%d turn=%+v", attempts, retries, turn)
			}
			if failures < 4 {
				if turn.Status != "success" || turn.Reply != "Complete" || turn.Failure != nil {
					t.Fatalf("recovered %+v", turn)
				}
			} else {
				if turn.Status != "error" || turn.Code != "upstream_rate_limited" || turn.Failure.UpstreamStatus != 429 || turn.Failure.Parameter != "model" || turn.Failure.Attempts != 4 || !turn.Failure.IsRetryExhausted {
					t.Fatalf("failure %+v", turn)
				}
				stored, err := runtime.Current(context.Background())
				if err != nil || !reflect.DeepEqual(stored.Turns[0].Failure, turn.Failure) {
					t.Fatalf("stored failure %+v %v", stored, err)
				}
			}
		})
	}
}

// A refusal the identical request reaches again is reported on its first attempt: retrying it
// would only spend more paid generations, and the operator waits through the backoff for nothing.
func TestDeterministicFailuresAreTerminalWithoutRetries(t *testing.T) {
	cases := []struct {
		name      string
		failure   *gateway.Error
		code      string
		status    int
		parameter string
	}{
		{name: "context overflow", failure: &gateway.Error{Code: "context_length_exceeded", Status: 400, Parameter: "messages"}, code: "context_length_exceeded", status: 400, parameter: "messages"},
		{name: "answer cut short", failure: &gateway.Error{Code: "unsupported_output"}, code: "unsupported_output"},
		{name: "unclassified 4xx", failure: &gateway.Error{Code: "upstream_rejected", Status: 400}, code: "upstream_rejected", status: 400},
		{name: "stream refusal", failure: &gateway.Error{Code: "upstream_stream_rejected"}, code: "upstream_stream_rejected"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := newTestRuntime(t)
			calls := 0
			runtime.Client = func(context.Context, string) (ModelClient, error) {
				return modelFunc(func(context.Context, string, []gateway.AgentMessage, []gateway.AgentTool, func(gateway.Event) error) (gateway.AgentReply, error) {
					calls++
					return gateway.AgentReply{}, testCase.failure
				}), nil
			}
			var final *Conversation
			if err := runtime.Run(context.Background(), Input{Message: "question", Model: "fixture", Fingerprint: "key"}, func(event Event) error {
				if event.Type == "retry" {
					t.Fatalf("%s retried", testCase.name)
				}
				if event.Type == "finished" {
					final = event.Conversation
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			failure := final.Turns[0].Failure
			if calls != 1 || final.Turns[0].Code != testCase.code || failure.IsRetryExhausted || failure.Attempts != 1 || failure.UpstreamStatus != testCase.status || failure.Parameter != testCase.parameter {
				t.Fatalf("%s: %+v calls %d", testCase.name, failure, calls)
			}
		})
	}
}

// An unclassified 5xx is an outage, not a verdict on the request: the same send can succeed once
// the upstream recovers, so it keeps its retries.
func TestUnclassifiedServerFailureIsRetried(t *testing.T) {
	runtime := newTestRuntime(t)
	runtime.RetryDelay = time.Nanosecond
	calls, retries := 0, 0
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(_ context.Context, _ string, _ []gateway.AgentMessage, _ []gateway.AgentTool, emit func(gateway.Event) error) (gateway.AgentReply, error) {
			calls++
			if calls == 1 {
				return gateway.AgentReply{}, &gateway.Error{Code: "upstream_rejected", Status: 502}
			}
			if err := emit(gateway.Event{Type: "delta", Content: "Complete"}); err != nil {
				return gateway.AgentReply{}, err
			}
			return gateway.AgentReply{Content: "Complete"}, nil
		}), nil
	}
	var final *Conversation
	if err := runtime.Run(context.Background(), Input{Message: "question", Model: "fixture", Fingerprint: "key"}, func(event Event) error {
		if event.Type == "retry" {
			retries++
			if event.Failure.Code != "upstream_rejected" || event.Failure.UpstreamStatus != 502 {
				t.Fatalf("retry failure %+v", event.Failure)
			}
		}
		if event.Type == "finished" {
			final = event.Conversation
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if calls != 2 || retries != 1 || final.Turns[0].Status != "success" || final.Turns[0].Reply != "Complete" {
		t.Fatalf("outage calls=%d retries=%d turn=%+v", calls, retries, final.Turns[0])
	}
}

func TestRetryBackoffHonoursCancellationAndEmissionFailure(t *testing.T) {
	for _, isEmissionFailure := range []bool{false, true} {
		runtime := newTestRuntime(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		calls := 0
		runtime.Client = func(context.Context, string) (ModelClient, error) {
			return modelFunc(func(context.Context, string, []gateway.AgentMessage, []gateway.AgentTool, func(gateway.Event) error) (gateway.AgentReply, error) {
				calls++
				return gateway.AgentReply{}, &gateway.Error{Code: "gateway_unavailable"}
			}), nil
		}
		emitErr := errors.New("transport failed")
		err := runtime.Run(ctx, Input{Message: "question", Model: "fixture", Fingerprint: "key"}, func(event Event) error {
			if event.Type == "retry" {
				if isEmissionFailure {
					return emitErr
				}
				cancel()
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		stored, err := runtime.Current(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		expected := "cancelled"
		if isEmissionFailure {
			expected = "operation_failed"
		}
		if calls != 1 || stored.Turns[0].Code != expected || len(runtime.Slots) != 0 {
			t.Fatalf("calls %d turn %+v", calls, stored.Turns[0])
		}
	}
}

func TestFingerprintResolutionIsRetriedAndDiagnosticsAreAllowlisted(t *testing.T) {
	runtime := newTestRuntime(t)
	runtime.RetryDelay = time.Nanosecond
	resolutions := 0
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		resolutions++
		if resolutions < 4 {
			return nil, &gateway.Error{Code: "gateway_unavailable"}
		}
		return modelFunc(func(context.Context, string, []gateway.AgentMessage, []gateway.AgentTool, func(gateway.Event) error) (gateway.AgentReply, error) {
			return gateway.AgentReply{Content: "done"}, nil
		}), nil
	}
	if err := runtime.Run(context.Background(), Input{Message: "question", Model: "fixture", Fingerprint: "key"}, func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if resolutions != 4 {
		t.Fatalf("resolutions %d", resolutions)
	}
	encoded, _ := json.Marshal(describeRunFailure(errors.New("secret request body")))
	if string(encoded) != `{"code":"operation_failed"}` {
		t.Fatalf("leaked %s", encoded)
	}
}
