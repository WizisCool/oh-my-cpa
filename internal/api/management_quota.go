package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// QuotaItemDTO keeps the legacy quota_exceeded/quota_reason fields alongside the
// embedded normalized quota, so older clients still see the summary they expect.
type QuotaItemDTO struct {
	quota.NormalizedQuota
	Quota            *managementQuotaObservation           `json:"quota,omitempty"`
	ModelQuotas      map[string]managementQuotaObservation `json:"model_quotas,omitempty"`
	QuotaExceeded    bool                                  `json:"quota_exceeded"`
	QuotaReason      string                                `json:"quota_reason,omitempty"`
	NextRecoverAtMS  *int64                                `json:"next_recover_at_ms,omitempty"`
	NextRetryAfterMS *int64                                `json:"next_retry_after_ms,omitempty"`
}

func (h *Handler) getQuotaOverview(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	overview, err := h.buildQuotaOverview(request.Context(), client)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, overview)
}

type refreshQuotaRequest struct {
	AuthIndex   string   `json:"auth_index,omitempty"`
	AuthIndexes []string `json:"auth_indexes,omitempty"`
}

func (h *Handler) refreshCredentialQuota(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req refreshQuotaRequest
	if err := decodeManagementJSON(writer, request, 32*1024, &req); err != nil {
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx := request.Context()
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	// Meta's observation endpoint can mint a key. Fail closed before downloading
	// its DCA credential or making that upstream call, including batch refreshes.
	auditMetaAttempt := func(file management.AuthFile) error {
		if quota.DetectProvider(file.Type, file.Provider) != "meta" || file.Disabled {
			return nil
		}
		return h.recordAudit(request, "quota.refresh", "quota", file.AuthIndex, "attempt", map[string]any{"provider": "meta", "upstream_action": "key_exchange"})
	}

	fileMap := make(map[string]management.AuthFile)
	for _, f := range filesResp.Files {
		idx := strings.TrimSpace(f.AuthIndex)
		if idx != "" {
			fileMap[idx] = f
		}
	}

	targetIndex := strings.TrimSpace(req.AuthIndex)
	if targetIndex != "" {
		file, exists := fileMap[targetIndex]
		if !exists {
			writeError(writer, http.StatusNotFound, fmt.Sprintf("credential with auth_index %q not found", targetIndex))
			return
		}

		if err := auditMetaAttempt(file); err != nil {
			writeAuditFailure(writer, "quota refresh attempt could not be audited")
			return
		}
		prior := h.loadPriorNormalizedQuota(ctx, targetIndex)
		svc := quota.NewService(client)
		refreshed, err := svc.RefreshCredentialQuota(ctx, file, prior)
		if err != nil {
			writeError(writer, http.StatusBadGateway, fmt.Sprintf("refresh quota failed: %v", err))
			return
		}

		// Persist snapshot to DB only when successful (healthy, warning, or exhausted), never stale or error
		if h.repo != nil && refreshed.Status != "error" && refreshed.Status != "stale" {
			_ = h.persistNormalizedQuotaSnapshot(ctx, refreshed)
		}
		h.attachWindowCapacity(ctx, refreshed, h.now().UnixMilli())

		outcome := "success"
		if refreshed.Provider == "meta" && refreshed.Error != "" {
			outcome = "failure"
		}
		_ = h.recordAudit(request, "quota.refresh", "quota", targetIndex, outcome, map[string]any{
			"status": refreshed.Status,
		})

		writeJSON(writer, http.StatusOK, map[string]any{
			"status": "ok",
			"quota":  refreshed,
		})
		return
	}

	// Deduplicate before auditing or exchanging keys: repeated selections must
	// not perform the same credential-bearing observation more than once.
	targetIndexes := make([]string, 0, len(req.AuthIndexes))
	seenIndexes := make(map[string]bool, len(req.AuthIndexes))
	for _, value := range req.AuthIndexes {
		authIndex := strings.TrimSpace(value)
		if authIndex != "" && !seenIndexes[authIndex] {
			seenIndexes[authIndex] = true
			targetIndexes = append(targetIndexes, authIndex)
		}
	}
	if len(targetIndexes) == 0 {
		writeError(writer, http.StatusBadRequest, "auth_index or auth_indexes is required")
		return
	}
	if len(targetIndexes) > 10 {
		targetIndexes = targetIndexes[:10]
	}

	for _, targetIndex := range targetIndexes {
		if file, exists := fileMap[strings.TrimSpace(targetIndex)]; exists {
			if err := auditMetaAttempt(file); err != nil {
				writeAuditFailure(writer, "quota refresh attempt could not be audited")
				return
			}
		}
	}
	svc := quota.NewService(client)
	results := make([]*quota.NormalizedQuota, len(targetIndexes))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)

	for i, idx := range targetIndexes {
		cleanIdx := strings.TrimSpace(idx)
		file, exists := fileMap[cleanIdx]
		if !exists {
			continue
		}
		wg.Add(1)
		go func(index int, authIdx string, f management.AuthFile) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			prior := h.loadPriorNormalizedQuota(ctx, authIdx)
			refreshed, rErr := svc.RefreshCredentialQuota(ctx, f, prior)
			if rErr == nil && refreshed != nil {
				results[index] = refreshed
				if h.repo != nil && refreshed.Status != "error" && refreshed.Status != "stale" {
					_ = h.persistNormalizedQuotaSnapshot(ctx, refreshed)
				}
			}
		}(i, cleanIdx, file)
	}
	wg.Wait()

	out := make([]*quota.NormalizedQuota, 0, len(results))
	for _, r := range results {
		if r != nil {
			if r.Provider == "meta" && !r.Disabled {
				outcome := "success"
				if r.Error != "" {
					outcome = "failure"
				}
				_ = h.recordAudit(request, "quota.refresh", "quota", r.AuthIndex, outcome, map[string]any{"status": r.Status})
			}
			h.attachWindowCapacity(ctx, r, h.now().UnixMilli())
			out = append(out, r)
		}
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"quotas": out,
		"total":  len(out),
	})
}

