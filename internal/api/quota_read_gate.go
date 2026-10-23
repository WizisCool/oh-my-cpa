package api

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

// Claude quota read pacing. Anthropic answers a burst of usage reads from one host with 429 for
// every credential in it, so Claude reads go one at a time, across the manual refresh, the
// background loop, the warmup probe and the Agent capability alike. Other providers keep the
// callers' own concurrency.
const (
	QUOTA_CLAUDE_READ_CONCURRENCY = 1
	// After a 429 every Claude read waits at least this long, or the Retry-After the provider
	// named when that is longer. It is what stops the rest of a round or a batch from sending the
	// requests the first refusal already answered.
	QUOTA_RATE_LIMIT_PROVIDER_PAUSE = 2 * time.Minute
	// The refused credential itself is not read on a schedule again until its own backoff has
	// passed: the base doubles with each consecutive 429 and stays below the reset-driven retry
	// window, so a read after a window reset is delayed rather than abandoned.
	QUOTA_RATE_LIMIT_BACKOFF_BASE = 5 * time.Minute
	QUOTA_RATE_LIMIT_BACKOFF_MAX  = 30 * time.Minute
	// A Claude read is three requests - profile, usage and reset grants - and all three count
	// against the same limit. Only usage changes between reads, so the plan is re-read every
	// six hours and the grants every hour, and a steady refresh costs one request.
	QUOTA_CLAUDE_PROFILE_MAX_AGE      = 6 * time.Hour
	QUOTA_CLAUDE_RESET_GRANTS_MAX_AGE = time.Hour
)

// quotaReadGates holds the pacing of every provider that needs one. The zero value is ready.
type quotaReadGates struct {
	once   sync.Once
	claude *quotaProviderGate
}

// forFile is the gate a read of file passes through, or nil for a provider read at the caller's
// concurrency. A disabled credential is never read upstream, so it needs no gate either.
func (g *quotaReadGates) forFile(file management.AuthFile) *quotaProviderGate {
	if file.Disabled || quota.DetectProvider(file.Type, file.Provider) != "claude" {
		return nil
	}
	return g.claudeGate()
}

func (g *quotaReadGates) claudeGate() *quotaProviderGate {
	g.once.Do(func() { g.claude = newQuotaProviderGate(QUOTA_CLAUDE_READ_CONCURRENCY) })
	return g.claude
}

// forgetExcept drops pacing state of credentials CPA no longer lists.
func (g *quotaReadGates) forgetExcept(current map[string]management.AuthFile) {
	g.claudeGate().forgetExcept(current)
}

// quotaProviderGate bounds one provider's reads and remembers its rate limits. It lives in
// memory: a restart forgets a pause, and the first read after it learns the limit again.
type quotaProviderGate struct {
	slots         chan struct{}
	mu            sync.Mutex
	pausedUntilMS int64
	backoffs      map[string]quotaCredentialBackoff
	// supplementary remembers when each credential's profile and grants were last read. A
	// restart forgets it, and the first read after it reads all three again.
	supplementary map[string]quotaSupplementaryReads
}

type quotaSupplementaryReads struct {
	profileAtMS     int64
	resetGrantsAtMS int64
}

type quotaCredentialBackoff struct {
	consecutive int
	untilMS     int64
}

func newQuotaProviderGate(concurrency int) *quotaProviderGate {
	return &quotaProviderGate{
		slots:         make(chan struct{}, concurrency),
		backoffs:      make(map[string]quotaCredentialBackoff),
		supplementary: make(map[string]quotaSupplementaryReads),
	}
}

