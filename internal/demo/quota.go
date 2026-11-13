package demo

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Seed observations, not estimates: the real handlers join the same locked
// usage and model-consumption observations a live deployment uses.
func seedQuotaObservations(ctx context.Context, repo *repository.Repository, now time.Time) error {
	payloads := quotaPayloads(now)
	for _, credential := range []struct{ authIndex, provider, url string }{
		{"auth-codex-01", "codex", codexUsageURL},
		{"auth-codex-02", "codex", codexUsageURL},
		{"auth-claude-01", "claude", claudeUsageURL},
		{"auth-antigravity-01", "antigravity", antigravityUsageURL},
	} {
		raw, err := json.Marshal(payloads[credential.url])
		if err != nil {
			return fmt.Errorf("marshal quota payload for %s: %w", credential.authIndex, err)
		}
		var windows []quota.QuotaWindow
		var plan *quota.QuotaPlan
		switch credential.provider {
		case "codex":
			plan, windows, _, err = quota.ParseCodexUsage(raw, now.UnixMilli())
		case "claude":
			windows, _, err = quota.ParseClaudeUsage(raw, now.UnixMilli())
			if profilePayload, ok := payloads[claudeProfileURL]; ok {
				if profileRaw, marshalErr := json.Marshal(profilePayload); marshalErr == nil {
					plan = quota.ParseClaudeProfile(profileRaw)
				}
			}
		case "antigravity":
			windows, err = quota.ParseAntigravityUsage(raw, now.UnixMilli(), 0)
		}
		if err != nil {
			return fmt.Errorf("parse %s quota payload for %s: %w", credential.provider, credential.authIndex, err)
		}
		if credential.authIndex == "auth-codex-02" && len(windows) > 0 {
			previous := windows[0]
			currentStart, _, reason := quota.WindowCycleRange(previous, now.UnixMilli(), now.UnixMilli())
			if reason == "" {
				previous.ResetAtMS = &currentStart
				used, remaining := 65.0, 35.0
				previous.UsedPercent, previous.RemainingPercent = &used, &remaining
				if err := saveDemoQuotaSnapshot(ctx, repo, credential.authIndex, credential.provider, plan, []quota.QuotaWindow{previous}, currentStart-60000); err != nil {
					return fmt.Errorf("seed previous-cycle quota for %s: %w", credential.authIndex, err)
				}
				currentUsed, currentRemaining := 2.0, 98.0
				windows[0].UsedPercent, windows[0].RemainingPercent = &currentUsed, &currentRemaining
			}
		}
		if credential.authIndex == "auth-codex-01" && len(windows) > 0 {
			for _, window := range windows {
				if err := seedModelQuotaObservations(ctx, repo, credential.authIndex, credential.provider, plan, window, now.UnixMilli()); err != nil {
					return fmt.Errorf("seed quota observations for %s: %w", credential.authIndex, err)
				}
			}
		}
		if err := saveDemoQuotaSnapshot(ctx, repo, credential.authIndex, credential.provider, plan, windows, now.UnixMilli()); err != nil {
			return fmt.Errorf("seed current-cycle quota for %s: %w", credential.authIndex, err)
		}
	}
	return nil
}

func saveDemoQuotaSnapshot(ctx context.Context, repo *repository.Repository, authIndex, provider string, plan *quota.QuotaPlan, windows []quota.QuotaWindow, observedAtMS int64) error {
	raw, err := json.Marshal(windows)
	if err != nil {
		return fmt.Errorf("marshal quota snapshot for %s: %w", authIndex, err)
	}
	record := repository.QuotaSnapshotRecord{
		ID:           "demo-quota-" + authIndex + "-" + strconv.FormatInt(observedAtMS, 10),
		CreatedAtMS:  observedAtMS,
		AuthIndex:    authIndex,
		Provider:     provider,
		Status:       "healthy",
		WindowsJSON:  string(raw),
		ObservedAtMS: observedAtMS,
	}
	if plan != nil {
		record.PlanType = plan.PlanType
		record.PlanTier = plan.Tier
		if b, err := json.Marshal(plan); err == nil {
			record.PlanJSON = string(b)
		}
	}
	if err := repo.SaveQuotaSnapshot(ctx, record); err != nil {
		return fmt.Errorf("save quota snapshot for %s: %w", authIndex, err)
	}
	return nil
}

// Checkpoints surround an existing single-model request run. The fixture passes
// through ordinary snapshot persistence rather than inserting a forecast result.
func seedModelQuotaObservations(ctx context.Context, repo *repository.Repository, authIndex, provider string, plan *quota.QuotaPlan, window quota.QuotaWindow, observedAtMS int64) error {
	fromMS, _, reason := quota.WindowCycleRange(window, observedAtMS, observedAtMS)
	used, hasReading := quota.WindowUsedPercent(window)
	if reason != "" || !hasReading || used < 10 {
		return nil
	}
	rows, err := repo.SQL().QueryContext(ctx, `SELECT COALESCE(NULLIF(response_model, ''), model), timestamp_ms + MAX(latency_ms, 0),
        CASE WHEN billed_service_tier IS NOT NULL THEN LOWER(TRIM(billed_service_tier))
        WHEN LOWER(TRIM(COALESCE(response_service_tier, ''))) NOT IN ('', 'auto') THEN LOWER(TRIM(response_service_tier))
        WHEN LOWER(TRIM(COALESCE(service_tier, ''))) NOT IN ('', 'auto') THEN LOWER(TRIM(service_tier)) ELSE '' END
        FROM usage_events WHERE auth_index = ? AND timestamp_ms + MAX(latency_ms, 0) >= ?
        AND timestamp_ms + MAX(latency_ms, 0) < ? AND total_tokens > 0 ORDER BY timestamp_ms + MAX(latency_ms, 0), id`, authIndex, fromMS+1, observedAtMS)
	if err != nil {
		return fmt.Errorf("read demo quota sample: %w", err)
	}
	var model, tier string
	var start, end int64
	count := 0
	for rows.Next() {
		var next, nextTier string
		var atMS int64
		if err := rows.Scan(&next, &atMS, &nextTier); err != nil {
			_ = rows.Close()
			return err
		}
		if next != model || nextTier != tier {
			model, tier, start, count = next, nextTier, atMS-1, 0
		}
		count++
		if count >= 5 {
			end = atMS + 1
			break
		}
	}
	scanErr := rows.Err()
	_ = rows.Close()
	if scanErr != nil {
		return scanErr
	}
	if end == 0 {
		return nil
	}
	checkpoints := []struct {
		at   int64
		used float64
	}{{start, used - 10}, {end, used}}
	for _, checkpoint := range checkpoints {
		reading := window
		remaining := 100 - checkpoint.used
		reading.UsedPercent, reading.RemainingPercent = &checkpoint.used, &remaining
		if err := saveDemoQuotaSnapshot(ctx, repo, authIndex, provider, plan, []quota.QuotaWindow{reading}, checkpoint.at); err != nil {
			return err
		}
	}
	return nil
}
