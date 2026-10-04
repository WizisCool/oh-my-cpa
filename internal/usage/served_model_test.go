package usage

import (
	"testing"
	"time"
)

func TestIsModelSubstituted(t *testing.T) {
	cases := []struct {
		name      string
		requested string
		served    string
		want      bool
	}{
		{"identical", "gpt-5", "gpt-5", false},
		{"case differs", "GPT-5", "gpt-5", false},
		{"dated snapshot", "gpt-5", "gpt-5-2026-08-07", false},
		{"compact date snapshot", "claude-sonnet-5", "claude-sonnet-5-20260514", false},
		{"snapshot requested, alias served", "gpt-5-2026-08-07", "gpt-5", false},
		{"build number", "gemini-3-pro", "gemini-3-pro-002", false},
		{"latest alias", "grok-5-latest", "grok-5", false},
		{"provider prefix", "openai/gpt-5", "gpt-5", false},
		{"prefixed latest to snapshot", "anthropic/claude-opus-5-latest", "claude-opus-5-20260301", false},
		{"thinking suffix", "gpt-5(high)", "gpt-5", false},
		{"unknown served", "gpt-5", "", false},
		{"unknown requested", "", "gpt-5", false},
		{"smaller sibling", "gpt-5", "gpt-5-mini", true},
		{"different family", "gpt-5", "gpt-4o", true},
		{"suffix is not a release", "gpt-5", "gpt-5-codex", true},
		{"four digit suffix is not a build", "gemini-3-pro", "gemini-3-pro-2026", true},
	}
	for _, testCase := range cases {
		if got := IsModelSubstituted(testCase.requested, testCase.served); got != testCase.want {
			t.Errorf("%s: IsModelSubstituted(%q, %q) = %v, want %v",
				testCase.name, testCase.requested, testCase.served, got, testCase.want)
		}
	}
}

func TestDecodeEventRecordsServedModel(t *testing.T) {
	observedAt := time.UnixMilli(1_700_000_000_000)
	cases := []struct {
		name            string
		fields          string
		wantServed      string
		wantSubstituted bool
	}{
		{"absent", `"model":"gpt-5","alias":"gpt-5"`, "", false},
		{"served as requested", `"model":"gpt-5","alias":"gpt-5","response_model":"gpt-5-2026-08-07"`, "gpt-5-2026-08-07", false},
		{"substituted", `"model":"gpt-5","alias":"gpt-5","response_model":" gpt-5-mini "`, "gpt-5-mini", true},
		{"upstream echoes the client alias", `"model":"gpt-5","alias":"team-default","response_model":"team-default"`, "team-default", false},
		{"matches neither name", `"model":"gpt-5","alias":"team-default","response_model":"gpt-4o"`, "gpt-4o", true},
	}
	for _, testCase := range cases {
		event, err := DecodeEvent(`{"request_id":"req-1",`+testCase.fields+`}`, "instance", observedAt)
		if err != nil {
			t.Fatalf("%s: decode: %v", testCase.name, err)
		}
		if event.ResponseModel != testCase.wantServed || event.ModelSubstituted != testCase.wantSubstituted {
			t.Errorf("%s: served = %q substituted = %v, want %q / %v",
				testCase.name, event.ResponseModel, event.ModelSubstituted, testCase.wantServed, testCase.wantSubstituted)
		}
	}
}
