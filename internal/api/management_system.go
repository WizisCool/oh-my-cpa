package api

import (
	"fmt"
	"net/http"
	"runtime"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

type SystemInfoDTO struct {
	OMCVersion      string                `json:"omc_version"`
	CPAVersion      string                `json:"cpa_version"`
	LatestVersion   string                `json:"latest_version,omitempty"`
	UpdateAvailable bool                  `json:"update_available"`
	UptimeSeconds   int64                 `json:"uptime_seconds"`
	Database        SystemDatabaseDTO     `json:"database"`
	CPA             SystemCPADTO          `json:"cpa"`
	Collector       SystemCollectorDTO    `json:"collector"`
	AuditSummary    SystemAuditSummaryDTO `json:"audit_summary"`
	Runtime         SystemRuntimeDTO      `json:"runtime"`
}

type SystemDatabaseDTO struct {
	Status  string `json:"status"`
	Driver  string `json:"driver"`
	WALMode bool   `json:"wal_mode"`
}

type SystemCPADTO struct {
	Status         string `json:"status"`
	EndpointMasked string `json:"endpoint_masked"`
	LatencyMS      int64  `json:"latency_ms"`
}

type SystemCollectorDTO struct {
	Status     string `json:"status"`
	Mode       string `json:"mode"`
	IngestGaps int    `json:"ingest_gaps"`
}

type SystemAuditSummaryDTO struct {
	TotalRecentEvents int            `json:"total_recent_events"`
	ActionCounts      map[string]int `json:"action_counts,omitempty"`
}

type SystemRuntimeDTO struct {
	GoVersion     string `json:"go_version"`
	OSArch        string `json:"os_arch"`
	NumGoroutines int    `json:"num_goroutines"`
	AllocMB       uint64 `json:"alloc_mb"`
}

func (h *Handler) getSystemInfo(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	ctx := request.Context()

	omcVersion := h.cfg.Version
	if omcVersion == "" {
		omcVersion = "v0.1.0"
	}
	var uptime int64
	if !h.startTime.IsZero() {
		uptime = int64(time.Since(h.startTime).Seconds())
	}

	dbStatus := "ok"
	if h.repo == nil || h.repo.SQL() == nil || h.repo.SQL().PingContext(ctx) != nil {
		dbStatus = "error"
	}

	cpaStatus := "offline"
	cpaVersion := "unknown"
	latestVersion := ""
	updateAvailable := false
	var cpaLatency int64
	maskedEndpoint := "configured"

	var client *management.Client
	if h.repo != nil {
		if instance, err := h.repo.GetInstance(ctx, defaultInstanceID()); err == nil {
			if c, err := h.clientForInstance(ctx, instance); err == nil {
				client = c
			}
			if instance.BaseURL != "" {
				maskedEndpoint = security.PublicURL(instance.BaseURL)
			}
		}
	}

	if client != nil {
		start := time.Now()
		if err := client.Health(ctx); err == nil {
			cpaStatus = "connected"
			cpaLatency = time.Since(start).Milliseconds()
		}
		if latest, meta, err := client.LatestVersion(ctx); err == nil {
			latestVersion = latest
			if v := meta.Header.Get("X-CPA-Version"); v != "" {
				cpaVersion = v
			}
			if latestVersion != "" && cpaVersion != "unknown" && latestVersion != cpaVersion {
				updateAvailable = true
			}
		}
	}

	collectorStatus := "disabled"
	if h.cfg.Usage.Enabled {
		collectorStatus = "active"
	}
	collectorMode := h.cfg.Usage.Mode
	if collectorMode == "" {
		collectorMode = "auto"
	}
	ingestGapsCount := 0
	if h.repo != nil {
		if gaps, err := h.repo.ListIngestGaps(ctx, "", 100); err == nil {
			ingestGapsCount = len(gaps)
		}
	}

	auditSummary := SystemAuditSummaryDTO{
		ActionCounts: make(map[string]int),
	}
	if h.repo != nil {
		if events, err := h.repo.ListAuditEvents(ctx, 100); err == nil {
			auditSummary.TotalRecentEvents = len(events)
			for _, ev := range events {
				auditSummary.ActionCounts[ev.Action]++
			}
		}
	}

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	dto := SystemInfoDTO{
		OMCVersion:      omcVersion,
		CPAVersion:      cpaVersion,
		LatestVersion:   latestVersion,
		UpdateAvailable: updateAvailable,
		UptimeSeconds:   uptime,
		Database: SystemDatabaseDTO{
			Status:  dbStatus,
			Driver:  "sqlite3",
			WALMode: true,
		},
		CPA: SystemCPADTO{
			Status:         cpaStatus,
			EndpointMasked: maskedEndpoint,
			LatencyMS:      cpaLatency,
		},
		Collector: SystemCollectorDTO{
			Status:     collectorStatus,
			Mode:       collectorMode,
			IngestGaps: ingestGapsCount,
		},
		AuditSummary: auditSummary,
		Runtime: SystemRuntimeDTO{
			GoVersion:     runtime.Version(),
			OSArch:        fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH),
			NumGoroutines: runtime.NumGoroutine(),
			AllocMB:       mem.Alloc / (1024 * 1024),
		},
	}

	writeJSON(writer, http.StatusOK, dto)
}

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

	diagnostics := map[string]any{
		"generated_at": time.Now().UTC().Format(time.RFC3339),
		"omc_version":  h.cfg.Version,
		"runtime": map[string]any{
			"go_version":     runtime.Version(),
			"os":             runtime.GOOS,
			"arch":           runtime.GOARCH,
			"goroutines":     runtime.NumGoroutine(),
			"alloc_mb":       mem.Alloc / (1024 * 1024),
			"sys_mb":         mem.Sys / (1024 * 1024),
			"uptime_seconds": uptime,
		},
		"database": map[string]any{
			"driver":   "sqlite3",
			"wal_mode": true,
			"status":   "ok",
		},
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
