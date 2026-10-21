package api

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Automatic quota refresh cadence. The loop wakes every minute, which is the resolution a
// reset-driven read needs. A wake with nothing due makes no provider request: it costs the
// settings read, CPA's credential list and the latest stored observations, the same reads
// the dashboard's Credential Quota panel already makes each minute.
const (
	QUOTA_AUTO_REFRESH_TICK = time.Minute
	// A round reads at most this many credentials, and the rest are due again on the next
	// tick. A fleet whose windows all reset at one instant would otherwise turn a single
	// minute into a burst of credential-bearing requests through CPA.
	QUOTA_AUTO_REFRESH_ROUND_LIMIT = 16
	// The same concurrency bound the manual batch refresh uses.
	QUOTA_AUTO_REFRESH_CONCURRENCY = 4
)

// quotaAutoRefreshState remembers when this process last tried each credential. It lives
// in memory because it only exists to stop a failing read from repeating every tick: a
// failed read is never persisted, so the stored observation alone would keep it due.
type quotaAutoRefreshState struct {
	mu             sync.Mutex
	lastAttemptsMS map[string]int64
	// lastRoundError keeps a gateway that stays unreachable from logging the same warning
	// every minute: a failure is logged when it starts or changes, and recovery once.
	lastRoundError string
}

// quotaAutoRefreshRound summarizes one round for the service log.
type quotaAutoRefreshRound struct {
	Due       int
	Refreshed int
	Failed    int
	ByReset   int
}

// RunQuotaAutoRefresh reads due credentials' quotas in the background until ctx ends.
//
// It is best effort in the way the pricing sync is: a round that cannot reach CPA leaves
// the stored readings as they were, and the next tick tries again. The policy is read on
// every tick, so a change made in the console takes effect within a minute.
func (h *Handler) RunQuotaAutoRefresh(ctx context.Context) error {
	ticker := time.NewTicker(QUOTA_AUTO_REFRESH_TICK)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			round, err := h.runQuotaAutoRefreshRound(ctx)
			if ctx.Err() != nil {
				return ctx.Err()
			}
			h.logQuotaAutoRefreshFailure(err)
			if round.Due > 0 && h.logger != nil {
				h.logger.Info("automatic quota refresh round",
					"due", round.Due, "refreshed", round.Refreshed, "failed", round.Failed, "after_reset", round.ByReset)
			}
		}
	}
}

