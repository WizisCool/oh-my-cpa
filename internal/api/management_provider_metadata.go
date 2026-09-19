package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func (h *Handler) loadProviderNames(ctx context.Context) map[string]string {
	names, err := h.loadProviderNamesStrict(ctx)
	if err != nil {
		return nil
	}
	return names
}

func (h *Handler) loadProviderNamesStrict(ctx context.Context) (map[string]string, error) {
	return h.loadStringPreference(ctx, repository.PreferenceProviderNames)
}

// applyProviderMetadata persists the name and website overlays for one provider
// change in one transaction. They describe the same accepted write, so a failed
// website write must not leave the name from a newer revision beside the old
// website.
func (h *Handler) applyProviderMetadata(ctx context.Context, id, name, website string, isWebsiteProvided bool) error {
	if id == "" || (name == "" && !isWebsiteProvided) {
		return nil
	}
	updates := make(map[string]map[string]string, 2)
	if name != "" {
		if h.beforeProviderNamesSave != nil {
			h.beforeProviderNamesSave()
		}
		names, err := h.loadProviderNamesStrict(ctx)
		if err != nil {
			return fmt.Errorf("read provider names for metadata update: %w", err)
		}
		if names[id] != name {
			names[id] = name
			updates[repository.PreferenceProviderNames] = names
		}
	}
	if isWebsiteProvided {
		websites, err := h.loadProviderWebsitesStrict(ctx)
		if err != nil {
			return fmt.Errorf("read provider websites for metadata update: %w", err)
		}
		if website == "" {
			if _, present := websites[id]; present {
				delete(websites, id)
				updates[repository.PreferenceProviderWebsites] = websites
			}
		} else if websites[id] != website {
			websites[id] = website
			updates[repository.PreferenceProviderWebsites] = websites
		}
	}
	if err := h.saveStringPreferences(ctx, updates); err != nil {
		return fmt.Errorf("persist provider metadata: %w", err)
	}
	return nil
}

// shiftProviderMetadataAfterDelete re-keys the operator metadata of every entry
// that moved down one position when an entry was deleted. The three overlay
// documents are replaced in one transaction, so a delete cannot leave names,
// websites, and icons describing different positions.
func (h *Handler) shiftProviderMetadataAfterDelete(ctx context.Context, idPrefix string, deletedIndex int) error {
	if idPrefix == "" {
		return nil
	}
	updates := make(map[string]map[string]string, 3)
	names, err := h.loadProviderNamesStrict(ctx)
	if err != nil {
		return err
	}
	if len(names) > 0 {
		updates[repository.PreferenceProviderNames] = shiftPositionalProviderIDs(names, idPrefix, deletedIndex)
	}
	websites, err := h.loadProviderWebsitesStrict(ctx)
	if err != nil {
		return err
	}
	if len(websites) > 0 {
		updates[repository.PreferenceProviderWebsites] = shiftPositionalProviderIDs(websites, idPrefix, deletedIndex)
	}
	// The icon overlay is written by the console through the preferences API
	// instead of by a provider save, but it is keyed by the same positional id,
	// so a delete has to move it here too. Leaving it alone is what made a
	// deleted provider's brand mark reappear on whichever credential inherited
	// its index.
	icons, err := h.loadProviderIconsStrict(ctx)
	if err != nil {
		return err
	}
	if len(icons) > 0 {
		updates[repository.PreferenceProviderIcons] = shiftPositionalProviderIDs(icons, idPrefix, deletedIndex)
	}
	return h.saveStringPreferences(ctx, updates)
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
	websites, err := h.loadProviderWebsitesStrict(ctx)
	if err != nil {
		return nil
	}
	return websites
}

func (h *Handler) loadProviderWebsitesStrict(ctx context.Context) (map[string]string, error) {
	return h.loadStringPreference(ctx, repository.PreferenceProviderWebsites)
}

// loadProviderIcons reads the per-provider brand-icon overlay.
//
// The console owns this key: an icon is chosen in the picker and written
// through the preferences API rather than through a provider save, so there is
// no per-provider setter here. It is read and rewritten only to keep the map
// aligned with the positions it is keyed by - see
// shiftProviderMetadataAfterDelete.
func (h *Handler) loadProviderIcons(ctx context.Context) map[string]string {
	icons, err := h.loadProviderIconsStrict(ctx)
	if err != nil {
		return nil
	}
	return icons
}

func (h *Handler) loadProviderIconsStrict(ctx context.Context) (map[string]string, error) {
	return h.loadStringPreference(ctx, repository.PreferenceProviderIcons)
}

func (h *Handler) loadStringPreference(ctx context.Context, key string) (map[string]string, error) {
	if h.repo == nil {
		return nil, errors.New("repository is not initialized")
	}
	raw, found, err := h.repo.GetPreference(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("read preference %q: %w", key, err)
	}
	if !found || strings.TrimSpace(raw) == "" {
		return map[string]string{}, nil
	}
	values := make(map[string]string)
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, fmt.Errorf("decode preference %q: %w", key, err)
	}
	if values == nil {
		values = make(map[string]string)
	}
	return values, nil
}

func (h *Handler) saveStringPreferences(ctx context.Context, values map[string]map[string]string) error {
	if h.repo == nil {
		return errors.New("repository is not initialized")
	}
	encoded := make(map[string]string, len(values))
	for key, value := range values {
		document, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("encode preference %q: %w", key, err)
		}
		encoded[key] = string(document)
	}
	return h.repo.PutPreferences(ctx, encoded)
}
