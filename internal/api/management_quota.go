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

func projectModelCooldowns(records []repository.ActiveCooldownRecord) []quota.ActiveCooldown {
	var result []quota.ActiveCooldown
	for _, record := range records {
		result = append(result, quota.ActiveCooldown{
			IsActive: record.IsActive, Model: record.Model, Reason: record.Reason,
			RecoverAtMS: record.RecoverAtMS, RetryAtMS: record.RetryAtMS,
			CorrelatedAtMS: record.CorrelatedAtMS, BackoffLevel: record.BackoffLevel,
		})
	}
	return result
}

// oauthGlobalAliasRules is the provider-wide OAuth model alias document every catalog build
// needs: the warmup task model list and each quota read ask for the same rules.
func (h *Handler) oauthGlobalAliasRules(ctx context.Context, client *management.Client) map[string][]management.OAuthModelAlias {
	if client == nil {
		return nil
	}
	return h.cachedAliasRules(globalAliasCacheKey, func() (aliasCacheEntry, error) {
		aliases, err := client.OAuthModelAliases(ctx)
		return aliasCacheEntry{global: aliases}, err
	}).global
}

// modelCooldownKeyResolver folds the spellings stored in error_events onto the model CPA keys
// them under. A rule recorded before CPA resolved it to its upstream leaves the alias behind, so
// without this one resting model would be listed once per spelling it was ever reported under.
// When the alias document cannot be read, spellings alone still group the rows.
func (h *Handler) modelCooldownKeyResolver(ctx context.Context, client *management.Client, files map[string]management.AuthFile) repository.ModelCooldownKeyResolver {
	aliases := h.oauthGlobalAliasRules(ctx, client)
	if len(aliases) == 0 {
		return nil
	}
	rules := make(map[string][]management.OAuthModelAlias, len(files))
	for authIndex, file := range files {
		// Rules resolve the way CPA resolves a call point: this credential's provider first.
		if family := management.ModelAliasFamily(file); len(aliases[family]) > 0 {
			rules[authIndex] = aliases[family]
		}
	}
	if len(rules) == 0 {
		return nil
	}
	return func(authIndex, model string) string {
		return management.ResolveOAuthModelAlias(model, rules[authIndex])
	}
}

// QuotaRefreshResponseDTO documents either a single refreshed quota or a batch refresh summary.
type QuotaRefreshResponseDTO struct {
	Status string                   `json:"status"`
	Quota  *quota.NormalizedQuota   `json:"quota,omitempty"`
	Quotas []*quota.NormalizedQuota `json:"quotas,omitempty"`
	Total  *int                     `json:"total,omitempty"`
}

// QuotaSingleRefreshResponseDTO returns a single refreshed credential quota reading.
type QuotaSingleRefreshResponseDTO struct {
	Status string                 `json:"status"`
	Quota  *quota.NormalizedQuota `json:"quota"`
}

// QuotaBatchRefreshResponseDTO returns the batch quota refresh results and count, preserving empty collections.
type QuotaBatchRefreshResponseDTO struct {
	Status string                   `json:"status"`
	Quotas []*quota.NormalizedQuota `json:"quotas"`
	Total  int                      `json:"total"`
}

// QuotaSnapshotDTO projects a persisted normalized quota snapshot record for detail history responses.
type QuotaSnapshotDTO struct {
	WarmupJSON       string `json:"warmup_json,omitempty"`
	ID               string `json:"id"`
	AuthIndex        string `json:"auth_index"`
	Provider         string `json:"provider"`
	Status           string `json:"status"`
	PlanType         string `json:"plan_type"`
	PlanTier         string `json:"plan_tier"`
	PlanJSON         string `json:"plan_json,omitempty"`
	WindowsJSON      string `json:"windows_json"`
	ResetCreditsJSON string `json:"reset_credits_json,omitempty"`
	ResetGrantsJSON  string `json:"reset_grants_json,omitempty"`
	ObservedAtMS     int64  `json:"observed_at_ms"`
	CreatedAtMS      int64  `json:"created_at_ms"`
}

