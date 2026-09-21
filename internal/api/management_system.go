package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// ReleaseManager is the release-observation surface the system page reads. It is an
// interface so the handler can be built without one - tests, and a deployment that
// disabled checking - and every read then reports "not checked yet" rather than
// failing the page.
type ReleaseManager interface {
	Status(ctx context.Context, product, runningVersion string) (release.ProductStatus, error)
	Releases(ctx context.Context, product, runningVersion string) (release.MergedLog, error)
	Check(ctx context.Context, product string) (release.Comparison, error)
	// CheckReportingFreshness also reports whether the feed was actually read, so the caller
	// can distinguish a real check from an answer served by the floor.
	CheckReportingFreshness(ctx context.Context, product string) (bool, error)
	Products() []release.Product
}

// SystemInfoDTO is the System Information page's payload.
//
// Every field here is a DTO allowlist entry: adding one is a deliberate change to
// what the console may see, which is why the struct is written out rather than
// marshalled from internal types.
type SystemInfoDTO struct {
	OMCVersion SystemProductVersionDTO `json:"omc_version"`
	CPAVersion SystemProductVersionDTO `json:"cpa_version"`

	UptimeSeconds int64 `json:"uptime_seconds"`

	Database SystemDatabaseDTO `json:"database"`
	CPA      SystemCPADTO      `json:"cpa"`
	// Collector reports the usage pipeline.
	Collector SystemCollectorDTO `json:"collector"`
	// DataVolumes are record counts, so a size can be read against the data behind it.
	DataVolumes SystemDataVolumesDTO `json:"data_volumes"`
	// Maintenance is the running or last maintenance job. It is served from memory,
	// so it stays readable while a job holds the database.
	Maintenance SystemMaintenanceStatusDTO `json:"maintenance"`
	// MaintenanceAdmission states what VACUUM would need, before it is run.
	MaintenanceAdmission SystemMaintenanceAdmissionDTO `json:"maintenance_admission"`
	Runtime              SystemRuntimeDTO              `json:"runtime"`
}

// SystemProductVersionDTO is one product's version answer.
//
// The state is a string rather than a pair of booleans because "the running build is
// a development build, so no comparison is possible" is a third answer that a
// boolean cannot carry, and reporting it as "up to date" would be a claim the data
// does not support.
type SystemProductVersionDTO struct {
	Product string `json:"product"`
	// RunningVersion is what is running here; empty when the gateway never reported
	// one, which is different from a version that could not be parsed.
	RunningVersion string `json:"running_version"`
	LatestVersion  string `json:"latest_version"`
	State          string `json:"state"`
	Reason         string `json:"reason,omitempty"`
	Repository     string `json:"repository"`
	RepositoryURL  string `json:"repository_url"`
	// CheckedAtMS is when the stored index was last read successfully.
	CheckedAtMS *int64 `json:"checked_at_ms"`
	// AttemptedAtMS is when a check was last tried, successful or not, so the page can
	// say a failure is recent without pretending the data is.
	AttemptedAtMS *int64 `json:"attempted_at_ms"`
	CheckError    string `json:"check_error"`
	Checking      bool   `json:"checking"`
	MergeCount    int    `json:"merge_count"`
	// RangeComplete is false when the release walk stopped early.
	RangeComplete bool `json:"range_complete"`
	// NotesAvailable is false when this process holds no release notes, which is the
	// normal state after a restart.
	NotesAvailable bool `json:"notes_available"`
}

// SystemDatabaseDTO reports the database's own description of itself.
type SystemDatabaseDTO struct {
	Status string `json:"status"`
	Driver string `json:"driver"`
	// JournalMode is observed, not assumed. WALMode is derived from it, which is why
	// the page can no longer claim a mode the database is not in.
	JournalMode string `json:"journal_mode"`
	WALMode     bool   `json:"wal_mode"`
	// Synchronous, ForeignKeys and BusyTimeoutMS are null when the connection did not
	// answer for them, rather than defaulted to a value nobody measured.
	Synchronous   *int64 `json:"synchronous"`
	ForeignKeys   *int64 `json:"foreign_keys"`
	BusyTimeoutMS *int64 `json:"busy_timeout_ms"`
	SchemaVersion int64  `json:"schema_version"`
	PageSize      int64  `json:"page_size"`
	PageCount     int64  `json:"page_count"`
	// FreelistCount and FreePageBytes describe pages inside the file that later writes
	// reuse. They are never presented as reclaimable disk space.
	FreelistCount int64                  `json:"freelist_count"`
	UsedBytes     int64                  `json:"used_bytes"`
	FreePageBytes int64                  `json:"free_page_bytes"`
	Files         SystemDatabaseFilesDTO `json:"files"`
}

