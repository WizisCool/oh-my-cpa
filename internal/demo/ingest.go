package demo

import (
	"context"
	"fmt"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage/ingest"
)

// IngestStatus is the capture state the demonstration reports.
//
// A self-hosted deployment answers this from its real collector. The demo runs
// none - its history is a fixture - but this endpoint is what the request list
// prints in its own header, and "capture disabled" there would describe the
// fixture rather than the product. What is reported instead is the deployment the
// fixture describes: a subscribe-mode collector that last captured moments ago.
//
// Nothing about future traffic is claimed, and every number that describes stored
// data is read from the database rather than invented.
func IngestStatus(ctx context.Context, store *repository.Repository, now time.Time) (ingest.PipelineStatus, error) {
	stats, err := store.StatsUsagePipeline(ctx)
	if err != nil {
		return ingest.PipelineStatus{}, fmt.Errorf("read demo pipeline stats: %w", err)
	}
	capturedAt := now.Add(-4 * time.Second)
	aggregatedAt := now.Add(-9 * time.Second)
	return ingest.PipelineStatus{
		Enabled: true,
		Collector: ingest.Status{
			Mode:          ingest.ModeSubscribe,
			Running:       true,
			Captured:      stats.Events,
			LastCaptureAt: &capturedAt,
		},
		Decoder: ingest.ProcessorStatus{
			Running: true,
			Decoded: stats.Events,
		},
		Maintenance: ingest.MaintenanceStatus{
			Running:          true,
			HourlyAggregated: stats.CheckpointHourly,
			DailyAggregated:  stats.CheckpointDaily,
			LastRunAt:        &aggregatedAt,
		},
		Stats:   stats,
		Healthy: true,
	}, nil
}

// RefreshResult answers the request list's manual sync.
//
// It reports a pass that found an empty queue, which is exactly what a real
// deployment answers when no request arrived in between: nothing was captured and
// nothing is pending. No queue is popped and no upstream is contacted, because the
// demonstration has no gateway to pop one from.
func RefreshResult() ingest.RefreshNowResult {
	return ingest.RefreshNowResult{
		Enabled:  true,
		Synced:   true,
		Mode:     string(ingest.ModeSubscribe),
		Captured: 0,
		Decoded:  0,
		Pending:  0,
	}
}
