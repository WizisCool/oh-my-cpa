package refresh

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// Task is one named background refresh worker managed by Scheduler.
type Task struct {
	Name string
	Run  func(ctx context.Context) error
	// Wake is an optional non-blocking nudge triggered when the task's
	// runtime schedule changes so the loop re-reads its policy without restart.
	Wake func()
}

// PeriodicConfig describes an interval-driven background refresh job whose
// cadence is read dynamically from a policy function.
type PeriodicConfig struct {
	Name string
	// Tick bounds how often the loop checks whether the configured interval
	// has elapsed. Defaults to one minute.
	Tick time.Duration
	// RunOnStart executes one immediate sweep when the loop starts (or when
	// first enabled after starting disabled) if Interval returns > 0.
	RunOnStart bool
	// Interval returns the current refresh interval. Returning <= 0 pauses
	// scheduled runs while keeping the loop alive for future policy changes.
	Interval func(ctx context.Context) time.Duration
	Run      func(ctx context.Context)
	// Now overrides time.Now for deterministic tests.
	Now func() time.Time
}

// Scheduler owns the lifecycle of all periodic background refresh workers:
// starting them under one context, forwarding policy-change wake signals, and
// joining every goroutine on shutdown before storage is closed.
type Scheduler struct {
	logger *slog.Logger
	mu     sync.RWMutex
	tasks  []Task
	wakers map[string]func()
}

// New creates a background refresh scheduler.
func New(logger *slog.Logger) *Scheduler {
	if logger == nil {
		logger = slog.Default()
	}
	return &Scheduler{
		logger: logger,
		wakers: make(map[string]func()),
	}
}

// Add registers a custom background refresh task.
func (s *Scheduler) Add(task Task) {
	if s == nil || task.Name == "" || task.Run == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tasks = append(s.tasks, task)
	if task.Wake != nil {
		s.wakers[task.Name] = task.Wake
	}
}

// AddPeriodic builds and registers a dynamically scheduled periodic task.
func (s *Scheduler) AddPeriodic(cfg PeriodicConfig) {
	if s == nil || cfg.Name == "" || cfg.Run == nil {
		return
	}
	tick := cfg.Tick
	if tick <= 0 {
		tick = time.Minute
	}
	nowFn := cfg.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	wakeCh := make(chan struct{}, 1)
	wake := func() {
		select {
		case wakeCh <- struct{}{}:
		default:
		}
	}

	s.Add(Task{
		Name: cfg.Name,
		Wake: wake,
		Run: func(ctx context.Context) error {
			intervalFor := func() time.Duration {
				if cfg.Interval == nil {
					return 0
				}
				return cfg.Interval(ctx)
			}

			last := nowFn()
			hasRun := false
			if cfg.RunOnStart && ctx.Err() == nil && intervalFor() > 0 {
				cfg.Run(ctx)
				last = nowFn()
				hasRun = true
			}

			ticker := time.NewTicker(tick)
			defer ticker.Stop()

			for {
				select {
				case <-ctx.Done():
					return nil
				case <-ticker.C:
				case <-wakeCh:
				}
				if ctx.Err() != nil {
					return nil
				}
				interval := intervalFor()
				if interval <= 0 {
					continue
				}
				if cfg.RunOnStart && !hasRun {
					cfg.Run(ctx)
					last = nowFn()
					hasRun = true
					continue
				}
				if nowFn().Sub(last) < interval {
					continue
				}
				cfg.Run(ctx)
				last = nowFn()
				hasRun = true
			}
		},
	})
}

// Wake nudges one named task so a changed schedule takes effect immediately.
func (s *Scheduler) Wake(name string) {
	if s == nil || name == "" {
		return
	}
	s.mu.RLock()
	wake := s.wakers[name]
	s.mu.RUnlock()
	if wake != nil {
		wake()
	}
}

// Run launches all registered refresh tasks concurrently and waits until every
// worker has exited after ctx is cancelled.
func (s *Scheduler) Run(ctx context.Context) {
	if s == nil {
		return
	}
	s.mu.RLock()
	tasks := append([]Task(nil), s.tasks...)
	s.mu.RUnlock()

	var wg sync.WaitGroup
	for _, task := range tasks {
		wg.Add(1)
		go func(t Task) {
			defer wg.Done()
			if err := t.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				s.logger.Warn("background refresh loop stopped", "task", t.Name, "error", err)
			}
		}(task)
	}
	wg.Wait()
}
