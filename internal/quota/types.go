package quota

// QuotaWindow represents a normalized quota usage window (e.g. 5-hour rolling, weekly, model-specific).
type QuotaWindow struct {
	ID               string   `json:"id"`
	Label            string   `json:"label"`
	Kind             string   `json:"kind,omitempty"` // "five_hour", "weekly", "daily", "monthly", "model_scoped", "credit_usage", "custom"
	Scope            string   `json:"scope"`          // "standard", "model", "group"
	Model            string   `json:"model,omitempty"`
	Used             *float64 `json:"used,omitempty"`
	Limit            *float64 `json:"limit,omitempty"`
	UsedPercent      *float64 `json:"used_percent,omitempty"`      // 0..100
	RemainingPercent *float64 `json:"remaining_percent,omitempty"` // 0..100
	ResetAtMS        *int64   `json:"reset_at_ms,omitempty"`
	ResetLabel       string   `json:"reset_label,omitempty"`
	PeriodHours      *float64 `json:"period_hours,omitempty"`
	ResetAccuracy    string   `json:"reset_accuracy,omitempty"` // "exact", "derived", "approximate"
}

// QuotaExtraUsage represents paid extra usage credits (e.g. Claude Extra Usage).
type QuotaExtraUsage struct {
	IsEnabled          bool     `json:"is_enabled"`
	MonthlyLimitCents  int64    `json:"monthly_limit_cents"`
	UsedCreditsCents   int64    `json:"used_credits_cents"`
	UtilizationPercent *float64 `json:"utilization_percent,omitempty"`
}

// Plan expiry provenance. A credential's id_token only carries the subscription
// window recorded at its last upstream subscription check, so a freshly minted
// token can still describe an already-superseded period. Callers must therefore
// keep a live reading distinguishable from that snapshot.
const (
	// PlanSourceLiveSubscription is a subscription window read from the provider's
	// live subscription endpoint during this refresh.
	PlanSourceLiveSubscription = "live_subscription"
	// PlanSourceCredentialSnapshot is the window embedded in the credential's
	// id_token. It is a lower bound of the real expiry: upstream only ever moves
	// the window forward, so a stale snapshot can understate it but never
	// overstate it.
	PlanSourceCredentialSnapshot = "credential_snapshot"
)

// QuotaPlan represents the normalized subscription plan and tier.
type QuotaPlan struct {
	PlanType     string           `json:"plan_type"`               // e.g. "pro", "plus", "ultra", "team", "free"
	PlanLabel    string           `json:"plan_label"`              // e.g. "Pro 20x", "Pro", "Ultra", "Team"
	Tier         string           `json:"tier"`                    // "elite", "premium", "standard", "free", "unknown"
	ExpiresAtMS  *int64           `json:"expires_at_ms,omitempty"` // epoch ms
	ExpiresLabel string           `json:"expires_label,omitempty"`
	ExtraUsage   *QuotaExtraUsage `json:"extra_usage,omitempty"`

	// ExpiresSource names where ExpiresAtMS came from; see the PlanSource
	// constants. Empty on snapshots written before provenance was tracked.
	ExpiresSource string `json:"expires_source,omitempty"`
	// IsAutoRenewing reports whether upstream says the plan will renew. Nil when
	// the source does not expose it.
	IsAutoRenewing *bool `json:"auto_renews,omitempty"`
}

// CodexResetCredit represents an individual Codex rate limit reset credit.
type CodexResetCredit struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	GrantedAtMS *int64 `json:"granted_at_ms,omitempty"`
	ExpiresAtMS *int64 `json:"expires_at_ms,omitempty"`
}

// CodexResetCreditsInfo contains summary of rate limit reset credits for Codex.
type CodexResetCreditsInfo struct {
	AvailableCount           int                `json:"available_count"`
	ApplicableAvailableCount int                `json:"applicable_available_count"`
	Credits                  []CodexResetCredit `json:"credits,omitempty"`
	Error                    string             `json:"error,omitempty"`
}

// ActiveCooldown represents CPA-correlated cooldown or rate-limit event for an auth index.
type ActiveCooldown struct {
	IsActive          bool   `json:"is_active"`
	Reason            string `json:"reason,omitempty"`
	RecoverAtMS       *int64 `json:"recover_at_ms,omitempty"`
	RetryAfterSeconds *int64 `json:"retry_after_seconds,omitempty"`
	CorrelatedAtMS    *int64 `json:"correlated_at_ms,omitempty"`
}

// QuotaRecommendation represents intelligent, actionable status and guidance.
type QuotaRecommendation struct {
	Status   string `json:"status"`   // "healthy", "warning", "exhausted", "cooldown", "needs_reauth", "credits_available", "idle"
	Priority string `json:"priority"` // "critical", "high", "medium", "low", "none"
	Action   string `json:"action"`   // "refresh", "clear_cooldown", "redeem_credit", "reauth", "none"
	Reason   string `json:"reason"`
}

// QuotaCapabilities flags which operations are supported for this credential.
type QuotaCapabilities struct {
	RefreshSupported       bool `json:"refresh_supported"`
	ClearCooldownSupported bool `json:"clear_cooldown_supported"`
	ResetCreditSupported   bool `json:"reset_credit_supported"`
}

// NormalizedQuota is the unified DTO representing all quota dimensions for a credential.
type NormalizedQuota struct {
	AuthIndex      string                 `json:"auth_index"`
	Name           string                 `json:"name"`
	Type           string                 `json:"type"`
	Provider       string                 `json:"provider"`
	Disabled       bool                   `json:"disabled"`
	Status         string                 `json:"status"` // "idle", "loading", "healthy", "warning", "exhausted", "error", "stale"
	ObservedAtMS   int64                  `json:"observed_at_ms"`
	Plan           *QuotaPlan             `json:"plan,omitempty"`
	Windows        []QuotaWindow          `json:"windows"`
	ResetCredits   *CodexResetCreditsInfo `json:"reset_credits,omitempty"`
	ActiveCooldown *ActiveCooldown        `json:"active_cooldown,omitempty"`
	Recommendation QuotaRecommendation    `json:"recommendation"`
	Capabilities   QuotaCapabilities      `json:"capabilities"`
	RawSignals     map[string]string      `json:"raw_signals,omitempty"`
	Error          string                 `json:"error,omitempty"`
}

// QuotaOverviewSummary provides fleet-wide counts and stats.
type QuotaOverviewSummary struct {
	TotalCredentials  int    `json:"total_credentials"`
	HealthyCount      int    `json:"healthy_count"`
	WarningCount      int    `json:"warning_count"`
	ExhaustedCount    int    `json:"exhausted_count"`
	CooldownCount     int    `json:"cooldown_count"`
	AttentionCount    int    `json:"attention_count"`
	SoonestRecoveryMS *int64 `json:"soonest_recovery_ms,omitempty"`
}

// QuotaOverviewResponse is the API response for the quota overview endpoint.
type QuotaOverviewResponse struct {
	Summary QuotaOverviewSummary `json:"summary"`
	Quotas  []NormalizedQuota    `json:"quotas"`
}