func (h *Handler) loadPriorNormalizedQuota(ctx context.Context, authIndex string) *quota.NormalizedQuota {
	if h.repo == nil {
		return nil
	}
	snapshots, err := h.repo.GetLatestQuotaSnapshots(ctx, []string{authIndex})
	if err != nil {
		return nil
	}
	snapshot, ok := snapshots[authIndex]
	if !ok {
		return nil
	}

	q := &quota.NormalizedQuota{
		AuthIndex:    authIndex,
		Provider:     snapshot.Provider,
		Status:       snapshot.Status,
		ObservedAtMS: snapshot.ObservedAtMS,
	}
	if plan := planFromSnapshot(snapshot); plan != nil {
		q.Plan = plan
	}
	if snapshot.WindowsJSON != "" {
		var windows []quota.QuotaWindow
		if err := json.Unmarshal([]byte(snapshot.WindowsJSON), &windows); err == nil {
			q.Windows = windows
		}
	}
	if snapshot.ResetCreditsJSON != "" {
		var credits quota.CodexResetCreditsInfo
		if err := json.Unmarshal([]byte(snapshot.ResetCreditsJSON), &credits); err == nil {
			q.ResetCredits = &credits
		}
	}
	return q
}

func (h *Handler) persistNormalizedQuotaSnapshot(ctx context.Context, q *quota.NormalizedQuota) error {
	if h.repo == nil || q == nil || q.Disabled || q.Error != "" || q.Status == "stale" || q.Status == "error" {
		return nil
	}
	// Carry observed reset evidence through the existing JSON snapshots, so a
	// tainted cycle stays tainted after earlier readings fall out of retention.
	var history []quota.ObservedWindows
	hasIncompleteHistory := false
	for _, window := range q.Windows {
		if !quota.SupportsWindowCapacity(q.Provider, window) {
			continue
		}
		var err error
		history, err = h.loadObservedWindows(ctx, q.AuthIndex, q.Provider)
		if err != nil {
			hasIncompleteHistory = true
			if h.logger != nil {
				h.logger.Warn("quota capacity history unavailable while saving observation", "provider", q.Provider, "error", err)
			}
		}
		break
	}
	windows := append([]quota.QuotaWindow(nil), q.Windows...)
	for i := range windows {
		window := &windows[i]
		window.Usage, window.Capacity, window.CapacityUnavailable = nil, nil, ""
		fromMS, toMS, reason := quota.WindowCycleRange(*window, q.ObservedAtMS, q.ObservedAtMS)
		if reason == "" && quota.SupportsWindowCapacity(q.Provider, *window) {
			window.HasIncompleteHistory = hasIncompleteHistory || quota.HasIncompleteWindowHistory(*window, history, fromMS, toMS)
			window.HasMidCycleReset = quota.HasWindowCycleReset(*window, history, fromMS, toMS)
		}
	}
	q.Windows = windows
	winJSON := "[]"
	if len(q.Windows) > 0 {
		if b, err := json.Marshal(windows); err == nil {
			winJSON = string(b)
		}
	}
	creditsJSON := ""
	if q.ResetCredits != nil {
		if b, err := json.Marshal(q.ResetCredits); err == nil {
			creditsJSON = string(b)
		}
	}
	planType := ""
	planTier := ""
	planJSON := ""
	if q.Plan != nil {
		planType = q.Plan.PlanType
		planTier = q.Plan.Tier
		if b, err := json.Marshal(q.Plan); err == nil {
			planJSON = string(b)
		}
	}

	return h.repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		AuthIndex:        q.AuthIndex,
		Provider:         q.Provider,
		Status:           q.Status,
		PlanType:         planType,
		PlanTier:         planTier,
		PlanJSON:         planJSON,
		WindowsJSON:      winJSON,
		ResetCreditsJSON: creditsJSON,
		ObservedAtMS:     q.ObservedAtMS,
	})
}

