package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
)

// CPA v8 stores upstream credentials as groups: `api-keys.<family>` is a list
// of {name, base-url, shared settings, keys: [...]}, and each key may override
// a shared setting. The v0 per-family lists are those groups flattened, one
// entry per key, in order, with each key's runtime `auth-index`. The console
// edits the flattened list (its positions are the provider ids it shows) and
// writes the family back as groups, keeping the operator's grouping wherever an
// edit can still be expressed in it.

// keyGroupOrigin ties an editable entry to the stored group it was read from.
type keyGroupOrigin struct {
	group map[string]any
}

// groupSharedFields are the settings a group may carry for all of its keys
// (CPA's sharedKeyFields plus base-url, which only a group may carry).
var groupSharedFields = []string{
	"base-url", "priority", "prefix", "proxy-url", "headers", "models",
	"excluded-models", "disable-cooling", "request-retry", "request-scoped-errors",
}

// keyZeroOverrides are the shared settings whose absence CPA reads as the zero
// value, so a key can clear its group's value by stating that zero. The other
// shared settings (disable-cooling, request-retry) are pointers in CPA, where
// absent means "inherit the global setting" and no key-level value says that;
// a key that clears one of them is moved into a group of its own instead.
var keyZeroOverrides = map[string]any{
	"priority":              float64(0),
	"prefix":                "",
	"proxy-url":             "",
	"headers":               map[string]any{},
	"models":                []any{},
	"excluded-models":       []any{},
	"request-scoped-errors": []any{},
}

// GroupsPath is the v8 configuration path of the family's credential groups.
func (f ConfigKeyFamily) GroupsPath() []string {
	return []string{"api-keys", string(f)}
}

// OPENAI_COMPATIBILITY_GROUPS_PATH is where v8 keeps the OpenAI-compatible
// providers, one group per provider.
var OPENAI_COMPATIBILITY_GROUPS_PATH = []string{"api-keys", "openai-compatibility"}

