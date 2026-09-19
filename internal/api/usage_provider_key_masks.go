package api

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

/**
 * Provider key masks answer "which of this provider's keys served the request?"
 * on a request record.
 *
 * CPA's usage payload carries no provider key. What it carries is the runtime
 * `auth_index` of the credential CPA selected, which is stable for a configured
 * credential, and the keys themselves live only in CPA's configuration. The mask
 * is therefore resolved here, at read time, from the credential lists CPA
 * reports - the four config API-key families and the openai-compatibility
 * providers - and returned on the record as `provider_key_mask`.
 *
 * Three properties bound what this can answer, and each is deliberate:
 *
 *   - **It resolves against the configuration as it is read, not as it was at
 *     request time.** A credential that has since been rotated, deleted or
 *     disabled no longer claims its index, so the row prints nothing. The console
 *     cannot reconstruct a key it can no longer read, and printing a plausible
 *     one would be a fabrication.
 *   - **A mask is not an identity, and neither is an index on its own.** An index
 *     claimed by more than one credential resolves to nothing rather than to
 *     whichever entry was read first: one key's mask on another key's request is
 *     worse than no mask at all. This is the same rule the repository applies when
 *     it joins a record to a discovered resource.
 *   - **The plaintext key never leaves this process** except toward the credential
 *     list the operator is editing, which is what ADR 0015 fixes. Only
 *     `security.MaskSecret` output is ever stored in this cache or returned to the
 *     browser, and the browser renders it as a label without asking for anything.
 *
 * The read is best effort. A CPA that is down, slow or missing a family leaves the
 * records' masks empty and returns the request list unchanged: a display label
 * must not be able to fail the page whose job is to show request history.
 */

// providerKeyMaskNamespace names one CPA credential list, and is also the scope
// an auth index is allowed to match within.
//
// Two credential lists can in principle mint the same index, so a match is only
// honoured inside the list the record came from: a config family's index cannot
// be answered with a compatibility provider's entry, or the other way round. The
// four family lists are named by the family itself, because that is the label CPA
// puts on a record they served.
type providerKeyMaskNamespace string

// namespaceOpenAICompatibility is the one list CPA names by upstream provider
// rather than by family, with one `api-key-entries` array per provider.
const namespaceOpenAICompatibility providerKeyMaskNamespace = "openai-compatibility"

// providerKeyMaskFamilies are the credential lists CPA stores one entry per
// credential for, keyed by the label such a record carries. A record CPA labels
// with `openai-compatible-<provider name>` belongs to the compatibility list
// instead; any other label belongs to neither and is not a candidate.
var providerKeyMaskFamilies = map[string]bool{
	string(management.ConfigFamilyCodex):  true,
	string(management.ConfigFamilyClaude): true,
	string(management.ConfigFamilyGemini): true,
	string(management.ConfigFamilyMeta):   true,
}

const (
	// providerKeyMaskTTL is how long a read credential list is reused. It bounds
	// how long an operator's credential edit can take to appear on a request row,
	// and equally how often the console re-reads lists it only needs for a label.
	providerKeyMaskTTL = 60 * time.Second
	// providerKeyMaskFailureTTL is the negative cache for a list that could not be
	// read. It is short because the state is transient, and long enough that a
	// polling request list cannot turn one unreachable gateway into a request per
	// poll.
	providerKeyMaskFailureTTL = 30 * time.Second
	// providerKeyMaskReadTimeout bounds the whole enrichment of one page. It is
	// deliberately shorter than the gateway client's own timeout: this runs inside
	// a request whose own answer is already in hand, so a slow credential read must
	// give up rather than hold the page open.
	providerKeyMaskReadTimeout = 3 * time.Second
	// maxProviderKeyMaskEntries bounds the cache. Its keys are
	// (instance, credential list) pairs, so a deployment holds a handful; the cap
	// exists only so an instance whose endpoint keeps changing cannot grow it
	// without bound.
	maxProviderKeyMaskEntries = 32
)