// SystemDatabaseFilesDTO reports each file separately, so a missing WAL is
// distinguishable from an empty one.
type SystemDatabaseFilesDTO struct {
	MainBytes  int64 `json:"main_bytes"`
	MainExists bool  `json:"main_exists"`
	WALBytes   int64 `json:"wal_bytes"`
	WALExists  bool  `json:"wal_exists"`
	SHMBytes   int64 `json:"shm_bytes"`
	SHMExists  bool  `json:"shm_exists"`
	TotalBytes int64 `json:"total_bytes"`
}

type SystemCPADTO struct {
	Status         string `json:"status"`
	EndpointMasked string `json:"endpoint_masked"`
	LatencyMS      int64  `json:"latency_ms"`
}

type SystemCollectorDTO struct {
	Status   string `json:"status"`
	Mode     string `json:"mode"`
	GapCount int    `json:"gap_count"`
}

// SystemDataVolumesDTO counts what is stored.
type SystemDataVolumesDTO struct {
	UsageEvents  int64  `json:"usage_events"`
	ErrorEvents  int64  `json:"error_events"`
	InboxPending int64  `json:"inbox_pending"`
	FirstEventMS *int64 `json:"first_event_ms"`
	LastEventMS  *int64 `json:"last_event_ms"`
	AuditEvents  int64  `json:"audit_events"`
	// Null when the gateway could not be reached: a count that could not be read is
	// not zero credentials.
	Credentials *int `json:"credentials"`
	Providers   *int `json:"providers"`
	Plugins     *int `json:"plugins"`
}

type SystemMaintenanceStatusDTO struct {
	Action          string `json:"action"`
	Running         bool   `json:"running"`
	StartedAtMS     int64  `json:"started_at_ms"`
	FinishedAtMS    int64  `json:"finished_at_ms"`
	SizeBeforeBytes int64  `json:"size_before_bytes"`
	SizeAfterBytes  int64  `json:"size_after_bytes"`
	ReclaimedBytes  int64  `json:"reclaimed_bytes"`
	// Incomplete distinguishes "the statement ran" from "it did its job": SQLite does
	// not error when a checkpoint is blocked.
	Incomplete bool   `json:"incomplete"`
	Detail     string `json:"detail"`
	Error      string `json:"error"`
}

type SystemMaintenanceAdmissionDTO struct {
	Action         string `json:"action"`
	RequiredBytes  int64  `json:"required_bytes"`
	AvailableBytes int64  `json:"available_bytes"`
	Allowed        bool   `json:"allowed"`
	Reason         string `json:"reason"`
}

type SystemRuntimeDTO struct {
	GoVersion     string `json:"go_version"`
	OSArch        string `json:"os_arch"`
	PID           int    `json:"pid"`
	StartedAtMS   int64  `json:"started_at_ms"`
	NumGoroutines int    `json:"num_goroutines"`
	AllocMB       uint64 `json:"alloc_mb"`
	SysMB         uint64 `json:"sys_mb"`
	NumGC         uint32 `json:"num_gc"`
}

// SystemReleasesDTO is one product's merged change log.
//
// Release bodies are served here and nowhere else, and they are held only in this
// process's memory. That is why BodyAvailable is reported per entry: after a restart
// the index still names the versions while the notes are unavailable, and the page
// says so instead of rendering an empty log as if nothing changed.
type SystemReleasesDTO struct {
	Product        string                  `json:"product"`
	Repository     string                  `json:"repository"`
	RepositoryURL  string                  `json:"repository_url"`
	RunningVersion string                  `json:"running_version"`
	LatestVersion  string                  `json:"latest_version"`
	State          string                  `json:"state"`
	Reason         string                  `json:"reason,omitempty"`
	RangeComplete  bool                    `json:"range_complete"`
	CheckedAtMS    *int64                  `json:"checked_at_ms"`
	AttemptedAtMS  *int64                  `json:"attempted_at_ms"`
	CheckError     string                  `json:"check_error"`
	Checking       bool                    `json:"checking"`
	Releases       []SystemReleaseEntryDTO `json:"releases"`
}

