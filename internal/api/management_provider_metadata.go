package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func (h *Handler) loadProviderNames(ctx context.Context) map[string]string {
	if h.repo == nil {
		return nil
	}
	raw, found, err := h.repo.GetPreference(ctx, repository.PreferenceProviderNames)
	if err != nil || !found || raw == "" {
		return nil
	}
	var res map[string]string
	if err := json.Unmarshal([]byte(raw), &res); err != nil {
		return nil
	}
	return res
}

func (h *Handler) saveProviderName(ctx context.Context, id, name string) {
	if h.repo == nil || id == "" || name == "" {
		return
	}
	names := h.loadProviderNames(ctx)
	if names == nil {
		names = make(map[string]string)
	}
	names[id] = name
	h.saveProviderNames(ctx, names)
}

func (h *Handler) removeProviderName(ctx context.Context, id string) {
	if h.repo == nil || id == "" {
		return
	}
	names := h.loadProviderNames(ctx)
	if names == nil {
		return
	}
	delete(names, id)
	h.saveProviderNames(ctx, names)
}

// saveProviderNames replaces the whole name map. It exists for the operations
// that re-key several entries at once (a delete shifts every later position), so
// those cannot leave the stored overlay half-written.
func (h *Handler) saveProviderNames(ctx context.Context, names map[string]string) {
	if h.repo == nil {
		return
	}
	encoded, err := json.Marshal(names)
	if err == nil {
		_ = h.repo.PutPreference(ctx, repository.PreferenceProviderNames, string(encoded))
	}
}

// shiftProviderMetadataAfterDelete re-keys the operator metadata of every entry
// that moved down one position when an entry was deleted.
func (h *Handler) shiftProviderMetadataAfterDelete(ctx context.Context, idPrefix string, deletedIndex int) {
	if idPrefix == "" {
		return
	}
	if names := h.loadProviderNames(ctx); len(names) > 0 {
		h.saveProviderNames(ctx, shiftPositionalProviderIDs(names, idPrefix, deletedIndex))
	}
	if websites := h.loadProviderWebsites(ctx); len(websites) > 0 {
		h.saveProviderWebsites(ctx, shiftPositionalProviderIDs(websites, idPrefix, deletedIndex))
	}
	// The icon overlay is written by the console through the preferences API
	// instead of by a provider save, but it is keyed by the same positional id,
	// so a delete has to move it here too. Leaving it alone is what made a
	// deleted provider's brand mark reappear on whichever credential inherited
	// its index.
	if icons := h.loadProviderIcons(ctx); len(icons) > 0 {
		h.saveProviderIcons(ctx, shiftPositionalProviderIDs(icons, idPrefix, deletedIndex))
	}
}

// idPrefixForFamily is the positional id prefix a family's rows carry.
func idPrefixForFamily(family string) string {
	if spec, ok := lookupProviderConfigFamily(family); ok {
		return spec.IDPrefix
	}
	if family == openAICompatibilityFamily {
		return openAICompatIDPrefix
	}
	return ""
}

// shiftPositionalProviderIDs re-keys one family's metadata after an entry was
// deleted, mapping a stored positional id onto the entry's new position.
//
// Provider rows are addressed by position, and an operator's name and website are
// stored under that same id. Deleting an entry moves every later entry down one,
// so without re-keying the name given to one credential would relabel whichever
// credential took its place — and the deleted entry's own name would survive on
// an unrelated row. Ids of other families are left untouched; the overlay is
// shared across families and only this one's positions moved.
func shiftPositionalProviderIDs(entries map[string]string, idPrefix string, deletedIndex int) map[string]string {
	if len(entries) == 0 {
		return entries
	}
	shifted := make(map[string]string, len(entries))
	for id, value := range entries {
		if !strings.HasPrefix(id, idPrefix) {
			shifted[id] = value
			continue
		}
		index, err := strconv.Atoi(strings.TrimPrefix(id, idPrefix))
		if err != nil {
			// An id this family cannot be addressed by is not ours to rewrite.
			shifted[id] = value
			continue
		}
		switch {
		case index == deletedIndex:
			// The entry this metadata described no longer exists.
		case index > deletedIndex:
			shifted[fmt.Sprintf("%s%d", idPrefix, index-1)] = value
		default:
			shifted[id] = value
		}
	}
	return shifted
}

