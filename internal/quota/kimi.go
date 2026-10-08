package quota

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type RawKimiDetail struct {
	Used         any    `json:"used"`
	Limit        any    `json:"limit"`
	Remaining    any    `json:"remaining"`
	ResetAt      string `json:"reset_at"`
	ResetAtAlt   string `json:"resetAt"`
	ResetTime    string `json:"reset_time"`
	ResetTimeAlt string `json:"resetTime"`
	ResetIn      any    `json:"reset_in"`
	ResetInAlt   any    `json:"resetIn"`
	TTL          any    `json:"ttl"`
}

type RawKimiWindow struct {
	Duration    any    `json:"duration"`
	TimeUnit    string `json:"time_unit"`
	TimeUnitAlt string `json:"timeUnit"`
}

type RawKimiLimitItem struct {
	Name        string         `json:"name"`
	Title       string         `json:"title"`
	Scope       string         `json:"scope"`
	Used        any            `json:"used"`
	Limit       any            `json:"limit"`
	Duration    any            `json:"duration"`
	TimeUnit    string         `json:"timeUnit"`
	TimeUnitAlt string         `json:"time_unit"`
	ResetAt     string         `json:"resetAt"`
	ResetAtAlt  string         `json:"reset_at"`
	ResetIn     any            `json:"resetIn"`
	ResetInAlt  any            `json:"reset_in"`
	TTL         any            `json:"ttl"`
	Detail      *RawKimiDetail `json:"detail"`
	Window      *RawKimiWindow `json:"window"`
}

// RawKimiRatioPool is one window of the ratio-pool family Kimi publishes under `usages`.
//
// Pools report a share instead of absolute counts, and the family is open-ended: a plan
// publishes the durations it meters, and a plan without a weekly limit reports only its
// monthly Total pool. The keys are therefore read as a set rather than as named fields.
type RawKimiRatioPool struct {
	UsedRatio    any    `json:"used_ratio"`
	UsedRatioAlt any    `json:"usedRatio"`
	ResetTime    string `json:"reset_time"`
	ResetTimeAlt string `json:"resetTime"`
}

type RawKimiUsagePayload struct {
	Usage  *RawKimiLimitItem           `json:"usage"`
	Limits []RawKimiLimitItem          `json:"limits"`
	Usages map[string]RawKimiRatioPool `json:"usages"`
}

