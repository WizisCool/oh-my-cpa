package demo

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Seed observations, not estimates: the real handlers join the same locked
// usage and cycle evidence a live deployment uses.
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
			if err == nil && plan != nil && !subscriptionUnavailable[credential.authIndex] {
				if subPayload, ok := payloads[codexSubscriptionURL]; ok {
					if subRaw, marshalErr := json.Marshal(subPayload); marshalErr == nil {
						if sub, okSub := quota.ParseCodexSubscription(subRaw); okSub {
							untilMS := sub.UntilAtMS
							plan.StartsAtMS = sub.StartAtMS
							plan.ExpiresAtMS = &untilMS
							plan.BillingPeriod = sub.BillingPeriod
							plan.ExpiresLabel = ""
							plan.ExpiresSource = quota.PlanSourceLiveSubscription
							plan.IsAutoRenewing = sub.ShouldRenew
						}
					}
				}
			}
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
		if credential.authIndex != "auth-codex-02" {
			if err := seedDemoQuotaSteps(ctx, repo, credential.authIndex, credential.provider, plan, windows, now.UnixMilli()); err != nil {
				return fmt.Errorf("seed quota history for %s: %w", credential.authIndex, err)
			}
		}
		if err := saveDemoQuotaSnapshot(ctx, repo, credential.authIndex, credential.provider, plan, windows, now.UnixMilli()); err != nil {
			return fmt.Errorf("seed current-cycle quota for %s: %w", credential.authIndex, err)
		}
	}
	return nil
}

// seedDemoQuotaSteps records provider readings at several places in the current
// cycle and two completed cycles. Group points sharing a timestamp into one read.
func seedDemoQuotaSteps(ctx context.Context, repo *repository.Repository, index, provider string, plan *quota.QuotaPlan, windows []quota.QuotaWindow, nowMS int64) error {
	steps := map[int64][]quota.QuotaWindow{}
	for _, window := range windows {
		start, _, reason := quota.WindowCycleRange(window, nowMS, nowMS)
		used, ok := quota.WindowUsedPercent(window)
		if reason != "" || !ok {
			continue
		}
		span := *window.ResetAtMS - start
		add := func(at, reset int64, used float64) {
			point := window
			remaining := 100 - used
			point.ResetAtMS, point.UsedPercent, point.RemainingPercent = &reset, &used, &remaining
			steps[at] = append(steps[at], point)
		}
		for cycle := int64(2); cycle > 0; cycle-- {
			reset := *window.ResetAtMS - cycle*span
			for i, fraction := range []float64{0.28, 0.64, 0.98} {
				pastUsed := min(100, (used+float64(cycle)*8)*[]float64{0.22, 0.62, 1.04}[i])
				add(reset-span+int64(float64(span)*fraction), reset, pastUsed)
			}
		}
		for i, fraction := range []float64{0.10, 0.34, 0.58, 0.81} {
			add(start+int64(float64(nowMS-start)*fraction), *window.ResetAtMS, used*[]float64{0.08, 0.24, 0.45, 0.72}[i])
		}
	}
	times := make([]int64, 0, len(steps))
	for at := range steps {
		times = append(times, at)
	}
	slices.Sort(times)
	for _, at := range times {
		if err := saveDemoQuotaSnapshot(ctx, repo, index, provider, plan, steps[at], at); err != nil {
			return err
		}
	}
	return nil
}

func saveDemoQuotaSnapshot(ctx context.Context, repo *repository.Repository, authIndex, provider string, plan *quota.QuotaPlan, windows []quota.QuotaWindow, observedAtMS int64) error {
	raw, err := json.Marshal(windows)
	if err != nil {
		return fmt.Errorf("marshal quota snapshot for %s: %w", authIndex, err)
	}
	windowKey := "all"
	if len(windows) == 1 {
		windowKey = windows[0].ID
	}
	record := repository.QuotaSnapshotRecord{
		ID:           "demo-quota-" + authIndex + "-" + windowKey + "-" + strconv.FormatInt(observedAtMS, 10),
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
