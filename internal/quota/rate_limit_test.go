package quota

import (
	"net/http"
	"testing"
	"time"
)

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 23, 14, 30, 0, 0, time.UTC)
	for name, test := range map[string]struct {
		header map[string][]string
		want   time.Duration
	}{
		"delta seconds":             {map[string][]string{"Retry-After": {"30"}}, 30 * time.Second},
		"key casing from the relay": {map[string][]string{"retry-after": {"45"}}, 45 * time.Second},
		"HTTP date":                 {map[string][]string{"Retry-After": {now.Add(2 * time.Minute).Format(http.TimeFormat)}}, 2 * time.Minute},
		"HTTP date already passed":  {map[string][]string{"Retry-After": {now.Add(-time.Minute).Format(http.TimeFormat)}}, 0},
		"clamped":                   {map[string][]string{"Retry-After": {"86400"}}, RETRY_AFTER_MAX},
		"missing":                   {map[string][]string{"Content-Type": {"application/json"}}, 0},
		"malformed":                 {map[string][]string{"Retry-After": {"soon"}}, 0},
		"negative":                  {map[string][]string{"Retry-After": {"-5"}}, 0},
	} {
		if got := ParseRetryAfter(test.header, now); got != test.want {
			t.Errorf("%s: ParseRetryAfter = %s, want %s", name, got, test.want)
		}
	}
}