// planFromSnapshot rebuilds the full normalized plan (including subscription
// expiry and extra usage) from the persisted plan payload, falling back to the
// legacy plan_type/plan_tier columns for snapshots written before plan_json.
func planFromSnapshot(snapshot repository.QuotaSnapshotRecord) *quota.QuotaPlan {
	if snapshot.PlanJSON != "" {
		var plan quota.QuotaPlan
		if err := json.Unmarshal([]byte(snapshot.PlanJSON), &plan); err == nil && plan.PlanType != "" {
			return &plan
		}
	}
	if snapshot.PlanType != "" {
		return &quota.QuotaPlan{
			PlanType:  snapshot.PlanType,
			PlanLabel: snapshot.PlanType,
			Tier:      snapshot.PlanTier,
		}
	}
	return nil
}

type quotaActionRequest struct {
	AuthIndex string `json:"auth_index"`
}

func (h *Handler) clearCredentialCooldownWithAction(writer http.ResponseWriter, request *http.Request, action string) {
	writer.Header().Set("Cache-Control", "no-store")
	var req quotaActionRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
		return
	}

	authIndex := strings.TrimSpace(req.AuthIndex)
	if authIndex == "" {
		writeError(writer, http.StatusBadRequest, "auth_index is required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	defer h.providerWrites.release()
	result, err := h.clearQuotaCooldown(request.Context(), client, authIndex, action, func(action, targetType, targetID, result string, details map[string]any) error {
		return h.recordAudit(request, action, targetType, targetID, result, details)
	})
	if err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	writeJSON(writer, 200, result)
}

func (h *Handler) clearCredentialCooldown(writer http.ResponseWriter, request *http.Request) {
	h.clearCredentialCooldownWithAction(writer, request, "quota.clear_cooldown")
}

func (h *Handler) resetCredentialQuota(writer http.ResponseWriter, request *http.Request) {
	h.clearCredentialCooldownWithAction(writer, request, "quota.reset")
}

func (h *Handler) redeemCodexResetCredit(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req quotaActionRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
		return
	}

	authIndex := strings.TrimSpace(req.AuthIndex)
	if authIndex == "" {
		writeError(writer, http.StatusBadRequest, "auth_index is required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	defer h.providerWrites.release()
	result, err := h.redeemQuotaCredit(request.Context(), client, authIndex, func(action, targetType, targetID, result string, details map[string]any) error {
		return h.recordAudit(request, action, targetType, targetID, result, details)
	})
	if err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	writeJSON(writer, 200, result)
}

func (h *Handler) getCredentialQuotaDetail(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	authIndex := strings.TrimSpace(chi.URLParam(request, "authIndex"))
	if authIndex == "" {
		writeError(writer, http.StatusBadRequest, "auth_index is required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx := request.Context()
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	var targetFile *management.AuthFile
	for _, f := range filesResp.Files {
		if strings.TrimSpace(f.AuthIndex) == authIndex {
			targetFile = &f
			break
		}
	}
	if targetFile == nil {
		writeError(writer, http.StatusNotFound, fmt.Sprintf("credential %q not found", authIndex))
		return
	}

	nowMS := h.now().UnixMilli()
	stdProvider := quota.DetectProvider(targetFile.Type, targetFile.Provider)
	caps := quota.CapabilitiesForProvider(stdProvider)

	normalized := quota.NormalizedQuota{
		AuthIndex:    authIndex,
		Name:         targetFile.Name,
		Type:         targetFile.Type,
		Provider:     stdProvider,
		Disabled:     targetFile.Disabled,
		ObservedAtMS: nowMS,
		Capabilities: caps,
		Windows:      []quota.QuotaWindow{},
	}

	if h.repo != nil {
		if cooldowns, err := h.repo.BatchCorrelatedCooldowns(ctx, []string{authIndex}, nowMS); err == nil {
			if cooldown, ok := cooldowns[authIndex]; ok && cooldown.IsActive {
				normalized.ActiveCooldown = &quota.ActiveCooldown{
					IsActive:          true,
					Reason:            cooldown.Reason,
					RecoverAtMS:       cooldown.RecoverAtMS,
					RetryAfterSeconds: cooldown.RetryAfterSeconds,
					CorrelatedAtMS:    cooldown.CorrelatedAtMS,
				}
			}
		}
		if snapshots, err := h.repo.GetLatestQuotaSnapshots(ctx, []string{authIndex}); err == nil {
			if snapshot, ok := snapshots[authIndex]; ok {
				normalized.ObservedAtMS = snapshot.ObservedAtMS
				// See buildQuotaOverview: an empty reading survives only through the stored status.
				normalized.Status = snapshot.Status
				if plan := planFromSnapshot(snapshot); plan != nil {
					normalized.Plan = plan
				}
				if snapshot.WindowsJSON != "" && snapshot.WindowsJSON != "[]" {
					var windows []quota.QuotaWindow
					if err := json.Unmarshal([]byte(snapshot.WindowsJSON), &windows); err == nil {
						normalized.Windows = windows
					}
				}
				if snapshot.ResetCreditsJSON != "" {
					var credits quota.CodexResetCreditsInfo
					if err := json.Unmarshal([]byte(snapshot.ResetCreditsJSON), &credits); err == nil {
						normalized.ResetCredits = &credits
					}
				}
			}
		}
	}

	quota.EvaluateStatusAndRecommendation(&normalized, nowMS)
	h.attachWindowCapacity(ctx, &normalized, nowMS)

	var history []repository.QuotaSnapshotRecord
	if h.repo != nil {
		if hist, err := h.repo.GetQuotaSnapshotHistory(ctx, authIndex, 20); err == nil {
			history = hist
		}
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"quota":        normalized,
		"history":      history,
		"model_quotas": projectModelQuotas(targetFile.ModelQuotas),
	})
}

type quotaOverviewData struct {
	Summary quota.QuotaOverviewSummary `json:"summary"`
	Quotas  []QuotaItemDTO             `json:"quotas"`
	Total   int                        `json:"total"`
}

func (h *Handler) buildQuotaOverview(ctx context.Context, client *management.Client) (quotaOverviewData, error) {
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		return quotaOverviewData{}, err
	}

	authIndexes := make([]string, 0, len(filesResp.Files))
	fileMap := make(map[string]management.AuthFile)
	for _, file := range filesResp.Files {
		authIndex := strings.TrimSpace(file.AuthIndex)
		if authIndex == "" {
			continue
		}
		authIndexes = append(authIndexes, authIndex)
		fileMap[authIndex] = file
	}

	nowMS := h.now().UnixMilli()
	var latestSnapshots map[string]repository.QuotaSnapshotRecord
	var activeCooldowns map[string]repository.ActiveCooldownRecord

	if h.repo != nil && len(authIndexes) > 0 {
		if snapshots, err := h.repo.GetLatestQuotaSnapshots(ctx, authIndexes); err == nil {
			latestSnapshots = snapshots
		}
		if cooldowns, err := h.repo.BatchCorrelatedCooldowns(ctx, authIndexes, nowMS); err == nil {
			activeCooldowns = cooldowns
		}
	}

	items := make([]QuotaItemDTO, 0, len(authIndexes))
	var soonestRecoveryMS *int64

	var healthyCount, warningCount, exhaustedCount, cooldownCount, attentionCount int

	for _, authIndex := range authIndexes {
		file := fileMap[authIndex]
		stdProvider := quota.DetectProvider(file.Type, file.Provider)
		caps := quota.CapabilitiesForProvider(stdProvider)

		normalized := quota.NormalizedQuota{
			AuthIndex:    authIndex,
			Name:         file.Name,
			Type:         file.Type,
			Provider:     stdProvider,
			Disabled:     file.Disabled,
			ObservedAtMS: nowMS,
			Capabilities: caps,
			Windows:      []quota.QuotaWindow{},
		}

		if file.Quota != nil {
			if signals, ok := file.Quota["signals"].(map[string]any); ok {
				rawSigs := make(map[string]string)
				for k, v := range signals {
					rawSigs[k] = fmt.Sprint(v)
				}
				normalized.RawSignals = rawSigs
			}
		}

		if cooldown, ok := activeCooldowns[authIndex]; ok && cooldown.IsActive {
			normalized.ActiveCooldown = &quota.ActiveCooldown{
				IsActive:          true,
				Reason:            cooldown.Reason,
				RecoverAtMS:       cooldown.RecoverAtMS,
				RetryAfterSeconds: cooldown.RetryAfterSeconds,
				CorrelatedAtMS:    cooldown.CorrelatedAtMS,
			}
			if cooldown.RecoverAtMS != nil && *cooldown.RecoverAtMS > nowMS {
				if soonestRecoveryMS == nil || *cooldown.RecoverAtMS < *soonestRecoveryMS {
					soonestRecoveryMS = cooldown.RecoverAtMS
				}
			}
		}

		if snapshot, ok := latestSnapshots[authIndex]; ok {
			normalized.ObservedAtMS = snapshot.ObservedAtMS
			// The stored status is what the last read produced, and an empty reading is only
			// knowable from it: without it the evaluation below recomputes the credential as one
			// nobody has read, and the console asks for a repeat of a read that already happened.
			normalized.Status = snapshot.Status
			if plan := planFromSnapshot(snapshot); plan != nil {
				normalized.Plan = plan
			}
			if snapshot.WindowsJSON != "" && snapshot.WindowsJSON != "[]" {
				var windows []quota.QuotaWindow
				if err := json.Unmarshal([]byte(snapshot.WindowsJSON), &windows); err == nil {
					normalized.Windows = windows
					// Check windows for soonest recovery
					for _, w := range windows {
						if w.ResetAtMS != nil && *w.ResetAtMS > nowMS {
							if soonestRecoveryMS == nil || *w.ResetAtMS < *soonestRecoveryMS {
								soonestRecoveryMS = w.ResetAtMS
							}
						}
					}
				}
			}
			if snapshot.ResetCreditsJSON != "" {
				var credits quota.CodexResetCreditsInfo
				if err := json.Unmarshal([]byte(snapshot.ResetCreditsJSON), &credits); err == nil {
					normalized.ResetCredits = &credits
				}
			}
		}

		quota.EvaluateStatusAndRecommendation(&normalized, nowMS)
		h.attachWindowCapacity(ctx, &normalized, nowMS)

		switch normalized.Status {
		case "healthy":
			healthyCount++
		case "warning":
			warningCount++
			attentionCount++
		case "exhausted":
			exhaustedCount++
			attentionCount++
		case "cooldown":
			cooldownCount++
			attentionCount++
		case "error":
			attentionCount++
		}

		dto := QuotaItemDTO{
			NormalizedQuota: normalized,
			Quota:           projectQuota(file.Quota),
			ModelQuotas:     projectModelQuotas(file.ModelQuotas),
		}
		if normalized.ActiveCooldown != nil && normalized.ActiveCooldown.IsActive {
			dto.QuotaExceeded = true
			dto.QuotaReason = normalized.ActiveCooldown.Reason
			dto.NextRecoverAtMS = normalized.ActiveCooldown.RecoverAtMS
			if normalized.ActiveCooldown.RetryAfterSeconds != nil {
				ms := *normalized.ActiveCooldown.RetryAfterSeconds * 1000
				dto.NextRetryAfterMS = &ms
			}
		} else if normalized.Status == "exhausted" {
			dto.QuotaExceeded = true
			dto.QuotaReason = "配额已耗尽"
		}

		items = append(items, dto)
	}

	summary := quota.QuotaOverviewSummary{
		TotalCredentials:  len(items),
		HealthyCount:      healthyCount,
		WarningCount:      warningCount,
		ExhaustedCount:    exhaustedCount,
		CooldownCount:     cooldownCount,
		AttentionCount:    attentionCount,
		SoonestRecoveryMS: soonestRecoveryMS,
	}

	return quotaOverviewData{summary, items, len(items)}, nil
}
