package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

const (
	warmupBodyLimit      = 16 << 10
	warmupInstanceID     = "default"
	warmupLoopInterval   = time.Minute
	warmupModelCacheTTL  = 5 * time.Minute
	warmupRequestTimeout = 30 * time.Second
	// A failed quota read waits this long instead of repeating on the next minute tick, so a
	// provider that stays unreachable does not cost one request per credential per minute.
	warmupRefreshBackoff = 5 * time.Minute
)

var (
	errWarmupTaskNotFound = errors.New("warmup task not found")
	errWarmupTaskBusy     = errors.New("warmup task already running")
)

type warmupRuntime struct {
	mu          sync.Mutex
	recovered   bool
	runningTask map[string]bool
	models      map[string]warmupModelCacheEntry
	// fileModels caches one credential's model list by file name, because a catalog build
	// asks for the same credential twice: once for the account and again for the provider scan.
	fileModels map[string]warmupModelCacheEntry
	// refreshBackoff holds the auth indices whose quota read failed, until the next attempt.
	refreshBackoff map[string]time.Time
	// aliasRules caches the OAuth model aliases CPA applies: one entry per credential file, read
	// by downloading it, and the provider-wide map under warmupGlobalAliasKey.
	aliasRules map[string]warmupAliasCacheEntry
	// prices is the price book as warmup reads it, so a model choice costs no query per build.
	prices *warmupPriceIndex
}

// warmupPriceIndex answers "what does one request cost" per model, which is what makes the
// cheapest warmup model a price-book fact rather than a guess about its name.
type warmupPriceIndex struct {
	// shared and per-channel rates by normalized model identity, in USD per million tokens for
	// one request's input and output together.
	shared    map[string]float64
	byChannel map[string]map[string]float64
	expiresAt time.Time
}

// warmupGlobalAliasKey holds the provider-wide alias map; a credential file name is never empty.
const warmupGlobalAliasKey = ""

type warmupAliasCacheEntry struct {
	credential []management.OAuthModelAlias
	global     map[string][]management.OAuthModelAlias
	expiresAt  time.Time
}

type warmupModelCacheEntry struct {
	models    []string
	expiresAt time.Time
}

func (h *Handler) getWarmupSettings(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	state, err := h.warmupState(request.Context())
	if err != nil {
		h.writeWarmupError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, state)
}

func (h *Handler) createWarmupTask(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var input warmup.TaskInput
	if err := decodeManagementJSON(writer, request, warmupBodyLimit, &input); err != nil {
		return
	}
	state, err := h.saveWarmupTask(request.Context(), "", input)
	if err != nil {
		h.writeWarmupError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, state)
}

func (h *Handler) updateWarmupTask(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id := strings.TrimSpace(chi.URLParam(request, "id"))
	if id == "" {
		writeWarmupJSONError(writer, http.StatusBadRequest, "invalid_parameters")
		return
	}
	var input warmup.TaskInput
	if err := decodeManagementJSON(writer, request, warmupBodyLimit, &input); err != nil {
		return
	}
	state, err := h.saveWarmupTask(request.Context(), id, input)
	if err != nil {
		h.writeWarmupError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, state)
}

func (h *Handler) deleteWarmupTask(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id := strings.TrimSpace(chi.URLParam(request, "id"))
	if id == "" {
		writeWarmupJSONError(writer, http.StatusBadRequest, "invalid_parameters")
		return
	}
	state, err := h.removeWarmupTask(request.Context(), id)
	if err != nil {
		h.writeWarmupError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, state)
}

func (h *Handler) runWarmupTask(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id := strings.TrimSpace(chi.URLParam(request, "id"))
	if id == "" {
		writeWarmupJSONError(writer, http.StatusBadRequest, "invalid_parameters")
		return
	}
	result, err := h.triggerWarmupTask(request.Context(), id)
	if err != nil {
		h.writeWarmupError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

// clearWarmupRuns empties the run history; repeated task_id parameters narrow it to those tasks.
func (h *Handler) clearWarmupRuns(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	requested, namesTasks := request.URL.Query()["task_id"]
	taskIDs := make([]string, 0, len(requested))
	for _, raw := range requested {
		if id := strings.TrimSpace(raw); id != "" {
			taskIDs = append(taskIDs, id)
		}
	}
	// A request that names tasks has to name one: an empty selection would otherwise read as
	// "every task" and delete the whole history.
	if namesTasks && len(taskIDs) == 0 {
		writeWarmupJSONError(writer, http.StatusBadRequest, "invalid_parameters")
		return
	}
	state, err := h.removeWarmupRuns(request.Context(), taskIDs)
	if err != nil {
		h.writeWarmupError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, state)
}

func writeWarmupJSONError(writer http.ResponseWriter, status int, code string) {
	writeJSON(writer, status, map[string]string{
		"code":  code,
		"error": code,
	})
}

func (h *Handler) writeWarmupError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errWarmupTaskNotFound):
		writeWarmupJSONError(writer, http.StatusNotFound, "resource_not_found")
	case errors.Is(err, errWarmupTaskBusy):
		writeWarmupJSONError(writer, http.StatusConflict, "resource_conflict")
	case err != nil && (strings.HasPrefix(err.Error(), "invalid_") || strings.HasPrefix(err.Error(), "missing_")):
		writeWarmupJSONError(writer, http.StatusBadRequest, "invalid_parameters")
	default:
		writeWarmupJSONError(writer, http.StatusServiceUnavailable, "warmup_unavailable")
	}
}

func (h *Handler) warmupState(ctx context.Context) (warmup.StateView, error) {
	if h.repo == nil {
		return warmup.StateView{}, errors.New("repository unavailable")
	}
	h.recoverWarmupRunsOnce(ctx)
	var client *management.Client
	if c, err := h.capabilityClient(ctx); err == nil {
		client = c
	}
	catalog, _ := h.warmupCatalogWithFiles(ctx, client)
	return h.buildWarmupStateView(ctx, &catalog)
}

