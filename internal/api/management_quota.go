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
	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
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
	LastRefresh      *QuotaRefreshAttemptDTO               `json:"last_refresh,omitempty"`
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

// QuotaRefreshAttemptDTO is the last try to read a credential's quota, as the console shows it.
//
// It travels beside the reading rather than inside it: the reading is the last successful
// observation, and a failure must not become one. A page that has both can say "refreshed 3
// minutes ago, failed with 401" instead of presenting a reading from three days ago as current.
type QuotaRefreshAttemptDTO struct {
	AttemptedAtMS int64  `json:"attempted_at_ms"`
	Outcome       string `json:"outcome"`
	Error         string `json:"error,omitempty"`
}

// refreshQuotaReading runs one credential read and records the attempt before returning.
//
// It is the single door to quota.Service.RefreshCredentialQuota for every surface that can read
// a credential - the manual refresh, the background loop, the warmup probe and the Agent
// capability - so a failure the operator is shown in a toast is also the failure the page can
// still report after the toast is gone.
func (h *Handler) refreshQuotaReading(ctx context.Context, svc *quota.Service, file management.AuthFile, prior *quota.NormalizedQuota) (*quota.NormalizedQuota, error) {
	// Stamped before the read, on the same clock the service stamps the reading with: two reads of
	// one credential can overlap, and the stored attempt must answer "which read started last", not
	// "which response landed last". A slow failing read that started first may finish after a newer
	// successful one, and completion order would let it report the credential as broken.
	attemptedAtMS := svc.Now().UnixMilli()
	refreshed, err := svc.RefreshCredentialQuota(ctx, file, prior)
	h.recordQuotaReadAttempt(ctx, file, attemptedAtMS, refreshed, err)
	if err == nil && quota.HasRestoredCapacity(refreshed, attemptedAtMS) {
		h.releaseRestoredCooldown(ctx, svc, refreshed)
	}
	return refreshed, err
}

// releaseRestoredCooldown lifts a CPA cooldown once a fresh read shows the credential has
// capacity again. A provider can reset a quota before the recovery time CPA recorded, and
// without this the credential stays blocked until that time even though it could serve.
//
// It runs for every read, so a manual refresh, the background loop and the warmup probe all
// release the credential the same way. Best effort: the read itself already succeeded.
func (h *Handler) releaseRestoredCooldown(ctx context.Context, svc *quota.Service, reading *quota.NormalizedQuota) {
	authIndex := strings.TrimSpace(reading.AuthIndex)
	if h.repo == nil || authIndex == "" {
		return
	}
	hasEvidence, err := h.repo.HasCooldownEvidence(ctx, authIndex)
	if err != nil || !hasEvidence {
		return
	}
	clearErr := svc.ClearCPACooldown(ctx, authIndex)
	var evidenceErr error
	if clearErr == nil {
		evidenceErr = h.repo.ClearCooldownEvidence(ctx, authIndex)
	}
	h.recordAutomaticCooldownClear(authIndex, "capacity_restored", clearErr, evidenceErr)
	if clearErr != nil || evidenceErr != nil {
		h.logCooldownClearFailure("quota restored but CPA cooldown release failed", authIndex, 0, clearErr, evidenceErr)
		return
	}
	// The reading carried the prior cooldown forward; the response must show what it is now.
	reading.ActiveCooldown = nil
	quota.EvaluateStatusAndRecommendation(reading, svc.Now().UnixMilli())
	if h.logger != nil {
		h.logger.Info("CPA cooldown cleared after quota restored", "auth_index", authIndex, "status", reading.Status)
	}
}