type SystemReleaseEntryDTO struct {
	Tag           string `json:"tag"`
	Name          string `json:"name"`
	PublishedAtMS int64  `json:"published_at_ms"`
	Prerelease    bool   `json:"prerelease"`
	// Body is untrusted remote Markdown. The frontend renders it without raw HTML and
	// without loading remote images.
	Body          string `json:"body"`
	HTMLURL       string `json:"html_url"`
	InRange       bool   `json:"in_range"`
	BodyAvailable bool   `json:"body_available"`
}

// getSystemInfo answers the whole page.
func (h *Handler) getSystemInfo(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	ctx := request.Context()

	var uptime int64
	if !h.startTime.IsZero() {
		uptime = int64(time.Since(h.startTime).Seconds())
	}

	dto := SystemInfoDTO{
		OMCVersion:    h.productVersionDTO(ctx, release.ProductOMC, h.omcVersion()),
		CPAVersion:    h.productVersionDTO(ctx, release.ProductCPA, h.observedCPAVersion(ctx)),
		UptimeSeconds: uptime,
		Database:      h.databaseDTO(ctx),
		CPA:           h.cpaDTO(ctx),
		Collector:     h.collectorDTO(ctx),
		DataVolumes:   h.dataVolumesDTO(ctx),
		Maintenance:   h.maintenanceStatusDTO(),
		Runtime:       h.runtimeDTO(),
	}
	dto.MaintenanceAdmission = h.maintenanceAdmissionDTO(ctx)
	writeJSON(writer, http.StatusOK, dto)
}

// getSystemReleases serves one product's merged change log.
func (h *Handler) getSystemReleases(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	product := request.URL.Query().Get("product")
	if product == "" {
		product = release.ProductOMC
	}
	if h.release == nil {
		writeError(writer, http.StatusServiceUnavailable, "release checking is not configured")
		return
	}
	if _, ok := h.releaseProduct(product); !ok {
		writeError(writer, http.StatusBadRequest, "unknown release product")
		return
	}

	runningVersion := h.omcVersion()
	if product == release.ProductCPA {
		runningVersion = h.observedCPAVersion(request.Context())
	}
	log, err := h.release.Releases(request.Context(), product, runningVersion)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "could not read release notes")
		return
	}

	dto := SystemReleasesDTO{
		Product:        log.Product,
		Repository:     log.Repository,
		RepositoryURL:  log.RepositoryURL,
		RunningVersion: log.RunningVersion,
		LatestVersion:  log.LatestVersion,
		State:          log.Comparison.State,
		Reason:         log.Comparison.Why,
		RangeComplete:  log.RangeComplete,
		CheckedAtMS:    log.CheckedAtMS,
		AttemptedAtMS:  log.AttemptedAtMS,
		CheckError:     log.CheckError,
		Checking:       log.Checking,
		Releases:       make([]SystemReleaseEntryDTO, 0, len(log.Releases)),
	}
	for _, entry := range log.Releases {
		dto.Releases = append(dto.Releases, SystemReleaseEntryDTO{
			Tag:           entry.Tag,
			Name:          entry.Name,
			PublishedAtMS: entry.PublishedAtMS,
			Prerelease:    entry.Prerelease,
			Body:          entry.Body,
			HTMLURL:       entry.HTMLURL,
			InRange:       entry.InRange,
			BodyAvailable: entry.BodyAvailable,
		})
	}
	writeJSON(writer, http.StatusOK, dto)
}