func (h *Handler) buildWarmupStateView(ctx context.Context, catalog *warmup.Catalog) (warmup.StateView, error) {
	tasks, err := h.repo.ListWarmupTasks(ctx, warmupInstanceID)
	if err != nil {
		return warmup.StateView{}, err
	}
	marksMap, err := h.repo.ListWarmupMarks(ctx, warmupInstanceID)
	if err != nil {
		return warmup.StateView{}, err
	}
	runs, err := h.repo.ListWarmupRuns(ctx, warmupInstanceID)
	if err != nil {
		return warmup.StateView{}, err
	}
	now := h.now().UTC()
	next := make(map[string]*string, len(tasks))
	timeline := make([]warmup.TimelineEntry, 0)

	for _, task := range tasks {
		if !task.Enabled {
			next[task.ID] = nil
			continue
		}
		account := findCatalogAccount(catalog, task)
		resolvedModel := warmup.ResolveModel(task, account)
		if resolvedModel == "" {
			resolvedModel = "Auto"
		}
		accountLabel := task.Account
		if accountLabel == "" && account != nil {
			accountLabel = account.Name
		}
		if task.Trigger.Kind == "window" {
			marks := marksMap[task.ID]
			due := warmup.CurrentWindowDue(task, account, marks, now)
			if due != nil && !slices.Contains(marks.ResetKeys, due.ResetKey) {
				at := due.At
				next[task.ID] = &at
				timeline = append(timeline, warmup.TimelineEntry{
					TaskID:   task.ID,
					TaskName: task.Name,
					At:       at,
					Account:  accountLabel,
					Model:    resolvedModel,
				})
			} else {
				next[task.ID] = nil
			}
			continue
		}
		slots := warmup.Upcoming(task.Trigger, nil, now, 3)
		if len(slots) > 0 {
			first := slots[0]
			next[task.ID] = &first
		} else {
			next[task.ID] = nil
		}
		for _, at := range slots {
			timeline = append(timeline, warmup.TimelineEntry{
				TaskID:   task.ID,
				TaskName: task.Name,
				At:       at,
				Account:  accountLabel,
				Model:    resolvedModel,
			})
		}
	}
	slices.SortFunc(timeline, func(a, b warmup.TimelineEntry) int {
		return strings.Compare(a.At, b.At)
	})
	if len(timeline) > warmup.MAX_TIMELINE {
		timeline = timeline[:warmup.MAX_TIMELINE]
	}
	return warmup.StateView{
		Tasks:    tasks,
		Runs:     runs,
		Next:     next,
		Timeline: timeline,
		Catalog:  catalog,
	}, nil
}

// normalizeWarmupTask is the task every save path validates and stores, the Agent's preview
// included: names trimmed, and a daily trigger that names no zone placed in the deployment's.
func (h *Handler) normalizeWarmupTask(input warmup.TaskInput) warmup.TaskInput {
	input.Provider = strings.ToLower(strings.TrimSpace(input.Provider))
	input.AuthIndex = strings.TrimSpace(input.AuthIndex)
	input.Account = strings.TrimSpace(input.Account)
	input.Model = strings.TrimSpace(input.Model)
	if input.Trigger.Kind == "daily" && strings.TrimSpace(input.Trigger.TimeZone) == "" {
		input.Trigger.TimeZone = h.warmupTimezoneName()
	}
	return input
}

func (h *Handler) saveWarmupTask(ctx context.Context, id string, input warmup.TaskInput) (warmup.StateView, error) {
	if h.cfg.IsDemoMode {
		return warmup.StateView{}, errors.New("demo_operation_refused")
	}
	if h.repo == nil {
		return warmup.StateView{}, errors.New("repository unavailable")
	}
	input = h.normalizeWarmupTask(input)
	if err := warmup.ValidateTask(input); err != nil {
		return warmup.StateView{}, err
	}

	var client *management.Client
	if c, err := h.capabilityClient(ctx); err == nil {
		client = c
	}
	catalog, _ := h.warmupCatalogWithFiles(ctx, client)
	if account := findCatalogAccount(&catalog, warmup.Task{Provider: input.Provider, AuthIndex: input.AuthIndex, Account: input.Account}); account != nil {
		if input.AuthIndex == "" {
			input.AuthIndex = account.AuthIndex
		}
		if input.Account == "" {
			input.Account = account.Name
		}
	}
	if input.Account == "" {
		input.Account = input.AuthIndex
	}

	now := h.now().UTC()
	nowISO := warmup.FormatISO(now)
	var task warmup.Task
	action := "warmup.task.create"
	if strings.TrimSpace(id) != "" {
		existing, err := h.repo.ReadWarmupTask(ctx, warmupInstanceID, id)
		if err != nil {
			return warmup.StateView{}, err
		}
		if existing == nil {
			return warmup.StateView{}, errWarmupTaskNotFound
		}
		task = warmup.Task{
			ID:        existing.ID,
			Name:      warmup.DefaultTaskName(input),
			Enabled:   input.Enabled,
			Provider:  input.Provider,
			AuthIndex: input.AuthIndex,
			Account:   input.Account,
			Model:     input.Model,
			Trigger:   input.Trigger,
			CreatedAt: existing.CreatedAt,
			UpdatedAt: nowISO,
		}
		action = "warmup.task.update"
	} else {
		task = warmup.Task{
			ID:        newWarmupID("t", now),
			Name:      warmup.DefaultTaskName(input),
			Enabled:   input.Enabled,
			Provider:  input.Provider,
			AuthIndex: input.AuthIndex,
			Account:   input.Account,
			Model:     input.Model,
			Trigger:   input.Trigger,
			CreatedAt: nowISO,
			UpdatedAt: nowISO,
		}
	}
	if err := h.writeWarmupAudit(ctx, action, task.ID, map[string]any{
		"enabled":    task.Enabled,
		"provider":   task.Provider,
		"auth_index": task.AuthIndex,
		"model":      task.Model,
		"trigger":    task.Trigger,
	}); err != nil {
		return warmup.StateView{}, err
	}
	if err := h.repo.WriteWarmupTask(ctx, warmupInstanceID, task, now.UnixMilli()); err != nil {
		return warmup.StateView{}, err
	}
	return h.buildWarmupStateView(ctx, &catalog)
}

