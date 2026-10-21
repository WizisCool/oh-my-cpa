package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

type warmupRuntime struct {
	mu      sync.Mutex
	running map[string]bool
}

func (runtime *warmupRuntime) acquire(authIndex string) bool {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.running == nil {
		runtime.running = map[string]bool{}
	}
	if runtime.running[authIndex] {
		return false
	}
	runtime.running[authIndex] = true
	return true
}
func (runtime *warmupRuntime) release(authIndex string) {
	runtime.mu.Lock()
	delete(runtime.running, authIndex)
	runtime.mu.Unlock()
}
func (runtime *warmupRuntime) isRunning(authIndex string) bool {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return runtime.running[authIndex]
}

func (h *Handler) warmupPolicyTarget(file management.AuthFile) string {
	return quota.DetectProvider(file.Type, file.Provider) + "/" + file.AuthIndex + "/" + h.warmupCredentialIdentity(file)
}

// This is a replacement guard, never a quota join or an account lookup. An
// identity projection changing must discard activation observations and scheduling
// state, even at the same index.
func (h *Handler) warmupCredentialIdentity(file management.AuthFile) string {
	// CPA's account field is opaque and can carry secret material. Hash the
	// replacement guard with a keyed purpose; never persist or expose its input.
	raw, _ := json.Marshal(struct{ ID, AccountID, Account, Email string }{file.ID, file.CodexChatgptAccountID(), file.Account, file.Email})
	fingerprint, _ := h.cipher.Fingerprint("warmup-credential-identity", string(raw))
	return fingerprint
}
func (h *Handler) warmupFile(ctx context.Context, client *management.Client, authIndex string) (management.AuthFile, error) {
	files, err := client.AuthFiles(ctx)
	if err != nil {
		return management.AuthFile{}, err
	}
	var selected *management.AuthFile
	for _, file := range files.Files {
		if file.AuthIndex == authIndex && authIndex != "" {
			if selected != nil {
				return management.AuthFile{}, errors.New("credential_ambiguous")
			}
			copyFile := file
			selected = &copyFile
		}
	}
	if selected == nil {
		return management.AuthFile{}, errors.New("resource_missing")
	}
	for _, file := range files.Files {
		if file.AuthIndex != authIndex && file.Name == selected.Name {
			return management.AuthFile{}, errors.New("credential_ambiguous")
		}
	}
	if !warmup.IsProvider(quota.DetectProvider(selected.Type, selected.Provider)) || selected.Source == "config" {
		return management.AuthFile{}, errors.New("provider_unsupported")
	}
	return *selected, nil
}
func (h *Handler) warmupSettings(ctx context.Context) (warmup.Settings, error) {
	settings := warmup.Settings{Providers: map[string]warmup.Policy{}, Models: map[string][]string{"codex": {}, "claude": {}}, Timezone: h.repo.Timezone().Location().String()}
	for _, provider := range []string{"codex", "claude"} {
		policy, _, err := h.repo.ReadWarmupPolicy(ctx, defaultInstanceID(), "provider", provider)
		if err != nil {
			return settings, err
		}
		settings.Providers[provider] = policy
	}
	settings.Revision = h.operationsService().Revision(settings.Providers)
	if h.cfg.IsDemoMode {
		settings.Revision = "demo-warmup-settings"
	}
	return settings, nil
}
func (h *Handler) warmupCredential(ctx context.Context, client *management.Client, file management.AuthFile, readModels bool) (warmup.Credential, error) {
	provider := quota.DetectProvider(file.Type, file.Provider)
	policy, hasOverride, err := h.repo.ReadWarmupPolicy(ctx, defaultInstanceID(), "credential", h.warmupPolicyTarget(file))
	if err != nil {
		return warmup.Credential{}, err
	}
	if !hasOverride {
		policy, _, err = h.repo.ReadWarmupPolicy(ctx, defaultInstanceID(), "provider", provider)
		if err != nil {
			return warmup.Credential{}, err
		}
	}
	state, err := h.repo.ReadWarmupState(ctx, defaultInstanceID(), file.AuthIndex)
	if err != nil {
		return warmup.Credential{}, err
	}
	if state.CredentialID != h.warmupCredentialIdentity(file) || state.Provider != provider {
		state = warmup.State{CredentialID: h.warmupCredentialIdentity(file), Provider: provider}
	}
	if state.LastResult != nil && state.LastResult.Status == "executing" && !h.warmupRuntime.isRunning(file.AuthIndex) {
		state.LastResult.Status = "uncertain"
		state.LastResult.Reason = "outcome_unknown"
	}
	credential := warmup.Credential{AuthIndex: file.AuthIndex, Name: file.Name, Provider: provider, IsInherited: !hasOverride, Policy: policy, State: state, Timezone: h.repo.Timezone().Location().String(), Models: []string{}}
	if readModels {
		models, err := client.AuthFileModels(ctx, file.Name)
		if err != nil {
			return credential, err
		}
		for _, model := range models {
			if model.ID != "" && len(model.ID) <= 200 && len(credential.Models) < 64 {
				credential.Models = append(credential.Models, model.ID)
			}
		}
		slices.Sort(credential.Models)
		credential.Models = slices.Compact(credential.Models)
	}
	credential.Revision = h.operationsService().Revision(struct {
		Identity      string
		AuthIndex     string
		Provider      string
		Name          string
		IsDisabled    bool
		IsUnavailable bool
		Policy        warmup.Policy
		IsInherited   bool
	}{h.warmupCredentialIdentity(file), file.AuthIndex, provider, file.Name, file.Disabled, file.Unavailable, policy, !hasOverride})
	if h.cfg.IsDemoMode {
		credential.Revision = "demo-warmup-credential"
		credential.State.CredentialID = "demo-credential/" + file.AuthIndex
	}
	_, credential.Reason, _, credential.NextAtMS = warmup.Decide(policy, state, h.now().In(h.repo.Timezone().Location()), false)
	if file.Disabled {
		credential.Reason = "credential_disabled"
	}
	if file.Unavailable {
		credential.Reason = "credential_unavailable"
	}
	return credential, nil
}
func (h *Handler) getWarmupSettings(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	settings, err := h.warmupSettings(request.Context())
	if err != nil {
		writeWarmupError(writer, err)
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	files, err := client.AuthFiles(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	for _, file := range files.Files {
		provider := quota.DetectProvider(file.Type, file.Provider)
		if !warmup.IsProvider(provider) || file.Source == "config" {
			continue
		}
		models := file.Models
		if len(models) == 0 && len(settings.Models[provider]) == 0 {
			if listed, readErr := client.AuthFileModels(request.Context(), file.Name); readErr == nil {
				models = listed
			}
		}
		for _, model := range models {
			if model.ID != "" && len(model.ID) <= 200 && len(settings.Models[provider]) < 64 {
				settings.Models[provider] = append(settings.Models[provider], model.ID)
			}
		}
	}
	for provider, models := range settings.Models {
		slices.Sort(models)
		settings.Models[provider] = slices.Compact(models)
	}
	writeJSON(writer, http.StatusOK, settings)
}
func (h *Handler) saveWarmupSettings(ctx context.Context, input warmup.PolicyWrite) (warmup.Settings, error) {
	if h.cfg.IsDemoMode {
		return warmup.Settings{}, errors.New("demo_operation_refused")
	}
	if !input.IsConfirmed || !warmup.IsProvider(input.Provider) || input.Policy.Validate() != nil {
		return warmup.Settings{}, warmup.ErrInvalidPolicy
	}
	if err := h.providerWrites.acquire(ctx); err != nil {
		return warmup.Settings{}, err
	}
	defer h.providerWrites.release()
	settings, err := h.warmupSettings(ctx)
	if err != nil {
		return settings, err
	}
	if input.Revision == "" || input.Revision != settings.Revision {
		return settings, errors.New("resource_conflict")
	}
	if err = h.auditWarmup(ctx, "warmup.settings", input.Provider, "attempt", map[string]any{"policy": input.Policy}); err != nil {
		return settings, err
	}
	if err = h.repo.WriteWarmupPolicy(ctx, defaultInstanceID(), "provider", input.Provider, &input.Policy, h.now().UnixMilli()); err != nil {
		return settings, err
	}
	_ = h.auditWarmup(ctx, "warmup.settings", input.Provider, "success", nil)
	return h.warmupSettings(ctx)
}
func (h *Handler) putWarmupSettings(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var input warmup.PolicyWrite
	if decodeManagementJSON(writer, request, 8192, &input) != nil {
		return
	}
	result, err := h.saveWarmupSettings(request.Context(), input)
	if err != nil {
		writeWarmupError(writer, err)
		return
	}
	writeJSON(writer, 200, result)
}
func (h *Handler) getWarmupCredential(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	file, err := h.warmupFile(request.Context(), client, chi.URLParam(request, "authIndex"))
	if err != nil {
		writeWarmupError(writer, err)
		return
	}
	result, err := h.warmupCredential(request.Context(), client, file, true)
	if err != nil {
		writeWarmupError(writer, err)
		return
	}
	writeJSON(writer, 200, result)
}
func (h *Handler) saveWarmupCredential(ctx context.Context, authIndex string, input warmup.CredentialWrite) (warmup.Credential, error) {
	if h.cfg.IsDemoMode {
		return warmup.Credential{}, errors.New("demo_operation_refused")
	}
	if !input.IsConfirmed || (!input.IsInherited && input.Policy.Validate() != nil) {
		return warmup.Credential{}, warmup.ErrInvalidPolicy
	}
	if err := h.providerWrites.acquire(ctx); err != nil {
		return warmup.Credential{}, err
	}
	defer h.providerWrites.release()
	if !h.warmupRuntime.acquire(authIndex) {
		return warmup.Credential{}, warmup.ErrBusy
	}
	defer h.warmupRuntime.release(authIndex)
	client, err := h.capabilityClient(ctx)
	if err != nil {
		return warmup.Credential{}, err
	}
	file, err := h.warmupFile(ctx, client, authIndex)
	if err != nil {
		return warmup.Credential{}, err
	}
	credential, err := h.warmupCredential(ctx, client, file, true)
	if err != nil {
		return credential, err
	}
	if input.Revision == "" || input.Revision != credential.Revision {
		return credential, errors.New("resource_conflict")
	}
	if !input.IsInherited && input.Policy.Model != "" && !slices.Contains(credential.Models, input.Policy.Model) {
		return credential, errors.New("model_unavailable")
	}
	if err = h.auditWarmup(ctx, "warmup.credential", authIndex, "attempt", map[string]any{"inherit": input.IsInherited, "policy": input.Policy}); err != nil {
		return credential, err
	}
	policy := &input.Policy
	if input.IsInherited {
		policy = nil
	}
	if err = h.repo.WriteWarmupPolicy(ctx, defaultInstanceID(), "credential", h.warmupPolicyTarget(file), policy, h.now().UnixMilli()); err != nil {
		return credential, err
	}
	_ = h.auditWarmup(ctx, "warmup.credential", authIndex, "success", nil)
	return h.warmupCredential(ctx, client, file, true)
}
func (h *Handler) putWarmupCredential(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var input warmup.CredentialWrite
	if decodeManagementJSON(writer, request, 8192, &input) != nil {
		return
	}
	result, err := h.saveWarmupCredential(request.Context(), chi.URLParam(request, "authIndex"), input)
	if err != nil {
		writeWarmupError(writer, err)
		return
	}
	writeJSON(writer, 200, result)
}
func (h *Handler) postWarmupRun(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var input struct {
		RequestID   string `json:"request_id"`
		Revision    string `json:"revision"`
		IsConfirmed bool   `json:"confirmed"`
	}
	if decodeManagementJSON(writer, request, 8192, &input) != nil {
		return
	}
	if !input.IsConfirmed || !validWarmupRequestID(input.RequestID) {
		writeWarmupError(writer, errors.New("invalid_parameters"))
		return
	}
	result, err := h.executeWarmup(request.Context(), chi.URLParam(request, "authIndex"), input.RequestID, input.Revision, true)
	if err != nil {
		writeWarmupError(writer, err)
		return
	}
	writeJSON(writer, 200, result)
}
func validWarmupRequestID(requestID string) bool {
	return len(requestID) >= 8 && len(requestID) <= 128 && strings.TrimSpace(requestID) == requestID && !strings.ContainsAny(requestID, "\r\n\x00") && !strings.HasPrefix(requestID, "auto/")
}
func (h *Handler) auditWarmup(ctx context.Context, action, authIndex, result string, details map[string]any) error {
	_, err := h.repo.RecordAuditEvent(ctx, repository.AuditEvent{Action: action, TargetType: "credential_warmup", TargetID: authIndex, Result: result, OccurredAtMS: h.now().UnixMilli(), Details: details})
	return err
}
func writeWarmupError(writer http.ResponseWriter, err error) {
	code := err.Error()
	status := http.StatusInternalServerError
	switch code {
	case "demo_operation_refused":
		status = http.StatusForbidden
	case "invalid_warmup_policy", "invalid_parameters", "provider_unsupported", "model_unavailable":
		status = http.StatusBadRequest
	case "resource_missing":
		status = http.StatusNotFound
	case "resource_conflict", "credential_ambiguous", "warmup_busy":
		status = http.StatusConflict
	default:
		if errors.Is(err, errProviderWriteBusy) {
			status = http.StatusConflict
			code = "warmup_busy"
		} else {
			code = "warmup_unavailable"
		}
	}
	writeJSON(writer, status, map[string]string{"code": code, "error": code})
}

func (h *Handler) refreshWarmupObservation(ctx context.Context, client *management.Client, file management.AuthFile) (*warmup.Observation, error) {
	service := quota.NewServiceWithClock(client, h.now)
	reading, err := h.refreshQuotaReading(ctx, service, file, h.loadPriorNormalizedQuota(ctx, file.AuthIndex))
	if err != nil || reading == nil || reading.Error != "" || reading.Status == "error" || reading.Status == "stale" || reading.WarmupEvidence == nil {
		return nil, errors.New("quota_unknown")
	}
	if err = h.persistNormalizedQuotaSnapshot(ctx, reading); err != nil {
		return nil, err
	}
	return reading.WarmupEvidence, nil
}
func isWarmupActivated(before, after *warmup.Observation) bool {
	if before == nil || after == nil || after.ObservedAtMS <= before.ObservedAtMS {
		return false
	}
	for _, pair := range [][2]warmup.Window{{before.FiveHour, after.FiveHour}, {before.Weekly, after.Weekly}} {
		// An idle Codex window slides: its reset tracks each read, so between reads
		// it moves by the elapsed time. A window the warmup started is frozen at
		// send time and moved only by the delay between the first read and the
		// send. Requiring that delay to be under a second rejected real starts.
		if pair[0].State == "idle" && pair[0].ResetAtMS != nil && pair[1].ResetAtMS != nil && pair[1].UsedPercent != nil && *pair[1].UsedPercent == 0 {
			elapsed := after.ObservedAtMS - before.ObservedAtMS
			drift := *pair[1].ResetAtMS - *pair[0].ResetAtMS
			if elapsed < 30000 || drift < -1000 || drift > elapsed-5000 {
				return false
			}
		}
	}
	return after.PaidFallback == "disabled" && (before.FiveHour.State != "idle" || after.FiveHour.State == "active") && (before.Weekly.State != "idle" || after.Weekly.State == "active") && (before.FiveHour.State == "idle" || before.Weekly.State == "idle")
}
func (h *Handler) persistWarmupResult(ctx context.Context, authIndex string, state warmup.State, result warmup.Result) error {
	// Latest receipts change during a recheck; the model's refusal survives until activation.
	state.ProtocolPause = state.ReadProtocolPause()
	if result.Reason == "protocol_unsupported" || result.Reason == "unexpected_tool" {
		state.ProtocolPause = &warmup.ProtocolPause{Model: result.Model, Reason: result.Reason}
	} else if result.Status == "activated" && state.ProtocolPause != nil && state.ProtocolPause.Model == result.Model {
		state.ProtocolPause = nil
	}
	// A non-consuming refusal must not erase unresolved or unsupported-model evidence.
	if result.Status != "skipped" || state.LastResult == nil {
		state.LastResult = &result
	}
	if err := h.repo.WriteWarmupState(ctx, defaultInstanceID(), authIndex, state, h.now().UnixMilli()); err != nil {
		return err
	}
	return h.repo.WriteWarmupRun(ctx, defaultInstanceID(), authIndex, result)
}

func (h *Handler) executeWarmup(ctx context.Context, authIndex, requestID, revision string, isManual bool) (warmup.Result, error) {
	if h.cfg.IsDemoMode {
		return warmup.Result{}, errors.New("demo_operation_refused")
	}
	if !h.warmupRuntime.acquire(authIndex) {
		return warmup.Result{}, warmup.ErrBusy
	}
	defer h.warmupRuntime.release(authIndex)
	if requestID != "" {
		previous, err := h.repo.ReadWarmupRun(ctx, defaultInstanceID(), authIndex, requestID)
		if err != nil {
			return warmup.Result{}, err
		}
		if previous != nil {
			if previous.Status == "executing" {
				previous.Status = "uncertain"
				previous.Reason = "outcome_unknown"
			}
			return *previous, nil
		}
	}
	client, err := h.capabilityClient(ctx)
	if err != nil {
		return warmup.Result{}, err
	}
	file, err := h.warmupFile(ctx, client, authIndex)
	if err != nil {
		return warmup.Result{}, err
	}
	credential, err := h.warmupCredential(ctx, client, file, true)
	if err != nil {
		return warmup.Result{}, err
	}

	if isManual && (revision == "" || revision != credential.Revision) {
		return warmup.Result{}, errors.New("resource_conflict")
	}
	state := credential.State
	now := h.now().In(h.repo.Timezone().Location())
	result := warmup.Result{RequestID: requestID, Status: "skipped", Model: credential.Policy.Model, Trigger: "manual", StartedAtMS: now.UnixMilli()}
	finish := func(reason string) (warmup.Result, error) {
		result.Reason = reason
		result.FinishedAtMS = h.now().UnixMilli()
		if result.RequestID == "" {
			return result, nil
		}
		return result, h.persistWarmupResult(ctx, authIndex, state, result)
	}
	if file.Disabled {
		return finish("credential_disabled")
	}
	if file.Unavailable {
		return finish("credential_unavailable")
	}
	if credential.Policy.Model == "" {
		return finish("model_required")
	}
	if !slices.Contains(credential.Models, credential.Policy.Model) {
		return finish("model_unavailable")
	}
	if cooldowns, err := h.repo.BatchCorrelatedCooldowns(ctx, []string{authIndex}, h.now().UnixMilli()); err != nil {
		return warmup.Result{}, err
	} else if cooldowns[authIndex].IsActive {
		return finish("cooldown")
	}
	priorReading := h.loadPriorNormalizedQuota(ctx, authIndex)
	before, err := h.refreshWarmupObservation(ctx, client, file)
	if err != nil {
		return finish("quota_unknown")
	}
	if priorReading != nil && priorReading.WarmupEvidence != nil && priorReading.WarmupEvidence.ObservedAtMS < before.ObservedAtMS {
		state = warmup.Reconcile(state, *priorReading.WarmupEvidence)
	}
	state = warmup.Reconcile(state, *before)
	before = state.Observation
	if state.LastResult != nil && state.LastCycle == fmt.Sprintf("cycle/%d", state.Generation) && (state.LastResult.Status == "pending" || state.LastResult.Status == "uncertain" || state.LastResult.Status == "executing") {
		previous := *state.LastResult
		if previous.Status == "pending" && isWarmupActivated(state.ActivationBasis, before) {
			previous.Status = "activated"
			state.LastCycle = fmt.Sprintf("cycle/%d", state.Generation)
			state.VerifiedModel = previous.Model
			previous.Reason = ""
			state.IsProtocolVerified = true
		}
		// A pending run keeps confirming in the scheduler; a second click must
		// neither send again nor cut that confirmation short.
		if previous.Status == "executing" {
			previous.Status = "uncertain"
			previous.Reason = "outcome_unknown"
		}
		if err := h.persistWarmupResult(ctx, authIndex, state, previous); err != nil {
			return warmup.Result{}, err
		}
		// This receipt refuses the new request without overwriting the observed prior run.
		result.Reason = "outcome_unknown"
		switch previous.Status {
		case "pending":
			result.Reason = "activation_pending"
		case "activated":
			result.Reason = "already_active"
		}
		result.FinishedAtMS = h.now().UnixMilli()
		if result.RequestID == "" {
			return result, nil
		}
		return result, h.repo.WriteWarmupRun(ctx, defaultInstanceID(), authIndex, result)
	}
	trigger, reason, cycle, _ := warmup.Decide(credential.Policy, state, now, isManual)
	if trigger == "" {
		if strings.HasPrefix(cycle, "daily/") {
			state.DailyKey = warmup.DailyKey(credential.Policy.DailyTime, now)
			_ = h.repo.WriteWarmupState(ctx, defaultInstanceID(), authIndex, state, now.UnixMilli())
		}
		return finish(reason)
	}
	if state.LastCycle == fmt.Sprintf("cycle/%d", state.Generation) && !isManual {
		return finish("already_attempted")
	}
	if state.LastCycle == fmt.Sprintf("cycle/%d", state.Generation) && state.LastResult != nil && state.LastResult.Status == "activated" && isManual {
		return finish("already_active")
	}
	if requestID == "" {
		result.RequestID = fmt.Sprintf("auto/%s/attempt/%d", cycle, state.Failures)
	}
	result.Trigger = trigger
	result.Status = "executing"
	if err = h.auditWarmup(ctx, "warmup.run", authIndex, "attempt", map[string]any{"model": result.Model, "trigger": trigger, "request_id": result.RequestID}); err != nil {
		return result, err
	}
	previousCycle, previousDailyKey, previousBasis := state.LastCycle, state.DailyKey, state.ActivationBasis
	state.ActivationBasis = before
	state.LastCycle = fmt.Sprintf("cycle/%d", state.Generation)
	if trigger == "daily" {
		state.DailyKey = warmup.DailyKey(credential.Policy.DailyTime, now)
	}
	if err = h.persistWarmupResult(ctx, authIndex, state, result); err != nil {
		return result, err
	}
	// Revalidate identity and policy after admission, before any consuming request.
	currentFile, err := h.warmupFile(ctx, client, authIndex)
	if err != nil || h.warmupCredentialIdentity(currentFile) != h.warmupCredentialIdentity(file) || currentFile.Disabled || currentFile.Unavailable {
		state.LastCycle, state.DailyKey, state.ActivationBasis = previousCycle, previousDailyKey, previousBasis
		result.Status = "failed"
		return finish("resource_conflict")
	}
	current, err := h.warmupCredential(ctx, client, currentFile, false)
	if err != nil || current.Policy != credential.Policy {
		state.LastCycle, state.DailyKey, state.ActivationBasis = previousCycle, previousDailyKey, previousBasis
		result.Status = "failed"
		return finish("resource_conflict")
	}
	outcome := warmup.Send(ctx, client, file, credential.Provider, credential.Policy.Model)
	result.Status = outcome.Status
	result.Reason = outcome.Reason
	result.InputTokens = outcome.InputTokens
	result.OutputTokens = outcome.OutputTokens
	result.FinishedAtMS = h.now().UnixMilli()
	if outcome.Status == "pending" {
		after, readErr := h.refreshWarmupObservation(ctx, client, file)
		state.VerificationReads = 1
		if readErr == nil {
			if isWarmupActivated(before, after) {
				result.Status = "activated"
				result.Reason = ""
				state.IsProtocolVerified = true
				state.VerifiedModel = credential.Policy.Model
			}
			state = warmup.Reconcile(state, *after)
			state.LastCycle = fmt.Sprintf("cycle/%d", state.Generation)
		}
	}
	if outcome.Status == "failed" && outcome.Reason == "rate_limited" {
		state.Failures++
		if state.Failures <= 3 {
			delays := []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute}
			state.NextAttemptMS = h.now().Add(delays[state.Failures-1]).UnixMilli()
			state.LastCycle = ""
		}
	} else {
		state.NextAttemptMS = 0
		state.Failures = 0
	}
	// A consumed request must not become a plain retryable error if persistence fails.
	finalCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err = h.persistWarmupResult(finalCtx, authIndex, state, result); err != nil {
		return warmup.Result{RequestID: result.RequestID, Status: "uncertain", Reason: "outcome_unknown", Model: result.Model, Trigger: trigger, StartedAtMS: result.StartedAtMS}, nil
	}
	_ = h.auditWarmup(finalCtx, "warmup.run", authIndex, result.Status, map[string]any{"reason": result.Reason, "request_id": result.RequestID})
	return result, nil
}

func (h *Handler) RunCredentialWarmup(ctx context.Context) error {
	if h.cfg.IsDemoMode {
		return nil
	}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	return h.runCredentialWarmupTicks(ctx, ticker.C)
}

func (h *Handler) runCredentialWarmupTicks(ctx context.Context, ticks <-chan time.Time) error {
	// Recovery must complete before a consuming round, but transient database
	// failures must not remove the scheduler until the process is restarted.
	recoverExecution := func() bool {
		if err := h.recoverWarmupExecution(ctx); err != nil {
			if ctx.Err() == nil {
				h.logger.Warn("credential warmup recovery unavailable", "error", err)
			}
			return false
		}
		return true
	}
	hasRecovered := recoverExecution()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticks:
			if !hasRecovered {
				hasRecovered = recoverExecution()
				if !hasRecovered {
					continue
				}
			}
			if err := h.runCredentialWarmupRound(ctx); err != nil {
				h.logger.Warn("credential warmup round unavailable")
			}
		}
	}
}
func (h *Handler) runCredentialWarmupRound(ctx context.Context) error {
	_, err := h.warmupSettings(ctx)
	if err != nil {
		return err
	}
	// Disabled defaults may still have independently enabled credential policies.
	var count int
	if err = h.repo.SQL().QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM credential_warmup_policies WHERE instance_id=?) + (SELECT COUNT(*) FROM credential_warmup_state WHERE instance_id=? AND json_extract(document_json,'$.last_result.status')='pending')`, defaultInstanceID(), defaultInstanceID()).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		return nil
	}
	client, err := h.capabilityClient(ctx)
	if err != nil {
		return err
	}
	files, err := client.AuthFiles(ctx)
	if err != nil {
		return err
	}
	counts := map[string]int{}
	for _, file := range files.Files {
		counts[file.AuthIndex]++
	}
	attemptOrder := map[string]int64{}
	for _, file := range files.Files {
		state, readErr := h.repo.ReadWarmupState(ctx, defaultInstanceID(), file.AuthIndex)
		if readErr != nil {
			return readErr
		}
		observed := int64(0)
		if state.Observation != nil {
			observed = state.Observation.ObservedAtMS
		}
		if state.NextAttemptMS > observed {
			observed = state.NextAttemptMS
		}
		attemptOrder[file.AuthIndex] = observed
	}
	slices.SortStableFunc(files.Files, func(first, second management.AuthFile) int {
		if attemptOrder[first.AuthIndex] < attemptOrder[second.AuthIndex] {
			return -1
		}
		if attemptOrder[first.AuthIndex] > attemptOrder[second.AuthIndex] {
			return 1
		}
		return strings.Compare(first.AuthIndex, second.AuthIndex)
	})

	semaphore := make(chan struct{}, 4)
	var workers sync.WaitGroup
	processed := 0
	for _, file := range files.Files {
		if processed >= 16 {
			break
		}
		if counts[file.AuthIndex] != 1 || file.AuthIndex == "" || file.Disabled || file.Unavailable || !warmup.IsProvider(quota.DetectProvider(file.Type, file.Provider)) || file.Source == "config" {
			continue
		}
		credential, err := h.warmupCredential(ctx, client, file, false)
		if err != nil {
			continue
		}
		pendingPolicy := credential.State.LastResult != nil && credential.State.LastResult.Status == "pending"
		if !credential.Policy.IsEnabled() && !pendingPolicy {
			continue
		}
		state := credential.State
		now := h.now().In(h.repo.Timezone().Location())
		isPending := state.LastResult != nil && (state.LastResult.Status == "pending" || state.LastResult.Status == "executing")
		if !isPending && state.NextAttemptMS > now.UnixMilli() {
			continue
		}
		isFresh := state.Observation != nil && now.UnixMilli()-state.Observation.ObservedAtMS < warmup.OBSERVATION_MAX_AGE_MS
		hasElapsedReset := false
		if state.Observation != nil {
			for _, window := range []warmup.Window{state.Observation.FiveHour, state.Observation.Weekly} {
				if window.ResetAtMS != nil && *window.ResetAtMS <= now.UnixMilli() {
					hasElapsedReset = true
				}
			}
		}
		trigger, _, cycle, next := warmup.Decide(credential.Policy, state, now, false)
		latest := h.loadPriorNormalizedQuota(ctx, file.AuthIndex)
		hasNewReading := latest != nil && latest.WarmupEvidence != nil && (state.Observation == nil || latest.WarmupEvidence.ObservedAtMS > state.Observation.ObservedAtMS)
		if !isPending && !hasNewReading && !hasElapsedReset && !strings.HasPrefix(cycle, "daily/") && isFresh && trigger == "" && (next == nil || *next > now.UnixMilli()) {
			continue
		}
		processed++
		semaphore <- struct{}{}
		workers.Add(1)
		go func(file management.AuthFile, credential warmup.Credential) {
			defer workers.Done()
			defer func() { <-semaphore }()
			if !h.warmupRuntime.acquire(file.AuthIndex) {
				return
			}
			state := credential.State
			reading := h.loadPriorNormalizedQuota(ctx, file.AuthIndex)
			observation := (*warmup.Observation)(nil)
			if reading != nil && reading.WarmupEvidence != nil && h.now().UnixMilli()-reading.WarmupEvidence.ObservedAtMS < warmup.OBSERVATION_MAX_AGE_MS {
				observation = reading.WarmupEvidence
			}
			isPending := state.LastResult != nil && (state.LastResult.Status == "pending" || state.LastResult.Status == "executing")
			if observation == nil || isPending {
				observation, _ = h.refreshWarmupObservation(ctx, client, file)
			}
			if observation == nil {
				state.NextAttemptMS = h.now().Add(5 * time.Minute).UnixMilli()
				_ = h.repo.WriteWarmupState(ctx, defaultInstanceID(), file.AuthIndex, state, h.now().UnixMilli())
				h.warmupRuntime.release(file.AuthIndex)
				return
			}
			state = warmup.Reconcile(state, *observation)
			observation = state.Observation
			if isPending {
				result := *state.LastResult
				if result.Status == "executing" {
					result.Status = "uncertain"
					result.Reason = "outcome_unknown"
				} else if isWarmupActivated(state.ActivationBasis, observation) {
					result.Status = "activated"
					state.LastCycle = fmt.Sprintf("cycle/%d", state.Generation)
					result.Reason = ""
					state.IsProtocolVerified = true
					state.VerifiedModel = result.Model
				} else {
					state.VerificationReads++
					if state.VerificationReads >= 3 {
						result.Status = "uncertain"
						result.Reason = "activation_unconfirmed"
					}
				}
				_ = h.persistWarmupResult(ctx, file.AuthIndex, state, result)
				h.warmupRuntime.release(file.AuthIndex)
				return
			}
			saveErr := h.repo.WriteWarmupState(ctx, defaultInstanceID(), file.AuthIndex, state, h.now().UnixMilli())
			h.warmupRuntime.release(file.AuthIndex)
			if saveErr != nil {
				return
			}
			_, _ = h.executeWarmup(ctx, file.AuthIndex, "", "", false)
		}(file, credential)
	}
	workers.Wait()
	return nil
}

func (h *Handler) recoverWarmupExecution(ctx context.Context) error {
	rows, err := h.repo.SQL().QueryContext(ctx, `SELECT auth_index FROM credential_warmup_state WHERE instance_id=? AND json_extract(document_json,'$.last_result.status')='executing'`, defaultInstanceID())
	if err != nil {
		return err
	}
	authIndexes := []string{}
	for rows.Next() {
		var authIndex string
		if err = rows.Scan(&authIndex); err != nil {
			rows.Close()
			return err
		}
		authIndexes = append(authIndexes, authIndex)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, authIndex := range authIndexes {
		if !h.warmupRuntime.acquire(authIndex) {
			continue
		}
		state, readErr := h.repo.ReadWarmupState(ctx, defaultInstanceID(), authIndex)
		if readErr == nil && state.LastResult != nil && state.LastResult.Status == "executing" {
			result := *state.LastResult
			result.Status = "uncertain"
			result.Reason = "outcome_unknown"
			readErr = h.persistWarmupResult(ctx, authIndex, state, result)
		}
		h.warmupRuntime.release(authIndex)
		if readErr != nil {
			return readErr
		}
	}
	return nil
}
