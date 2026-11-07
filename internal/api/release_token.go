package api

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// releaseTokenTTL bounds how long one read of the gateway's configuration answers the token
// question. It is short enough that a token changed in the console reaches the next sweep, and
// long enough that a sweep's few requests share one configuration read.
const releaseTokenTTL = 5 * time.Minute

// releaseTokenCache holds the gateway's GitHub token for this process.
//
// `attemptedAt` is armed by an attempt that actually reached a conclusion, so a read abandoned
// with its caller is retried rather than leaving the window without a token, and a gateway that
// cannot be read is not asked again on every request; the previous token stays in place meanwhile.
// The lock is held across that one read, which is bounded by the console's request timeout: a
// slow gateway serialises the release reads behind it once per window, which is cheaper than the
// bookkeeping a narrower lock would need to keep the attempt and its outcome together.
type releaseTokenCache struct {
	mutex       sync.Mutex
	token       string
	attemptedAt time.Time
}

// ReleaseToken answers the GitHub token Oh My CPA's own release and star-count reads carry.
//
// The token is the one set on the configuration panel (`server.github-token`), which the
// gateway uses for its own downloads: a deployment configures GitHub once and both processes
// benefit from the higher limit. It is read through the management client, held in memory for a
// few minutes, and never logged or returned to a browser. A configuration that cannot be read
// leaves the previous answer in place, and no answer at all means the reads go out anonymously.
func (h *Handler) ReleaseToken(ctx context.Context) string {
	if h == nil || h.repo == nil {
		return ""
	}
	cache := &h.releaseToken
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	if !cache.attemptedAt.IsZero() && time.Since(cache.attemptedAt) < releaseTokenTTL {
		return cache.token
	}

	token, err := h.readReleaseToken(ctx)
	if err != nil {
		// A read the caller abandoned says nothing about the gateway, so it does not arm the
		// window; a real failure does, which keeps a gateway that is down from being asked on
		// every request.
		if ctx.Err() == nil {
			cache.attemptedAt = time.Now()
		}
		return cache.token
	}
	cache.token = token
	cache.attemptedAt = time.Now()
	return cache.token
}

// readReleaseToken reads the gateway's configured token once.
func (h *Handler) readReleaseToken(ctx context.Context) (string, error) {
	instance, err := h.repo.GetInstance(ctx, defaultInstanceID())
	if err != nil {
		return "", err
	}
	client, err := h.clientForInstance(ctx, instance)
	if err != nil {
		return "", err
	}
	view, _, err := client.ConfigView(ctx)
	if err != nil {
		return "", err
	}
	raw, _ := management.ValueAt(view, []string{"server", "github-token"})
	value, _ := raw.(string)
	return strings.TrimSpace(value), nil
}