// providerKeyMaskEntry is one credential list's resolved masks.
type providerKeyMaskEntry struct {
	// masks maps an auth index to the display mask of the key that claims it, and
	// omits every index that is unclaimed or ambiguous.
	masks map[string]string
	// expiresAt is when this entry must be read again. A failed read sets it too,
	// which is what stops an unreachable gateway from being retried per poll.
	expiresAt time.Time
	// refreshing is non-nil while one caller is reading CPA for this entry. Every
	// other caller waits on it instead of starting a second read of the same list:
	// the request list polls, and without this every open tab would multiply into
	// its own credential read.
	refreshing chan struct{}
}

// providerKeyMaskCache holds the resolved masks.
//
// It is owned by the handler, is safe for concurrent use, and holds masked
// mappings only - never a credential, and never a value that can be turned back
// into one. It is invalidated whenever a write this console makes could have
// changed what a credential list claims; the TTL is what covers a change made
// outside the console, such as an edit through CPA's own control panel or a
// config file reload.
type providerKeyMaskCache struct {
	mu      sync.Mutex
	entries map[string]providerKeyMaskEntry
}

func newProviderKeyMaskCache() *providerKeyMaskCache {
	return &providerKeyMaskCache{entries: make(map[string]providerKeyMaskEntry)}
}

// masks returns the masks for one credential list, reading CPA only when the
// cached answer has expired.
//
// `load` is called outside the lock, so a slow gateway delays the caller that
// triggered the read rather than every other caller. A caller that arrives while a
// read is already running waits for it and then reads the result.
func (c *providerKeyMaskCache) masks(
	ctx context.Context,
	key string,
	load func(context.Context) (map[string]string, error),
) map[string]string {
	if c == nil {
		return nil
	}
	for {
		c.mu.Lock()
		entry, found := c.entries[key]
		if found && entry.refreshing == nil && time.Now().Before(entry.expiresAt) {
			masks := entry.masks
			c.mu.Unlock()
			return masks
		}
		if found && entry.refreshing != nil {
			waiting := entry.refreshing
			c.mu.Unlock()
			select {
			case <-waiting:
				// Answer from what that read stored. Asking again here would be a
				// second read of a list this caller has already waited for once.
				return c.cached(key)
			case <-ctx.Done():
				return nil
			}
		}
		if !found && len(c.entries) >= maxProviderKeyMaskEntries {
			// Dropping the whole cache is safe and simpler than an eviction order:
			// every entry is a cached read, and each one is re-read on demand. This
			// cannot loop, because the only key that can be asked for next is one
			// this call is about to insert.
			c.entries = make(map[string]providerKeyMaskEntry)
		}
		// Stored from an empty entry rather than from the expired one, so no stale
		// mask can be observed while this read is in flight.
		done := make(chan struct{})
		entry = providerKeyMaskEntry{refreshing: done}
		c.entries[key] = entry
		c.mu.Unlock()

		masks, err := load(ctx)

		c.mu.Lock()
		// Written through the entry this call owns rather than through a fresh
		// lookup: an invalidation during the read has replaced the map, and the
		// answer belongs to the read that is finishing, not to the new state.
		stored := providerKeyMaskEntry{expiresAt: time.Now().Add(providerKeyMaskTTL)}
		if err != nil {
			// No stale fallback. A list that cannot be read now is a list whose
			// keys may have changed, and a mask that no longer matches the
			// configuration is exactly the wrong answer this feature must not give.
			stored.expiresAt = time.Now().Add(providerKeyMaskFailureTTL)
		} else {
			stored.masks = masks
		}
		current, stillOwned := c.entries[key]
		if stillOwned && current.refreshing == done {
			c.entries[key] = stored
		}
		c.mu.Unlock()
		close(done)

		// A write that landed while this read was in flight has invalidated every
		// entry, which means the list this read saw was replaced underneath it. Its
		// answer is therefore not known to still describe the configuration, so it is
		// withheld as well as not stored: returning it would hand this request the
		// very claim the invalidation exists to withdraw.
		if !stillOwned || current.refreshing != done {
			return nil
		}
		if err != nil {
			return nil
		}
		return masks
	}
}