// postSystemCheckUpdates reads the feed when `release.CheckFloor` allows it and answers with
// the resulting version states.
//
// A request is spent only outside the floor: inside it the stored index answers and the
// response says so through `served_from_cache`. The floor exists because the feed is one
// shared per-address budget - sixty requests an hour for the unauthenticated GitHub API - and
// a page view costs up to four requests, so an unthrottled check let page loads exhaust an
// allowance the operator shares with everything else they run.
//
// The audit records what happened rather than that the request arrived: "unavailable" when no
// release service is configured, "cached" when the floor answered, and otherwise the outcome
// of the attempt. Recording success before the check runs would put a claim in the audit trail
// that the code has not yet earned.
func (h *Handler) postSystemCheckUpdates(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	ctx := request.Context()

	if h.release == nil {
		_ = h.recordAudit(request, "system.check_updates", "system", "release_feed", "unavailable", nil)
		writeError(writer, http.StatusServiceUnavailable, "release checking is not configured")
		return
	}
	// A check is a real read of the feed unless the floor says the last answer is still
	// fresh. Both products share the floor, so whether a request was spent is a property of
	// the pair rather than of one product.
	// Whether a request was spent is recorded before the error is considered, because a failed
	// attempt is still an attempt: reporting it as a cached answer would tell the operator the
	// page is showing a stored result when it actually tried the feed and was refused.
	servedFromCache := true
	for _, product := range h.release.Products() {
		read, err := h.release.CheckReportingFreshness(ctx, product.Key)
		if read {
			servedFromCache = false
		}
		if err != nil {
			// One product's failure is recorded in its own state and does not stop the other:
			// they have separate sources and separate reasons to fail.
			h.logger.Warn("release check failed", "product", product.Key, "error", err)
		}
	}

	response := struct {
		OMCVersion SystemProductVersionDTO `json:"omc_version"`
		CPAVersion SystemProductVersionDTO `json:"cpa_version"`
		// ServedFromCache states that the floor answered this request instead of the feed.
		// The field exists so the button can say "checked" only when a request was actually
		// made: the feed is one shared per-address budget, and a control that reported a
		// check it did not perform would teach the operator the wrong thing about what the
		// page knows.
		ServedFromCache bool `json:"served_from_cache"`
	}{
		OMCVersion:      h.productVersionDTO(ctx, release.ProductOMC, h.omcVersion()),
		CPAVersion:      h.productVersionDTO(ctx, release.ProductCPA, h.observedCPAVersion(ctx)),
		ServedFromCache: servedFromCache,
	}
	result := "checked"
	if servedFromCache {
		result = "cached"
	}
	_ = h.recordAudit(request, "system.check_updates", "system", "release_feed", result, nil)

	writeJSON(writer, http.StatusOK, response)
}

// systemMaintenanceActionDTO is the answer to a maintenance request.
type systemMaintenanceActionDTO struct {
	Maintenance SystemMaintenanceStatusDTO    `json:"maintenance"`
	Admission   SystemMaintenanceAdmissionDTO `json:"maintenance_admission"`
}

// getSystemMaintenance reports the current or last maintenance job.
func (h *Handler) getSystemMaintenance(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, http.StatusOK, systemMaintenanceActionDTO{
		Maintenance: h.maintenanceStatusDTO(),
		Admission:   h.maintenanceAdmissionDTO(request.Context()),
	})
}

// postSystemMaintenanceCheckpoint runs a WAL-truncating checkpoint.
func (h *Handler) postSystemMaintenanceCheckpoint(writer http.ResponseWriter, request *http.Request) {
	h.startMaintenance(writer, request, "checkpoint")
}

// postSystemMaintenanceVacuum rebuilds the database file.
func (h *Handler) postSystemMaintenanceVacuum(writer http.ResponseWriter, request *http.Request) {
	h.startMaintenance(writer, request, "vacuum")
}