func (h *Handler) removeWarmupTask(ctx context.Context, id string) (warmup.StateView, error) {
	if h.cfg.IsDemoMode {
		return warmup.StateView{}, errors.New("demo_operation_refused")
	}
	if h.repo == nil {
		return warmup.StateView{}, errors.New("repository unavailable")
	}
	existing, err := h.repo.ReadWarmupTask(ctx, warmupInstanceID, id)
	if err != nil {
		return warmup.StateView{}, err
	}
	if existing == nil {
		return warmup.StateView{}, errWarmupTaskNotFound
	}
	// A run in flight writes its record when it ends, so its task cannot be deleted under it; the
	// claim also keeps a run from starting while the task's rows go.
	if !h.claimWarmupTask(existing.ID) {
		return warmup.StateView{}, errWarmupTaskBusy
	}
	defer h.releaseWarmupTask(existing.ID)
	if err := h.writeWarmupAudit(ctx, "warmup.task.delete", existing.ID, map[string]any{
		"provider":   existing.Provider,
		"auth_index": existing.AuthIndex,
	}); err != nil {
		return warmup.StateView{}, err
	}
	if err := h.repo.DeleteWarmupTask(ctx, warmupInstanceID, existing.ID); err != nil {
		return warmup.StateView{}, err
	}
	return h.warmupState(ctx)
}

func (h *Handler) removeWarmupRuns(ctx context.Context, taskIDs []string) (warmup.StateView, error) {
	if h.cfg.IsDemoMode {
		return warmup.StateView{}, errors.New("demo_operation_refused")
	}
	if h.repo == nil {
		return warmup.StateView{}, errors.New("repository unavailable")
	}
	if err := h.writeWarmupAudit(ctx, "warmup.runs.clear", strings.Join(taskIDs, ","), map[string]any{
		"task_ids": taskIDs,
	}); err != nil {
		return warmup.StateView{}, err
	}
	if err := h.repo.ClearWarmupRuns(ctx, warmupInstanceID, taskIDs); err != nil {
		return warmup.StateView{}, err
	}
	return h.warmupState(ctx)
}

func (h *Handler) triggerWarmupTask(ctx context.Context, id string) (warmup.RunResponse, error) {
	if h.cfg.IsDemoMode {
		return warmup.RunResponse{}, errors.New("demo_operation_refused")
	}
	if h.repo == nil {
		return warmup.RunResponse{}, errors.New("repository unavailable")
	}
	task, err := h.repo.ReadWarmupTask(ctx, warmupInstanceID, id)
	if err != nil {
		return warmup.RunResponse{}, err
	}
	if task == nil {
		return warmup.RunResponse{}, errWarmupTaskNotFound
	}
	if h.isWarmupTaskRunning(task.ID) {
		return warmup.RunResponse{}, errWarmupTaskBusy
	}
	if err := h.writeWarmupAudit(ctx, "warmup.task.run", task.ID, map[string]any{
		"provider":   task.Provider,
		"auth_index": task.AuthIndex,
		"model":      task.Model,
		"source":     "manual",
	}); err != nil {
		return warmup.RunResponse{}, err
	}
	var client *management.Client
	if c, err := h.capabilityClient(ctx); err == nil {
		client = c
	}
	catalog, filesByIndex := h.warmupCatalogWithFiles(ctx, client)
	run, err := h.executeTaskRun(ctx, client, &catalog, filesByIndex, *task, "manual", "", "")
	if err != nil {
		return warmup.RunResponse{}, err
	}
	state, err := h.buildWarmupStateView(ctx, &catalog)
	if err != nil {
		return warmup.RunResponse{}, err
	}
	return warmup.RunResponse{Run: run, State: state}, nil
}

func (h *Handler) executeTaskRun(
	ctx context.Context,
	client *management.Client,
	catalog *warmup.Catalog,
	filesByIndex map[string]management.AuthFile,
	task warmup.Task,
	source, due, resetKey string,
) (warmup.Run, error) {
	if !h.claimWarmupTask(task.ID) {
		return warmup.Run{}, errWarmupTaskBusy
	}
	defer h.releaseWarmupTask(task.ID)
	// The round and the console hand over a task read moments earlier. One deleted since must not
	// send, nor one switched off since on schedule, and a run that does send uses what the task
	// names now.
	current, err := h.repo.ReadWarmupTask(ctx, warmupInstanceID, task.ID)
	if err != nil {
		return warmup.Run{}, err
	}
	if current == nil || (source != "manual" && !current.Enabled) {
		return warmup.Run{}, errWarmupTaskNotFound
	}
	task = *current

	started := h.now().UTC()
	account := findCatalogAccount(catalog, task)
	var file *management.AuthFile
	if task.AuthIndex != "" {
		if f, ok := filesByIndex[task.AuthIndex]; ok {
			file = &f
		}
	}
	if file == nil && account != nil && account.AuthIndex != "" {
		if f, ok := filesByIndex[account.AuthIndex]; ok {
			file = &f
		}
	}
	model := warmup.ResolveModel(task, account)
	accountName := task.Account
	if accountName == "" && account != nil {
		accountName = account.Name
	}
	authIndex := task.AuthIndex
	if authIndex == "" && account != nil {
		authIndex = account.AuthIndex
	}

	run := warmup.Run{
		ID:        newWarmupID("r", started),
		TaskID:    task.ID,
		TaskName:  task.Name,
		At:        warmup.FormatISO(started),
		Outcome:   "running",
		Source:    source,
		Provider:  task.Provider,
		AuthIndex: authIndex,
		Account:   accountName,
		Model:     model,
		Due:       due,
		ResetKey:  resetKey,
	}
	if run.Model == "" {
		run.Model = "Auto"
	}
	// The recorded intent is what proves this credential was about to be consumed, so a run
	// that cannot write it must not reach CPA.
	if err := h.repo.WriteWarmupRun(ctx, warmupInstanceID, run); err != nil {
		return warmup.Run{}, err
	}

	finish := func(outcome, message string) warmup.Run {
		elapsed := h.now().UTC().Sub(started).Milliseconds()
		if elapsed < 0 {
			elapsed = 0
		}
		run.Outcome = outcome
		run.Message = message
		run.MS = &elapsed
		_ = h.repo.WriteWarmupRun(context.WithoutCancel(ctx), warmupInstanceID, run)
		return run
	}

	if client == nil {
		return finish("failed", "gateway_unavailable"), nil
	}
	if file == nil {
		return finish("failed", "credential_not_found"), nil
	}
	if file.Disabled {
		return finish("failed", "credential_disabled"), nil
	}
	if file.Unavailable {
		return finish("failed", "credential_unavailable"), nil
	}
	if model == "" {
		return finish("failed", "model_unavailable"), nil
	}

	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), warmupRequestTimeout)
	outcome := warmup.Send(sendCtx, client.VerifyAuthFile, *file, model)
	cancel()

	completed := finish(outcome.Status, outcome.Reason)
	if task.Trigger.Kind == "window" && outcome.Status == "ok" {
		marks, err := h.repo.ReadWarmupMarks(context.WithoutCancel(ctx), warmupInstanceID, task.ID)
		if err == nil {
			marks.LastSent = warmup.FormatISO(h.now().UTC())
			_ = h.repo.WriteWarmupMarks(context.WithoutCancel(ctx), warmupInstanceID, task.ID, marks, h.now().UnixMilli())
		}
	}
	return completed, nil
}