// runQuotaAutoRefreshRound performs one tick's work and reports what it did.
func (h *Handler) runQuotaAutoRefreshRound(ctx context.Context) (quotaAutoRefreshRound, error) {
	if h.repo == nil {
		return quotaAutoRefreshRound{}, nil
	}
	raw, isStored, err := h.repo.GetPreference(ctx, repository.PreferenceQuotaAutoRefresh)
	if err != nil {
		return quotaAutoRefreshRound{}, err
	}
	settings := quota.ResolveAutoRefreshSettings(raw, isStored)
	if !settings.IsEnabled() {
		return quotaAutoRefreshRound{}, nil
	}

	instance, err := h.repo.GetInstance(ctx, defaultInstanceID())
	if errors.Is(err, sql.ErrNoRows) {
		// A deployment with no gateway configured yet has nothing to read.
		return quotaAutoRefreshRound{}, nil
	}
	if err != nil {
		return quotaAutoRefreshRound{}, err
	}
	client, err := h.clientForInstance(ctx, instance)
	if err != nil {
		return quotaAutoRefreshRound{}, err
	}
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		return quotaAutoRefreshRound{}, err
	}

	// An index two credentials claim is the workspace's ambiguity diagnostic, not a
	// credential: reading it would store an observation that belongs to neither.
	filesByIndex := make(map[string]management.AuthFile, len(filesResp.Files))
	claims := make(map[string]int, len(filesResp.Files))
	for _, file := range filesResp.Files {
		authIndex := strings.TrimSpace(file.AuthIndex)
		if authIndex == "" {
			continue
		}
		claims[authIndex]++
		filesByIndex[authIndex] = file
	}
	authIndexes := make([]string, 0, len(filesByIndex))
	for authIndex := range filesByIndex {
		if claims[authIndex] == 1 {
			authIndexes = append(authIndexes, authIndex)
		}
	}
	if len(authIndexes) == 0 {
		return quotaAutoRefreshRound{}, nil
	}
	snapshots, err := h.repo.GetLatestQuotaSnapshots(ctx, authIndexes)
	if err != nil {
		return quotaAutoRefreshRound{}, err
	}

	type dueCredential struct {
		file       management.AuthFile
		prior      *quota.NormalizedQuota
		trigger    string
		observedMS int64
	}
	nowMS := h.now().UnixMilli()
	lastAttempts := h.quotaAutoRefresh.snapshotAttempts()
	due := make([]dueCredential, 0)
	for _, authIndex := range authIndexes {
		file := filesByIndex[authIndex]
		candidate := quota.AutoRefreshCandidate{
			Provider:        quota.DetectProvider(file.Type, file.Provider),
			IsDisabled:      file.Disabled,
			IsSupported:     quota.CapabilitiesForFile(file).RefreshSupported,
			LastAttemptAtMS: lastAttempts[authIndex],
		}
		var prior *quota.NormalizedQuota
		if snapshot, ok := snapshots[authIndex]; ok {
			prior = normalizedQuotaFromSnapshot(authIndex, snapshot)
			candidate.LastObservedAtMS = snapshot.ObservedAtMS
			candidate.ResetAtMS = quota.WindowResetTimes(prior.Windows)
		}
		if trigger := quota.AutoRefreshTrigger(settings, candidate, nowMS); trigger != quota.AutoRefreshTriggerNone {
			due = append(due, dueCredential{file: file, prior: prior, trigger: trigger, observedMS: candidate.LastObservedAtMS})
		}
	}
	// Reset-driven reads go first, because they answer whether a credential can serve
	// again; scheduled ones follow, oldest reading first.
	slices.SortFunc(due, func(a, b dueCredential) int {
		if a.trigger != b.trigger {
			if a.trigger == quota.AutoRefreshTriggerReset {
				return -1
			}
			return 1
		}
		return cmp.Or(cmp.Compare(a.observedMS, b.observedMS), strings.Compare(a.file.AuthIndex, b.file.AuthIndex))
	})
	round := quotaAutoRefreshRound{Due: len(due)}
	if len(due) > QUOTA_AUTO_REFRESH_ROUND_LIMIT {
		due = due[:QUOTA_AUTO_REFRESH_ROUND_LIMIT]
	}

	svc := quota.NewService(client)
	var wg sync.WaitGroup
	var countMu sync.Mutex
	sem := make(chan struct{}, QUOTA_AUTO_REFRESH_CONCURRENCY)
	for _, credential := range due {
		authIndex := strings.TrimSpace(credential.file.AuthIndex)
		h.quotaAutoRefresh.recordAttempt(authIndex, nowMS)
		wg.Add(1)
		go func(file management.AuthFile, prior *quota.NormalizedQuota, trigger string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			refreshed, err := h.refreshQuotaReading(ctx, svc, file, prior)
			// The same persistence rule as a manual refresh: a failed or stale read
			// never replaces the last good observation.
			isRefreshed := err == nil && refreshed != nil
			if isRefreshed {
				if isUsable, _ := quota.ReadOutcome(refreshed, nil); !isUsable {
					isRefreshed = false
				} else if persistErr := h.persistNormalizedQuotaSnapshot(ctx, refreshed); persistErr != nil {
					isRefreshed = false
				}
			}
			countMu.Lock()
			defer countMu.Unlock()
			if !isRefreshed {
				round.Failed++
				return
			}
			round.Refreshed++
			if trigger == quota.AutoRefreshTriggerReset {
				round.ByReset++
			}
		}(credential.file, credential.prior, credential.trigger)
	}
	wg.Wait()
	h.quotaAutoRefresh.forgetExcept(filesByIndex)
	return round, nil
}

func (h *Handler) logQuotaAutoRefreshFailure(err error) {
	message := ""
	if err != nil {
		message = err.Error()
	}
	h.quotaAutoRefresh.mu.Lock()
	previous := h.quotaAutoRefresh.lastRoundError
	h.quotaAutoRefresh.lastRoundError = message
	h.quotaAutoRefresh.mu.Unlock()
	if h.logger == nil || message == previous {
		return
	}
	if message == "" {
		h.logger.Info("automatic quota refresh rounds recovered")
		return
	}
	h.logger.Warn("automatic quota refresh round failed", "error", message)
}

func (s *quotaAutoRefreshState) snapshotAttempts() map[string]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return maps.Clone(s.lastAttemptsMS)
}

func (s *quotaAutoRefreshState) recordAttempt(authIndex string, nowMS int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastAttemptsMS == nil {
		s.lastAttemptsMS = make(map[string]int64)
	}
	s.lastAttemptsMS[authIndex] = nowMS
}

// forgetExcept drops attempts for credentials CPA no longer lists, so the map is bounded
// by the fleet rather than by every index the process has ever seen.
func (s *quotaAutoRefreshState) forgetExcept(current map[string]management.AuthFile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for authIndex := range s.lastAttemptsMS {
		if _, ok := current[authIndex]; !ok {
			delete(s.lastAttemptsMS, authIndex)
		}
	}
}