// configValueAt reads one path of the v8 configuration view into output. An
// absent path is not an error: it reports false.
func (c *Client) configValueAt(ctx context.Context, path []string, output any) (bool, error) {
	if c == nil {
		return false, errors.New("CPA client is not initialized")
	}
	request, err := c.newRequest(ctx, http.MethodGet, configPathEndpoint(path), nil, "")
	if err != nil {
		return false, err
	}
	if _, err := c.do(request, output); err != nil {
		if isConfigPathMissing(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func isConfigPathMissing(err error) bool {
	var httpErr *HTTPError
	return errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound && strings.Contains(httpErr.Body, "not_found")
}

// storedKeyGroups reads one credential group list as stored.
func (c *Client) storedKeyGroups(ctx context.Context, path []string) ([]map[string]any, error) {
	var groups []map[string]any
	if _, err := c.configValueAt(ctx, path, &groups); err != nil {
		return nil, err
	}
	return groups, nil
}

// storedKey is one key of a stored group, flattened the way CPA flattens it.
type storedKey struct {
	fields map[string]any
	origin *keyGroupOrigin
}

func flattenKeyGroups(groups []map[string]any) []storedKey {
	var out []storedKey
	for _, group := range groups {
		origin := &keyGroupOrigin{group: group}
		keys, _ := group["keys"].([]any)
		for _, rawKey := range keys {
			key, ok := rawKey.(map[string]any)
			if !ok {
				continue
			}
			fields := map[string]any{}
			for name, value := range group {
				if name != "name" && name != "keys" {
					fields[name] = value
				}
			}
			for name, value := range key {
				if value != nil {
					fields[name] = value
				}
			}
			out = append(out, storedKey{fields: fields, origin: origin})
		}
	}
	return out
}

// EditableConfigAPIKeys reads one family's credentials for a write: the v0
// list's positions and auth indexes, with each entry's settings as the
// configuration file stores them and the group it belongs to.
//
// The v0 list is CPA's runtime view, which normalizes values and leaves out
// keys it cannot use (a duplicate, a key without the base URL its family
// requires). The stored keys are matched to it in order by API key and base
// URL. A stored key the runtime left out is not part of the list, so a write
// drops it, as a whole-list write through v0 did. An entry with no stored match
// keeps its runtime settings and is written as a group of its own.
func (c *Client) EditableConfigAPIKeys(ctx context.Context, family ConfigKeyFamily) ([]ConfigAPIKey, error) {
	runtime, err := c.ConfigAPIKeys(ctx, family)
	if err != nil {
		return nil, err
	}
	groups, err := c.storedKeyGroups(ctx, family.GroupsPath())
	if err != nil {
		return nil, err
	}
	stored := flattenKeyGroups(groups)
	entries := make([]ConfigAPIKey, len(runtime))
	next := 0
	for i, live := range runtime {
		entries[i] = live
		for j := next; j < len(stored); j++ {
			if !isSameStoredKey(stored[j].fields, live.APIKey, live.BaseURL) {
				continue
			}
			data, err := json.Marshal(stored[j].fields)
			if err != nil {
				return nil, err
			}
			var entry ConfigAPIKey
			if err := json.Unmarshal(data, &entry); err != nil {
				return nil, fmt.Errorf("decode %s: %w", strings.Join(family.GroupsPath(), "."), err)
			}
			entry.AuthIndex = live.AuthIndex
			entry.origin = stored[j].origin
			entries[i] = entry
			next = j + 1
			break
		}
	}
	return entries, nil
}

// isSameStoredKey compares a stored key with a runtime entry. The base URL is
// compared only when both have one, because the runtime fills in a family's
// default endpoint where the file has none.
func isSameStoredKey(fields map[string]any, apiKey, baseURL string) bool {
	storedKey, _ := fields["api-key"].(string)
	if strings.TrimSpace(storedKey) != strings.TrimSpace(apiKey) {
		return false
	}
	storedURL, _ := fields["base-url"].(string)
	storedURL, baseURL = strings.TrimSpace(storedURL), strings.TrimSpace(baseURL)
	return storedURL == "" || baseURL == "" || storedURL == baseURL
}

// UpdateConfigAPIKeys writes the whole family as v8 groups.
func (c *Client) UpdateConfigAPIKeys(ctx context.Context, family ConfigKeyFamily, entries []ConfigAPIKey) error {
	groups, err := regroupConfigKeys(string(family), entries)
	if err != nil {
		return err
	}
	return c.writeKeyGroups(ctx, family.GroupsPath(), groups)
}

func (c *Client) writeKeyGroups(ctx context.Context, path []string, groups []map[string]any) error {
	if len(groups) == 0 {
		return c.ApplyConfigChanges(ctx, []ConfigChange{{Path: path, Remove: true}})
	}
	return c.ApplyConfigChanges(ctx, []ConfigChange{{Path: path, Value: groups}})
}

// regroupConfigKeys turns the edited flat list back into groups.
//
// The output keeps the list's order exactly, because the console's provider ids
// are positions in the flattened list. Each entry returns to the group it came
// from while it still fits: a setting every member of a group agrees on is the
// group's, and a key that differs states its own value. An entry that cannot be
// expressed in its group (another base URL, or a pointer setting it cleared) and
// a new entry each become a group of their own, and the keys of a group that
// follow such an entry continue in a group with the same settings.
func regroupConfigKeys(family string, entries []ConfigAPIKey) ([]map[string]any, error) {
	fields := make([]map[string]any, len(entries))
	members := map[*keyGroupOrigin][]map[string]any{}
	names := map[string]bool{}
	for i, entry := range entries {
		entryFields, err := wireObject(entry)
		if err != nil {
			return nil, err
		}
		// A runtime field, never part of the configuration.
		delete(entryFields, "auth-index")
		fields[i] = entryFields
		if entry.origin != nil {
			members[entry.origin] = append(members[entry.origin], entryFields)
			if name, _ := entry.origin.group["name"].(string); name != "" {
				names[name] = true
			}
		}
	}
	settled := map[*keyGroupOrigin]map[string]any{}
	for origin, groupMembers := range members {
		settled[origin] = settleGroupFields(origin.group, groupMembers)
	}

	uniqueName := func(base string, first int) string {
		for n := first; ; n++ {
			candidate := fmt.Sprintf("%s-%d", base, n)
			if !names[candidate] {
				names[candidate] = true
				return candidate
			}
		}
	}
	namedOrigins := map[*keyGroupOrigin]bool{}
	var out []map[string]any
	var openOrigin *keyGroupOrigin
	var openGroup map[string]any
	for i, entryFields := range fields {
		origin := entries[i].origin
		if origin != nil {
			if key, fits := keyWithinGroup(entryFields, settled[origin]); fits {
				if openOrigin != origin {
					name, _ := origin.group["name"].(string)
					if name == "" || namedOrigins[origin] {
						name = uniqueName(fallbackGroupName(name, family), 2)
					}
					namedOrigins[origin] = true
					openGroup = newKeyGroup(name, settled[origin])
					out = append(out, openGroup)
					openOrigin = origin
				}
				openGroup["keys"] = append(openGroup["keys"].([]any), key)
				continue
			}
		}
		openOrigin, openGroup = nil, nil
		base, first := family, 1
		if origin != nil {
			name, _ := origin.group["name"].(string)
			base, first = fallbackGroupName(name, family), 2
		}
		out = append(out, standaloneKeyGroup(uniqueName(base, first), entryFields))
	}
	return out, nil
}

func fallbackGroupName(name, family string) string {
	if name == "" {
		return family
	}
	return name
}

func newKeyGroup(name string, shared map[string]any) map[string]any {
	group := map[string]any{"name": name, "keys": []any{}}
	for field, value := range shared {
		group[field] = value
	}
	return group
}

func standaloneKeyGroup(name string, entryFields map[string]any) map[string]any {
	group := map[string]any{"name": name}
	key := map[string]any{}
	for field, value := range entryFields {
		if isGroupSharedField(field) {
			group[field] = value
		} else {
			key[field] = value
		}
	}
	group["keys"] = []any{key}
	return group
}

// settleGroupFields decides the group's own settings. A setting the group
// stores takes the value every member now states, or keeps its stored value
// when the members disagree, and the members that differ state their own; a
// setting every member dropped leaves the group. base-url, which only a group
// may carry, is the group's whenever the members agree on it.
func settleGroupFields(group map[string]any, members []map[string]any) map[string]any {
	settled := map[string]any{}
	for _, field := range groupSharedFields {
		first, firstHas := members[0][field]
		isAgreed := true
		for _, member := range members[1:] {
			value, has := member[field]
			if has != firstHas || !reflect.DeepEqual(value, first) {
				isAgreed = false
				break
			}
		}
		_, isStored := group[field]
		if isAgreed {
			// Only base-url must live on the group; any other agreed value stays
			// where the operator put it, so a write does not reshape the file.
			if firstHas && !isEmptyWireValue(first) && (isStored || field == "base-url") {
				settled[field] = first
			}
			continue
		}
		if isStored {
			settled[field] = group[field]
		}
	}
	return settled
}

// keyWithinGroup returns the key object that expresses entryFields inside a
// group with the given settings, or false when no key can.
func keyWithinGroup(entryFields map[string]any, shared map[string]any) (map[string]any, bool) {
	key := map[string]any{}
	for field, value := range entryFields {
		if !isGroupSharedField(field) {
			key[field] = value
		}
	}
	for _, field := range groupSharedFields {
		value, has := entryFields[field]
		sharedValue, sharedHas := shared[field]
		switch {
		case has && sharedHas && reflect.DeepEqual(value, sharedValue):
		case has && !sharedHas && isEmptyWireValue(value):
		case !has && (!sharedHas || isEmptyWireValue(sharedValue)):
		case field == "base-url":
			return nil, false
		case has:
			key[field] = value
		default:
			zero, canClear := keyZeroOverrides[field]
			if !canClear {
				return nil, false
			}
			key[field] = zero
		}
	}
	return key, true
}

func isGroupSharedField(field string) bool {
	for _, shared := range groupSharedFields {
		if field == shared {
			return true
		}
	}
	return false
}

// isEmptyWireValue reports a value CPA reads the same as an absent one: an
// empty string, list or object. False and zero are not empty, because a
// pointer setting distinguishes them from absence.
func isEmptyWireValue(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return typed == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
}

// wireObject is value's JSON encoding as a generic object, the form the group
// comparison works on.
func wireObject(value any) (map[string]any, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, err
	}
	return object, nil
}

// EditableOpenAICompatibility reads the OpenAI-compatible providers for a
// write: the v0 list's positions and key auth indexes, with each provider's
// settings as the configuration file stores them. v8 keeps one group per
// provider, so providers are matched to the stored groups in order by name,
// and a stored provider the runtime left out is dropped by a write, as a
// whole-list write through v0 did.
func (c *Client) EditableOpenAICompatibility(ctx context.Context) ([]OpenAICompatibility, error) {
	runtime, err := c.OpenAICompatibility(ctx)
	if err != nil {
		return nil, err
	}
	groups, err := c.storedKeyGroups(ctx, OPENAI_COMPATIBILITY_GROUPS_PATH)
	if err != nil {
		return nil, err
	}
	entries := make([]OpenAICompatibility, len(runtime.Entries))
	next := 0
	for i, live := range runtime.Entries {
		entries[i] = live
		for j := next; j < len(groups); j++ {
			name, _ := groups[j]["name"].(string)
			if strings.TrimSpace(name) != strings.TrimSpace(live.Name) {
				continue
			}
			provider := map[string]any{}
			for field, value := range groups[j] {
				if field == "keys" {
					field = "api-key-entries"
				}
				provider[field] = value
			}
			data, err := json.Marshal(provider)
			if err != nil {
				return nil, err
			}
			var entry OpenAICompatibility
			if err := json.Unmarshal(data, &entry); err != nil {
				return nil, fmt.Errorf("decode %s: %w", strings.Join(OPENAI_COMPATIBILITY_GROUPS_PATH, "."), err)
			}
			for k := range entry.APIKeyEntries {
				entry.APIKeyEntries[k].AuthIndex = runtimeKeyAuthIndex(live, entry.APIKeyEntries[k].APIKey)
			}
			entries[i] = entry
			next = j + 1
			break
		}
	}
	return entries, nil
}

func runtimeKeyAuthIndex(provider OpenAICompatibility, apiKey string) string {
	for _, key := range provider.APIKeyEntries {
		if strings.TrimSpace(key.APIKey) == strings.TrimSpace(apiKey) {
			return key.AuthIndex
		}
	}
	return ""
}

// UpdateOpenAICompatibility writes the OpenAI-compatible providers as v8
// groups, one per provider.
func (c *Client) UpdateOpenAICompatibility(ctx context.Context, entries []OpenAICompatibility) error {
	groups := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		group, err := wireObject(entry)
		if err != nil {
			return err
		}
		keys := []any{}
		if rawKeys, ok := group["api-key-entries"].([]any); ok {
			for _, rawKey := range rawKeys {
				if key, ok := rawKey.(map[string]any); ok {
					delete(key, "auth-index")
					keys = append(keys, key)
				}
			}
		}
		// The pre-v8 spelling of a provider's keys; v8 has only the key list.
		if legacy, ok := group["api-keys"].([]any); ok {
			for _, apiKey := range legacy {
				keys = append(keys, map[string]any{"api-key": apiKey})
			}
		}
		delete(group, "api-key-entries")
		delete(group, "api-keys")
		group["keys"] = keys
		if disabled, _ := group["disabled"].(bool); !disabled {
			delete(group, "disabled")
		}
		groups = append(groups, group)
	}
	return c.writeKeyGroups(ctx, OPENAI_COMPATIBILITY_GROUPS_PATH, groups)
}