func (h *Handler) RunCredentialWarmup(ctx context.Context) error {
	h.recoverWarmupRunsOnce(ctx)
	ticker := time.NewTicker(warmupLoopInterval)
	defer ticker.Stop()
	for {
		if err := h.runCredentialWarmupRound(ctx); err != nil && h.logger != nil && !errors.Is(err, context.Canceled) {
			h.logger.Warn("credential warmup round failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (h *Handler) runCredentialWarmupRound(ctx context.Context) error {
	if h.repo == nil {
		return nil
	}
	h.recoverWarmupRunsOnce(ctx)
	tasks, err := h.repo.ListWarmupTasks(ctx, warmupInstanceID)
	if err != nil {
		return err
	}
	enabled := make([]warmup.Task, 0, len(tasks))
	for _, task := range tasks {
		if task.Enabled {
			enabled = append(enabled, task)
		}
	}
	if len(enabled) == 0 {
		return nil
	}

	client, err := h.capabilityClient(ctx)
	if err != nil {
		return err
	}
	catalog, filesByIndex := h.warmupCatalogWithFiles(ctx, client)
	marksMap, err := h.repo.ListWarmupMarks(ctx, warmupInstanceID)
	if err != nil {
		return err
	}
	now := h.now().UTC()

	refreshedAny := false
	refreshedIndices := make(map[string]struct{})
	for _, task := range enabled {
		if task.Trigger.Kind != "window" {
			continue
		}
		account := findCatalogAccount(&catalog, task)
		authIndex := task.AuthIndex
		if authIndex == "" && account != nil {
			authIndex = account.AuthIndex
		}
		if authIndex == "" {
			continue
		}
		if _, already := refreshedIndices[authIndex]; already {
			continue
		}
		file, ok := filesByIndex[authIndex]
		if !ok || file.Disabled || file.Unavailable {
			continue
		}
		if h.warmupRefreshBackoffActive(authIndex, now) {
			continue
		}
		if needsWindowQuotaRefresh(task, account, marksMap[task.ID], now) {
			refreshedIndices[authIndex] = struct{}{}
			if h.refreshWarmupQuota(ctx, client, file) {
				h.clearWarmupRefreshBackoff(authIndex)
				refreshedAny = true
			} else {
				h.deferWarmupRefresh(authIndex, now)
			}
		}
	}
	if refreshedAny {
		catalog, filesByIndex = h.warmupCatalogWithFiles(ctx, client)
	}

	now = h.now().UTC()
	for _, task := range enabled {
		if h.isWarmupTaskRunning(task.ID) {
			continue
		}
		marks := marksMap[task.ID]
		if task.Trigger.Kind == "window" {
			account := findCatalogAccount(&catalog, task)
			win := warmup.FindAccountWindow(account, task.Trigger.Window)
			due := warmup.CurrentWindowDue(task, account, marks, now)
			if due != nil && !due.Idle && win != nil && win.ResetsAt != "" && marks.LastReset != win.ResetsAt {
				marks.LastReset = win.ResetsAt
				marksMap[task.ID] = marks
				_ = h.repo.WriteWarmupMarks(ctx, warmupInstanceID, task.ID, marks, now.UnixMilli())
			}
			if due == nil || slices.Contains(marks.ResetKeys, due.ResetKey) {
				continue
			}
			dueTime, ok := warmup.ParseISO(due.At)
			if !ok || dueTime.After(now) {
				continue
			}
			marks.ResetKeys = append(marks.ResetKeys, due.ResetKey)
			if len(marks.ResetKeys) > warmup.MAX_RESET_KEYS {
				marks.ResetKeys = marks.ResetKeys[len(marks.ResetKeys)-warmup.MAX_RESET_KEYS:]
			}
			marksMap[task.ID] = marks
			if err := h.repo.WriteWarmupMarks(ctx, warmupInstanceID, task.ID, marks, now.UnixMilli()); err != nil {
				continue
			}
			if _, err := h.executeTaskRun(ctx, client, &catalog, filesByIndex, task, "schedule", due.At, due.ResetKey); err != nil {
				h.reportSkippedWarmup(task, err)
			}
			continue
		}

		dueTime, ok := warmup.LastDue(now, task.Trigger)
		if !ok {
			continue
		}
		floorISO := maxISOString(marks.LastDue, task.UpdatedAt)
		if floorTime, ok := warmup.ParseISO(floorISO); ok && !dueTime.After(floorTime) {
			continue
		}
		source := "schedule"
		if now.Sub(dueTime) > warmup.CATCHUP_LAG {
			source = "catchup"
		}
		dueISO := warmup.FormatISO(dueTime)
		marks.LastDue = dueISO
		marksMap[task.ID] = marks
		if err := h.repo.WriteWarmupMarks(ctx, warmupInstanceID, task.ID, marks, now.UnixMilli()); err != nil {
			continue
		}
		if _, err := h.executeTaskRun(ctx, client, &catalog, filesByIndex, task, source, dueISO, ""); err != nil {
			h.reportSkippedWarmup(task, err)
		}
	}
	return nil
}

// reportSkippedWarmup names a scheduled run that never left. The round has already advanced the
// task's marks by the time the run is attempted, so a discarded error would hide both the cause
// and the fact that this window or due slot was passed over.
func (h *Handler) reportSkippedWarmup(task warmup.Task, err error) {
	// A run already in flight, or a task withdrawn since the round read it, is the round's own
	// guard working, not a skipped slot.
	if errors.Is(err, errWarmupTaskBusy) || errors.Is(err, errWarmupTaskNotFound) || h.logger == nil {
		return
	}
	h.logger.Warn("warmup run was not sent", "task", task.ID, "error", err)
}

func needsWindowQuotaRefresh(task warmup.Task, account *warmup.CatalogAccount, marks warmup.TaskMarks, now time.Time) bool {
	if account == nil || strings.TrimSpace(account.SnapshotAt) == "" {
		return true
	}
	snapAt, hasSnap := warmup.ParseISO(account.SnapshotAt)
	if !hasSnap {
		return true
	}
	if sentAt, ok := warmup.ParseISO(marks.LastSent); ok {
		settleAt := sentAt.Add(warmup.POST_SEND_SETTLE)
		if !now.Before(settleAt) && snapAt.Before(settleAt) {
			return true
		}
	}
	win := warmup.FindAccountWindow(account, task.Trigger.Window)
	if win == nil {
		return false
	}
	if resetAt, ok := warmup.ParseISO(win.ResetsAt); ok {
		if !now.Before(resetAt) && snapAt.Before(resetAt) {
			return true
		}
	}
	return false
}

func (h *Handler) refreshWarmupQuota(ctx context.Context, client *management.Client, file management.AuthFile) bool {
	service := quota.NewServiceWithClock(client, h.now)
	prior := h.loadPriorNormalizedQuota(ctx, file.AuthIndex)
	reading, err := h.refreshQuotaReadingAs(ctx, service, file, prior, true)
	if err != nil || reading == nil {
		return false
	}
	_ = h.persistNormalizedQuotaSnapshot(ctx, reading)
	return true
}

func (h *Handler) warmupRefreshBackoffActive(authIndex string, now time.Time) bool {
	h.warmupRuntime.mu.Lock()
	defer h.warmupRuntime.mu.Unlock()
	until, ok := h.warmupRuntime.refreshBackoff[authIndex]
	return ok && now.Before(until)
}

// deferWarmupRefresh records a failed read; the expired entries it drops on the way keep the
// map as small as the credentials that currently fail.
func (h *Handler) deferWarmupRefresh(authIndex string, now time.Time) {
	h.warmupRuntime.mu.Lock()
	defer h.warmupRuntime.mu.Unlock()
	if h.warmupRuntime.refreshBackoff == nil {
		h.warmupRuntime.refreshBackoff = make(map[string]time.Time)
	}
	for key, until := range h.warmupRuntime.refreshBackoff {
		if !now.Before(until) {
			delete(h.warmupRuntime.refreshBackoff, key)
		}
	}
	h.warmupRuntime.refreshBackoff[authIndex] = now.Add(warmupRefreshBackoff)
}

func (h *Handler) clearWarmupRefreshBackoff(authIndex string) {
	h.warmupRuntime.mu.Lock()
	defer h.warmupRuntime.mu.Unlock()
	delete(h.warmupRuntime.refreshBackoff, authIndex)
}

func (h *Handler) warmupCatalogWithFiles(ctx context.Context, client *management.Client) (warmup.Catalog, map[string]management.AuthFile) {
	catalog := warmup.Catalog{
		Providers: []warmup.CatalogProvider{},
		TimeZone:  h.warmupTimezoneName(),
	}
	filesByIndex := make(map[string]management.AuthFile)
	if client == nil {
		return catalog, filesByIndex
	}
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		return catalog, filesByIndex
	}

	authIndices := make([]string, 0, len(filesResp.Files))
	for _, file := range filesResp.Files {
		idx := strings.TrimSpace(file.AuthIndex)
		if idx == "" || file.RuntimeOnly {
			continue
		}
		filesByIndex[idx] = file
		authIndices = append(authIndices, idx)
	}
	snapshots, _ := h.repo.GetLatestQuotaSnapshots(ctx, authIndices)

	byProvider := map[string][]warmup.CatalogAccount{
		"codex":  {},
		"claude": {},
	}
	for _, file := range filesResp.Files {
		idx := strings.TrimSpace(file.AuthIndex)
		if idx == "" || file.RuntimeOnly {
			continue
		}
		provider := warmupProvider(file)
		if provider == "" {
			continue
		}
		models := h.warmupModelsForFile(ctx, client, provider, file, filesResp.Files)
		upstream := h.warmupModelUpstreams(ctx, client, file, models)
		models = warmup.FilterWarmupModels(models, upstream)
		autoModel := h.pickWarmupAutoModel(ctx, provider, models, upstream)
		windows, snapshotAt := warmupAccountWindows(provider, idx, snapshots)
		account := warmup.CatalogAccount{
			AuthIndex:     idx,
			Name:          firstNonEmpty(strings.TrimSpace(file.Name), idx),
			Provider:      provider,
			OAuthProvider: strings.TrimSpace(file.OAuthProvider),
			Email:         strings.TrimSpace(file.Email),
			Status:        strings.TrimSpace(file.Status),
			Disabled:      file.Disabled || file.Unavailable,
			Models:        models,
			AutoModel:     autoModel,
			Windows:       windows,
			SnapshotAt:    snapshotAt,
		}
		byProvider[provider] = append(byProvider[provider], account)
	}

	providerOrder := []string{"codex", "claude"}
	for p := range byProvider {
		if p != "codex" && p != "claude" {
			providerOrder = append(providerOrder, p)
		}
	}
	if len(providerOrder) > 2 {
		sort.Strings(providerOrder[2:])
	}
	for _, p := range providerOrder {
		accounts := byProvider[p]
		slices.SortFunc(accounts, func(a, b warmup.CatalogAccount) int {
			if a.Name != b.Name {
				return strings.Compare(a.Name, b.Name)
			}
			return strings.Compare(a.AuthIndex, b.AuthIndex)
		})
		catalog.Providers = append(catalog.Providers, warmup.CatalogProvider{
			Provider: p,
			Accounts: accounts,
		})
	}
	return catalog, filesByIndex
}

func warmupAccountWindows(provider, authIndex string, snapshots map[string]repository.QuotaSnapshotRecord) ([]warmup.QuotaWindow, string) {
	snapshot, hasSnapshot := snapshots[authIndex]
	windows := make([]warmup.QuotaWindow, 0)
	snapshotAt := ""
	if hasSnapshot {
		q := normalizedQuotaFromSnapshot(authIndex, snapshot)
		if q.ObservedAtMS > 0 {
			snapshotAt = warmup.FormatISO(time.UnixMilli(q.ObservedAtMS).UTC())
		}
		seenIDs := make(map[string]bool, len(q.Windows))
		for _, w := range q.Windows {
			resetsAt := formatOptionalEpochISO(w.ResetAtMS)
			windows = append(windows, warmup.QuotaWindow{
				ID:          w.ID,
				Label:       firstNonEmpty(w.Label, w.ID),
				UsedPercent: w.UsedPercent,
				ResetsAt:    resetsAt,
			})
			seenIDs[w.ID] = true
		}
		if q.WarmupEvidence != nil {
			if !seenIDs["five_hour"] && (q.WarmupEvidence.FiveHour.State == "idle" || q.WarmupEvidence.FiveHour.ResetAtMS != nil) {
				windows = append([]warmup.QuotaWindow{{
					ID:          "five_hour",
					Label:       "5h",
					UsedPercent: q.WarmupEvidence.FiveHour.UsedPercent,
					ResetsAt:    formatOptionalEpochISO(q.WarmupEvidence.FiveHour.ResetAtMS),
				}}, windows...)
			}
			if !seenIDs["seven_day"] && !seenIDs["weekly"] && (q.WarmupEvidence.Weekly.State == "idle" || q.WarmupEvidence.Weekly.ResetAtMS != nil) {
				wid := "seven_day"
				if provider == "codex" {
					wid = "weekly"
				}
				windows = append(windows, warmup.QuotaWindow{
					ID:          wid,
					Label:       "7d",
					UsedPercent: q.WarmupEvidence.Weekly.UsedPercent,
					ResetsAt:    formatOptionalEpochISO(q.WarmupEvidence.Weekly.ResetAtMS),
				})
			}
		}
	}
	if len(windows) == 0 && (provider == "claude" || provider == "codex") {
		wid := "seven_day"
		if provider == "codex" {
			wid = "weekly"
		}
		windows = []warmup.QuotaWindow{
			{ID: "five_hour", Label: "5h"},
			{ID: wid, Label: "7d"},
		}
	}
	return windows, snapshotAt
}

func formatOptionalEpochISO(epochMS *int64) string {
	if epochMS == nil || *epochMS <= 0 {
		return ""
	}
	return warmup.FormatISO(time.UnixMilli(*epochMS).UTC())
}

func findCatalogAccount(catalog *warmup.Catalog, task warmup.Task) *warmup.CatalogAccount {
	if catalog == nil {
		return nil
	}
	for pIdx := range catalog.Providers {
		p := &catalog.Providers[pIdx]
		if task.Provider != "" && p.Provider != task.Provider {
			continue
		}
		for aIdx := range p.Accounts {
			acc := &p.Accounts[aIdx]
			if task.AuthIndex != "" && acc.AuthIndex == task.AuthIndex {
				return acc
			}
		}
		for aIdx := range p.Accounts {
			acc := &p.Accounts[aIdx]
			if task.Account != "" && acc.Name == task.Account {
				return acc
			}
		}
	}
	return nil
}

func warmupProvider(file management.AuthFile) string {
	provider := quota.DetectProvider(file.Type, file.Provider)
	if provider == "unknown" {
		return ""
	}
	return provider
}

func (h *Handler) warmupModelsForFile(ctx context.Context, client *management.Client, provider string, file management.AuthFile, allFiles []management.AuthFile) []string {
	candidates := modelIDs(file.Models)
	if len(candidates) == 0 {
		candidates = h.warmupAuthFileModels(ctx, client, file.Name)
	}
	if len(candidates) == 0 {
		candidates = h.warmupModelsForProvider(ctx, client, provider, allFiles)
	}
	filtered := make([]string, 0, len(candidates))
	seen := make(map[string]bool, len(candidates))
	for _, m := range candidates {
		m = strings.TrimSpace(m)
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		filtered = append(filtered, m)
	}
	sort.Strings(filtered)
	return filtered
}

// warmupModelUpstreams maps each call point the credential lists to the upstream model CPA
// resolves it to, applying the credential's own aliases before its provider's as CPA does. A
// rule source that cannot be read leaves its call points mapped to themselves.
func (h *Handler) warmupModelUpstreams(ctx context.Context, client *management.Client, file management.AuthFile, models []string) map[string]string {
	if client == nil || len(models) == 0 {
		return nil
	}
	global := h.warmupAliasRules(warmupGlobalAliasKey, func() (warmupAliasCacheEntry, error) {
		aliases, err := client.OAuthModelAliases(ctx)
		return warmupAliasCacheEntry{global: aliases}, err
	})
	var credential warmupAliasCacheEntry
	if name := strings.TrimSpace(file.Name); name != "" && !file.RuntimeOnly {
		credential = h.warmupAliasRules(name, func() (warmupAliasCacheEntry, error) {
			rules, err := client.CredentialModelAliases(ctx, name)
			return warmupAliasCacheEntry{credential: rules}, err
		})
	}
	rules := append(slices.Clone(credential.credential), global.global[management.ModelAliasFamily(file)]...)
	if len(rules) == 0 {
		return nil
	}
	upstream := make(map[string]string, len(models))
	for _, callPoint := range models {
		if target := management.ResolveOAuthModelAlias(callPoint, rules); target != callPoint {
			upstream[callPoint] = target
		}
	}
	return upstream
}

// warmupAliasRules serves one alias source from the cache, reading it when stale. A failed read
// is not cached, so the next catalog build retries it.
func (h *Handler) warmupAliasRules(key string, read func() (warmupAliasCacheEntry, error)) warmupAliasCacheEntry {
	now := h.now()
	h.warmupRuntime.mu.Lock()
	if cached, ok := h.warmupRuntime.aliasRules[key]; ok && now.Before(cached.expiresAt) {
		h.warmupRuntime.mu.Unlock()
		return cached
	}
	h.warmupRuntime.mu.Unlock()

	entry, err := read()
	if err != nil {
		return warmupAliasCacheEntry{}
	}
	entry.expiresAt = now.Add(warmupModelCacheTTL)
	h.warmupRuntime.mu.Lock()
	if h.warmupRuntime.aliasRules == nil {
		h.warmupRuntime.aliasRules = make(map[string]warmupAliasCacheEntry)
	}
	h.warmupRuntime.aliasRules[key] = entry
	h.warmupRuntime.mu.Unlock()
	return entry
}

// warmupPrices reads the price book for a warmup model choice. A rate is the two ends of one
// request per million tokens: the warmup prompt is tiny and the answer shorter, so their sum
// orders models the way the bill does. A channel's own row wins over the shared book, as it does
// on the price page. An unreadable book prices nothing, which is never zero.
func (h *Handler) warmupPrices(ctx context.Context) *warmupPriceIndex {
	if h.pricing == nil {
		return nil
	}
	now := h.now()
	h.warmupRuntime.mu.Lock()
	cached := h.warmupRuntime.prices
	h.warmupRuntime.mu.Unlock()
	if cached != nil && now.Before(cached.expiresAt) {
		return cached
	}
	rows, err := h.pricing.ListPrices(ctx)
	if err != nil {
		return nil
	}
	index := &warmupPriceIndex{
		shared:    make(map[string]float64, len(rows)),
		byChannel: make(map[string]map[string]float64),
		expiresAt: now.Add(warmupModelCacheTTL),
	}
	for _, row := range rows {
		recordWarmupRate(index.shared, row)
	}
	// Channel overrides refine the book rather than replace it, so a failed read leaves the
	// shared rates in place.
	if h.repo != nil {
		if overrides, err := h.repo.ListChannelModelPrices(ctx); err == nil {
			for _, row := range overrides {
				channel := strings.ToLower(strings.TrimSpace(row.Channel))
				if channel == "" {
					continue
				}
				if index.byChannel[channel] == nil {
					index.byChannel[channel] = make(map[string]float64)
				}
				recordWarmupRate(index.byChannel[channel], row)
			}
		}
	}
	h.warmupRuntime.mu.Lock()
	h.warmupRuntime.prices = index
	h.warmupRuntime.mu.Unlock()
	return index
}

func recordWarmupRate(book map[string]float64, row pricing.ModelPrice) {
	key := pricing.NormalizeModelKey(pricing.StripProviderPrefix(row.Model))
	if key == "" {
		return
	}
	// One model can be priced twice; the cheaper statement is the one to compare against.
	rate := row.PromptPricePer1M + row.CompletionPer1M
	if existing, ok := book[key]; ok && existing <= rate {
		return
	}
	book[key] = rate
}

// rate is the price of calling a model on a provider's channel, preferring that channel's own row.
func (index *warmupPriceIndex) rate(provider, reached string) (float64, bool) {
	if index == nil {
		return 0, false
	}
	key := pricing.NormalizeModelKey(pricing.StripProviderPrefix(reached))
	if key == "" {
		return 0, false
	}
	if book := index.byChannel[strings.ToLower(strings.TrimSpace(provider))]; book != nil {
		if rate, ok := book[key]; ok {
			return rate, true
		}
	}
	rate, ok := index.shared[key]
	return rate, ok
}

// pickWarmupAutoModel answers Auto with the cheapest model the price book prices. A zero rate is
// skipped rather than preferred: a free model is one that never runs the metered request which
// starts a window, so warming up on it would not open the window at all. The light name ranking
// answers when the book prices none of the call points, and still orders models priced the same,
// so the answer stays deterministic.
func (h *Handler) pickWarmupAutoModel(ctx context.Context, provider string, models []string, upstream map[string]string) string {
	index := h.warmupPrices(ctx)
	cheapest, cheapestRate := "", 0.0
	for _, model := range warmup.SortModelsForAuto(models, upstream) {
		rate, ok := index.rate(provider, warmup.Reached(model, upstream))
		if !ok || rate <= 0 {
			continue
		}
		if cheapest == "" || rate < cheapestRate {
			cheapest, cheapestRate = model, rate
		}
	}
	if cheapest != "" {
		return cheapest
	}
	return warmup.PickAutoModel(models, upstream)
}

// warmupAuthFileModels returns the models CPA reports for one credential, cached by file name.
// An answer that lists nothing is cached too: a catalog build otherwise asks again for the same
// credential from the provider-wide scan, which turns each tick into a request per credential.
// A failed read is not cached, so the next tick retries it.
func (h *Handler) warmupAuthFileModels(ctx context.Context, client *management.Client, name string) []string {
	name = strings.TrimSpace(name)
	if client == nil || name == "" {
		return nil
	}
	now := h.now()
	h.warmupRuntime.mu.Lock()
	if cached, ok := h.warmupRuntime.fileModels[name]; ok && now.Before(cached.expiresAt) {
		models := slices.Clone(cached.models)
		h.warmupRuntime.mu.Unlock()
		return models
	}
	h.warmupRuntime.mu.Unlock()

	listed, err := client.AuthFileModels(ctx, name)
	if err != nil {
		return nil
	}
	models := modelIDs(listed)
	h.warmupRuntime.mu.Lock()
	if h.warmupRuntime.fileModels == nil {
		h.warmupRuntime.fileModels = make(map[string]warmupModelCacheEntry)
	}
	h.warmupRuntime.fileModels[name] = warmupModelCacheEntry{models: slices.Clone(models), expiresAt: now.Add(warmupModelCacheTTL)}
	h.warmupRuntime.mu.Unlock()
	return models
}

func (h *Handler) warmupModelsForProvider(ctx context.Context, client *management.Client, provider string, files []management.AuthFile) []string {
	now := h.now()
	h.warmupRuntime.mu.Lock()
	if h.warmupRuntime.models == nil {
		h.warmupRuntime.models = make(map[string]warmupModelCacheEntry)
	}
	if cached, ok := h.warmupRuntime.models[provider]; ok && now.Before(cached.expiresAt) {
		out := slices.Clone(cached.models)
		h.warmupRuntime.mu.Unlock()
		return out
	}
	h.warmupRuntime.mu.Unlock()

	seen := make(map[string]bool)
	models := make([]string, 0)
	add := func(ids []string) {
		for _, id := range ids {
			id = strings.TrimSpace(id)
			if id != "" && !seen[id] {
				seen[id] = true
				models = append(models, id)
			}
		}
	}
	for _, f := range files {
		if warmupProvider(f) == provider {
			add(modelIDs(f.Models))
			if len(f.Models) == 0 {
				add(h.warmupAuthFileModels(ctx, client, f.Name))
			}
		}
	}
	if len(models) == 0 && client != nil {
		if defs, _, err := client.OAuthChannelModelDefinitions(ctx, provider); err == nil {
			add(modelIDs(defs))
		}
	}
	sort.Strings(models)
	if len(models) > 0 {
		h.warmupRuntime.mu.Lock()
		h.warmupRuntime.models[provider] = warmupModelCacheEntry{models: slices.Clone(models), expiresAt: now.Add(warmupModelCacheTTL)}
		h.warmupRuntime.mu.Unlock()
	}
	return models
}

func modelIDs(models []management.AuthModel) []string {
	out := make([]string, 0, len(models))
	for _, m := range models {
		if id := strings.TrimSpace(m.ID); id != "" {
			out = append(out, id)
		}
	}
	return out
}

func (h *Handler) warmupTimezoneName() string {
	if h.repo != nil && h.repo.Timezone() != nil && h.repo.Timezone().Location() != nil {
		if tz := strings.TrimSpace(h.repo.Timezone().Location().String()); tz != "" && warmup.ValidTimeZone(tz) {
			return tz
		}
	}
	return "UTC"
}

func (h *Handler) claimWarmupTask(taskID string) bool {
	h.warmupRuntime.mu.Lock()
	defer h.warmupRuntime.mu.Unlock()
	if h.warmupRuntime.runningTask == nil {
		h.warmupRuntime.runningTask = make(map[string]bool)
	}
	if h.warmupRuntime.runningTask[taskID] {
		return false
	}
	h.warmupRuntime.runningTask[taskID] = true
	return true
}

func (h *Handler) releaseWarmupTask(taskID string) {
	h.warmupRuntime.mu.Lock()
	defer h.warmupRuntime.mu.Unlock()
	delete(h.warmupRuntime.runningTask, taskID)
}

func (h *Handler) isWarmupTaskRunning(taskID string) bool {
	h.warmupRuntime.mu.Lock()
	defer h.warmupRuntime.mu.Unlock()
	return h.warmupRuntime.runningTask[taskID]
}

func (h *Handler) recoverWarmupRunsOnce(ctx context.Context) {
	h.warmupRuntime.mu.Lock()
	if h.warmupRuntime.recovered {
		h.warmupRuntime.mu.Unlock()
		return
	}
	h.warmupRuntime.recovered = true
	h.warmupRuntime.mu.Unlock()
	if h.repo != nil {
		_ = h.repo.RecoverWarmupRuns(ctx, warmupInstanceID)
	}
}

func (h *Handler) writeWarmupAudit(ctx context.Context, action, target string, detail map[string]any) error {
	if h.repo == nil {
		return nil
	}
	_, err := h.repo.RecordAuditEvent(ctx, repository.AuditEvent{
		OccurredAtMS: h.now().UTC().UnixMilli(),
		Action:       action,
		TargetType:   "warmup",
		TargetID:     target,
		Result:       "success",
		Details:      detail,
	})
	return err
}

func newWarmupID(prefix string, now time.Time) string {
	var b [3]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + strconv.FormatInt(now.UnixMilli(), 36) + "_" + hex.EncodeToString(b[:])
}

func maxISOString(a, b string) string {
	ta, oka := warmup.ParseISO(a)
	tb, okb := warmup.ParseISO(b)
	switch {
	case oka && okb:
		if ta.After(tb) {
			return a
		}
		return b
	case oka:
		return a
	case okb:
		return b
	default:
		return ""
	}
}
