package quota

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type RawKimiLimitItem struct {
	Name     string `json:"name"`
	Title    string `json:"title"`
	Scope    string `json:"scope"`
	Used     any    `json:"used"`
	Limit    any    `json:"limit"`
	Duration any    `json:"duration"`
	TimeUnit string `json:"timeUnit"`
	ResetAt  string `json:"resetAt"`
	ResetIn  any    `json:"resetIn"`
	TTL      any    `json:"ttl"`
}

type RawKimiUsagePayload struct {
	Usage  *RawKimiLimitItem   `json:"usage"`
	Limits []RawKimiLimitItem  `json:"limits"`
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

		usedVal, hasUsed := toFloat(item.Used)
		limVal, hasLim := toFloat(item.Limit)

		var usedPercent *float64
		var remainingPercent *float64
		var usedPtr *float64
		var limPtr *float64

		if hasUsed {
			usedPtr = &usedVal
		}
		if hasLim {
			limPtr = &limVal
		}

		if hasUsed && hasLim && limVal > 0 {
			uPct := clamp(usedVal/limVal*100, 0, 100)
			rPct := clamp(100-uPct, 0, 100)
			usedPercent = &uPct
			remainingPercent = &rPct
		} else if hasUsed && usedVal > 0 && (!hasLim || limVal == 0) {
			uPct := 100.0
			rPct := 0.0
			usedPercent = &uPct
			remainingPercent = &rPct
		}

		var resetAtMS *int64
		var resetLabel string
		if item.ResetAt != "" {
			if t, err := time.Parse(time.RFC3339, item.ResetAt); err == nil {
				ms := t.UnixMilli()
				resetAtMS = &ms
				resetLabel = formatResetInstant(ms, nowMS)
			}
		} else if rIn, ok := toFloat(item.ResetIn); ok && rIn > 0 {
			ms := nowMS + int64(rIn*1000)
			resetAtMS = &ms
			resetLabel = formatResetInstant(ms, nowMS)
		} else if ttl, ok := toFloat(item.TTL); ok && ttl > 0 {
			ms := nowMS + int64(ttl*1000)
			resetAtMS = &ms
			resetLabel = formatResetInstant(ms, nowMS)
		}

		var periodHours *float64
		if dur, ok := toFloat(item.Duration); ok && dur > 0 {
			tu := strings.ToLower(item.TimeUnit)
			switch tu {
			case "hour", "hours", "h":
				periodHours = &dur
			case "day", "days", "d":
				h := dur * 24
				periodHours = &h
			case "minute", "minutes", "m":
				h := dur / 60
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
			Scope:            scope,
			Model:            item.Scope,
			Used:             usedPtr,
			Limit:            limPtr,
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