// startMaintenance admits and launches one maintenance job.
//
// The ordering here is deliberate and load-bearing. Every database call this request
// makes happens BEFORE the job is started, and the response afterwards performs none at
// all. That is what keeps the response independent of the job: a request that wrote
// anything after admitting the job would be issuing a gated write while the job held
// the gate, so the operator's 202 would not arrive until the rebuild had finished - the
// status code would claim the job was accepted while the connection looked like it had
// hung. For the same reason the response carries the status the start returned instead
// of re-reading it.
//
// The audit records admission, which is what this request actually did. Completion is
// the job's own outcome, recorded by the service, because an admission that returns 202
// is not a successful rebuild.
func (h *Handler) startMaintenance(writer http.ResponseWriter, request *http.Request, action string) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.maintenance == nil {
		writeError(writer, http.StatusServiceUnavailable, "maintenance is not available")
		return
	}

	// Admission is measured before the job begins, so the response can state what a
	// rebuild would need without a further database read.
	admission := h.maintenanceAdmissionDTO(request.Context())

	internalAction := repository.MaintenanceCheckpoint
	if action == "vacuum" {
		internalAction = repository.MaintenanceVacuum
	} else if action != "checkpoint" {
		writeError(writer, http.StatusBadRequest, "unknown maintenance action")
		return
	}

	// Reserve first, audit, and only then launch. The order is the whole point of the
	// split: the audit record is a database write, and a write issued after the job starts
	// would wait for the write gate the job holds, so the operator's 202 would not arrive
	// until the rebuild had finished.
	status, err := h.maintenance.Reserve(request.Context(), internalAction)
	if err != nil {
		result := "failure"
		if errors.Is(err, repository.ErrMaintenanceRunning) {
			result = "conflict"
		}
		_ = h.recordAudit(request, "system.maintenance."+action, "database", action, result, nil)
		switch {
		case errors.Is(err, repository.ErrMaintenanceRunning):
			writeError(writer, http.StatusConflict, "a maintenance job is already running")
		case errors.Is(err, repository.ErrInsufficientDiskSpace):
			writeError(writer, http.StatusInsufficientStorage, err.Error())
		case errors.Is(err, repository.ErrMaintenanceClosed):
			writeError(writer, http.StatusServiceUnavailable, "maintenance is shutting down")
		default:
			writeError(writer, http.StatusInternalServerError, "could not start the maintenance job")
		}
		return
	}

	if auditErr := h.recordAudit(request, "system.maintenance."+action, "database", action, "admitted", nil); auditErr != nil {
		// Fail closed. An operator action against the database that leaves no audit record
		// is not admitted at all, and the reservation is unwound so the page does not
		// report a job that will never run.
		h.maintenance.Release(request.Context())
		writeError(writer, http.StatusInternalServerError, "could not record the maintenance admission")
		return
	}

	if launchErr := h.maintenance.Launch(request.Context()); launchErr != nil {
		h.maintenance.Release(request.Context())
		writeError(writer, http.StatusInternalServerError, "could not start the maintenance job")
		return
	}

	writeJSON(writer, http.StatusAccepted, systemMaintenanceActionDTO{
		Maintenance: maintenanceStatusToDTO(status),
		Admission:   admission,
	})
}

// omcVersion is the version this process was built as.
func (h *Handler) omcVersion() string {
	if version := h.cfg.Version; version != "" {
		return version
	}
	// An unset build version is unknown rather than a plausible-looking default: a
	// fabricated "v0.1.0" would be compared against the release feed and reported as
	// far behind, which is a wrong answer dressed as a precise one.
	return "unknown"
}

// observedCPAVersion reads the gateway's own version.
//
// This is fetched independently of any release check, and deliberately so: the
// gateway's running version is a fact about the gateway, and the previous
// implementation only learned it from the response headers of an
// internet-dependent version lookup, so a deployment that could not reach GitHub
// could not say which gateway version it was running.
func (h *Handler) observedCPAVersion(ctx context.Context) string {
	if h.repo == nil {
		return "unknown"
	}
	instance, err := h.repo.GetInstance(ctx, defaultInstanceID())
	if err != nil {
		return "unknown"
	}
	client, err := h.clientForInstance(ctx, instance)
	if err != nil {
		return "unknown"
	}
	// The version is reported on this endpoint's response headers, and reading it here
	// costs one request that the page performs anyway to answer "is the gateway up".
	_, meta, err := client.AuthFilesWithMeta(ctx)
	if err != nil {
		return "unknown"
	}
	return safeVersionHeader(meta.Header)
}

