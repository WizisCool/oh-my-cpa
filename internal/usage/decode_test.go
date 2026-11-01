package usage

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

// Decoded rows are asserted whole by the golden cases under testdata/golden/; the
// tests here hold the claims a fixed record cannot: classification of control
// traffic and the bounds on generated, oversized input.

func TestClassifyPassesRealUsageRecords(t *testing.T) {
	raw := `{"request_id":"abc","model":"gemini-2.5-pro","tokens":{"total_tokens":7}}`
	if got := Classify(raw); got.IsControl {
		t.Fatalf("real record classified as control: %+v", got)
	}
	// Whitespace and key order must not defeat the fast path.
	if got := Classify(`  { "tokens" : {} , "request_id" : "x" } `); got.IsControl {
		t.Fatalf("spaced real record classified as control: %+v", got)
	}
}

func TestClassifyRecognisesControlMessages(t *testing.T) {
	cases := []struct {
		raw            string
		supportRefresh bool
		refresh        bool
	}{
		{`{"support_refresh":true}`, true, false},
		{`{"refresh":true}`, true, true},
		{`  {"refresh" : true }  `, true, true},
	}
	for _, entry := range cases {
		got := Classify(entry.raw)
		if !got.IsControl || got.SupportRefresh != entry.supportRefresh || got.Refresh != entry.refresh {
			t.Fatalf("Classify(%q) = %+v, want control support=%v refresh=%v",
				entry.raw, got, entry.supportRefresh, entry.refresh)
		}
	}
}

func TestClassifyRejectsLooseControlLookalikes(t *testing.T) {
	for _, raw := range []string{
		`{"refresh":false}`,
		`{"refresh":"true"}`,
		`{"refresh":true,"extra":1}`,
		`{"unknown":true}`,
		`[]`,
		`{"refresh":true} trailing`,
		`not json`,
	} {
		if got := Classify(raw); got.IsControl {
			t.Fatalf("Classify(%q) reported control, want passthrough", raw)
		}
	}
}

func TestDecodeEventBoundsFailureBody(t *testing.T) {
	body := strings.Repeat("x", MaxFailBodyRunes+500)
	event, err := DecodeEvent(`{"request_id":"req-big","failed":true,"fail":{"status_code":999,"body":"`+body+`"}}`, "default", time.Now())
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := len([]rune(event.FailBody)); got != MaxFailBodyRunes {
		t.Fatalf("fail body length = %d, want %d", got, MaxFailBodyRunes)
	}
	if event.FailStatusCode != 0 {
		t.Fatalf("out-of-range status kept: %d", event.FailStatusCode)
	}
}

func TestFilterResponseHeadersBoundsTheSnapshot(t *testing.T) {
	crowded := map[string][]string{}
	for index := 0; index < MaxResponseHeaders+20; index++ {
		crowded[fmt.Sprintf("x-diagnostic-%03d", index)] = []string{strings.Repeat("v", MaxResponseHeaderValueRunes+50)}
	}
	bounded := FilterResponseHeaders(crowded)
	if len(bounded) != MaxResponseHeaders || len([]rune(bounded[0].Value)) != MaxResponseHeaderValueRunes {
		t.Fatalf("bounds not applied: %d headers, value %d runes", len(bounded), len([]rune(bounded[0].Value)))
	}
}

func TestStructuredUsageBoundsAndInvalidCounters(t *testing.T) {
	counters := map[string]int64{"negative": -1, "image_search_calls": 0, "tool_use_prompt_tokens": 2, "google_maps_chunks": 1}
	for index := 0; index < 25; index++ {
		counters[fmt.Sprintf("tool-%02d", index)] = int64(index)
	}
	counters[strings.Repeat("界", 100)] = 0
	iterations := make([]IterationUsageDetails, MaxStructuredUsageIterations+5)
	negative, zero := int64(-1), int64(0)
	infinity := math.Inf(1)
	source := &StructuredUsageDetails{
		Speed:             strings.Repeat("界", MaxStructuredUsageStringRunes+10),
		WebSearchRequests: &zero,
		ToolUsageDetails:  &ToolUsageDetails{Extra: counters, WebFetchCalls: &negative},
		MediaCounts:       &MediaUsageCounts{AudioSeconds: &infinity},
		Iterations:        iterations,
	}
	got := SanitizeStructuredUsage(source)
	if got == nil || !got.IsPartial || len([]rune(got.Speed)) != MaxStructuredUsageStringRunes ||
		len(got.Iterations) != MaxStructuredUsageIterations || len(got.ToolUsageDetails.Extra) != 3 ||
		got.ToolUsageDetails.WebFetchCalls != nil || got.MediaCounts != nil || got.WebSearchRequests == nil || *got.WebSearchRequests != 0 {
		t.Fatalf("bounded evidence = %+v", got)
	}
	if _, err := json.Marshal(got); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(got)
	again, _ := json.Marshal(SanitizeStructuredUsage(source))
	if string(encoded) != string(again) {
		t.Fatal("bounded counter selection is not deterministic")
	}
	if source.ToolUsageDetails.WebFetchCalls == nil || len(source.ToolUsageDetails.Extra) != len(counters) || source.MediaCounts.AudioSeconds == nil {
		t.Fatal("sanitization mutated the supplied evidence")
	}
	if _, ok := got.ToolUsageDetails.Extra["image_search_calls"]; !ok {
		t.Fatal("lost known zero-valued extra counter")
	}
	large := &StructuredUsageDetails{}
	for index := 0; index < MaxStructuredUsageIterations; index++ {
		text := strings.Repeat("\x00", MaxStructuredUsageStringRunes)
		large.Iterations = append(large.Iterations, IterationUsageDetails{
			Type: text, Model: text,
			CacheCreation: &CacheUsageDetails{Mode: text, TTL: text, Retention: text, ByTTL: map[string]int64{"5m": math.MaxInt64}},
		})
	}
	bounded := SanitizeStructuredUsage(large)
	encoded, err := json.Marshal(bounded)
	if err != nil || len(encoded) > MaxStructuredUsageBytes || !bounded.IsPartial || len(bounded.Iterations) == 0 {
		t.Fatalf("overall capture budget: %d bytes, %+v, %v", len(encoded), bounded, err)
	}
	invalidDuration := -1.0
	withoutDuration := SanitizeStructuredUsage(&StructuredUsageDetails{MediaCounts: &MediaUsageCounts{AudioSeconds: &invalidDuration}})
	if withoutDuration == nil || !withoutDuration.IsPartial || withoutDuration.MediaCounts != nil {
		t.Fatal("retained a negative media duration")
	}
	sensitive := SanitizeStructuredUsage(&StructuredUsageDetails{InferenceGeo: "Bearer abcdefghijklmnopqrstuvwxyz0123456789"})
	if strings.Contains(sensitive.InferenceGeo, "abcdefghijklmnopqrstuvwxyz0123456789") {
		t.Fatal("kept sensitive metadata")
	}
}