// cached returns a fresh entry's masks, or nothing when the entry is absent,
// expired or a recorded failure.
func (c *providerKeyMaskCache) cached(key string) map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, found := c.entries[key]
	if !found || time.Now().After(entry.expiresAt) {
		return nil
	}
	return entry.masks
}

// invalidate drops every cached mask. It is called after a write this console
// makes to a provider or to the configuration document, so an operator who
// renames or re-keys a credential sees the result on the next request list
// rather than at the end of the TTL.
func (c *providerKeyMaskCache) invalidate() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[string]providerKeyMaskEntry)
}

// attachProviderKeyMasks fills in the mask of the provider key that answered each
// record, reading each credential list at most once for the whole page.
//
// It is best effort and never fails the request: an unreadable CPA leaves the
// field empty, and the console then prints no key line rather than a wrong one.
func (h *Handler) attachProviderKeyMasks(request *http.Request, items []usageEventResponse) {
	if len(items) == 0 {
		return
	}
	resolved := h.resolveProviderKeyMasks(request, items)
	if resolved == nil {
		return
	}
	for index := range items {
		applyProviderKeyMask(&items[index], resolved)
	}
}

// resolveProviderKeyMasks reads the credential lists this page needs and indexes
// them by auth index. It returns nil when nothing needs resolving.
func (h *Handler) resolveProviderKeyMasks(
	request *http.Request,
	items []usageEventResponse,
) map[providerKeyMaskNamespace]map[string]string {
	if h.repo == nil || h.providerKeyMasks == nil {
		return nil
	}
	// Only the credential lists this page actually needs are read. A window that
	// served no API-key request resolves nothing and reads nothing, which is what
	// keeps an OAuth-only request list from paying for this at all.
	needed := make(map[providerKeyMaskNamespace]bool)
	for _, item := range items {
		if namespace, ok := providerKeyMaskNamespaceForEvent(item); ok {
			needed[namespace] = true
		}
	}
	if len(needed) == 0 {
		return nil
	}
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		return nil
	}
	client, err := h.clientForInstance(request.Context(), instance)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), providerKeyMaskReadTimeout)
	defer cancel()

	resolved := make(map[providerKeyMaskNamespace]map[string]string, len(needed))
	for namespace := range needed {
		// The instance is part of the cache key so that re-pointing the console at
		// another gateway can never serve the previous gateway's masks.
		cacheKey := instance.ID + "|" + instance.BaseURL + "|" + string(namespace)
		resolved[namespace] = h.providerKeyMasks.masks(ctx, cacheKey, func(readCtx context.Context) (map[string]string, error) {
			masks, readErr := readProviderKeyMaskClaims(readCtx, client, namespace)
			if readErr != nil && h.logger != nil {
				// Coalesced and negatively cached, so this is at most one line per
				// credential list per failure window - not one per request row. The
				// message is the same public classifier every other gateway failure
				// uses: a management error body can echo the credential it rejected.
				h.logger.Warn("provider key mask read failed",
					"namespace", string(namespace), "error", publicCPAErrorMessage(readErr))
			}
			return masks, readErr
		})
	}
	return resolved
}

// applyProviderKeyMask writes the resolved mask onto one record, leaving the field
// empty when nothing claimed the record's auth index.
func applyProviderKeyMask(
	item *usageEventResponse,
	resolved map[providerKeyMaskNamespace]map[string]string,
) {
	namespace, ok := providerKeyMaskNamespaceForEvent(*item)
	if !ok {
		return
	}
	if mask := resolved[namespace][item.AuthIndex]; mask != "" {
		item.ProviderKeyMask = mask
	}
}