// productVersionDTO assembles one product's card.
func (h *Handler) productVersionDTO(ctx context.Context, product, runningVersion string) SystemProductVersionDTO {
	dto := SystemProductVersionDTO{
		Product:        product,
		RunningVersion: runningVersion,
		State:          release.UpdateIndeterminate,
		Reason:         release.ReasonNoData,
		Checking:       false,
		RangeComplete:  true,
	}
	if h.release == nil {
		return dto
	}
	status, err := h.release.Status(ctx, product, runningVersion)
	if err != nil {
		return dto
	}
	dto.LatestVersion = status.LatestVersion
	dto.State = status.Comparison.State
	dto.Reason = status.Comparison.Why
	dto.Repository = status.Repository
	dto.RepositoryURL = status.RepositoryURL
	dto.CheckedAtMS = status.CheckedAtMS
	dto.AttemptedAtMS = status.AttemptedAtMS
	dto.CheckError = status.CheckError
	dto.Checking = status.Checking
	dto.MergeCount = status.MergeCount
	dto.RangeComplete = status.RangeComplete
	dto.NotesAvailable = status.NotesAvailable
	return dto
}

func (h *Handler) releaseProduct(product string) (release.Product, bool) {
	if h.release == nil {
		return release.Product{}, false
	}
	for _, candidate := range h.release.Products() {
		if candidate.Key == product {
			return candidate, true
		}
	}
	return release.Product{}, false
}

// databaseDTO reports what the database says about itself.
func (h *Handler) databaseDTO(ctx context.Context) SystemDatabaseDTO {
	dto := SystemDatabaseDTO{Driver: "sqlite", Status: "error"}
	if h.repo == nil || h.repo.SQL() == nil || h.repo.SQL().PingContext(ctx) != nil {
		return dto
	}
	dto.Status = "ok"

	footprint := h.repo.ReadFileFootprint()
	dto.Files = SystemDatabaseFilesDTO{
		MainBytes:  footprint.MainBytes,
		MainExists: footprint.MainExists,
		WALBytes:   footprint.WALBytes,
		WALExists:  footprint.WALExists,
		SHMBytes:   footprint.SHMBytes,
		SHMExists:  footprint.SHMExists,
		TotalBytes: footprint.TotalBytes,
	}

	facts, err := h.repo.ReadDatabaseFacts(ctx)
	if err != nil {
		// The page still has the file sizes, which are measured directly. Reporting the
		// pragma set as absent is the honest answer when the database did not answer.
		return dto
	}
	dto.JournalMode = facts.JournalMode
	dto.WALMode = facts.WALEnabled()
	dto.Synchronous = facts.Synchronous
	dto.ForeignKeys = facts.ForeignKeys
	dto.BusyTimeoutMS = facts.BusyTimeout
	dto.SchemaVersion = facts.SchemaVersion
	dto.PageSize = facts.PageSize
	dto.PageCount = facts.PageCount
	dto.FreelistCount = facts.FreelistCount
	dto.UsedBytes = facts.UsedBytes()
	dto.FreePageBytes = facts.FreePageBytes()
	return dto
}

func (h *Handler) runtimeDTO() SystemRuntimeDTO {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	var startedAtMS int64
	if !h.startTime.IsZero() {
		startedAtMS = h.startTime.UnixMilli()
	}
	return SystemRuntimeDTO{
		GoVersion:     runtime.Version(),
		OSArch:        runtime.GOOS + "/" + runtime.GOARCH,
		PID:           processID(),
		StartedAtMS:   startedAtMS,
		NumGoroutines: runtime.NumGoroutine(),
		AllocMB:       mem.Alloc / (1024 * 1024),
		SysMB:         mem.Sys / (1024 * 1024),
		NumGC:         mem.NumGC,
	}
}

func (h *Handler) collectorDTO(ctx context.Context) SystemCollectorDTO {
	status := "disabled"
	if h.cfg.Usage.Enabled {
		status = "active"
	}
	mode := h.cfg.Usage.Mode
	if mode == "" {
		mode = "auto"
	}
	gaps := 0
	if h.repo != nil {
		if recorded, err := h.repo.ListIngestGaps(ctx, "", 100); err == nil {
			gaps = len(recorded)
		}
	}
	return SystemCollectorDTO{Status: status, Mode: mode, GapCount: gaps}
}