// loadProviderWebsites reads the per-provider homepage map. It is keyed by the
// same positional provider id as provider_names, so the two move together when a
// provider is deleted and neither can be joined to the wrong entry.
func (h *Handler) loadProviderWebsites(ctx context.Context) map[string]string {
	if h.repo == nil {
		return nil
	}
	raw, found, err := h.repo.GetPreference(ctx, repository.PreferenceProviderWebsites)
	if err != nil || !found || raw == "" {
		return nil
	}
	var res map[string]string
	if err := json.Unmarshal([]byte(raw), &res); err != nil {
		return nil
	}
	return res
}

// saveProviderWebsite writes one provider's homepage. An empty url removes the
// entry rather than storing an empty string, so "no website" has exactly one
// representation in storage.
func (h *Handler) saveProviderWebsite(ctx context.Context, id, website string) {
	if h.repo == nil || id == "" {
		return
	}
	websites := h.loadProviderWebsites(ctx)
	if websites == nil {
		websites = make(map[string]string)
	}
	if website == "" {
		if _, present := websites[id]; !present {
			return
		}
		delete(websites, id)
	} else {
		websites[id] = website
	}
	h.saveProviderWebsites(ctx, websites)
}

// applyProviderWebsite stores a website only when the save request actually
// carried the field.
//
// The distinction is load-bearing rather than defensive: a client that predates
// the field sends no website at all, and reading that as "clear it" would wipe
// operator metadata on every rename performed from such a client. An explicitly
// present empty string is what clears it.
func (h *Handler) applyProviderWebsite(ctx context.Context, id, website string, isProvided bool) {
	if !isProvided {
		return
	}
	h.saveProviderWebsite(ctx, id, website)
}

// saveProviderWebsites replaces the whole website map, for the operations that
// re-key several entries at once.
func (h *Handler) saveProviderWebsites(ctx context.Context, websites map[string]string) {
	if h.repo == nil {
		return
	}
	encoded, err := json.Marshal(websites)
	if err == nil {
		_ = h.repo.PutPreference(ctx, repository.PreferenceProviderWebsites, string(encoded))
	}
}

func (h *Handler) removeProviderWebsite(ctx context.Context, id string) {
	h.saveProviderWebsite(ctx, id, "")
}

// loadProviderIcons reads the per-provider brand-icon overlay.
//
// The console owns this key: an icon is chosen in the picker and written
// through the preferences API rather than through a provider save, so there is
// no per-provider setter here. It is read and rewritten only to keep the map
// aligned with the positions it is keyed by - see
// shiftProviderMetadataAfterDelete.
func (h *Handler) loadProviderIcons(ctx context.Context) map[string]string {
	if h.repo == nil {
		return nil
	}
	raw, found, err := h.repo.GetPreference(ctx, repository.PreferenceProviderIcons)
	if err != nil || !found || raw == "" {
		return nil
	}
	var res map[string]string
	if err := json.Unmarshal([]byte(raw), &res); err != nil {
		return nil
	}
	return res
}

// saveProviderIcons replaces the whole icon map, which is the only way it is
// written here: the operation that touches it re-keys every later entry, and a
// per-entry write could leave the map half-shifted.
func (h *Handler) saveProviderIcons(ctx context.Context, icons map[string]string) {
	if h.repo == nil {
		return
	}
	encoded, err := json.Marshal(icons)
	if err == nil {
		_ = h.repo.PutPreference(ctx, repository.PreferenceProviderIcons, string(encoded))
	}
}
