package quota

import (
	"encoding/json"
	"fmt"
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

type RawKimiUsagePayload struct {
	Usage  *RawKimiLimitItem  `json:"usage"`
	Limits []RawKimiLimitItem `json:"limits"`
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

	return windows, nil
}
