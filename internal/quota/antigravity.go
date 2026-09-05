package quota

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

type RawAntigravityBucket struct {
	BucketID          string `json:"bucketId"`
	BucketIDAlt       string `json:"bucket_id"`
	DisplayName       string `json:"displayName"`
	DisplayNameAlt    string `json:"display_name"`
	Window            string `json:"window"`
	ResetTime         string `json:"resetTime"`
	ResetTimeAlt      string `json:"reset_time"`
	RemainingFraction any    `json:"remainingFraction"`
	RemainingFracAlt  any    `json:"remaining_fraction"`
	Description       string `json:"description"`
}

type RawAntigravityGroup struct {
	DisplayName    string                 `json:"displayName"`
	DisplayNameAlt string                 `json:"display_name"`
	Description    string                 `json:"description"`
	Buckets        []RawAntigravityBucket `json:"buckets"`
}

type RawAntigravityPayload struct {
	Groups []RawAntigravityGroup `json:"groups"`
}

func parseAntigravityWindowHours(window string) float64 {
	w := strings.ToLower(strings.TrimSpace(window))
	if strings.Contains(w, "5h") || (strings.Contains(w, "5") && strings.Contains(w, "hour")) {
		return 5
	}
	if strings.Contains(w, "24h") || strings.Contains(w, "1d") || strings.Contains(w, "day") || strings.Contains(w, "daily") {
		return 24
	}
	if strings.Contains(w, "7d") || strings.Contains(w, "1w") || strings.Contains(w, "week") {
		return 168
	}
	if strings.Contains(w, "30d") || strings.Contains(w, "1m") || strings.Contains(w, "month") {
		return 720
	}
	return 24
}

func translateAntigravityBucketLabel(groupName, bucketName string) string {
	b := strings.ToLower(strings.TrimSpace(bucketName))
	windowLabel := bucketName
	if strings.Contains(b, "5") && strings.Contains(b, "hour") {
		windowLabel = "5小时限制 (5-Hour)"
	} else if strings.Contains(b, "daily") || strings.Contains(b, "day") {
		windowLabel = "每日限制 (Daily)"
	} else if strings.Contains(b, "week") {
		windowLabel = "每周限制 (Weekly)"
	} else if strings.Contains(b, "month") {
		windowLabel = "每月限制 (Monthly)"
	}

	if groupName != "" {
		return fmt.Sprintf("%s · %s", groupName, windowLabel)
	}
	return windowLabel
}

// antigravityBucketWindowOrder ranks buckets inside a group: the 5-hour
// window leads, then weekly, then anything else — matching CPAMC's builder,
// since upstream lists the weekly bucket first.
func antigravityBucketWindowOrder(bucket RawAntigravityBucket) int {
	switch hours := parseAntigravityWindowHours(bucket.Window); hours {
	case 5:
		return 0
	case 168:
		return 1
	default:
		return 2
	}
}

// ParseAntigravityUsage parses Antigravity quota response and returns normalized windows.
func ParseAntigravityUsage(raw []byte, nowMS int64, serverOffsetMS int64) ([]QuotaWindow, error) {
	var payload RawAntigravityPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("invalid antigravity payload: %w", err)
	}

	windows := make([]QuotaWindow, 0)

	for gIdx, group := range payload.Groups {
		gName := group.DisplayName
		if gName == "" {
			gName = group.DisplayNameAlt
		}
		if gName == "" {
			gName = fmt.Sprintf("Group %d", gIdx+1)
		}

		// Keep each group's windows contiguous while ordering 5h before weekly.
		buckets := make([]RawAntigravityBucket, len(group.Buckets))
		copy(buckets, group.Buckets)
		sort.SliceStable(buckets, func(i, j int) bool {
			return antigravityBucketWindowOrder(buckets[i]) < antigravityBucketWindowOrder(buckets[j])
		})

		for bIdx, bucket := range buckets {
			bID := bucket.BucketID
			if bID == "" {
				bID = bucket.BucketIDAlt
			}
			if bID == "" {
				bID = fmt.Sprintf("bucket_%d_%d", gIdx, bIdx)
			}

			bName := bucket.DisplayName
			if bName == "" {
				bName = bucket.DisplayNameAlt
			}
			if bName == "" {
				bName = bID
			}

			fullLabel := translateAntigravityBucketLabel(gName, bName)

			rawFrac := bucket.RemainingFraction
			if rawFrac == nil {
				rawFrac = bucket.RemainingFracAlt
			}

			var remainingPercent *float64
			var usedPercent *float64
			if frac, ok := toFloat(rawFrac); ok {
				// remainingFraction is 0.0 .. 1.0 (or sometimes 0..100)
				var rem float64
				if frac <= 1.0 && frac >= 0.0 {
					rem = clamp(frac*100, 0, 100)
				} else {
					rem = clamp(frac, 0, 100)
				}
				remainingPercent = &rem
				used := clamp(100-rem, 0, 100)
				usedPercent = &used
			}

			resetTimeStr := bucket.ResetTime
			if resetTimeStr == "" {
				resetTimeStr = bucket.ResetTimeAlt
			}

			var resetAtMS *int64
			var resetLabel string
			if resetTimeStr != "" {
				if t, err := time.Parse(time.RFC3339, resetTimeStr); err == nil {
					ms := t.UnixMilli() + serverOffsetMS
					resetAtMS = &ms
					resetLabel = formatResetInstant(ms, nowMS)
				} else if t, err := time.Parse(time.RFC3339Nano, resetTimeStr); err == nil {
					ms := t.UnixMilli() + serverOffsetMS
					resetAtMS = &ms
					resetLabel = formatResetInstant(ms, nowMS)
				}
			}

			periodHours := parseAntigravityWindowHours(bucket.Window)

			windows = append(windows, QuotaWindow{
				ID:               fmt.Sprintf("ag_%s_%s", gName, bID),
				Label:            fullLabel,
				Scope:            "group",
				UsedPercent:      usedPercent,
				RemainingPercent: remainingPercent,
				ResetAtMS:        resetAtMS,
				ResetLabel:       resetLabel,
				PeriodHours:      &periodHours,
				ResetAccuracy:    "exact",
			})
		}
	}

	return windows, nil
}

// ResolveAntigravityPlan creates the plan descriptor for Antigravity subscriptions.
func ResolveAntigravityPlan(planType string) *QuotaPlan {
	norm := strings.ToLower(strings.TrimSpace(planType))
	switch norm {
	case "ultra":
		return &QuotaPlan{
			PlanType:  "ultra",
			PlanLabel: "Ultra",
			Tier:      "elite",
		}
	case "ultra-lite", "ultra_lite":
		return &QuotaPlan{
			PlanType:  "ultra-lite",
			PlanLabel: "Ultra Lite",
			Tier:      "premium",
		}
	case "pro":
		return &QuotaPlan{
			PlanType:  "pro",
			PlanLabel: "Pro",
			Tier:      "standard",
		}
	case "free":
		return &QuotaPlan{
			PlanType:  "free",
			PlanLabel: "Free",
			Tier:      "free",
		}
	default:
		if norm != "" {
			return &QuotaPlan{
				PlanType:  norm,
				PlanLabel: strings.ToUpper(norm[:1]) + norm[1:],
				Tier:      "standard",
			}
		}
		return &QuotaPlan{
			PlanType:  "unknown",
			PlanLabel: "未知套餐",
			Tier:      "unknown",
		}
	}
}