func (h *Handler) dataVolumesDTO(ctx context.Context) SystemDataVolumesDTO {
	dto := SystemDataVolumesDTO{}
	if h.repo == nil {
		return dto
	}
	volumes, err := h.repo.ReadDataVolumes(ctx)
	if err == nil {
		dto.UsageEvents = volumes.UsageEvents
		dto.ErrorEvents = volumes.ErrorEvents
		dto.InboxPending = volumes.InboxPending
		dto.FirstEventMS = volumes.FirstEventMS
		dto.LastEventMS = volumes.LastEventMS
		dto.AuditEvents = volumes.AuditEvents
	}

	// Gateway-side counts. A gateway that cannot be reached leaves these null rather
	// than reporting zero credentials, which would read as an empty deployment.
	instance, err := h.repo.GetInstance(ctx, defaultInstanceID())
	if err != nil {
		return dto
	}
	client, err := h.clientForInstance(ctx, instance)
	if err != nil {
		return dto
	}
	if files, err := client.AuthFiles(ctx); err == nil {
		count := len(files.Files)
		dto.Credentials = &count
	}
	if plugins, err := client.Plugins(ctx); err == nil {
		count := len(plugins)
		dto.Plugins = &count
	}
	// Providers are counted the way the provider page counts them, from the config
	// API-key families plus the compatibility entries, so this number cannot disagree
	// with the page it summarizes.
	providerCount := 0
	providersRead := false
	for _, spec := range providerConfigFamilies {
		entries, err := client.ConfigAPIKeys(ctx, spec.Family)
		if err != nil {
			continue
		}
		providerCount += len(entries)
		providersRead = true
	}
	if providersRead {
		dto.Providers = &providerCount
	}
	return dto
}

func (h *Handler) cpaDTO(ctx context.Context) SystemCPADTO {
	dto := SystemCPADTO{Status: "offline", EndpointMasked: "configured"}
	if h.repo == nil {
		return dto
	}
	instance, err := h.repo.GetInstance(ctx, defaultInstanceID())
	if err != nil {
		return dto
	}
	if instance.BaseURL != "" {
		dto.EndpointMasked = security.PublicURL(instance.BaseURL)
	}
	client, err := h.clientForInstance(ctx, instance)
	if err != nil {
		return dto
	}
	start := time.Now()
	if err := client.Health(ctx); err != nil {
		return dto
	}
	dto.Status = "connected"
	dto.LatencyMS = time.Since(start).Milliseconds()
	return dto
}

func (h *Handler) maintenanceStatusDTO() SystemMaintenanceStatusDTO {
	if h.maintenance == nil {
		return SystemMaintenanceStatusDTO{}
	}
	return maintenanceStatusToDTO(h.maintenance.Status())
}

func maintenanceStatusToDTO(status repository.MaintenanceStatus) SystemMaintenanceStatusDTO {
	return SystemMaintenanceStatusDTO{
		Action:          status.Action,
		Running:         status.Running,
		StartedAtMS:     status.StartedAtMS,
		FinishedAtMS:    status.FinishedAtMS,
		SizeBeforeBytes: status.SizeBeforeBytes,
		SizeAfterBytes:  status.SizeAfterBytes,
		ReclaimedBytes:  status.ReclaimedBytes,
		Incomplete:      status.Incomplete,
		Detail:          status.Detail,
		Error:           status.Error,
	}
}

// maintenanceAdmissionDTO states what VACUUM would need before it is started.
//
// The page shows this in the confirmation so the operator sees the requirement -
// SQLite documents up to twice the database file - rather than discovering it as a
// failure. The numbers are measured, and a measurement that is unavailable is
// reported as not allowed with the reason, never as a zero requirement.
func (h *Handler) maintenanceAdmissionDTO(ctx context.Context) SystemMaintenanceAdmissionDTO {
	dto := SystemMaintenanceAdmissionDTO{Action: "vacuum"}
	if h.maintenance == nil {
		dto.Reason = "maintenance is not available"
		return dto
	}
	admission := h.maintenance.Admission()
	dto.RequiredBytes = admission.RequiredBytes
	dto.AvailableBytes = admission.AvailableBytes
	dto.Allowed = admission.Allowed
	dto.Reason = admission.Reason
	return dto
}

// processID reports the running process id, so an operator reading a log line can
// match it to the process that served this page.
func processID() int { return os.Getpid() }

