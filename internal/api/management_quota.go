package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Backwards-compatible fields embedded into quota DTO.
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

	ctx := request.Context()
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
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

	nowMS := time.Now().UnixMilli()
	var latestSnapshots map[string]repository.QuotaSnapshotRecord
	var activeCooldowns map[string]repository.ActiveCooldownRecord

	if h.repo != nil && len(authIndexes) > 0 {
		if snaps, err := h.repo.GetLatestQuotaSnapshots(ctx, authIndexes); err == nil {
			latestSnapshots = snaps
		}
		if cds, err := h.repo.BatchCorrelatedCooldowns(ctx, authIndexes, nowMS); err == nil {
			activeCooldowns = cds
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

		// Raw signals from passive observation
		if file.Quota != nil {
			if signals, ok := file.Quota["signals"].(map[string]any); ok {
				rawSigs := make(map[string]string)
				for k, v := range signals {
					rawSigs[k] = fmt.Sprint(v)
				}
				normalized.RawSignals = rawSigs
			}
		}

		// Correlated active cooldown
		if cd, ok := activeCooldowns[authIndex]; ok && cd.IsActive {
			normalized.ActiveCooldown = &quota.ActiveCooldown{
				IsActive:          true,
				Reason:            cd.Reason,
				RecoverAtMS:       cd.RecoverAtMS,
				RetryAfterSeconds: cd.RetryAfterSeconds,
				CorrelatedAtMS:    cd.CorrelatedAtMS,
			}
			if cd.RecoverAtMS != nil && *cd.RecoverAtMS > nowMS {
				if soonestRecoveryMS == nil || *cd.RecoverAtMS < *soonestRecoveryMS {
					soonestRecoveryMS = cd.RecoverAtMS
				}
			}
		}

		// Merge persisted snapshot if present
		if snap, ok := latestSnapshots[authIndex]; ok {
			normalized.ObservedAtMS = snap.ObservedAtMS
			if snap.PlanType != "" {
				normalized.Plan = &quota.QuotaPlan{
					PlanType:  snap.PlanType,
					PlanLabel: snap.PlanType,
					Tier:      snap.PlanTier,
				}
			}
			if snap.WindowsJSON != "" && snap.WindowsJSON != "[]" {
				var windows []quota.QuotaWindow
				if err := json.Unmarshal([]byte(snap.WindowsJSON), &windows); err == nil {
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
			if snap.ResetCreditsJSON != "" {
				var credits quota.CodexResetCreditsInfo
				if err := json.Unmarshal([]byte(snap.ResetCreditsJSON), &credits); err == nil {
					normalized.ResetCredits = &credits
				}
			}
		}

		quota.EvaluateStatusAndRecommendation(&normalized, nowMS)

		// Aggregate summary counts
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

	writeJSON(writer, http.StatusOK, map[string]any{
		"summary": summary,
		"quotas":  items,
		"total":   len(items),
	})
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

	fileMap := make(map[string]management.AuthFile)
	for _, f := range filesResp.Files {
		idx := strings.TrimSpace(f.AuthIndex)
		if idx != "" {
			fileMap[idx] = f
		}
	}

	// Single target refresh
	targetIndex := strings.TrimSpace(req.AuthIndex)
	if targetIndex != "" {
		file, exists := fileMap[targetIndex]
		if !exists {
			writeError(writer, http.StatusNotFound, fmt.Sprintf("credential with auth_index %q not found", targetIndex))
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

		_ = h.recordAudit(request, "quota.refresh", "quota", targetIndex, "success", map[string]any{
			"status": refreshed.Status,
		})

		writeJSON(writer, http.StatusOK, map[string]any{
			"status": "ok",
			"quota":  refreshed,
		})
		return
	}

	// Batch target refresh
	targetIndexes := req.AuthIndexes
	if len(targetIndexes) == 0 {
		writeError(writer, http.StatusBadRequest, "auth_index or auth_indexes is required")
		return
	}
	if len(targetIndexes) > 10 {
		targetIndexes = targetIndexes[:10]
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
	snaps, err := h.repo.GetLatestQuotaSnapshots(ctx, []string{authIndex})
	if err != nil {
		return nil
	}
	snap, ok := snaps[authIndex]
	if !ok {
		return nil
	}

	q := &quota.NormalizedQuota{
		AuthIndex:    authIndex,
		Provider:     snap.Provider,
		Status:       snap.Status,
		ObservedAtMS: snap.ObservedAtMS,
	}
	if snap.PlanType != "" {
		q.Plan = &quota.QuotaPlan{
			PlanType:  snap.PlanType,
			PlanLabel: snap.PlanType,
			Tier:      snap.PlanTier,
		}
	}
	if snap.WindowsJSON != "" {
		var windows []quota.QuotaWindow
		if err := json.Unmarshal([]byte(snap.WindowsJSON), &windows); err == nil {
			q.Windows = windows
		}
	}
	if snap.ResetCreditsJSON != "" {
		var credits quota.CodexResetCreditsInfo
		if err := json.Unmarshal([]byte(snap.ResetCreditsJSON), &credits); err == nil {
			q.ResetCredits = &credits
		}
	}
	return q
}

func (h *Handler) persistNormalizedQuotaSnapshot(ctx context.Context, q *quota.NormalizedQuota) error {
	if h.repo == nil || q == nil {
		return nil
	}
	winJSON := "[]"
	if len(q.Windows) > 0 {
		if b, err := json.Marshal(q.Windows); err == nil {
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
	if q.Plan != nil {
		planType = q.Plan.PlanType
		planTier = q.Plan.Tier
	}

	return h.repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		AuthIndex:        q.AuthIndex,
		Provider:         q.Provider,
		Status:           q.Status,
		PlanType:         planType,
		PlanTier:         planTier,
		WindowsJSON:      winJSON,
		ResetCreditsJSON: creditsJSON,
		ObservedAtMS:     q.ObservedAtMS,
	})
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

	// Validate that authIndex exists in CPA
	ctx := request.Context()
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	var found bool
	for _, f := range filesResp.Files {
		if strings.TrimSpace(f.AuthIndex) == authIndex {
			found = true
			break
		}
	}
	if !found {
		writeError(writer, http.StatusNotFound, fmt.Sprintf("credential %q not found", authIndex))
		return
	}

	if auditErr := h.recordAudit(request, action, "quota", authIndex, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; clear cooldown aborted")
		return
	}

	if err := client.ResetQuota(request.Context(), authIndex); err != nil {
		_ = h.recordAudit(request, action, "quota", authIndex, "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	// Durably clear local cooldown evidence from database
	if h.repo != nil {
		_ = h.repo.ClearCooldownEvidence(request.Context(), authIndex)
	}

	_ = h.recordAudit(request, action, "quota", authIndex, "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":     "ok",
		"auth_index": authIndex,
	})
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

	ctx := request.Context()
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	var foundFile *management.AuthFile
	for _, f := range filesResp.Files {
		if strings.TrimSpace(f.AuthIndex) == authIndex {
			foundFile = &f
			break
		}
	}
	if foundFile == nil {
		writeError(writer, http.StatusNotFound, fmt.Sprintf("credential %q not found", authIndex))
		return
	}
	if quota.DetectProvider(foundFile.Type, foundFile.Provider) != "codex" {
		writeError(writer, http.StatusBadRequest, "rate limit reset credit is only supported for Codex credentials")
		return
	}

	if auditErr := h.recordAudit(request, "quota.redeem_credit", "quota", authIndex, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; redeem credit aborted")
		return
	}

	svc := quota.NewService(client)
	if err := svc.RedeemCodexCredit(ctx, authIndex); err != nil {
		_ = h.recordAudit(request, "quota.redeem_credit", "quota", authIndex, "failure", map[string]any{"error": err.Error()})
		writeError(writer, http.StatusBadGateway, fmt.Sprintf("redeem reset credit failed: %v", err))
		return
	}

	// Immediately refresh quota to obtain updated credit count and usage windows
	prior := h.loadPriorNormalizedQuota(ctx, authIndex)
	refreshed, _ := svc.RefreshCredentialQuota(ctx, *foundFile, prior)
	if refreshed != nil && h.repo != nil && refreshed.Status != "error" && refreshed.Status != "stale" {
		_ = h.persistNormalizedQuotaSnapshot(ctx, refreshed)
	}

	_ = h.recordAudit(request, "quota.redeem_credit", "quota", authIndex, "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"quota":  refreshed,
	})
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

	nowMS := time.Now().UnixMilli()
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
		if cds, err := h.repo.BatchCorrelatedCooldowns(ctx, []string{authIndex}, nowMS); err == nil {
			if cd, ok := cds[authIndex]; ok && cd.IsActive {
				normalized.ActiveCooldown = &quota.ActiveCooldown{
					IsActive:          true,
					Reason:            cd.Reason,
					RecoverAtMS:       cd.RecoverAtMS,
					RetryAfterSeconds: cd.RetryAfterSeconds,
					CorrelatedAtMS:    cd.CorrelatedAtMS,
				}
			}
		}
		if snaps, err := h.repo.GetLatestQuotaSnapshots(ctx, []string{authIndex}); err == nil {
			if snap, ok := snaps[authIndex]; ok {
				normalized.ObservedAtMS = snap.ObservedAtMS
				if snap.PlanType != "" {
					normalized.Plan = &quota.QuotaPlan{
						PlanType:  snap.PlanType,
						PlanLabel: snap.PlanType,
						Tier:      snap.PlanTier,
					}
				}
				if snap.WindowsJSON != "" && snap.WindowsJSON != "[]" {
					var windows []quota.QuotaWindow
					if err := json.Unmarshal([]byte(snap.WindowsJSON), &windows); err == nil {
						normalized.Windows = windows
					}
				}
				if snap.ResetCreditsJSON != "" {
					var credits quota.CodexResetCreditsInfo
					if err := json.Unmarshal([]byte(snap.ResetCreditsJSON), &credits); err == nil {
						normalized.ResetCredits = &credits
					}
				}
			}
		}
	}

	quota.EvaluateStatusAndRecommendation(&normalized, nowMS)

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
