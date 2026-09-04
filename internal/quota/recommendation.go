package quota

import "strings"

// EvaluateStatusAndRecommendation calculates the lifecycle status and actionable guidance.
func EvaluateStatusAndRecommendation(q *NormalizedQuota, nowMS int64) {
	// 1. Check CPA Cooldown first
	if q.ActiveCooldown != nil && q.ActiveCooldown.IsActive {
		q.Status = "cooldown"
		reason := "CPA 冷却保护生效中"
		if q.ActiveCooldown.Reason != "" {
			reason = q.ActiveCooldown.Reason
		}
		q.Recommendation = QuotaRecommendation{
			Status:   "cooldown",
			Priority: "high",
			Action:   "clear_cooldown",
			Reason:   reason,
		}
		return
	}

	// 2. Disabled credentials
	if q.Disabled {
		q.Status = "idle"
		q.Recommendation = QuotaRecommendation{
			Status:   "idle",
			Priority: "none",
			Action:   "none",
			Reason:   "凭据已禁用",
		}
		return
	}

	// 3. Error state
	if q.Error != "" {
		errLower := strings.ToLower(q.Error)
		if strings.Contains(errLower, "401") || strings.Contains(errLower, "403") ||
			strings.Contains(errLower, "unauthorized") || strings.Contains(errLower, "forbidden") ||
			strings.Contains(errLower, "auth") || strings.Contains(errLower, "invalid_api_key") {
			q.Status = "error"
			q.Recommendation = QuotaRecommendation{
				Status:   "needs_reauth",
				Priority: "critical",
				Action:   "reauth",
				Reason:   "上游认证失败或凭据失效，建议重新配置密钥或登录授权",
			}
			return
		}

		// Non-auth transient error: keep stale status if preserved from previous snapshot
		if q.Status != "stale" {
			q.Status = "error"
		}
		q.Recommendation = QuotaRecommendation{
			Status:   "warning",
			Priority: "medium",
			Action:   "refresh",
			Reason:   "上游刷新超时或响应异常，已保留最近快照，可尝试重新刷新",
		}
		return
	}

	// 4. Evaluate quota windows
	if len(q.Windows) > 0 {
		minRemaining := 100.0
		hasRemaining := false
		for _, w := range q.Windows {
			if w.RemainingPercent != nil {
				hasRemaining = true
				if *w.RemainingPercent < minRemaining {
					minRemaining = *w.RemainingPercent
				}
			}
		}

		if hasRemaining {
			hasCredits := q.ResetCredits != nil && q.ResetCredits.AvailableCount > 0

			if minRemaining <= 0 {
				q.Status = "exhausted"
				if hasCredits {
					q.Recommendation = QuotaRecommendation{
						Status:   "credits_available",
						Priority: "high",
						Action:   "redeem_credit",
						Reason:   "当前窗口配额已耗尽，有可用 Codex 重置积分，可立即重置恢复容量",
					}
				} else {
					q.Recommendation = QuotaRecommendation{
						Status:   "exhausted",
						Priority: "medium",
						Action:   "none",
						Reason:   "配额已耗尽，请等待重置时间窗口或切换其他可用凭据",
					}
				}
				return
			}

			if minRemaining < 20 {
				q.Status = "warning"
				if hasCredits {
					q.Recommendation = QuotaRecommendation{
						Status:   "credits_available",
						Priority: "medium",
						Action:   "redeem_credit",
						Reason:   "配额余量低于 20%，检测到有可用重置积分储备",
					}
				} else {
					q.Recommendation = QuotaRecommendation{
						Status:   "warning",
						Priority: "low",
						Action:   "none",
						Reason:   "配额余量偏低（不足 20%），请注意流量消耗",
					}
				}
				return
			}

			q.Status = "healthy"
			q.Recommendation = QuotaRecommendation{
				Status:   "healthy",
				Priority: "none",
				Action:   "none",
				Reason:   "配额健康充足，服务运行正常",
			}
			return
		}
	}

	// 5. Idle / No active observations
	q.Status = "idle"
	q.Recommendation = QuotaRecommendation{
		Status:   "idle",
		Priority: "none",
		Action:   "refresh",
		Reason:   "暂无实时配额数据，可点击刷新获取上游最新额度",
	}
}