// ParseKimiUsage parses Kimi usage data into normalized quota windows.
func ParseKimiUsage(raw []byte, nowMS int64) ([]QuotaWindow, error) {
	var payload RawKimiUsagePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("invalid kimi payload: %w", err)
	}

	windows := make([]QuotaWindow, 0)

	items := payload.Limits
	if len(items) == 0 && payload.Usage != nil {
		items = []RawKimiLimitItem{*payload.Usage}
	}

	for i, item := range items {
		label := item.Title
		if label == "" {
			label = item.Name
		}
		if label == "" {
			label = fmt.Sprintf("限制项 %d", i+1)
		}

		rawUsed := item.Used
		rawLimit := item.Limit
		rawResetAt := item.ResetAt
		if rawResetAt == "" {
			rawResetAt = item.ResetAtAlt
		}
		rawResetIn := item.ResetIn
		if rawResetIn == nil {
			rawResetIn = item.ResetInAlt
		}
		rawTTL := item.TTL

		if item.Detail != nil {
			if rawUsed == nil {
				rawUsed = item.Detail.Used
			}
			if rawLimit == nil {
				rawLimit = item.Detail.Limit
			}
			if rawResetAt == "" {
				rawResetAt = item.Detail.ResetAt
				if rawResetAt == "" {
					rawResetAt = item.Detail.ResetAtAlt
				}
				if rawResetAt == "" {
					rawResetAt = item.Detail.ResetTime
				}
				if rawResetAt == "" {
					rawResetAt = item.Detail.ResetTimeAlt
				}
			}
			if rawResetIn == nil {
				rawResetIn = item.Detail.ResetIn
				if rawResetIn == nil {
					rawResetIn = item.Detail.ResetInAlt
				}
			}
			if rawTTL == nil {
				rawTTL = item.Detail.TTL
			}
		}

		rawDuration := item.Duration
		rawTimeUnit := item.TimeUnit
		if rawTimeUnit == "" {
			rawTimeUnit = item.TimeUnitAlt
		}
		if item.Window != nil {
			if rawDuration == nil {
				rawDuration = item.Window.Duration
			}
			if rawTimeUnit == "" {
				rawTimeUnit = item.Window.TimeUnit
				if rawTimeUnit == "" {
					rawTimeUnit = item.Window.TimeUnitAlt
				}
			}
		}

		usedVal, hasUsed := toFloat(rawUsed)
		limVal, hasLim := toFloat(rawLimit)

		var usedPercent *float64
		var remainingPercent *float64
		var usedPtr *float64
		var limitPtr *float64

		if hasUsed {
			usedPtr = &usedVal
		}
		if hasLim {
			limitPtr = &limVal
		}

		if hasUsed && hasLim && limVal > 0 {
			usedPct := clamp(usedVal/limVal*100, 0, 100)
			remainingPct := clamp(100-usedPct, 0, 100)
			usedPercent = &usedPct
			remainingPercent = &remainingPct
		} else if hasUsed && usedVal > 0 && (!hasLim || limVal == 0) {
			usedPct := 100.0
			remainingPct := 0.0
			usedPercent = &usedPct
			remainingPercent = &remainingPct
		}

		var resetAtMS *int64
		var resetLabel string
		if rawResetAt != "" {
			if t, err := time.Parse(time.RFC3339, rawResetAt); err == nil {
				ms := t.UnixMilli()
				resetAtMS = &ms
				resetLabel = formatResetInstant(ms, nowMS)
			} else if t, err := time.Parse(time.RFC3339Nano, rawResetAt); err == nil {
				ms := t.UnixMilli()
				resetAtMS = &ms
				resetLabel = formatResetInstant(ms, nowMS)
			}
		} else if rIn, ok := toFloat(rawResetIn); ok && rIn > 0 {
			ms := nowMS + int64(rIn*1000)
			resetAtMS = &ms
			resetLabel = formatResetInstant(ms, nowMS)
		} else if ttl, ok := toFloat(rawTTL); ok && ttl > 0 {
			ms := nowMS + int64(ttl*1000)
			resetAtMS = &ms
			resetLabel = formatResetInstant(ms, nowMS)
		}

		var periodHours *float64
		if dur, ok := toFloat(rawDuration); ok && dur > 0 {
			tu := strings.ToUpper(strings.TrimSpace(rawTimeUnit))
			tu = strings.TrimPrefix(tu, "TIME_UNIT_")
			switch tu {
			case "HOURS", "HOUR", "H":
				periodHours = &dur
			case "DAYS", "DAY", "D":
				h := dur * 24
				periodHours = &h
			case "MINUTES", "MINUTE", "M":
				h := dur / 60
				periodHours = &h
			case "WEEKS", "WEEK", "W":
				h := dur * 168
				periodHours = &h
			}
		}

		scope := "standard"
		if item.Scope != "" {
			scope = "model"
		}

		windows = append(windows, QuotaWindow{
			ID:               fmt.Sprintf("kimi_%d", i),
			Label:            label,
			Kind:             "custom",
			Scope:            scope,
			Model:            item.Scope,
			Used:             usedPtr,
			Limit:            limitPtr,
			UsedPercent:      usedPercent,
			RemainingPercent: remainingPercent,
			ResetAtMS:        resetAtMS,
			ResetLabel:       resetLabel,
			PeriodHours:      periodHours,
			ResetAccuracy:    "exact",
		})
	}

	windows = append(windows, parseKimiRatioPools(payload.Usages, windows, nowMS)...)

	return windows, nil
}

// kimiRatioPercent converts a pool's share into a used percentage.
//
// A pool states a 0–1 fraction, but a payload that states the percentage itself is read as it
// stands rather than scaled into thousands of percent: above 1 the two conventions cannot be
// confused, and the result is clamped either way.
func kimiRatioPercent(value any) (float64, bool) {
	ratio, hasRatio := toFloat(value)
	if !hasRatio || math.IsNaN(ratio) || math.IsInf(ratio, 0) || ratio < 0 {
		return 0, false
	}
	if ratio <= 1 {
		ratio *= 100
	}
	return clamp(ratio, 0, 100), true
}

// kimiPeriodKind names the period a duration covers, in the vocabulary the console localizes.
//
// This is the server-side twin of the console's `quotaWindowKindOf`: both decide a window's
// period from its length alone, so a ratio pool and a counted limit that cover the same period
// are recognized as describing one window.
func kimiPeriodKind(periodHours *float64) string {
	if periodHours == nil {
		return ""
	}
	hours := *periodHours
	switch {
	case math.Abs(hours-5) < 1:
		return "five_hour"
	case math.Abs(hours-24) < 1:
		return "daily"
	case math.Abs(hours-168) < 1:
		return "weekly"
	case hours >= 24*28 && hours <= 24*31:
		return "monthly"
	default:
		return ""
	}
}

