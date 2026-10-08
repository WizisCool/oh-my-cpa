package ingest

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// Pipeline owns the three background loops that keep usage data fresh:
// capture, decode and maintenance.
type Pipeline struct {
	runner      *Runner
	processor   *Processor
	maintenance *Maintenance
	store       *repository.Repository
	// refresh keeps overlapping manual syncs out of the pipeline.
	refresh refreshLock
}

// PipelineStatus is what the ingest status endpoint reports.
type PipelineStatus struct {
	Enabled     bool                          `json:"enabled"`
	Collector   Status                        `json:"collector"`
	Decoder     ProcessorStatus               `json:"decoder"`
	Maintenance MaintenanceStatus             `json:"maintenance"`
	Stats       repository.UsagePipelineStats `json:"stats"`
	RecentGaps  []repository.IngestGap        `json:"recent_gaps,omitempty"`
	// Healthy is true only while a selected collector is running and its newest
	// attempt did not fail, so the UI can say plainly when usage is not arriving.
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

// Run starts every stage and blocks until the context is cancelled or a stage
// exits, then stops the rest and returns only once all of them have.
//
// The join is the point: the caller closes the database and the upstream after
// Run returns, and a collector still writing its last received batch at that
// moment would lose records CPA no longer holds.
func (p *Pipeline) Run(ctx context.Context) error {
	stageCtx, stop := context.WithCancel(ctx)
	defer stop()
	errs := make(chan error, 3)
	var stages sync.WaitGroup
	launch := func(fn func(context.Context) error) {
		stages.Add(1)
		go func() {
			defer stages.Done()
			errs <- fn(stageCtx)
		}()
	}
	// A method value on a nil receiver is not a nil func, so each stage is checked
	// before its method is taken: integrations that run without rollup
	// maintenance must not panic at start-up.
	if p.runner != nil {
		launch(p.runner.Run)
	}
	if p.processor != nil {
		launch(p.processor.Run)
	}
	if p.maintenance != nil {
		launch(p.maintenance.Run)
	}

	var err error
	select {
	case <-ctx.Done():
	case err = <-errs:
		// Any stage exiting is abnormal while the parent lives: surface it so
		// the caller can shut the app down instead of silently losing data.
	}
	stop()
	stages.Wait()
	return err
}

// Status aggregates every stage plus the stored-data summary.
func (p *Pipeline) Status(ctx context.Context) (PipelineStatus, error) {
	status := PipelineStatus{Enabled: p.runner != nil}
	if p.runner != nil {
		status.Collector = p.runner.Status()
	}
	if p.processor != nil {
		status.Decoder = p.processor.Status()
	}
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
	status.Healthy = status.Collector.Mode != "" && status.Collector.Mode != ModeOff &&
		status.Collector.Running && !status.Collector.Failing
	return status, nil
}

// RefreshNowResult is the outcome of one manual "pull CPA now" request.
//
// It reports what happened rather than a record count: a caller that only sees
// `synced` cannot tell "CPA had nothing new" from "the collector is parked",
// and those need opposite words in the UI.
type RefreshNowResult struct {
	// Enabled is false when this deployment runs no collector at all.
	Enabled bool `json:"enabled"`
	// Synced is true only when a pass drained everything it found and every
	// record it captured reached usage_events.
	Synced bool `json:"synced"`
	// Mode is the transport that served the pass.
	Mode string `json:"mode,omitempty"`
	// Captured counts records persisted to the inbox by this pass.
	Captured int `json:"captured"`
	// Decoded counts usage events committed from the inbox while this sync ran.
	// It is a window delta, so it can include a record captured before this pass
	// whose decode was still outstanding when the pass started.
	Decoded int `json:"decoded"`
	// Pending is how many records from this pass were still awaiting decoding
	// when the wait ended.
	Pending int64 `json:"pending"`
	// Failed counts records from this pass whose payload could not be decoded.
	// They leave no event behind, so a sync that dropped records is not a sync.
	Failed int64 `json:"failed,omitempty"`
	// DecodeIncomplete marks that rows were still pending when the decode wait
	// expired; the background loop keeps working on them.
	DecodeIncomplete bool `json:"decode_incomplete,omitempty"`
	// Error is why the request was not served. Empty only on success.
	Error string `json:"error,omitempty"`
	// AuthRejected marks that CPA refused the management key, which the UI must
	// present as a configuration problem rather than a transient one.
	AuthRejected bool `json:"auth_rejected,omitempty"`
}

// ErrRefreshBusy is returned when the previous manual sync has not finished.
var ErrRefreshBusy = errors.New("a usage sync is already running")

// refreshDecodeSeconds bounds the wait for captured records to become queryable
// events. Decoding is local work, so this only spans a backlog; when it expires
// the pipeline reports incomplete instead of holding the request open.
const refreshDecodeSeconds = 3

// refreshLock serialises manual syncs. It is a plain mutex and flag rather than
// holding a lock for the whole request, so a refused caller returns at once
// instead of blocking on the sync it was told to wait for.
type refreshLock struct {
	mu sync.Mutex
	in bool
}

// RefreshNow pulls CPA's usage queue immediately and waits until the records it
// captured are queryable as events.
//
// The collector cannot be re-entered from here: CPA's queue is destructive, so
// the request is handed to the collector goroutine and only the persistence
// barrier is awaited by the caller. A second refresh while one is in flight is
// refused rather than queued, because both would ask for the same drain.
func (p *Pipeline) RefreshNow(ctx context.Context) (RefreshNowResult, error) {
	result := RefreshNowResult{Enabled: p.runner != nil}
	if p.runner == nil {
		return result, nil
	}
	if !p.tryAcquireRefresh() {
		return result, ErrRefreshBusy
	}
	defer p.releaseRefresh()

	// Rows above this mark are the ones this pass captures.
	floor, err := p.store.LatestUsageInboxID(ctx)
	if err != nil {
		result.Error = security.RedactText(err.Error())
		return result, err
	}
	outcome, err := p.runner.CaptureNow(ctx)
	result.Mode = string(outcome.Mode)
	result.Captured = outcome.Captured
	if err != nil {
		// The pass's own error says why it failed. Only a request the collector
		// never served - it is parked - falls back to the reason it is parked.
		result.AuthRejected = isAuthRejection(err) ||
			(errors.Is(err, ErrCollectorNotRunning) && p.runner.Status().AuthRejected)
		result.Error = security.RedactText(err.Error())
		return result, err
	}
	if !outcome.Drained {
		result.Error = "the usage queue was not drained; more records are waiting"
		return result, nil
	}

	// Records captured before this mark are what this pass owns; anything above
	// it arrived afterwards and belongs to the next one.
	watermark, err := p.store.LatestUsageInboxID(ctx)
	if err != nil {
		result.Error = security.RedactText(err.Error())
		return result, err
	}
	decodedBefore := p.processor.Status().Decoded
	drain, err := p.processor.Drain(ctx, watermark, refreshDecodeSeconds)
	result.Decoded = int(p.processor.Status().Decoded - decodedBefore)
	result.Pending = drain.Pending
	result.Failed = drain.Failed
	if err != nil {
		result.Error = security.RedactText(err.Error())
		return result, err
	}
	// The drain only sees what it discards itself. The background decoder can
	// give up on one of this pass's records before the drain starts, so the
	// pass's own rows are counted instead of a before/after difference.
	result.Failed, err = p.store.CountUndecodableUsageInboxBetween(ctx, floor, watermark)
	if err != nil {
		result.Error = security.RedactText(err.Error())
		return result, err
	}
	switch {
	case drain.Pending > 0:
		result.DecodeIncomplete = true
		result.Error = "captured records are still being decoded"
		return result, nil
	case result.Failed > 0:
		// Nothing will ever be stored for these, so claiming a clean sync would
		// promise records the request list can never show.
		result.Error = "some captured records could not be decoded"
		return result, nil
	}

	result.Synced = true
	return result, nil
}

// tryAcquireRefresh reports whether this caller owns the sync, so an overlapping
// request is told so instead of queueing behind an identical drain.
func (p *Pipeline) tryAcquireRefresh() bool {
	p.refresh.mu.Lock()
	defer p.refresh.mu.Unlock()
	if p.refresh.in {
		return false
	}
	p.refresh.in = true
	return true
}

func (p *Pipeline) releaseRefresh() {
	p.refresh.mu.Lock()
	p.refresh.in = false
	p.refresh.mu.Unlock()
}

// LastCaptureAt is a convenience for health reporting.
func (p *Pipeline) LastCaptureAt() *time.Time {
	if p.runner == nil {
		return nil
	}
	return p.runner.Status().LastCaptureAt
}
