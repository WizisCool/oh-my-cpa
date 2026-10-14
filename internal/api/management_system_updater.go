package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/updater"
)

// UpdateManager is the updater sidecar as the console uses it. The console never
// reaches the Docker daemon: it can ask this narrow interface to replace a product,
// and the sidecar decides which container and which image that means (ADR 0099).
type UpdateManager interface {
	Status(ctx context.Context) (updater.StatusResponse, error)
	Update(ctx context.Context, request updater.UpdateRequest) (updater.Job, error)
}

// ManifestSource downloads a release's signed manifest. The bytes are forwarded to the
// sidecar unread; verifying them is the sidecar's job, because it is the party the
// signature protects.
type ManifestSource interface {
	FetchManifest(ctx context.Context, repository, tag string) ([]byte, string, error)
}

// Updater states the page distinguishes.
const (
	updaterReady = "ready"
	// updaterNotInstalled is a containerised console with no sidecar answering: the
	// state the install command fixes.
	updaterNotInstalled = "not_installed"
	// updaterNotContainerised is a native install, which has no containers to replace.
	updaterNotContainerised = "not_containerised"
	updaterDisabled         = "disabled"
	// updaterRejected is a sidecar that answered but did not accept this console's
	// token: it is watching a different console container.
	updaterRejected = "rejected"
)

const (
	updateJobPollInterval = 2 * time.Second
	// updateJobWatchLimit bounds how long a finished job is waited for before its
	// outcome goes unrecorded; a replacement's own health timeout is three minutes.
	updateJobWatchLimit = 15 * time.Minute
)

// SystemUpdaterDTO is what the System Information page needs to offer an update.
type SystemUpdaterDTO struct {
	State    string                    `json:"state"`
	Products []SystemUpdaterProductDTO `json:"products"`
	Job      *SystemUpdaterJobDTO      `json:"job"`
}

// SystemUpdaterProductDTO says whether one product can be updated here, and why not.
type SystemUpdaterProductDTO struct {
	Product string `json:"product"`
	Action  string `json:"action"`
	Reason  string `json:"reason"`
	// Image is the configured image reference, shown so a pinned deployment can see
	// what it is pinned to.
	Image string `json:"image"`
}

// SystemUpdaterJobDTO is the running or most recent update.
type SystemUpdaterJobDTO struct {
	ID           string `json:"id"`
	Product      string `json:"product"`
	Stage        string `json:"stage"`
	Finished     bool   `json:"finished"`
	Error        string `json:"error"`
	FromVersion  string `json:"from_version"`
	ToVersion    string `json:"to_version"`
	StartedAtMS  int64  `json:"started_at_ms"`
	FinishedAtMS int64  `json:"finished_at_ms"`
}

// SetUpdater attaches the updater sidecar client and the manifest source.
// isContainerised tells a missing sidecar that can be installed apart from a native
// install that has no use for one.
func (h *Handler) SetUpdater(manager UpdateManager, manifests ManifestSource, isContainerised bool) {
	h.updater = manager
	h.manifests = manifests
	h.isContainerised = isContainerised
	h.updateWatchContext, h.stopUpdateWatchers = context.WithCancel(context.Background())
}

// WatchInterruptedUpdate starts RecordInterruptedUpdate as a watcher CloseUpdateWatchers
// waits for.
func (h *Handler) WatchInterruptedUpdate() {
	if h.updater == nil {
		return
	}
	h.updateWatchers.Add(1)
	go func() {
		defer h.updateWatchers.Done()
		h.RecordInterruptedUpdate(h.updateWatchContext)
	}()
}

// CloseUpdateWatchers stops waiting for update outcomes and returns once no watcher can
// still write. An outcome left unrecorded is picked up by the next process.
func (h *Handler) CloseUpdateWatchers() {
	if h == nil || h.stopUpdateWatchers == nil {
		return
	}
	h.stopUpdateWatchers()
	h.updateWatchers.Wait()
}

func updaterJobDTO(job *updater.Job) *SystemUpdaterJobDTO {
	if job == nil {
		return nil
	}
	return &SystemUpdaterJobDTO{
		ID:      job.ID,
		Product: job.Product,
		Stage:   job.Stage,
		// The text comes from the Docker daemon and a registry, neither of which this
		// process controls.
		Error:        security.RedactText(job.Error),
		Finished:     job.IsFinished(),
		FromVersion:  job.FromVersion,
		ToVersion:    job.ToVersion,
		StartedAtMS:  job.StartedAtMS,
		FinishedAtMS: job.FinishedAtMS,
	}
}