// acquire waits for a read slot, or for ctx to end.
func (g *quotaProviderGate) acquire(ctx context.Context) (release func(), err error) {
	select {
	case g.slots <- struct{}{}:
		return func() { <-g.slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// pausedUntil is when the provider may be read again, or zero when it may be read now.
func (g *quotaProviderGate) pausedUntil(nowMS int64) int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.pausedUntilMS > nowMS {
		return g.pausedUntilMS
	}
	return 0
}

// scheduledReadAt is the earliest instant the background loop may read authIndex: the provider
// pause or the credential's own backoff, whichever ends later.
func (g *quotaProviderGate) scheduledReadAt(authIndex string) int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	return max(g.pausedUntilMS, g.backoffs[authIndex].untilMS)
}

// readOptions leaves out the supplementary reads whose last answer is recent and still carried
// by prior. A prior plan with no type came from a failed profile read and is read again.
func (g *quotaProviderGate) readOptions(authIndex string, prior *quota.NormalizedQuota, nowMS int64) quota.ReadOptions {
	if prior == nil {
		return quota.ReadOptions{}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	reads := g.supplementary[authIndex]
	return quota.ReadOptions{
		IsClaudeProfileFresh:     prior.Plan != nil && prior.Plan.PlanType != "" && reads.profileAtMS > 0 && nowMS-reads.profileAtMS < QUOTA_CLAUDE_PROFILE_MAX_AGE.Milliseconds(),
		IsClaudeResetGrantsFresh: reads.resetGrantsAtMS > 0 && nowMS-reads.resetGrantsAtMS < QUOTA_CLAUDE_RESET_GRANTS_MAX_AGE.Milliseconds(),
	}
}

// recordSupplementary stamps the supplementary reads a usable reading just made. A refused grants
// read leaves its stamp alone, so the grants are listed again on the next read.
func (g *quotaProviderGate) recordSupplementary(authIndex string, options quota.ReadOptions, reading *quota.NormalizedQuota, nowMS int64) {
	if isUsable, _ := quota.ReadOutcome(reading, nil); !isUsable {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	reads := g.supplementary[authIndex]
	if !options.IsClaudeProfileFresh {
		reads.profileAtMS = nowMS
	}
	if !options.IsClaudeResetGrantsFresh && reading.RateLimit == nil {
		reads.resetGrantsAtMS = nowMS
	}
	g.supplementary[authIndex] = reads
}

// observe updates the pacing from one read's outcome. A refused read pauses the provider and
// backs the credential off; a usable one ends the credential's backoff. Any other failure says
// nothing about the rate and leaves both alone.
func (g *quotaProviderGate) observe(authIndex string, reading *quota.NormalizedQuota, nowMS int64) {
	if reading == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	isUsable, _ := quota.ReadOutcome(reading, nil)
	if reading.RateLimit != nil {
		retryAfterMS := reading.RateLimit.RetryAfter.Milliseconds()
		g.pausedUntilMS = max(g.pausedUntilMS, nowMS+max(retryAfterMS, QUOTA_RATE_LIMIT_PROVIDER_PAUSE.Milliseconds()))
		// A refused grants read rides on a usable reading: the provider is pacing us, but the
		// credential answered, so its own backoff ends as for any success.
		if !isUsable {
			backoff := g.backoffs[authIndex]
			backoff.consecutive++
			backoff.untilMS = nowMS + max(retryAfterMS, quotaRateLimitBackoff(backoff.consecutive).Milliseconds())
			g.backoffs[authIndex] = backoff
			return
		}
	}
	if isUsable {
		delete(g.backoffs, authIndex)
	}
}

// quotaRateLimitBackoff is the wait after the given number of consecutive 429s.
func quotaRateLimitBackoff(consecutive int) time.Duration {
	backoff := QUOTA_RATE_LIMIT_BACKOFF_BASE
	for range consecutive - 1 {
		if backoff >= QUOTA_RATE_LIMIT_BACKOFF_MAX {
			break
		}
		backoff *= 2
	}
	return min(backoff, QUOTA_RATE_LIMIT_BACKOFF_MAX)
}

// forgetExcept drops backoffs of credentials CPA no longer lists.
func (g *quotaProviderGate) forgetExcept(current map[string]management.AuthFile) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for authIndex := range g.backoffs {
		if _, ok := current[authIndex]; !ok {
			delete(g.backoffs, authIndex)
		}
	}
	for authIndex := range g.supplementary {
		if _, ok := current[authIndex]; !ok {
			delete(g.supplementary, authIndex)
		}
	}
}

// readThroughGate runs read under file's provider gate. While the provider is paused it sends
// nothing and answers with the previous reading marked stale, so a manual click inside a
// Retry-After cannot spend the request the provider asked us to hold.
func (h *Handler) readThroughGate(ctx context.Context, svc *quota.Service, file management.AuthFile, prior *quota.NormalizedQuota, read func(quota.ReadOptions) (*quota.NormalizedQuota, error)) (*quota.NormalizedQuota, error) {
	gate := h.quotaReadGates.forFile(file)
	if gate == nil {
		return read(quota.ReadOptions{})
	}
	if untilMS := gate.pausedUntil(h.now().UnixMilli()); untilMS > 0 {
		return svc.DeferredReading(file, prior, time.UnixMilli(untilMS)), nil
	}
	release, err := gate.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	// The read that held the slot may have been the one refused.
	if untilMS := gate.pausedUntil(h.now().UnixMilli()); untilMS > 0 {
		return svc.DeferredReading(file, prior, time.UnixMilli(untilMS)), nil
	}
	authIndex := strings.TrimSpace(file.AuthIndex)
	options := gate.readOptions(authIndex, prior, h.now().UnixMilli())
	reading, err := read(options)
	if err == nil {
		nowMS := h.now().UnixMilli()
		gate.observe(authIndex, reading, nowMS)
		gate.recordSupplementary(authIndex, options, reading, nowMS)
	}
	return reading, err
}

// holdsCallerSlot reports whether a batch read of file takes one of the caller's shared slots.
// A gated provider is already bounded by its gate; holding a shared slot while waiting for it
// would leave every other provider in the batch queued behind Claude.
func (h *Handler) holdsCallerSlot(file management.AuthFile) bool {
	return h.quotaReadGates.forFile(file) == nil
}