// getSystemDiagnostics exports a redacted bundle.
//
// It stays deliberately small and free of credentials: identifiers, versions,
// runtime numbers and the audit tail, with no key material, no tokens and no
// request content. The demo refuses this route because a bundle is a file that
// leaves the process.
func (h *Handler) getSystemDiagnostics(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="omc-diagnostics-%d.json"`, time.Now().Unix()))

	ctx := request.Context()
	_ = h.recordAudit(request, "system.diagnostics", "system", "redacted_bundle", "success", nil)

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	uptime := float64(0)
	if !h.startTime.IsZero() {
		uptime = time.Since(h.startTime).Seconds()
	}
	schemaVersion := int64(0)
	if facts, err := h.repo.ReadDatabaseFacts(ctx); err == nil {
		schemaVersion = facts.SchemaVersion
	}

	diagnostics := map[string]any{
		"generated_at":   time.Now().UTC().Format(time.RFC3339),
		"omc_version":    h.omcVersion(),
		"cpa_version":    h.observedCPAVersion(ctx),
		"schema_version": schemaVersion,
		"runtime": map[string]any{
			"go_version":     runtime.Version(),
			"os":             runtime.GOOS,
			"arch":           runtime.GOARCH,
			"goroutines":     runtime.NumGoroutine(),
			"alloc_mb":       mem.Alloc / (1024 * 1024),
			"sys_mb":         mem.Sys / (1024 * 1024),
			"uptime_seconds": uptime,
		},
		"database": func() map[string]any {
			footprint := h.repo.ReadFileFootprint()
			// The bundle is where the page's removed detail lives. The page answers "how much
			// disk, and in what mode" because that is what a gateway operator reads at a
			// glance; the file's internal geometry, its free-page accounting and the
			// connection's own settings are diagnostic facts, so they belong in the artifact
			// someone opens when they are actually diagnosing something.
			detail := map[string]any{
				"driver":       "sqlite",
				"status":       h.databaseDTO(ctx).Status,
				"total_bytes":  footprint.TotalBytes,
				"main_bytes":   footprint.MainBytes,
				"wal_bytes":    footprint.WALBytes,
				"shm_bytes":    footprint.SHMBytes,
				"journal_mode": h.databaseDTO(ctx).JournalMode,
			}
			if facts, err := h.repo.ReadDatabaseFacts(ctx); err == nil {
				detail["schema_version"] = facts.SchemaVersion
				detail["page_size"] = facts.PageSize
				detail["page_count"] = facts.PageCount
				detail["freelist_count"] = facts.FreelistCount
				detail["free_page_bytes"] = facts.FreePageBytes()
				detail["used_bytes"] = facts.UsedBytes()
				// A setting the connection declined to answer stays absent rather than being
				// reported as a value nobody measured.
				if facts.Synchronous != nil {
					detail["synchronous"] = *facts.Synchronous
				}
				if facts.ForeignKeys != nil {
					detail["foreign_keys"] = *facts.ForeignKeys
				}
				if facts.BusyTimeout != nil {
					detail["busy_timeout_ms"] = *facts.BusyTimeout
				}
			}
			return detail
		}(),
		"collector": map[string]any{
			"enabled": h.cfg.Usage.Enabled,
			"mode":    h.cfg.Usage.Mode,
		},
	}

	if h.repo != nil {
		if events, err := h.repo.ListAuditEvents(ctx, 50); err == nil {
			var safeEvents []map[string]any
			for _, e := range events {
				safeEvents = append(safeEvents, map[string]any{
					"time_ms":     e.OccurredAtMS,
					"action":      e.Action,
					"target_type": e.TargetType,
					"result":      e.Result,
				})
			}
			diagnostics["recent_audits"] = safeEvents
		}
		if gaps, err := h.repo.ListIngestGaps(ctx, "", 20); err == nil {
			var safeGaps []map[string]any
			for _, g := range gaps {
				safeGaps = append(safeGaps, map[string]any{
					"started_at_ms": g.StartedAtMS,
					"ended_at_ms":   g.EndedAtMS,
					"reason_code":   g.ReasonCode,
					"summary":       g.Summary,
				})
			}
			diagnostics["recent_ingest_gaps"] = safeGaps
		}
	}

	writeJSON(writer, http.StatusOK, diagnostics)
}