func projectQuotaSnapshotDTOs(records []repository.QuotaSnapshotRecord) []QuotaSnapshotDTO {
	out := make([]QuotaSnapshotDTO, 0, len(records))
	for _, record := range records {
		out = append(out, QuotaSnapshotDTO{
			WarmupJSON:       record.WarmupJSON,
			ID:               record.ID,
			AuthIndex:        record.AuthIndex,
			Provider:         record.Provider,
			Status:           record.Status,
			PlanType:         record.PlanType,
			PlanTier:         record.PlanTier,
			PlanJSON:         record.PlanJSON,
			WindowsJSON:      record.WindowsJSON,
			ResetCreditsJSON: record.ResetCreditsJSON,
			ResetGrantsJSON:  record.ResetGrantsJSON,
			ObservedAtMS:     record.ObservedAtMS,
			CreatedAtMS:      record.CreatedAtMS,
		})
	}
	return out
}

// QuotaCooldownClearResponseDTO confirms cooldown/quota reset for an auth index.
type QuotaCooldownClearResponseDTO struct {
	Status    string `json:"status"`
	AuthIndex string `json:"auth_index"`
}

// QuotaRedeemCreditResponseDTO confirms Codex credit redemption and cooldown clearing.
type QuotaRedeemCreditResponseDTO struct {
	Status          string                 `json:"status"`
	Quota           *quota.NormalizedQuota `json:"quota"`
	CooldownCleared bool                   `json:"cooldown_cleared"`
	CooldownError   string                 `json:"cooldown_error,omitempty"`
}

// CredentialQuotaDetailResponseDTO returns normalized quota, snapshot history, model quotas, and last refresh attempt.
type CredentialQuotaDetailResponseDTO struct {
	Quota       quota.NormalizedQuota                 `json:"quota"`
	History     []QuotaSnapshotDTO                    `json:"history"`
	ModelQuotas map[string]managementQuotaObservation `json:"model_quotas"`
	LastRefresh *QuotaRefreshAttemptDTO               `json:"last_refresh,omitempty"`
}

// @Summary Get credential quota overview
// @Description Return normalized quota windows, active cooldowns, capacity forecasts, and overview summary across credentials.
// @Tags Quota
// @Produce json
// @Security CookieAuth
// @Success 200 {object} quotaOverviewData
// @Failure 401 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/quota [get]
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

// quotaRefreshStreamWriteDeadline bounds one frame of a batch refresh stream.
const quotaRefreshStreamWriteDeadline = 10 * time.Second

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
	return h.refreshQuotaReadingAs(ctx, svc, file, prior, false)
}

// refreshAutomaticQuotaReading is the same read for a caller no operator is waiting on. It also
// honors the credential backoff a refused automatic read established; a manual refresh keeps its
// existing rule and waits only for the provider pause, because the operator is asking for the
// answer now.
func (h *Handler) refreshAutomaticQuotaReading(ctx context.Context, svc *quota.Service, file management.AuthFile, prior *quota.NormalizedQuota) (*quota.NormalizedQuota, error) {
	return h.refreshQuotaReadingAs(ctx, svc, file, prior, true)
}

