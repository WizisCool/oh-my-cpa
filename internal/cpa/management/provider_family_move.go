package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
)

// ProviderFamilyEntry is the configuration a protocol conversion reads or
// produces. A source has one provider row; a destination may have several keys
// because config API-key families expose one provider row per key.
type ProviderFamilyEntry struct {
	Compatibility *OpenAICompatibility
	Keys          []ConfigAPIKey
}

var ErrProviderNotFound = errors.New("provider index out of bounds")
var ErrProviderDestinationConflict = errors.New("the destination already contains this provider")
var ErrProviderSourceConflict = errors.New("the source provider identity is duplicated in the stored configuration")

// MoveProviderFamily replaces only the selected stored group or key and appends
// its converted entries to the destination. The caller holds the provider write
// gate. Both family arrays, including an emptied source, travel in one PATCH:
// separate append/delete requests could leave duplicate or missing credentials.
func (c *Client) MoveProviderFamily(ctx context.Context, sourceFamily, targetFamily string, index int, convert func(ProviderFamilyEntry) (ProviderFamilyEntry, error)) (int, int, error) {
	ctx = WithBackupReason(ctx, BackupReasonProviderKeys)
	stored, err := c.keepStoredConfig(ctx)
	if err != nil {
		return 0, 0, err
	}
	source, err := c.storedKeyGroups(ctx, ConfigKeyFamily(sourceFamily).GroupsPath())
	if err != nil {
		return 0, 0, err
	}
	entry, groupIndex, keyIndex, err := c.providerMoveSource(ctx, sourceFamily, index, source)
	if err != nil {
		return 0, 0, err
	}
	converted, err := convert(entry)
	if err != nil {
		return 0, 0, err
	}
	target, err := c.storedKeyGroups(ctx, ConfigKeyFamily(targetFamily).GroupsPath())
	if err != nil {
		return 0, 0, err
	}
	start, err := c.providerFamilySize(ctx, targetFamily)
	if err != nil {
		return 0, 0, err
	}
	var added []map[string]any
	count := len(converted.Keys)
	if converted.Compatibility != nil {
		count = 1
		for _, group := range target {
			name, _ := group["name"].(string)
			if strings.EqualFold(strings.TrimSpace(name), strings.TrimSpace(converted.Compatibility.Name)) {
				return 0, 0, ErrProviderDestinationConflict
			}
		}
		added, err = openAICompatibilityGroups([]OpenAICompatibility{*converted.Compatibility})
	} else {
		for _, key := range converted.Keys {
			for _, existing := range flattenKeyGroups(target) {
				if isSameStoredKey(existing.fields, key.APIKey, key.BaseURL) {
					return 0, 0, ErrProviderDestinationConflict
				}
			}
		}
		added, err = regroupConfigKeys(targetFamily, converted.Keys)
		// Generated group names must not collide with operator-owned groups.
		names := map[string]bool{}
		for _, group := range target {
			name, _ := group["name"].(string)
			names[name] = true
		}
		for _, group := range added {
			for n := 1; ; n++ {
				name := fmt.Sprintf("%s-%d", targetFamily, n)
				if !names[name] {
					group["name"] = name
					names[name] = true
					break
				}
			}
		}
	}
	if err != nil {
		return 0, 0, err
	}
	if keyIndex >= 0 {
		keys := source[groupIndex]["keys"].([]any)
		keys = slices.Delete(slices.Clone(keys), keyIndex, keyIndex+1)
		if len(keys) > 0 {
			source[groupIndex]["keys"] = keys
		} else {
			source = slices.Delete(source, groupIndex, groupIndex+1)
		}
	} else {
		source = slices.Delete(source, groupIndex, groupIndex+1)
	}
	if source == nil {
		source = []map[string]any{}
	}
	changes := []ConfigChange{
		{Path: ConfigKeyFamily(sourceFamily).GroupsPath(), Value: source},
		{Path: ConfigKeyFamily(targetFamily).GroupsPath(), Value: append(target, added...)},
	}
	merge := map[string]any{}
	for _, change := range changes {
		setAt(merge, change.Path, change.Value)
	}
	data, err := json.Marshal(merge)
	if err != nil {
		return 0, 0, err
	}
	version := storedConfigVersion(stored)
	err = c.writeConfigAt(ctx, http.MethodPatch, "/config", data, "application/json", &version)
	if err != nil {
		scrubWriteRejection(err, stored, changes)
	}
	return start, count, err
}

