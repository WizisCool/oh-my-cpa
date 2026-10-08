package quota

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// A successful dedicated zero is evidence, not a missing reading. Reuse the
// existing CPA mock so this desired-invariant experiment never opens a socket.
func TestCodexDedicatedZeroCreditsOverrideUsageFallback(t *testing.T) {
	const authIndex = "fixture-codex-credits"
	cases := []struct {
		name         string
		body         string
		statusCode   int
		usageCredits *CodexResetCreditsInfo
		wantCount    int
	}{
		{name: "dedicated_zero_over_stale_positive", body: `{"available_count":0,"credits":[]}`, statusCode: http.StatusOK, usageCredits: &CodexResetCreditsInfo{AvailableCount: 5}, wantCount: 0},
		{name: "dedicated_positive_control", body: `{"available_count":2,"credits":[]}`, statusCode: http.StatusOK, usageCredits: &CodexResetCreditsInfo{AvailableCount: 5}, wantCount: 2},
		{name: "missing_count_fallback_control", body: `{}`, statusCode: http.StatusOK, usageCredits: &CodexResetCreditsInfo{AvailableCount: 5}, wantCount: 5},
		{name: "failed_endpoint_fallback_control", body: `{"message":"synthetic unavailable"}`, statusCode: http.StatusServiceUnavailable, usageCredits: &CodexResetCreditsInfo{AvailableCount: 5}, wantCount: 5},
		{name: "zero_without_usage_control", body: `{"available_count":0,"credits":[]}`, statusCode: http.StatusOK, wantCount: 0},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			callCount := 0
			client := &mockCPAClient{
				apiCallFunc: func(_ context.Context, request management.ApiCallRequest) (management.ApiCallResponse, error) {
					callCount++
					if request.AuthIndex != authIndex || request.Method != http.MethodGet || request.URL != CodexResetCreditsURL || request.Data != "" {
						t.Fatalf("unexpected synthetic CPA probe: auth_index=%q method=%q url=%q data=%q", request.AuthIndex, request.Method, request.URL, request.Data)
					}
					return management.ApiCallResponse{StatusCode: testCase.statusCode, Body: json.RawMessage(testCase.body)}, nil
				},
			}
			actual := NewService(client).fetchCodexResetCredits(context.Background(), management.AuthFile{AuthIndex: authIndex}, nil, testCase.usageCredits)
			t.Logf("SEC-08 body=%s status=%d usage=%+v actual=%+v mock_calls=%d", testCase.body, testCase.statusCode, testCase.usageCredits, actual, callCount)
			if callCount != 1 {
				t.Errorf("want exactly one mocked dedicated request, got %d", callCount)
			}
			if actual == nil {
				t.Fatal("desired invariant: merged credit summary must not be nil")
			}
			if actual.AvailableCount != testCase.wantCount {
				t.Errorf("desired invariant: authoritative explicit count takes precedence; want available_count=%d, got %d", testCase.wantCount, actual.AvailableCount)
			}
		})
	}
}

func TestDevinResetEpochOverflowRejected(t *testing.T) {
	const maxSafeSeconds int64 = math.MaxInt64 / 1000
	cases := []struct {
		name         string
		input        any
		shouldReject bool
		wantMS       int64
	}{
		{name: "ordinary_seconds_control", input: int64(1700000000), wantMS: 1700000000000},
		{name: "max_safe_seconds_control", input: maxSafeSeconds, wantMS: maxSafeSeconds * 1000},
		{name: "first_overflow_seconds", input: maxSafeSeconds + 1, shouldReject: true},
		{name: "max_int64_string", input: strconv.FormatInt(math.MaxInt64, 10), shouldReject: true},
		{name: "max_int64_json_number", input: json.Number(strconv.FormatInt(math.MaxInt64, 10)), shouldReject: true},
		{name: "zero_control", input: int64(0), shouldReject: true},
		{name: "negative_control", input: int64(-1), shouldReject: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			actualMS := devinUnixMS(testCase.input)
			actualText := "nil"
			if actualMS != nil {
				actualText = strconv.FormatInt(*actualMS, 10)
			}
			t.Logf("SEC-10 input_type=%T input=%v max_safe_seconds=%d actual_ms=%s", testCase.input, testCase.input, maxSafeSeconds, actualText)
			if testCase.shouldReject {
				if actualMS != nil {
					t.Errorf("desired invariant: nonpositive or overflowing seconds must be rejected, got milliseconds=%d", *actualMS)
				}
				return
			}
			if actualMS == nil || *actualMS != testCase.wantMS {
				t.Errorf("valid-seconds control: want milliseconds=%d, got %s", testCase.wantMS, actualText)
			}
		})
	}
}
