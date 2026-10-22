package quota

import (
	"encoding/json"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/testkit"
)

// Each upstream parser is tested by its whole normalized output: a case is an input file
// under testdata/golden/<parser>/ and the golden file beside it. A new provider shape or
// boundary is a new pair of files, not a new test function.
func TestParsersMatchGoldenFiles(t *testing.T) {
	testkit.PinUTC(t)
	for name, parse := range map[string]func(t *testing.T, input testkit.Case) any{
		"codex": func(t *testing.T, input testkit.Case) any {
			plan, windows, credits, err := ParseCodexUsage(input.Body, input.NowMS)
			return goldenReading{Plan: plan, Windows: windows, ResetCredits: credits, Error: errorText(err)}
		},
		"codex-reset-credits": func(t *testing.T, input testkit.Case) any {
			credits, err := ParseCodexResetCreditsPayload(input.Body)
			return goldenReading{ResetCredits: credits, Error: errorText(err)}
		},
		"codex-subscription": func(t *testing.T, input testkit.Case) any {
			untilMS, shouldRenew, isRead := ParseCodexSubscription(input.Body)
			return map[string]any{"until_ms": untilMS, "should_renew": shouldRenew, "is_read": isRead}
		},
		"claude": func(t *testing.T, input testkit.Case) any {
			windows, extraUsage, err := ParseClaudeUsage(input.Body, input.NowMS)
			reading := goldenReading{
				Plan:        ParseClaudeProfile(input.Body),
				Windows:     windows,
				ExtraUsage:  extraUsage,
				Balances:    ParseClaudeBalances(input.Body),
				ResetGrants: ParseClaudeResetGrants(input.Body),
				Error:       errorText(err),
			}
			return reading.evaluated(input.NowMS)
		},
		"kimi": func(t *testing.T, input testkit.Case) any {
			windows, err := ParseKimiUsage(input.Body, input.NowMS)
			return goldenReading{Windows: windows, Error: errorText(err)}
		},
		"xai": func(t *testing.T, input testkit.Case) any {
			var documents struct {
				Credits json.RawMessage `json:"credits"`
				Monthly json.RawMessage `json:"monthly"`
			}
			if err := json.Unmarshal(input.Body, &documents); err != nil {
				t.Fatalf("decode the two billing documents: %v", err)
			}
			plan, windows, err := ParseXaiBillingDocuments(nonNull(documents.Credits), nonNull(documents.Monthly), input.NowMS)
			return goldenReading{Plan: plan, Windows: windows, Error: errorText(err)}.evaluated(input.NowMS)
		},
		"devin": func(t *testing.T, input testkit.Case) any {
			plan, windows, err := ParseDevinSeatStatus(input.Body, input.NowMS)
			return goldenReading{Plan: plan, Windows: windows, Error: errorText(err)}
		},
		"meta": func(t *testing.T, input testkit.Case) any {
			plan, windows, err := ParseMetaUsage(input.Body, input.NowMS)
			return goldenReading{Plan: plan, Windows: windows, Error: errorText(err)}
		},
		"antigravity": func(t *testing.T, input testkit.Case) any {
			windows, err := ParseAntigravityUsage(input.Body, input.NowMS, 0)
			return goldenReading{Windows: windows, Error: errorText(err)}
		},
	} {
		t.Run(name, func(t *testing.T) {
			testkit.Cases(t, "testdata/golden/"+name, parse)
		})
	}
}

// goldenReading is what a parser case records: every part of a reading the parser can
// produce, and the status the reading evaluates to where that is the claim.
type goldenReading struct {
	Plan         *QuotaPlan             `json:"plan,omitempty"`
	Windows      []QuotaWindow          `json:"windows,omitempty"`
	ExtraUsage   *QuotaExtraUsage       `json:"extra_usage,omitempty"`
	Balances     []QuotaBalance         `json:"balances,omitempty"`
	ResetGrants  []ClaudeResetGrant     `json:"reset_grants,omitempty"`
	ResetCredits *CodexResetCreditsInfo `json:"reset_credits,omitempty"`
	Status       string                 `json:"status,omitempty"`
	Error        string                 `json:"error,omitempty"`
}

func (reading goldenReading) evaluated(nowMS int64) goldenReading {
	if reading.Error != "" {
		return reading
	}
	normalized := &NormalizedQuota{Plan: reading.Plan, Windows: reading.Windows}
	EvaluateStatusAndRecommendation(normalized, nowMS)
	reading.Status = normalized.Status
	return reading
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func nonNull(raw json.RawMessage) []byte {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return raw
}