func kimiPeriodHours(kind string) *float64 {
	var hours float64
	switch kind {
	case "five_hour":
		hours = 5
	case "daily":
		hours = 24
	case "weekly":
		hours = 168
	case "monthly":
		hours = 720
	default:
		return nil
	}
	return &hours
}

// kimiQuantityPattern reads a quantity and its unit out of a pool key, so a duration written as a
// number is read as the duration it states: `7day` is a week, and `15h` is not this family's
// five-hour window rather than a substring of it.
var kimiQuantityPattern = regexp.MustCompile(`([0-9]+)(h|d|w)`)

// kimiRatioKind reads the period a pool's key describes.
//
// The keys are not a fixed vocabulary (`limit_month_total` today, whatever durations Kimi adds
// next), so the duration is what is read and the key only has to name one. A stated quantity is
// bucketed by the same rule a counted limit's duration goes through, so both shapes agree on which
// window they describe. A key that names no known period keeps its own name as the label and stays
// an unnamed window, instead of being forced into a period it does not describe.
func kimiRatioKind(key string) string {
	normalized := strings.Map(func(character rune) rune {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') {
			return character
		}
		return -1
	}, strings.ToLower(key))

	if match := kimiQuantityPattern.FindStringSubmatch(normalized); match != nil {
		quantity, err := strconv.Atoi(match[1])
		if err == nil {
			var unitHours float64
			switch match[2] {
			case "h":
				unitHours = 1
			case "d":
				unitHours = 24
			case "w":
				unitHours = 168
			}
			hours := float64(quantity) * unitHours
			return kimiPeriodKind(&hours)
		}
	}

	// A key that names its period in words. The concrete period wins over the vague "total" qualifier
	// that accompanies a monthly pool, so a daily total stays daily, and a week is matched before a
	// day so a weekly spelling is not read as a daily one.
	switch {
	case strings.Contains(normalized, "hour"):
		return "five_hour"
	case strings.Contains(normalized, "week"):
		return "weekly"
	case strings.Contains(normalized, "month"):
		return "monthly"
	case strings.Contains(normalized, "day"):
		return "daily"
	case strings.Contains(normalized, "total"):
		return "monthly"
	default:
		return ""
	}
}

// parseKimiRatioPools decodes the `usages` ratio family into windows.
//
// A counted limit already describing a period wins it: that entry carries the absolute usage a
// ratio cannot, so a pool only supplies the durations nothing else covered. When both shapes
// describe one period and the two disagree, the counted reading is what the credential's own
// window shows, and the disagreement stays invisible rather than becoming a second, contradicting
// window for the same limit.
//
// The keys are sorted because Go randomizes map iteration, and a window id that changed between
// two reads of one credential would break every cycle calculation keyed by it.
func parseKimiRatioPools(pools map[string]RawKimiRatioPool, counted []QuotaWindow, nowMS int64) []QuotaWindow {
	if len(pools) == 0 {
		return nil
	}

	covered := make(map[string]bool, len(counted))
	for _, window := range counted {
		if kind := kimiPeriodKind(window.PeriodHours); kind != "" {
			covered[kind] = true
		}
	}

	keys := make([]string, 0, len(pools))
	for key := range pools {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	windows := make([]QuotaWindow, 0, len(keys))
	for _, key := range keys {
		pool := pools[key]
		rawRatio := pool.UsedRatio
		if rawRatio == nil {
			rawRatio = pool.UsedRatioAlt
		}
		used, hasShare := kimiRatioPercent(rawRatio)
		if !hasShare {
			continue
		}
		kind := kimiRatioKind(key)
		if kind != "" {
			if covered[kind] {
				continue
			}
			covered[kind] = true
		}

		remaining := 100 - used
		window := QuotaWindow{
			ID:               "kimi_ratio_" + strings.ToLower(key),
			Label:            key,
			Kind:             kind,
			Scope:            "standard",
			UsedPercent:      &used,
			RemainingPercent: &remaining,
			PeriodHours:      kimiPeriodHours(kind),
			ResetAccuracy:    "exact",
		}

		resetTime := pool.ResetTime
		if resetTime == "" {
			resetTime = pool.ResetTimeAlt
		}
		if resetTime != "" {
			for _, layout := range []string{time.RFC3339, time.RFC3339Nano} {
				if instant, err := time.Parse(layout, resetTime); err == nil {
					ms := instant.UnixMilli()
					window.ResetAtMS = &ms
					window.ResetLabel = formatResetInstant(ms, nowMS)
					break
				}
			}
		}

		windows = append(windows, window)
	}

	return windows
}