func (h *Handler) refreshQuotaReadingAs(ctx context.Context, svc *quota.Service, file management.AuthFile, prior *quota.NormalizedQuota, isAutomatic bool) (*quota.NormalizedQuota, error) {
	// Stamped before the read, on the same clock the service stamps the reading with: two reads of
	// one credential can overlap, and the stored attempt must answer "which read started last", not
	// "which response landed last". A slow failing read that started first may finish after a newer
	// successful one, and completion order would let it report the credential as broken.
	attemptedAtMS := svc.Now().UnixMilli()
	refreshed, err := h.readThroughGate(ctx, svc, file, prior, isAutomatic, func(options quota.ReadOptions) (*quota.NormalizedQuota, error) {
		return svc.RefreshCredentialQuotaWith(ctx, file, prior, options)
	})
	if refreshed != nil && refreshed.IsDeferred {
		return refreshed, err
	}
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
	// The CPA reset is credential-wide; a restored global reading cannot justify
	// clearing another model's still-active cooldown.
	hasModelEvidence, err := h.repo.HasActiveModelCooldownEvidence(ctx, authIndex, svc.Now().UnixMilli())
	if err != nil || hasModelEvidence {
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
	reading.ModelCooldowns = nil
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

// @Summary Refresh credential quota
// @Description Refresh quota observations for one auth_index or up to 10 auth_indexes (supports SSE when Accept includes text/event-stream).
// @Tags Quota
// @Accept json
// @Produce json,text/event-stream
// @Security CookieAuth
// @Param body body refreshQuotaRequest true "Single or batch auth_index selection"
// @Success 200 {object} QuotaRefreshResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/quota/refresh [post]
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
		h.attachQuotaCapacity(ctx, refreshed, h.now().UnixMilli())

		outcome := "success"
		if refreshed.Provider == "meta" && refreshed.Error != "" {
			outcome = "failure"
		}
		_ = h.recordAudit(request, "quota.refresh", "quota", targetIndex, outcome, map[string]any{
			"status": refreshed.Status,
		})

		writeJSON(writer, http.StatusOK, QuotaSingleRefreshResponseDTO{
			Status: "ok",
			Quota:  refreshed,
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
	readings := make(chan *quota.NormalizedQuota)
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)

	for _, idx := range targetIndexes {
		cleanIdx := strings.TrimSpace(idx)
		file, exists := fileMap[cleanIdx]
		if !exists {
			continue
		}
		wg.Add(1)
		go func(authIdx string, f management.AuthFile) {
			defer wg.Done()
			if h.holdsCallerSlot(f) {
				sem <- struct{}{}
				defer func() { <-sem }()
			}

			prior := h.loadPriorNormalizedQuota(ctx, authIdx)
			refreshed, rErr := h.refreshQuotaReading(ctx, svc, f, prior)
			if rErr == nil && refreshed != nil {
				_ = h.persistNormalizedQuotaSnapshot(ctx, refreshed)
				readings <- refreshed
			}
		}(cleanIdx, file)
	}
	go func() {
		wg.Wait()
		close(readings)
	}()

	// A batch is as slow as its slowest provider, and a gated one reads one credential at a time.
	// A caller that accepts an event stream gets each reading the moment it lands, so the console
	// can settle that credential while the rest are still being read; every other caller keeps the
	// one JSON answer in request order.
	if !strings.Contains(request.Header.Get("Accept"), "text/event-stream") {
		byIndex := make(map[string]*quota.NormalizedQuota, len(targetIndexes))
		for r := range readings {
			h.finishBatchReading(request, r)
			byIndex[r.AuthIndex] = r
		}
		out := make([]*quota.NormalizedQuota, 0, len(byIndex))
		for _, idx := range targetIndexes {
			if r, ok := byIndex[strings.TrimSpace(idx)]; ok {
				out = append(out, r)
			}
		}
		writeJSON(writer, http.StatusOK, QuotaBatchRefreshResponseDTO{Status: "ok", Quotas: out, Total: len(out)})
		return
	}

	// The stream is one `quota` frame per reading, then `done` with the count; a stream that ends
	// without `done` was cut.
	controller := http.NewResponseController(writer)
	writer.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	writer.Header().Set("X-Accel-Buffering", "no")
	writer.WriteHeader(http.StatusOK)
	isWritable := controller.Flush() == nil
	writeFrame := func(event string, value any) {
		if !isWritable {
			return
		}
		payload, err := json.Marshal(value)
		if err != nil {
			return
		}
		// The server's write timeout counts from the request; a batch that outlives it is still alive.
		_ = controller.SetWriteDeadline(time.Now().Add(quotaRefreshStreamWriteDeadline))
		if _, err := fmt.Fprintf(writer, "event: %s\ndata: %s\n\n", event, payload); err != nil {
			isWritable = false
			return
		}
		isWritable = controller.Flush() == nil
	}

	// Drained to the end even after the client has gone, so no read is left blocked on the channel.
	total := 0
	for r := range readings {
		h.finishBatchReading(request, r)
		total++
		writeFrame("quota", r)
	}
	writeFrame("done", map[string]any{"status": "ok", "total": total})
}

// finishBatchReading audits a Meta read and attaches the quota forecasts before a batch reading is
// answered, whichever wire format carries it.
func (h *Handler) finishBatchReading(request *http.Request, r *quota.NormalizedQuota) {
	if r.Provider == "meta" && !r.Disabled {
		outcome := "success"
		if r.Error != "" {
			outcome = "failure"
		}
		_ = h.recordAudit(request, "quota.refresh", "quota", r.AuthIndex, outcome, map[string]any{"status": r.Status})
	}
	h.attachQuotaCapacity(request.Context(), r, h.now().UnixMilli())
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
	windows := append([]quota.QuotaWindow(nil), q.Windows...)
	for i := range windows {
		window := &windows[i]
		window.Usage, window.Capacity, window.CapacityUnavailable = nil, nil, ""
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
	if err := h.flushCoordinatorUnderProviderGate(request.Context()); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	result, err := h.clearQuotaCooldown(request.Context(), client, authIndex, action, func(action, targetType, targetID, result string, details map[string]any) error {
		return h.recordAudit(request, action, targetType, targetID, result, details)
	})
	if err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	h.invalidateCoordinator("management-auth-files", "management-quota")
	writeJSON(writer, 200, result)
}

// @Summary Clear credential cooldown
// @Description Clear active gateway cooldown and local cooldown evidence for a credential auth_index.
// @Tags Quota
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body quotaActionRequest true "Credential auth_index"
// @Success 200 {object} QuotaCooldownClearResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/quota/clear-cooldown [post]
func (h *Handler) clearCredentialCooldown(writer http.ResponseWriter, request *http.Request) {
	h.clearCredentialCooldownWithAction(writer, request, "quota.clear_cooldown")
}

// @Summary Reset credential quota state
// @Description Reset gateway quota cooldown state for a credential auth_index.
// @Tags Quota
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body quotaActionRequest true "Credential auth_index"
// @Success 200 {object} QuotaCooldownClearResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/quota/reset [post]
func (h *Handler) resetCredentialQuota(writer http.ResponseWriter, request *http.Request) {
	h.clearCredentialCooldownWithAction(writer, request, "quota.reset")
}

// @Summary Redeem Codex rate-limit reset credit
// @Description Redeem a Codex quota reset credit, clear gateway cooldown, and refresh the credential quota reading.
// @Tags Quota
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body quotaActionRequest true "Codex credential auth_index"
// @Success 200 {object} QuotaRedeemCreditResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/quota/redeem-credit [post]
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
	if err := h.flushCoordinatorUnderProviderGate(request.Context()); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	result, err := h.redeemQuotaCredit(request.Context(), client, authIndex, func(action, targetType, targetID, result string, details map[string]any) error {
		return h.recordAudit(request, action, targetType, targetID, result, details)
	})
	if err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	h.invalidateCoordinator("management-auth-files", "management-quota")
	writeJSON(writer, 200, result)
}

// @Summary Get credential quota detail
// @Description Return normalized quota windows, snapshot history, model quotas, and last refresh attempt for one credential.
// @Tags Quota
// @Produce json
// @Security CookieAuth
// @Param authIndex path string true "Credential runtime auth_index"
// @Success 200 {object} CredentialQuotaDetailResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/quota/{authIndex} [get]
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
		cooldownKeys := h.modelCooldownKeyResolver(ctx, client, map[string]management.AuthFile{authIndex: *targetFile})
		if cooldowns, err := h.repo.BatchCorrelatedCooldowns(ctx, []string{authIndex}, nowMS); err == nil {
			if cooldown, ok := cooldowns[authIndex]; ok && cooldown.IsActive {
				normalized.ActiveCooldown = &quota.ActiveCooldown{
					IsActive:          true,
					Reason:            cooldown.Reason,
					RecoverAtMS:       cooldown.RecoverAtMS,
					RetryAfterSeconds: cooldown.RetryAfterSeconds,
					CorrelatedAtMS:    cooldown.CorrelatedAtMS,
					RetryAtMS:         cooldown.RetryAtMS,
					BackoffLevel:      cooldown.BackoffLevel,
				}
			}
		}
		if cooldowns, err := h.repo.BatchModelCooldowns(ctx, []string{authIndex}, nowMS, cooldownKeys); err == nil {
			normalized.ModelCooldowns = projectModelCooldowns(cooldowns[authIndex])
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
	h.attachQuotaCapacity(ctx, &normalized, nowMS)

	var history []repository.QuotaSnapshotRecord
	if h.repo != nil {
		if hist, err := h.repo.GetQuotaSnapshotHistory(ctx, authIndex, 20); err == nil {
			history = hist
		}
	}

	response := CredentialQuotaDetailResponseDTO{
		Quota:       normalized,
		History:     projectQuotaSnapshotDTOs(history),
		ModelQuotas: projectModelQuotas(targetFile.ModelQuotas),
		LastRefresh: quotaAttemptDTO(attempt),
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
	var modelCooldowns map[string][]repository.ActiveCooldownRecord

	if h.repo != nil && len(authIndexes) > 0 {
		// One alias read serves the whole fleet: it is what a stored cooldown spelling resolves to.
		cooldownKeys := h.modelCooldownKeyResolver(ctx, client, fileMap)
		if snapshots, err := h.repo.GetLatestQuotaSnapshots(ctx, authIndexes); err == nil {
			latestSnapshots = snapshots
		}
		if cooldowns, err := h.repo.BatchCorrelatedCooldowns(ctx, authIndexes, nowMS); err == nil {
			activeCooldowns = cooldowns
		}
		if cooldowns, err := h.repo.BatchModelCooldowns(ctx, authIndexes, nowMS, cooldownKeys); err == nil {
			modelCooldowns = cooldowns
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
				RetryAtMS:         cooldown.RetryAtMS,
				BackoffLevel:      cooldown.BackoffLevel,
			}
			if cooldown.RecoverAtMS != nil && *cooldown.RecoverAtMS > nowMS {
				if soonestRecoveryMS == nil || *cooldown.RecoverAtMS < *soonestRecoveryMS {
					soonestRecoveryMS = cooldown.RecoverAtMS
				}
			}
		}

		normalized.ModelCooldowns = projectModelCooldowns(modelCooldowns[authIndex])
		for _, cooldown := range normalized.ModelCooldowns {
			at := cooldown.RecoverAtMS
			if cooldown.RetryAtMS != nil && (at == nil || *cooldown.RetryAtMS > *at) {
				at = cooldown.RetryAtMS
			}
			if at != nil && *at > nowMS && (soonestRecoveryMS == nil || *at < *soonestRecoveryMS) {
				soonestRecoveryMS = at
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
		h.attachQuotaCapacity(ctx, &normalized, nowMS)

		hasPartialCooldown := !normalized.Disabled && len(normalized.ModelCooldowns) > 0
		switch normalized.Status {
		case "healthy":
			if hasPartialCooldown {
				warningCount++
				attentionCount++
			} else {
				healthyCount++
			}
		case "idle", "unpublished":
			if hasPartialCooldown {
				warningCount++
				attentionCount++
			}
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