// providerKeyMaskNamespaceForEvent reports which credential list can answer for a
// record, and whether the record is even a candidate.
//
// Only an API-key credential has a provider key to name. An OAuth record carries
// the auth file it used instead, and its index must never be looked up in a key
// list - the two live in the same column, and a family's index would otherwise be
// answerable by a compatibility provider's entry.
//
// The namespace is read from the provider label, and an unrecognized label is not
// a candidate. CPA labels a config API-key credential with the family name and a
// compatibility one with `openai-compatible-<upstream name>`, so those two shapes
// are what a request this console can attribute looks like. Treating every other
// label as a compatibility provider would mean resolving, say, an OAuth-only
// provider's index against a key list it has nothing to do with.
func providerKeyMaskNamespaceForEvent(item usageEventResponse) (providerKeyMaskNamespace, bool) {
	if strings.TrimSpace(item.AuthIndex) == "" {
		return "", false
	}
	switch strings.ToLower(strings.TrimSpace(item.AuthType)) {
	case "apikey", "api_key":
	default:
		return "", false
	}
	label := strings.ToLower(strings.TrimSpace(item.Provider))
	if providerKeyMaskFamilies[label] {
		return providerKeyMaskNamespace(label), true
	}
	if strings.HasPrefix(label, management.OpenAICompatibilityLabelPrefix) {
		// The suffix is the provider's name and is deliberately ignored: renaming it
		// in CPA changes the label on later records while the credential, and CPA's
		// index for it, stay the same, so the match inside this list is by index alone.
		return namespaceOpenAICompatibility, true
	}
	return "", false
}

// readProviderKeyMaskClaims indexes one credential list by auth index.
func readProviderKeyMaskClaims(
	ctx context.Context,
	client *management.Client,
	namespace providerKeyMaskNamespace,
) (map[string]string, error) {
	claims := make(map[string]string)
	if namespace == namespaceOpenAICompatibility {
		response, err := client.OpenAICompatibility(ctx)
		if err != nil {
			return nil, err
		}
		for _, provider := range response.Entries {
			// A provider that is currently switched off is read like any other. Whether
			// its entries can claim an index is the gateway's call, and in practice it
			// reports no index for them, so they claim nothing already. Filtering on the
			// flag here would go further than that and also hide the key of a request
			// that was served before the provider was switched off: the provider's
			// enabled state is not part of the credential's identity, and dropping the
			// label would erase a true fact from history rather than a wrong one.
			for _, key := range provider.APIKeyEntries {
				claimProviderKeyMask(claims, key.AuthIndex, key.APIKey)
			}
		}
		return claims, nil
	}
	entries, err := client.ConfigAPIKeys(ctx, management.ConfigKeyFamily(namespace))
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		claimProviderKeyMask(claims, entry.AuthIndex, entry.APIKey)
	}
	return claims, nil
}

// claimProviderKeyMask records one credential under its auth index.
//
// An entry CPA reports without an index claims nothing: the compatibility list's
// legacy `api-keys` array carries no index, and a key that cannot be tied to a
// recorded index cannot be tied to a request either. A second claim on one index
// removes it rather than overwriting, because an index claimed twice is not an
// identity for either credential - and comparing the two masks could not settle
// it, since a mask keeps only a short head and tail and two keys can share one.
func claimProviderKeyMask(claims map[string]string, authIndex, apiKey string) {
	index := strings.TrimSpace(authIndex)
	mask := security.MaskSecret(apiKey)
	if index == "" || mask == "" {
		return
	}
	if _, claimed := claims[index]; claimed {
		// The empty mask is the tombstone: it is not a mask this console can
		// produce, so a third claim cannot revive the index by finding it vacant.
		claims[index] = ""
		return
	}
	claims[index] = mask
}
