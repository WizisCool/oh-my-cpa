package usage

import (
	"encoding/json"
	"math"
)

// TokenBreakdown is CPA's v2 partition. Its buckets are disjoint; vendor counts
// are not, so they remain beside it rather than being relabelled as a partition.
type TokenBreakdown struct {
	SchemaVersion      int                  `json:"schema_version"`
	Quality            string               `json:"quality"`
	TotalTokens        int64                `json:"total_tokens"`
	Input              TokenInputBreakdown  `json:"input"`
	Output             TokenOutputBreakdown `json:"output"`
	UnclassifiedTokens int64                `json:"unclassified_tokens"`
}

type TokenInputBreakdown struct {
	TotalTokens      int64 `json:"total_tokens"`
	UncachedTokens   int64 `json:"uncached_tokens"`
	CacheReadTokens  int64 `json:"cache_read_tokens"`
	CacheWriteTokens int64 `json:"cache_write_tokens"`
}

type TokenOutputBreakdown struct {
	TotalTokens        int64 `json:"total_tokens"`
	NonReasoningTokens int64 `json:"non_reasoning_tokens"`
	ReasoningTokens    int64 `json:"reasoning_tokens"`
}

// TokenAccounting keeps only allowlisted, non-secret accounting evidence. A nil
// value means legacy counts with no canonical evidence, including old records.
type TokenAccounting struct {
	Version   int             `json:"version"`
	Status    string          `json:"status"`
	RawTokens TokenStats      `json:"raw_tokens"`
	Breakdown *TokenBreakdown `json:"token_breakdown,omitempty"`
}

func decodeTokenAccounting(version, encoded json.RawMessage, raw TokenStats) *TokenAccounting {
	if len(version) == 0 && len(encoded) == 0 {
		return nil
	}
	accounting := &TokenAccounting{Status: "invalid", RawTokens: raw}
	if len(version) == 0 || json.Unmarshal(version, &accounting.Version) != nil {
		return accounting
	}
	var breakdown TokenBreakdown
	if len(encoded) == 0 || string(encoded) == "null" || json.Unmarshal(encoded, &breakdown) != nil {
		return accounting
	}
	// Future or malformed quality values are not an arbitrary string export path.
	switch breakdown.Quality {
	case "complete", "inconsistent", "unclassified":
	default:
		breakdown.Quality = ""
	}
	accounting.Breakdown = &breakdown
	if accounting.Version != 2 || breakdown.SchemaVersion != 2 {
		accounting.Status = "unsupported"
		return accounting
	}
	if !hasAccountingFields(encoded) || !breakdown.isValid() {
		return accounting
	}
	accounting.Status = breakdown.Quality
	if accounting.Status == "complete" && !breakdown.matchesRaw(raw) {
		accounting.Status = "invalid"
	}
	return accounting
}

func (b TokenBreakdown) isValid() bool {
	return b.SchemaVersion == 2 &&
		(b.Quality == "complete" || b.Quality == "inconsistent" || b.Quality == "unclassified") &&
		isTokenSum(b.Input.TotalTokens, b.Input.UncachedTokens, b.Input.CacheReadTokens, b.Input.CacheWriteTokens) &&
		isTokenSum(b.Output.TotalTokens, b.Output.NonReasoningTokens, b.Output.ReasoningTokens) &&
		isTokenSum(b.TotalTokens, b.Input.TotalTokens, b.Output.TotalTokens, b.UnclassifiedTokens) &&
		(b.Quality != "complete" || b.UnclassifiedTokens == 0)
}

func isTokenSum(total int64, parts ...int64) bool {
	if total < 0 {
		return false
	}
	var sum int64
	for _, part := range parts {
		if part < 0 || part > math.MaxInt64-sum {
			return false
		}
		sum += part
	}
	return sum == total
}

// Zero is meaningful in every bucket. Requiring presence prevents an omitted
// field from masquerading as a known zero in a supposedly complete partition.
func hasAccountingFields(encoded json.RawMessage) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(encoded, &fields) != nil {
		return false
	}
	hasFields := func(values map[string]json.RawMessage, names ...string) bool {
		for _, name := range names {
			value, ok := values[name]
			if !ok || string(value) == "null" {
				return false
			}
		}
		return true
	}
	if !hasFields(fields, "schema_version", "quality", "total_tokens", "input", "output", "unclassified_tokens") {
		return false
	}
	var input, output map[string]json.RawMessage
	if json.Unmarshal(fields["input"], &input) != nil || json.Unmarshal(fields["output"], &output) != nil {
		return false
	}
	return hasFields(input, "total_tokens", "uncached_tokens", "cache_read_tokens", "cache_write_tokens") &&
		hasFields(output, "total_tokens", "non_reasoning_tokens", "reasoning_tokens")
}

// CPA emits both subset and independent vendor dialects. The canonical input
// may include cache buckets and its output may include reasoning, but unrelated
// raw counts cannot corroborate a complete partition.
func (b TokenBreakdown) matchesRaw(raw TokenStats) bool {
	if raw.InputTokens < 0 || raw.OutputTokens < 0 || raw.ReasoningTokens < 0 || raw.CachedTokens < 0 || raw.CacheReadTokens < 0 || raw.CacheCreationTokens < 0 || raw.TotalTokens < 0 {
		return false
	}
	return (raw.TotalTokens == 0 || raw.TotalTokens == b.TotalTokens) &&
		(raw.InputTokens == b.Input.TotalTokens || raw.InputTokens == b.Input.UncachedTokens) &&
		(raw.OutputTokens == b.Output.TotalTokens || raw.OutputTokens == b.Output.NonReasoningTokens) &&
		raw.ReasoningTokens == b.Output.ReasoningTokens &&
		(!(raw.CacheReadTokensPresent || raw.CacheReadTokens != 0) || raw.CacheReadTokens == b.Input.CacheReadTokens) &&
		raw.CacheCreationTokens == b.Input.CacheWriteTokens
}
