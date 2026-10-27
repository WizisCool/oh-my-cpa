package exchangerate

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

var ErrRefreshRunning = errors.New("exchange_rate_refresh_running")
var ErrFetchFailed = errors.New("exchange_rate_fetch_failed")

type Store interface {
	ReadExchangeRates(context.Context) (Snapshot, error)
	SaveExchangeRates(context.Context, Snapshot) error
}

type Fetcher interface {
	Fetch(context.Context) ([]Rate, error)
}

// Service owns only display rates. It has no access to price versions or usage
// costs, so refreshing a rate cannot rewrite accounting history.
type Service struct {
	store   Store
	fetcher Fetcher
	logger     *slog.Logger
	permit     chan struct{}
	wake       chan struct{}
	clock      func() time.Time
	retryDelay time.Duration
}

func NewService(store Store, fetcher Fetcher, logger *slog.Logger) *Service {
	if fetcher == nil {
		fetcher = NewFrankfurterClient()
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		store: store, fetcher: fetcher, logger: logger,
		permit: make(chan struct{}, 1), wake: make(chan struct{}, 1),
		clock: time.Now, retryDelay: 5 * time.Minute,
	}
}

func (s *Service) Refresh(ctx context.Context) (Snapshot, error) {
	select {
	case s.permit <- struct{}{}:
	default:
		return Snapshot{}, ErrRefreshRunning
	}
	defer func() {
		<-s.permit
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}()
	snapshot, err := s.store.ReadExchangeRates(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	rates, fetchErr := s.fetcher.Fetch(ctx)
	if ctx.Err() != nil {
		return snapshot, ctx.Err()
	}
	snapshot.AttemptedAtMS = s.clock().UnixMilli()
	if fetchErr == nil {
		snapshot.Rates = rates
		snapshot.UpdatedAtMS = snapshot.AttemptedAtMS
		snapshot.LastError = ""
	} else {
		// Persist a bounded code, never an upstream body or URL. Failure leaves the
		// last complete snapshot available after both network loss and a restart.
		snapshot.LastError = ErrFetchFailed.Error()
	}
	if err := s.store.SaveExchangeRates(ctx, snapshot); err != nil {
		return Snapshot{}, fmt.Errorf("save exchange rates: %w", err)
	}
	if fetchErr != nil {
		return snapshot, fmt.Errorf("%w: %w", ErrFetchFailed, fetchErr)
	}
	return snapshot, nil
}

// Run derives its schedule from SQLite, so a restart does not redownload a
// fresh snapshot. Manual refresh wakes the timer without creating a second loop.
//
// A store or download failure is retried after a short delay instead of ending the
// loop: a locked database or a cancelled attempt would otherwise freeze display
// conversion on one snapshot until the process restarts.
func (s *Service) Run(ctx context.Context) error {
	for ctx.Err() == nil {
		snapshot, err := s.store.ReadExchangeRates(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			s.logger.Warn("exchange rate schedule unreadable", "error", err)
			if !s.sleep(ctx, s.retryDelay) {
				return nil
			}
			continue
		}
		delay := time.UnixMilli(snapshot.AttemptedAtMS).Add(RefreshInterval).Sub(s.clock())
		if delay <= 0 {
			refreshCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			_, refreshErr := s.Refresh(refreshCtx)
			cancel()
			switch {
			case refreshErr == nil, errors.Is(refreshErr, ErrFetchFailed):
				// Either way the attempt was published, and its time sets the next daily tick.
				continue
			case ctx.Err() != nil:
				return nil
			case errors.Is(refreshErr, ErrRefreshRunning):
				// A concurrent manual refresh publishes its own schedule and wake signal.
				delay = RefreshInterval
			default:
				s.logger.Warn("exchange rate refresh failed", "error", refreshErr)
				if !s.sleep(ctx, s.retryDelay) {
					return nil
				}
				continue
			}
		}
		if !s.sleep(ctx, delay) {
			return nil
		}
	}
	return nil
}

// sleep waits out a delay, ending early (false) when the run ends or a manual refresh
// asks the loop to read the store again.
func (s *Service) sleep(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-s.wake:
		return true
	case <-timer.C:
		return true
	}
}
