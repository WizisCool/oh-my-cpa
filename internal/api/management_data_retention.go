package api

import (
	"errors"
	"net/http"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage/ingest"
)

// UsageMaintenance is the background loop that folds and rolls stored usage.
type UsageMaintenance interface {
	Status() ingest.MaintenanceStatus
	// Defaults is the environment's retention, in force until the console saves one.
	Defaults() repository.UsageRetention
	// ApplyRetentionNow wakes the loop after the retention changed.
	ApplyRetentionNow()
}

// SetUsageMaintenance attaches the usage maintenance loop.
func (h *Handler) SetUsageMaintenance(maintenance UsageMaintenance) {
	h.usageMaintenance = maintenance
}

// DataRetentionDTO is the data retention panel: what is kept, what has been
// removed, and whether removing it gave the space back.
type DataRetentionDTO struct {
	// RequestRecordDays and PayloadDays are in force now; zero keeps rows (a zero
	// payload horizon follows the request records). The console sets only the
	// first; the payload horizon follows the environment unless the API set it.
	RequestRecordDays int `json:"request_record_days"`
	PayloadDays       int `json:"payload_days"`
	// Source is "console" once the operator saved a retention, "environment" until then.
	Source                       string `json:"source"`
	EnvironmentRequestRecordDays int    `json:"environment_request_record_days"`
	EnvironmentPayloadDays       int    `json:"environment_payload_days"`
	MaxDays                      int    `json:"max_days"`
	// IsScheduled is false when no maintenance loop runs in this process (the
	// demonstration); the stored setting then has no effect here.
	IsScheduled  bool   `json:"scheduled"`
	LastPassAtMS *int64 `json:"last_pass_at_ms"`
	NextPassAtMS *int64 `json:"next_pass_at_ms"`
	// OldestRequestRecordMS is the oldest request record still stored.
	OldestRequestRecordMS *int64                   `json:"oldest_request_record_ms"`
	Policies              []DataRetentionPolicyDTO `json:"policies"`
	Storage               DataRetentionStorageDTO  `json:"storage"`
}

// DataRetentionPolicyDTO is what one rolling policy has removed.
type DataRetentionPolicyDTO struct {
	Policy string `json:"policy"`
	// HorizonMS is the published horizon: rows older than it are gone or going.
	HorizonMS   int64  `json:"horizon_ms"`
	DeletedRows int64  `json:"deleted_rows"`
	LastRunAtMS *int64 `json:"last_run_at_ms"`
}

// DataRetentionStorageDTO says whether deleted rows shrink the file.
type DataRetentionStorageDTO struct {
	// AutoVacuum is "incremental" when retention hands freed pages back to the
	// filesystem; "none" means the file keeps its size until it is rebuilt.
	AutoVacuum    string `json:"auto_vacuum"`
	FreePageBytes int64  `json:"free_page_bytes"`
}

type dataRetentionRequest struct {
	// ExpectedRequestRecordDays is the horizon the console confirmed against. The
	// write is refused when another console has replaced it since.
	ExpectedRequestRecordDays *int `json:"expected_request_record_days"`
	RequestRecordDays         *int `json:"request_record_days"`
	PayloadDays               *int `json:"payload_days"`
}

func (h *Handler) usageRetentionDefaults() repository.UsageRetention {
	if h.usageMaintenance != nil {
		return h.usageMaintenance.Defaults()
	}
	return repository.UsageRetention{RequestRecordDays: h.cfg.Usage.RetentionDays, PayloadDays: h.cfg.Usage.InboxRetentionDays}
}

func (h *Handler) getDataRetention(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	dto, err := h.readDataRetention(request)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, dto)
}

