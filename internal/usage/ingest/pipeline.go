package ingest

import (
	"context"
	"errors"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Pipeline owns the three background loops that keep usage data fresh:
// capture, decode and maintenance.
type Pipeline struct {
	runner      *Runner
	processor   *Processor
	maintenance *Maintenance
	store       *repository.Repository
}

// PipelineStatus is what the ingest status endpoint reports.
type PipelineStatus struct {
	Enabled     bool                          `json:"enabled"`
	Collector   Status                        `json:"collector"`
	Decoder     ProcessorStatus               `json:"decoder"`
	Maintenance MaintenanceStatus             `json:"maintenance"`
	Stats       repository.UsagePipelineStats `json:"stats"`
	RecentGaps  []repository.IngestGap        `json:"recent_gaps,omitempty"`
	// Healthy is false when nothing has been captured and the collector is not
	// reporting a working mode, so the UI can say so plainly.
	Healthy bool `json:"healthy"`
}

// NewPipeline wires capture, decode and maintenance over one store.
func NewPipeline(runner *Runner, processor *Processor, maintenance *Maintenance, store *repository.Repository) (*Pipeline, error) {
	if processor == nil {
		return nil, errors.New("usage processor is required")
	}
	if store == nil {
		return nil, errors.New("usage store is required")
	}
	return &Pipeline{runner: runner, processor: processor, maintenance: maintenance, store: store}, nil
}

// Runner exposes the collector for wiring and tests.
func (p *Pipeline) Runner() *Runner { return p.runner }

// Run starts every stage and blocks until the context is cancelled.
func (p *Pipeline) Run(ctx context.Context) error {
	errs := make(chan error, 3)
	launch := func(fn func(context.Context) error) {
		if fn == nil {
			return
		}
		go func() { errs <- fn(ctx) }()
	}
	launch(p.runner.Run)
	launch(p.processor.Run)
	launch(p.maintenance.Run)

	select {
	case <-ctx.Done():
		return nil
	case err := <-errs:
		// Any stage exiting is abnormal while the parent lives: surface it so
		// the caller can shut the app down instead of silently losing data.
		return err
	}
}

// Status aggregates every stage plus the stored-data summary.
func (p *Pipeline) Status(ctx context.Context) (PipelineStatus, error) {
	status := PipelineStatus{Enabled: p.runner != nil}
	if p.runner != nil {
		status.Collector = p.runner.Status()
	}
	status.Decoder = p.processor.Status()
	if p.maintenance != nil {
		status.Maintenance = p.maintenance.Status()
	}
	stats, err := p.store.StatsUsagePipeline(ctx)
	if err != nil {
		return status, err
	}
	status.Stats = stats
	if p.store != nil {
		gaps, _ := p.store.ListIngestGaps(ctx, "default", 10)
		status.RecentGaps = gaps
	}
	status.Healthy = status.Collector.Mode != "" && status.Collector.Mode != ModeOff
	return status, nil
}

// LastCaptureAt is a convenience for health reporting.
func (p *Pipeline) LastCaptureAt() *time.Time {
	if p.runner == nil {
		return nil
	}
	return p.runner.Status().LastCaptureAt
}