// recordQuotaReadAttempt stores what a read produced for the console's next question about it.
//
// Best effort in the way the observation write is not: the read already happened upstream, and a
// storage failure must not turn a successful refresh into an error reply. It is logged, because
// a page silently showing an older attempt is exactly the confusion this record exists to end.
func (h *Handler) recordQuotaReadAttempt(ctx context.Context, file management.AuthFile, attemptedAtMS int64, reading *quota.NormalizedQuota, readErr error) {
	index := strings.TrimSpace(file.AuthIndex)
	// A disabled credential is never read upstream: its reading is the operator's own decision,
	// and recording an attempt would invent a try the console never made.
	if h.repo == nil || index == "" || file.Disabled {
		return
	}
	isUsable, reason := quota.ReadOutcome(reading, readErr)
	attempt := repository.QuotaRefreshAttemptRecord{
		AuthIndex:     index,
		AttemptedAtMS: attemptedAtMS,
		Outcome:       repository.QuotaRefreshAttemptSucceeded,
		Error:         reason,
	}
	if !isUsable {
		attempt.Outcome = repository.QuotaRefreshAttemptFailed
	}
	if err := h.repo.SaveQuotaRefreshAttempt(ctx, attempt); err != nil && h.logger != nil {
		h.logger.Warn("quota read attempt could not be recorded", "auth_index", index, "error", err)
	}
}

// lastQuotaAttempts reads the recorded attempts for the credentials a response describes.
func (h *Handler) lastQuotaAttempts(ctx context.Context, authIndexes []string) map[string]repository.QuotaRefreshAttemptRecord {
	if h.repo == nil || len(authIndexes) == 0 {
		return nil
	}
	attempts, err := h.repo.GetQuotaRefreshAttempts(ctx, authIndexes)
	if err != nil {
		if h.logger != nil {
			h.logger.Warn("quota refresh attempts unavailable", "error", err)
		}
		return nil
	}
	return attempts
}

// quotaAttemptOf turns a stored attempt into the domain fact the status derivation reads.
func quotaAttemptOf(record repository.QuotaRefreshAttemptRecord) *quota.ReadAttempt {
	if record.AttemptedAtMS == 0 {
		return nil
	}
	return &quota.ReadAttempt{
		AttemptedAtMS: record.AttemptedAtMS,
		IsFailed:      record.Outcome == repository.QuotaRefreshAttemptFailed,
		Failure:       record.Error,
	}
}