func (c *Client) providerFamilySize(ctx context.Context, family string) (int, error) {
	if family == "openai-compatibility" {
		entries, err := c.OpenAICompatibility(ctx)
		return len(entries.Entries), err
	}
	entries, err := c.ConfigAPIKeys(ctx, ConfigKeyFamily(family))
	return len(entries), err
}

// Runtime positions are matched forward to stored identities, not to stored
// positions: CPA may hide an unusable or duplicate key. Those hidden entries
// remain untouched when a visible neighbour moves to another family.
func (c *Client) providerMoveSource(ctx context.Context, family string, index int, groups []map[string]any) (ProviderFamilyEntry, int, int, error) {
	var entry ProviderFamilyEntry
	if family == "openai-compatibility" {
		runtime, err := c.OpenAICompatibility(ctx)
		if err != nil {
			return entry, 0, 0, err
		}
		if index < 0 || index >= len(runtime.Entries) {
			return entry, 0, 0, ErrProviderNotFound
		}
		next := 0
		for i, live := range runtime.Entries[:index+1] {
			for j := next; j < len(groups); j++ {
				name, _ := groups[j]["name"].(string)
				if strings.TrimSpace(name) != strings.TrimSpace(live.Name) {
					continue
				}
				next = j + 1
				if i == index {
					for otherIndex, group := range groups {
						otherName, _ := group["name"].(string)
						if otherIndex != j && strings.EqualFold(strings.TrimSpace(otherName), strings.TrimSpace(name)) {
							return entry, 0, 0, ErrProviderSourceConflict
						}
					}
					fields := map[string]any{}
					for field, value := range groups[j] {
						if field == "keys" {
							field = "api-key-entries"
						}
						fields[field] = value
					}
					data, err := json.Marshal(fields)
					if err != nil {
						return entry, 0, 0, err
					}
					var provider OpenAICompatibility
					if err := json.Unmarshal(data, &provider); err != nil {
						return entry, 0, 0, err
					}
					entry.Compatibility = &provider
					return entry, j, -1, nil
				}
				break
			}
		}
	} else {
		runtime, err := c.ConfigAPIKeys(ctx, ConfigKeyFamily(family))
		if err != nil {
			return entry, 0, 0, err
		}
		if index < 0 || index >= len(runtime) {
			return entry, 0, 0, ErrProviderNotFound
		}
		stored := flattenKeyGroups(groups)
		next := 0
		for i, live := range runtime[:index+1] {
			for j := next; j < len(stored); j++ {
				if !isSameStoredKey(stored[j].fields, live.APIKey, live.BaseURL) {
					continue
				}
				next = j + 1
				if i == index {
					// Removing a visible duplicate would activate its hidden twin
					// at the old position, invalidating every metadata shift.
					for otherIndex, other := range stored {
						if otherIndex != j && isSameStoredKey(other.fields, live.APIKey, live.BaseURL) {
							return entry, 0, 0, ErrProviderSourceConflict
						}
					}
					data, err := json.Marshal(stored[j].fields)
					if err != nil {
						return entry, 0, 0, err
					}
					var key ConfigAPIKey
					if err := json.Unmarshal(data, &key); err != nil {
						return entry, 0, 0, err
					}
					key.AuthIndex = live.AuthIndex
					entry.Keys = []ConfigAPIKey{key}
					return entry, stored[j].groupIndex, stored[j].keyIndex, nil
				}
				break
			}
		}
	}
	return entry, 0, 0, ErrConfigChanged
}
