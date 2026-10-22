package usage

import (
	"fmt"
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