// quotaAttemptDTO is the same attempt as the console reads it, absent when nobody has tried.
func quotaAttemptDTO(attempt *quota.ReadAttempt) *QuotaRefreshAttemptDTO {
	if attempt == nil {
		return nil
	}
	outcome := repository.QuotaRefreshAttemptSucceeded
	if attempt.IsFailed {
		outcome = repository.QuotaRefreshAttemptFailed
	}
	return &QuotaRefreshAttemptDTO{AttemptedAtMS: attempt.AttemptedAtMS, Outcome: outcome, Error: attempt.Failure}
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
		refreshed, err := h.refreshQuotaReading(ctx, svc, file, prior)
		if err != nil {
			writeError(writer, http.StatusBadGateway, fmt.Sprintf("refresh quota failed: %v", err))
			return
		}

		_ = h.persistNormalizedQuotaSnapshot(ctx, refreshed)
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
			refreshed, rErr := h.refreshQuotaReading(ctx, svc, f, prior)
			if rErr == nil && refreshed != nil {
				results[index] = refreshed
				_ = h.persistNormalizedQuotaSnapshot(ctx, refreshed)
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
	return normalizedQuotaFromSnapshot(authIndex, snapshot)
}

// normalizedQuotaFromSnapshot rebuilds the prior reading a refresh starts from.
func normalizedQuotaFromSnapshot(authIndex string, snapshot repository.QuotaSnapshotRecord) *quota.NormalizedQuota {
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
	if snapshot.ResetGrantsJSON != "" {
		var grants []quota.ClaudeResetGrant
		if err := json.Unmarshal([]byte(snapshot.ResetGrantsJSON), &grants); err == nil {
			q.ResetGrants = grants
		}
	}
	if snapshot.WarmupJSON != "" {
		var observation warmup.Observation
		if json.Unmarshal([]byte(snapshot.WarmupJSON), &observation) == nil {
			q.WarmupEvidence = &observation
		}
	}
	return q
}

func (h *Handler) persistNormalizedQuotaSnapshot(ctx context.Context, q *quota.NormalizedQuota) error {
	if h.repo == nil || q == nil || q.Disabled {
		return nil
	}
	// Only a usable reading becomes an observation: a failed or stale read leaves the last good
	// one in place, and the attempt beside it carries the failure.
	if isUsable, _ := quota.ReadOutcome(q, nil); !isUsable {
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
	grantsJSON := ""
	if len(q.ResetGrants) > 0 {
		if b, err := json.Marshal(q.ResetGrants); err == nil {
			grantsJSON = string(b)
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

	warmupJSON := ""
	if q.WarmupEvidence != nil {
		if raw, err := json.Marshal(q.WarmupEvidence); err == nil {
			warmupJSON = string(raw)
		}
	}
	return h.repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		WarmupJSON:       warmupJSON,
		AuthIndex:        q.AuthIndex,
		Provider:         q.Provider,
		Status:           q.Status,
		PlanType:         planType,
		PlanTier:         planTier,
		PlanJSON:         planJSON,
		WindowsJSON:      winJSON,
		ResetCreditsJSON: creditsJSON,
		ResetGrantsJSON:  grantsJSON,
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
	caps := quota.CapabilitiesForFile(*targetFile)

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
	// Whether an observation exists at all is what a failure means here: beside a reading it is a
	// reason the previous numbers still stand, and without one it is the whole answer about the
	// credential. See quota.ApplyReadingHealth.
	hasStoredReading := false

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
				hasStoredReading = true
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
				if snapshot.ResetGrantsJSON != "" {
					var grants []quota.ClaudeResetGrant
					if err := json.Unmarshal([]byte(snapshot.ResetGrantsJSON), &grants); err == nil {
						normalized.ResetGrants = grants
					}
				}
			}
		}
	}

	quota.EvaluateStatusAndRecommendation(&normalized, nowMS)
	lastAttempts := h.lastQuotaAttempts(ctx, []string{authIndex})
	attempt := quotaAttemptOf(lastAttempts[authIndex])
	quota.ApplyReadingHealth(&normalized, attempt, hasStoredReading, nowMS)
	h.attachWindowCapacity(ctx, &normalized, nowMS)

	var history []repository.QuotaSnapshotRecord
	if h.repo != nil {
		if hist, err := h.repo.GetQuotaSnapshotHistory(ctx, authIndex, 20); err == nil {
			history = hist
		}
	}

	response := map[string]any{
		"quota":        normalized,
		"history":      history,
		"model_quotas": projectModelQuotas(targetFile.ModelQuotas),
	}
	// Absent rather than null: a credential nobody has tried to read has no attempt to report, and
	// an explicit null would claim otherwise.
	if lastRefresh := quotaAttemptDTO(attempt); lastRefresh != nil {
		response["last_refresh"] = lastRefresh
	}
	writeJSON(writer, http.StatusOK, response)
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
	// Every row is read against the last attempt, because a reading alone cannot say whether the
	// console's own refreshes are still working; see quota.ApplyReadingHealth.
	lastAttempts := h.lastQuotaAttempts(ctx, authIndexes)

	items := make([]QuotaItemDTO, 0, len(authIndexes))
	var soonestRecoveryMS *int64

	var healthyCount, warningCount, exhaustedCount, cooldownCount, attentionCount int

	for _, authIndex := range authIndexes {
		file := fileMap[authIndex]
		stdProvider := quota.DetectProvider(file.Type, file.Provider)
		caps := quota.CapabilitiesForFile(file)

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
			if snapshot.ResetGrantsJSON != "" {
				var grants []quota.ClaudeResetGrant
				if err := json.Unmarshal([]byte(snapshot.ResetGrantsJSON), &grants); err == nil {
					normalized.ResetGrants = grants
				}
			}
		}

		quota.EvaluateStatusAndRecommendation(&normalized, nowMS)
		attempt := quotaAttemptOf(lastAttempts[authIndex])
		_, hasStoredReading := latestSnapshots[authIndex]
		quota.ApplyReadingHealth(&normalized, attempt, hasStoredReading, nowMS)
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
			LastRefresh:     quotaAttemptDTO(attempt),
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
