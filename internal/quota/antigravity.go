package quota

import (
	"encoding/json"
	"fmt"
	"regexp"
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

func normalizeAntigravityWindow(window string) string {
	window = strings.ReplaceAll(strings.ReplaceAll(window, "_", " "), "-", " ")
	return strings.ToLower(strings.Join(strings.Fields(window), " "))
}

func parseAntigravityWindowHours(window string) float64 {
	// A substring such as "week" also matches "biweekly"; guessing a shorter
	// period would mix unrelated traffic into the new capacity numerator.
	switch normalizeAntigravityWindow(window) {
	case "5h", "5hour", "5hours", "5 hour", "5 hours", "five hour", "five hours":
		return 5
	case "24h", "24hour", "24hours", "24 hour", "24 hours", "1d", "day", "daily":
		return 24
	case "7d", "7day", "7days", "7 day", "7 days", "1w", "week", "weekly":
		return 168
	case "30d", "30day", "30days", "30 day", "30 days":
		return 720
	default:
		// A calendar month is not a fixed 30-day duration.
		return 0
	}
}

var antigravityRemainingSuffix = regexp.MustCompile(`(?i)\s*[-:]?\s*remaining$`)

// translateAntigravityBucketLabel names a bucket by its period. Upstream's
// display names drift ("Five Hour Limit Remaining"), so the name is matched
// after dropping the "Remaining" suffix, and the structured window field
// decides when the name matches nothing.
func translateAntigravityBucketLabel(groupName, bucketName, window string) string {
	b := strings.ToLower(strings.TrimSpace(antigravityRemainingSuffix.ReplaceAllString(bucketName, "")))
	windowLabel := strings.TrimSpace(antigravityRemainingSuffix.ReplaceAllString(bucketName, ""))
	switch {
	case (strings.Contains(b, "5") || strings.Contains(b, "five")) && strings.Contains(b, "hour"):
		window = "5h"
	case strings.Contains(b, "daily") || strings.Contains(b, "day"):
		window = "daily"
	case strings.Contains(b, "week"):
		window = "weekly"
	case strings.Contains(b, "month"):
		window = "monthly"
	}
	switch normalizeAntigravityWindow(window) {
	case "month", "monthly", "1mo", "1month", "1 month", "calendar month":
		windowLabel = "每月限制 (Monthly)"
	default:
		switch parseAntigravityWindowHours(window) {
		case 5:
			windowLabel = "5小时限制 (5-Hour)"
		case 24:
			windowLabel = "每日限制 (Daily)"
		case 168:
			windowLabel = "每周限制 (Weekly)"
		case 720:
			windowLabel = "每月限制 (Monthly)"
		}
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

// Snapshot IDs were allocated after the original five-hour/weekly sort. Its
// exact identifiers are fixed: expanding display aliases must not assign an
// existing snapshot ID to a different source bucket.
func antigravityBucketIdentityOrder(window string) int {
	switch strings.ToLower(strings.TrimSpace(window)) {
	case "5h", "5 hour", "5 hours", "five_hour", "five-hour":
		return 0
	case "7d", "7 days", "1w", "week", "weekly":
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

	for groupIndex, group := range payload.Groups {
		gName := group.DisplayName
		if gName == "" {
			gName = group.DisplayNameAlt
		}
		if gName == "" {
			gName = fmt.Sprintf("Group %d", groupIndex+1)
		}

		// Keep each group's windows contiguous while ordering 5h before weekly.
		buckets := make([]RawAntigravityBucket, len(group.Buckets))
		copy(buckets, group.Buckets)
		var identityCounts [3]int
		for _, bucket := range buckets {
			identityCounts[antigravityBucketIdentityOrder(bucket.Window)]++
		}
		identityPositions := [3]int{0, identityCounts[0], identityCounts[0] + identityCounts[1]}
		for bucketIndex := range buckets {
			bucket := &buckets[bucketIndex]
			identityOrder := antigravityBucketIdentityOrder(bucket.Window)
			identityIndex := identityPositions[identityOrder]
			identityPositions[identityOrder]++
			if bucket.BucketID == "" {
				bucket.BucketID = bucket.BucketIDAlt
			}
			if bucket.BucketID == "" {
				bucket.BucketID = fmt.Sprintf("bucket_%d_%d", groupIndex, identityIndex)
			}
		}
		sort.SliceStable(buckets, func(i, j int) bool {
			return antigravityBucketWindowOrder(buckets[i]) < antigravityBucketWindowOrder(buckets[j])
		})

		for _, bucket := range buckets {
			bucketID := bucket.BucketID

			bName := bucket.DisplayName
			if bName == "" {
				bName = bucket.DisplayNameAlt
			}
			if bName == "" {
				bName = bucketID
			}

			fullLabel := translateAntigravityBucketLabel(gName, bName, bucket.Window)

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
				ID:               fmt.Sprintf("ag_%s_%s", gName, bucketID),
				Label:            fullLabel,
				Scope:            "group",
				ModelFamilies:    AntigravityModelFamilies(gName),
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