func (h *Handler) readDataRetention(request *http.Request) (DataRetentionDTO, error) {
	ctx := request.Context()
	defaults := h.usageRetentionDefaults()
	setting, err := h.repo.ResolveUsageRetention(ctx, defaults)
	if err != nil {
		return DataRetentionDTO{}, err
	}
	dto := DataRetentionDTO{
		RequestRecordDays:            setting.RequestRecordDays,
		PayloadDays:                  setting.PayloadDays,
		Source:                       setting.Source,
		EnvironmentRequestRecordDays: defaults.RequestRecordDays,
		EnvironmentPayloadDays:       defaults.PayloadDays,
		MaxDays:                      repository.USAGE_RETENTION_MAX_DAYS,
		Policies:                     []DataRetentionPolicyDTO{},
	}
	if h.usageMaintenance != nil {
		status := h.usageMaintenance.Status()
		dto.IsScheduled = status.Running
		if status.LastRetentionAt != nil {
			at := status.LastRetentionAt.UnixMilli()
			dto.LastPassAtMS = &at
		}
		if status.NextRetentionAt != nil {
			at := status.NextRetentionAt.UnixMilli()
			dto.NextPassAtMS = &at
		}
	}
	states, err := h.repo.ListLifecycleStates(ctx)
	if err != nil {
		return DataRetentionDTO{}, err
	}
	for _, state := range states {
		dto.Policies = append(dto.Policies, DataRetentionPolicyDTO{
			Policy: state.Policy, HorizonMS: state.HorizonMS, DeletedRows: state.DeletedRows, LastRunAtMS: state.LastRunAtMS,
		})
	}
	stats, err := h.repo.StatsUsagePipeline(ctx)
	if err != nil {
		return DataRetentionDTO{}, err
	}
	dto.OldestRequestRecordMS = stats.FirstEventMS
	facts, err := h.repo.ReadDatabaseFacts(ctx)
	if err != nil {
		return DataRetentionDTO{}, err
	}
	dto.Storage = DataRetentionStorageDTO{AutoVacuum: autoVacuumName(facts.AutoVacuum), FreePageBytes: facts.FreePageBytes()}
	return dto, nil
}

func autoVacuumName(mode int64) string {
	switch mode {
	case 1:
		return "full"
	case repository.AutoVacuumIncremental:
		return "incremental"
	default:
		return "none"
	}
}

// putDataRetention stores the operator's retention and wakes the maintenance
// loop, so the new horizon is published at once and rows past it go a minute
// later rather than at the next hourly pass.
//
// Shortening retention deletes request records for good, so the change is
// audited before it is stored, and refused when it cannot be.
func (h *Handler) putDataRetention(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req dataRetentionRequest
	if err := decodeManagementJSON(writer, request, 4*1024, &req); err != nil {
		return
	}
	defer request.Body.Close()
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	if req.RequestRecordDays == nil || req.ExpectedRequestRecordDays == nil {
		writeError(writer, http.StatusBadRequest, repository.ErrInvalidUsageRetention.Error())
		return
	}
	previous, err := h.repo.ResolveUsageRetention(request.Context(), h.usageRetentionDefaults())
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	// The console confirmed against a horizon that is no longer in force: another
	// console changed it, so the deletion it confirmed is not the one it would make.
	if previous.RequestRecordDays != *req.ExpectedRequestRecordDays {
		writeJSON(writer, http.StatusConflict, map[string]string{
			"error": repository.ErrUsageRetentionChanged.Error(),
			"code":  repository.ErrUsageRetentionChanged.Error(),
		})
		return
	}
	// The console sets request records only; payloads are an internal replay buffer, so a
	// request that leaves them out keeps the horizon in force.
	retention := repository.UsageRetention{RequestRecordDays: *req.RequestRecordDays, PayloadDays: previous.PayloadDays}
	if req.PayloadDays != nil {
		retention.PayloadDays = *req.PayloadDays
	}
	if err := retention.Validate(); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	details := map[string]any{
		"request_record_days":          retention.RequestRecordDays,
		"payload_days":                 retention.PayloadDays,
		"previous_request_record_days": previous.RequestRecordDays,
		"previous_payload_days":        previous.PayloadDays,
	}
	if err := h.recordAudit(request, "system.data_retention", "database", "usage_retention", "attempt", details); err != nil {
		writeInternalError(writer, errors.Join(errors.New("audit data retention change"), err))
		return
	}
	if err := h.repo.SetUsageRetention(request.Context(), retention.RequestRecordDays, req.PayloadDays, *req.ExpectedRequestRecordDays); err != nil {
		_ = h.recordAudit(request, "system.data_retention", "database", "usage_retention", "failure", details)
		if errors.Is(err, repository.ErrUsageRetentionChanged) {
			writeJSON(writer, http.StatusConflict, map[string]string{
				"error": repository.ErrUsageRetentionChanged.Error(),
				"code":  repository.ErrUsageRetentionChanged.Error(),
			})
			return
		}
		writeInternalError(writer, err)
		return
	}
	_ = h.recordAudit(request, "system.data_retention", "database", "usage_retention", "success", details)
	if h.usageMaintenance != nil {
		h.usageMaintenance.ApplyRetentionNow()
	}
	dto, err := h.readDataRetention(request)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, dto)
}