// updaterStatus reads the sidecar and reduces every way of not having one to a state
// the page can explain.
func (h *Handler) updaterStatus(ctx context.Context) (SystemUpdaterDTO, *updater.StatusResponse) {
	dto := SystemUpdaterDTO{Products: []SystemUpdaterProductDTO{}}
	switch {
	case h.updater == nil || !h.cfg.Updater.Enabled:
		dto.State = updaterDisabled
		return dto, nil
	case !h.isContainerised:
		dto.State = updaterNotContainerised
		return dto, nil
	}
	status, err := h.updater.Status(ctx)
	var refused *updater.RefusedError
	switch {
	case err == nil:
	case errors.As(err, &refused):
		dto.State = updaterRejected
		return dto, nil
	default:
		dto.State = updaterNotInstalled
		return dto, nil
	}
	dto.State = updaterReady
	for _, target := range status.Products {
		dto.Products = append(dto.Products, SystemUpdaterProductDTO{
			Product: target.Product,
			Action:  target.Action,
			Reason:  target.Reason,
			Image:   target.Image,
		})
	}
	dto.Job = updaterJobDTO(status.Job)
	return dto, &status
}

// getSystemUpdater reports whether updates can be applied from the console and how
// the running or last one is going. It always answers 200: an absent sidecar is a
// state of the deployment, not a failure of this request.
func (h *Handler) getSystemUpdater(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	dto, _ := h.updaterStatus(request.Context())
	writeJSON(writer, http.StatusOK, dto)
}

