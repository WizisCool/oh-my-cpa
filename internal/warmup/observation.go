package warmup

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

func readFields(raw json.RawMessage) map[string]json.RawMessage {
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	return fields
}
func readNumber(raw json.RawMessage) *float64 {
	var number float64
	if json.Unmarshal(raw, &number) != nil {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return nil
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return nil
		}
		number = parsed
	}
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) || math.IsNaN(number) || math.IsInf(number, 0) {
		return nil
	}
	return &number
}
func readBoolean(raw json.RawMessage) *bool {
	var value bool
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) || json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return &value
}
func firstField(fields map[string]json.RawMessage, names ...string) json.RawMessage {
	for _, name := range names {
		if raw, ok := fields[name]; ok {
			return raw
		}
	}
	return nil
}

// Only a documented explicit null means an unused Claude window. Missing keys,
// malformed reads and a zero percentage with a future boundary remain distinct.
func ParseObservation(provider string, raw []byte, nowMS int64) Observation {
	fields := readFields(raw)
	observation := Observation{Provider: provider, ObservedAtMS: nowMS, PaidFallback: "unknown", FiveHour: Window{State: "unknown", PeriodMS: FIVE_HOUR_MS}, Weekly: Window{State: "unknown", PeriodMS: WEEK_MS}}
	if provider == "claude" {
		observation.PaidSource = "claude_usage.extra_usage.is_enabled"
		if enabled := readBoolean(readFields(fields["extra_usage"])["is_enabled"]); enabled != nil {
			observation.PaidFallback = "disabled"
			if *enabled {
				observation.PaidFallback = "enabled"
			}
		}
		observation.FiveHour = parseClaudeWindow(fields["five_hour"], FIVE_HOUR_MS, nowMS)
		observation.Weekly = parseClaudeWindow(fields["seven_day"], WEEK_MS, nowMS)
		observation.ModelWindows = map[string]Window{}
		for _, family := range []string{"sonnet", "opus"} {
			if raw, ok := fields["seven_day_"+family]; ok {
				observation.ModelWindows[family] = parseClaudeWindow(raw, WEEK_MS, nowMS)
			}
		}
		// A dollar-denominated iguana_necktie is the cloud session credit pool,
		// not the legacy Fable window; reading it as Fable would gate the model
		// on unrelated spend.
		if raw, ok := fields["iguana_necktie"]; ok && !isDollarDenominated(raw) {
			observation.ModelWindows["fable"] = parseClaudeWindow(raw, WEEK_MS, nowMS)
		}
		// Modern model-scoped limits supersede the legacy Fable window, including
		// malformed evidence: falling back could authorize an exhausted model.
		var modelLimits []json.RawMessage
		if rawLimits, hasLimits := fields["limits"]; hasLimits && (json.Unmarshal(rawLimits, &modelLimits) != nil || modelLimits == nil) {
			observation.ModelWindows["fable"] = Window{State: "unknown", PeriodMS: WEEK_MS}
		}
		for _, rawLimit := range modelLimits {
			limit := readFields(rawLimit)
			model := readFields(readFields(limit["scope"])["model"])
			var displayName string
			_ = json.Unmarshal(model["display_name"], &displayName)
			if strings.EqualFold(displayName, "fable") || strings.EqualFold(displayName, "fable 5") {
				window, _ := json.Marshal(map[string]json.RawMessage{"utilization": limit["percent"], "resets_at": limit["resets_at"]})
				observation.ModelWindows["fable"] = parseClaudeWindow(window, WEEK_MS, nowMS)
				break
			}
		}
		for _, name := range []string{"seven_day_oauth_apps"} {
			window := parseClaudeWindow(fields[name], WEEK_MS, nowMS)
			if window.UsedPercent != nil && *window.UsedPercent >= 100 {
				observation.IsBlocked = true
			}
		}
	} else if provider == "codex" {
		observation.PaidSource = "codex_usage.credits"
		credits := readFields(fields["credits"])
		hasCredits := readBoolean(firstField(credits, "has_credits", "hasCredits"))
		unlimited := readBoolean(credits["unlimited"])
		balance := readNumber(credits["balance"])
		if hasCredits != nil && unlimited != nil && balance != nil {
			observation.PaidFallback = "disabled"
			if *hasCredits || *unlimited || *balance > 0 {
				observation.PaidFallback = "enabled"
			}
		}
		limits := readFields(firstField(fields, "rate_limit", "rateLimit"))
		if allowed := readBoolean(limits["allowed"]); allowed != nil && !*allowed {
			observation.IsBlocked = true
		}
		if reached := readBoolean(firstField(limits, "limit_reached", "limitReached")); reached != nil && *reached {
			observation.IsBlocked = true
		}
		var additional []json.RawMessage
		_ = json.Unmarshal(firstField(fields, "additional_rate_limits", "additionalRateLimits"), &additional)
		for _, raw := range additional {
			record := readFields(raw)
			var name string
			_ = json.Unmarshal(firstField(record, "limit_name", "limitName", "metered_feature"), &name)
			limits := readFields(firstField(record, "rate_limit", "rateLimit"))
			allowed := readBoolean(limits["allowed"])
			reached := readBoolean(firstField(limits, "limit_reached", "limitReached"))
			if name != "" && len(name) <= 200 && len(observation.BlockedModels) < 64 && (allowed != nil && !*allowed || reached != nil && *reached) {
				observation.BlockedModels = append(observation.BlockedModels, strings.ToLower(name))
			}
		}
		for _, names := range [][]string{{"primary_window", "primaryWindow"}, {"secondary_window", "secondaryWindow"}} {
			window := parseCodexWindow(firstField(limits, names...), nowMS)
			if window.PeriodMS == FIVE_HOUR_MS {
				observation.FiveHour = window
			}
			if window.PeriodMS == WEEK_MS {
				observation.Weekly = window
			}
		}
	}
	return observation
}
func isDollarDenominated(raw json.RawMessage) bool {
	fields := readFields(raw)
	for _, name := range []string{"limit_dollars", "used_dollars", "remaining_dollars"} {
		if readNumber(fields[name]) != nil {
			return true
		}
	}
	return false
}
func parseClaudeWindow(raw json.RawMessage, periodMS, nowMS int64) Window {
	window := Window{State: "unknown", PeriodMS: periodMS}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		window.State = "idle"
		zero := float64(0)
		window.UsedPercent = &zero
		return window
	}
	fields := readFields(raw)
	window.UsedPercent = readNumber(fields["utilization"])
	var reset string
	if json.Unmarshal(fields["resets_at"], &reset) == nil && reset != "" {
		if instant, err := time.Parse(time.RFC3339Nano, reset); err == nil {
			epoch := instant.UnixMilli()
			window.ResetAtMS = &epoch
		}
	}
	if window.ResetAtMS == nil && !bytes.Equal(bytes.TrimSpace(fields["resets_at"]), []byte("null")) {
		return window
	}
	return classifyWindow(window, nowMS)
}
func parseCodexWindow(raw json.RawMessage, nowMS int64) Window {
	fields := readFields(raw)
	window := Window{State: "unknown"}
	period := readNumber(firstField(fields, "limit_window_seconds", "limitWindowSeconds"))
	if period == nil {
		return window
	}
	window.PeriodMS = int64(*period * 1000)
	window.UsedPercent = readNumber(firstField(fields, "used_percent", "usedPercent"))
	if reset := readNumber(firstField(fields, "reset_at", "resetAt")); reset != nil && *reset > 0 {
		epoch := int64(*reset)
		if epoch < 100000000000 {
			epoch *= 1000
		}
		window.ResetAtMS = &epoch
	} else if remaining := readNumber(firstField(fields, "reset_after_seconds", "resetAfterSeconds")); remaining != nil && *remaining > 0 {
		epoch := nowMS + int64(*remaining*1000)
		window.ResetAtMS = &epoch
	}
	if window.ResetAtMS == nil {
		rawReset := firstField(fields, "reset_at", "resetAt")
		rawAfter := firstField(fields, "reset_after_seconds", "resetAfterSeconds")
		resetNumber := readNumber(rawReset)
		afterNumber := readNumber(rawAfter)
		hasNoReset := bytes.Equal(bytes.TrimSpace(rawReset), []byte("null")) || resetNumber != nil && *resetNumber == 0 || afterNumber != nil && *afterNumber == 0
		if !hasNoReset {
			return window
		}
	}
	return classifyWindow(window, nowMS)
}
func classifyWindow(window Window, nowMS int64) Window {
	if window.UsedPercent == nil || *window.UsedPercent < 0 || *window.UsedPercent > 100 {
		return window
	}
	if window.ResetAtMS != nil && *window.ResetAtMS > nowMS {
		window.State = "active"
		return window
	}
	if *window.UsedPercent == 0 && window.ResetAtMS == nil {
		window.State = "idle"
	}
	// An expired observation with nonzero use cannot prove that the reset happened.
	return window
}
