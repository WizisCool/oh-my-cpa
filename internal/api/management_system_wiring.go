package api

import (
	"context"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// MaintenanceManager runs the database-wide maintenance actions.
//
// It is an interface so the handler can be built without one: a deployment that does
// not offer maintenance, and the handler tests, then have every maintenance route
// answer "not available" rather than reaching into a database.
// maintenanceAuditTimeout bounds the write that records a finished maintenance job.
const maintenanceAuditTimeout = 10 * time.Second

type MaintenanceManager interface {
	Status() repository.MaintenanceStatus
	StartCheckpoint(ctx context.Context) (repository.MaintenanceStatus, error)
	StartVacuum(ctx context.Context) (repository.MaintenanceStatus, error)
	Admission() repository.MaintenanceAdmission
	// Reserve claims the single-flight slot without running anything, so the caller can audit the
	// admission before the job holds the write gate. It returns a handle that Launch and Release
	// require, so a caller can only act on the reservation it made: without it, a stale Release
	// could clear a newer reservation and a job the operator was told was accepted would never run.
	Reserve(ctx context.Context, action string) (repository.MaintenanceStatus, repository.MaintenanceReservation, error)
	Launch(ctx context.Context, handle repository.MaintenanceReservation) error
	Release(ctx context.Context, handle repository.MaintenanceReservation)
}

// SetRelease attaches the release-observation service after construction, which keeps
// the handler builder simple and keeps tests free of a real service.
func (h *Handler) SetRelease(manager ReleaseManager) {
	h.release = manager
}

// SetMaintenance attaches the maintenance service.
//
// A service that can report completion is also wired to the audit trail here, because
// the request that admitted the job has already been answered by the time the job
// finishes: the outcome cannot be recorded by that request, and the status code it
// returned describes admission rather than success.
func (h *Handler) SetMaintenance(manager MaintenanceManager) {
	h.maintenance = manager
	if observer, ok := manager.(interface {
		OnCompletion(func(repository.MaintenanceStatus))
	}); ok {
		observer.OnCompletion(h.recordMaintenanceCompletion)
	}
}

// recordMaintenanceCompletion writes the terminal outcome of a maintenance job.
//
// It runs on the job's goroutine, after the job has released the write gate, so the
// write cannot block a rebuild or be blocked by one. A failure to record is logged
// rather than surfaced: there is no caller left to tell, and the job's own status in
// memory already carries the result.
func (h *Handler) recordMaintenanceCompletion(status repository.MaintenanceStatus) {
	result := "success"
	switch {
	case status.Error != "":
		result = "failure"
	case status.Incomplete:
		result = "incomplete"
	}
	details := map[string]any{
		"action":          status.Action,
		"reclaimed_bytes": status.ReclaimedBytes,
	}
	if status.Error != "" {
		details["error"] = status.Error
	}
	h.recordAuditWithoutRequest("system.maintenance."+status.Action+".completed", "database", status.Action, result, details)
}

// recordAuditWithoutRequest records an audit event that has no HTTP request behind it.
func (h *Handler) recordAuditWithoutRequest(action, targetType, targetID, result string, details map[string]any) {
	if h.repo == nil {
		return
	}
	event := repository.AuditEvent{
		OccurredAtMS: time.Now().UnixMilli(),
		Action:       action,
		TargetType:   targetType,
		TargetID:     targetID,
		Result:       result,
		Details:      details,
	}
	// Bounded rather than unbounded-background: this runs on the job's own goroutine after
	// exclusivity is released, so a store that has stopped answering would otherwise keep the
	// process's shutdown waiting on a write that is only a record of a job which already
	// finished.
	auditCtx, cancelAudit := context.WithTimeout(context.Background(), maintenanceAuditTimeout)
	defer cancelAudit()
	if _, err := h.repo.RecordAuditEvent(auditCtx, event); err != nil {
		h.logger.Warn("could not record the maintenance outcome", "action", action, "error", err)
	}
}