// postSystemUpdaterApply asks the sidecar to replace one product with its newest
// release.
//
// The audit record is written before the sidecar is asked, and a failure to write it
// refuses the update: replacing the gateway or the console is the most consequential
// thing this console can do to its own deployment, and it must not happen unrecorded.
// The record says "admitted", which is all this request can know - the outcome is
// recorded when the job finishes, by a process that for a console update is not this
// one.
func (h *Handler) postSystemUpdaterApply(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	ctx := request.Context()
	var body struct {
		Product string `json:"product"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&body); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Product != release.ProductOMC && body.Product != release.ProductCPA {
		writeError(writer, http.StatusBadRequest, "unknown release product")
		return
	}
	refuse := func(status int, result, code, message string) {
		_ = h.recordAudit(request, "system.update.apply", "deployment", body.Product, result, map[string]any{"reason": code})
		writeJSON(writer, status, map[string]string{"error": message, "code": code})
	}

	dto, _ := h.updaterStatus(ctx)
	if dto.State != updaterReady {
		refuse(http.StatusConflict, "rejected", "updater_"+dto.State, "updates cannot be applied from the console in this deployment")
		return
	}
	for _, product := range dto.Products {
		if product.Product == body.Product && product.Action != updater.ActionAvailable {
			refuse(http.StatusConflict, "rejected", product.Reason, "this product cannot be updated from the console")
			return
		}
	}

	update := updater.UpdateRequest{Product: body.Product}
	details := map[string]any{}
	if body.Product == release.ProductOMC {
		// The console is only ever moved to the release the page is offering, and only
		// when that release is newer: the manifest of any other tag is never fetched.
		status, err := h.releaseStatus(ctx, release.ProductOMC, h.omcVersion())
		if err != nil || status.Comparison.State != release.UpdateAvailable {
			refuse(http.StatusConflict, "rejected", "no_update_available", "no newer release is available")
			return
		}
		manifest, signature, err := h.manifests.FetchManifest(ctx, status.Repository, status.LatestVersion)
		if err != nil {
			code := "manifest_unavailable"
			if errors.Is(err, release.ErrManifestMissing) {
				code = "manifest_missing"
			}
			h.logger.Warn("could not download the release manifest", "version", status.LatestVersion, "error", security.RedactText(err.Error()))
			refuse(http.StatusBadGateway, "failure", code, "the release's signed manifest could not be downloaded")
			return
		}
		update.Manifest, update.Signature = string(manifest), signature
		details["target_version"] = status.LatestVersion
	}

	if err := h.recordAudit(request, "system.update.apply", "deployment", body.Product, "admitted", details); err != nil {
		writeAuditFailure(writer, "could not record the update admission")
		return
	}
	job, err := h.updater.Update(ctx, update)
	if err != nil {
		// The admission is already on record, so what the updater did with it is that
		// admission's outcome rather than a second apply: one attempt stays one row under
		// system.update.apply, as it does when the job runs.
		end := func(status int, result, code, message string) {
			_ = h.recordAudit(request, "system.update.completed", "deployment", body.Product, result, map[string]any{"reason": code})
			writeJSON(writer, status, map[string]string{"error": message, "code": code})
		}
		var refused *updater.RefusedError
		if errors.As(err, &refused) {
			status := http.StatusConflict
			if refused.Status == http.StatusForbidden {
				status = http.StatusForbidden
			}
			end(status, "rejected", refused.Code, security.RedactText(refused.Message))
			return
		}
		end(http.StatusBadGateway, "failure", "updater_unreachable", "the updater did not answer")
		return
	}
	h.updateWatchers.Add(1)
	go func() {
		defer h.updateWatchers.Done()
		h.recordUpdateOutcome(job.ID)
	}()
	writeJSON(writer, http.StatusAccepted, SystemUpdaterDTO{State: updaterReady, Products: dto.Products, Job: updaterJobDTO(&job)})
}

// releaseStatus reads one product's stored version answer.
func (h *Handler) releaseStatus(ctx context.Context, product, runningVersion string) (release.ProductStatus, error) {
	if h.release == nil || h.manifests == nil {
		return release.ProductStatus{}, errors.New("release checking is not configured")
	}
	return h.release.Status(ctx, product, runningVersion)
}

// recordUpdateOutcome waits for a job to finish and writes its outcome to the audit
// trail. A gateway update finishes while this process is alive. A console update
// replaces this process first, so RecordInterruptedUpdate picks the outcome up in the
// process that replaces it.
func (h *Handler) recordUpdateOutcome(jobID string) {
	ctx, cancel := context.WithTimeout(h.updateWatchContext, updateJobWatchLimit)
	defer cancel()
	ticker := time.NewTicker(h.updateJobPollInterval())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		status, err := h.updater.Status(ctx)
		if err != nil || status.Job == nil || status.Job.ID != jobID || !status.Job.IsFinished() {
			continue
		}
		h.auditUpdateOutcome(*status.Job)
		return
	}
}

func (h *Handler) updateJobPollInterval() time.Duration {
	if h.updatePollInterval > 0 {
		return h.updatePollInterval
	}
	return updateJobPollInterval
}

// RecordInterruptedUpdate records the outcome of an update whose admitting process did
// not live to see it: the console's own. It runs at start-up, which for a console update
// is while that update is still verifying this very process, so it waits for the job to
// finish. A failed read is not the end of the wait: after a console update the sidecar
// replaces itself too. Only the job first seen is followed, because a later one has a
// watcher of its own, and nothing is written when its outcome is already on record.
func (h *Handler) RecordInterruptedUpdate(ctx context.Context) {
	if h.updater == nil || h.repo == nil || !h.cfg.Updater.Enabled || !h.isContainerised {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, updateJobWatchLimit)
	defer cancel()
	ticker := time.NewTicker(h.updateJobPollInterval())
	defer ticker.Stop()
	followedID := ""
	for {
		status, err := h.updater.Status(ctx)
		var refused *updater.RefusedError
		switch {
		case errors.As(err, &refused):
			return
		case err != nil:
		case status.Job == nil:
			return
		case followedID != "" && status.Job.ID != followedID:
			return
		case status.Job.IsFinished():
			if !h.isUpdateOutcomeRecorded(ctx, status.Job.ID) {
				h.auditUpdateOutcome(*status.Job)
			}
			return
		default:
			followedID = status.Job.ID
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// isUpdateOutcomeRecorded reports whether a job's outcome is on record. An unreadable
// trail counts as recorded: a missing outcome row is better than a doubled one.
func (h *Handler) isUpdateOutcomeRecorded(ctx context.Context, jobID string) bool {
	query := repository.AuditQuery{Search: "system.update.completed", Limit: repository.AuditPageMax}
	for {
		page, err := h.repo.QueryAuditEvents(ctx, query)
		if err != nil {
			return true
		}
		for _, event := range page.Events {
			if event.Action == "system.update.completed" && event.Details["job_id"] == jobID {
				return true
			}
		}
		if page.Next == nil {
			return false
		}
		query.Before = *page.Next
	}
}

func (h *Handler) auditUpdateOutcome(job updater.Job) {
	result := "success"
	if job.Stage == updater.StageRolledBack || job.Stage == updater.StageFailed {
		result = "failure"
	}
	details := map[string]any{
		"job_id":       job.ID,
		"stage":        job.Stage,
		"from_version": job.FromVersion,
		"to_version":   job.ToVersion,
	}
	if job.Error != "" {
		details["error"] = security.RedactText(job.Error)
	}
	h.recordAuditWithoutRequest("system.update.completed", "deployment", job.Product, result, details)
}
