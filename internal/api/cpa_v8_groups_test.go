package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// providerGroupSharedFields are the settings CPA lets a v8 credential group
// carry for all of its keys.
var providerGroupSharedFields = map[string]bool{
	"base-url": true, "priority": true, "prefix": true, "proxy-url": true, "headers": true,
	"models": true, "excluded-models": true, "disable-cooling": true, "request-retry": true,
	"request-scoped-errors": true,
}

// serveProviderGroups answers the v8 configuration routes a provider write
// uses, over the flat per-family lists a fake CPA keeps for its v0 reads, the
// way CPA itself does: reading a family renders one group per entry (CPA's
// conversion of a pre-v8 file), and writing groups flattens them back, one entry
// per key. An entry keeps the auth index of the key it replaces, since CPA
// derives the index from the key's content. It reports whether it answered.
//
// lists returns the family's list, or nil for a family the fake does not keep;
// written is called after a write lands.
func serveProviderGroups(writer http.ResponseWriter, request *http.Request, lists func(family string) *[]map[string]any, written func(family string)) bool {
	const groupsPrefix = "/v8/management/config/api-keys/"
	path := request.URL.Path
	switch {
	case strings.HasPrefix(path, groupsPrefix) && (request.Method == http.MethodGet || request.Method == http.MethodDelete):
		family := strings.TrimPrefix(path, groupsPrefix)
		list := lists(family)
		if list == nil {
			return false
		}
		writer.Header().Set("Content-Type", "application/json")
		if len(*list) == 0 {
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"error":"not_found"}`))
			return true
		}
		if request.Method == http.MethodDelete {
			*list = []map[string]any{}
			if written != nil {
				written(family)
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
			return true
		}
		_ = json.NewEncoder(writer).Encode(groupFlatList(family, genericEntries(*list)))
		return true
	case path == "/v8/management/config" && request.Method == http.MethodPatch:
		data, _ := io.ReadAll(request.Body)
		request.Body = io.NopCloser(bytes.NewReader(data))
		var merge struct {
			APIKeys map[string][]map[string]any `json:"api-keys"`
		}
		if json.Unmarshal(data, &merge) != nil || len(merge.APIKeys) == 0 {
			return false
		}
		for family, groups := range merge.APIKeys {
			list := lists(family)
			if list == nil {
				writer.WriteHeader(http.StatusBadRequest)
				_, _ = writer.Write([]byte(`{"error":"invalid_config","message":"unknown API-key provider ` + family + `"}`))
				return true
			}
			*list = flattenGroups(family, groups, genericEntries(*list))
			if written != nil {
				written(family)
			}
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
		return true
	}
	return false
}

func groupFlatList(family string, entries []map[string]any) []map[string]any {
	groups := make([]map[string]any, 0, len(entries))
	for i, entry := range entries {
		if family == "openai-compatibility" {
			group := map[string]any{}
			keys := []any{}
			for field, value := range entry {
				switch field {
				case "api-key-entries":
					for _, key := range anyList(value) {
						copied := map[string]any{}
						for name, keyValue := range key.(map[string]any) {
							if name != "auth-index" {
								copied[name] = keyValue
							}
						}
						keys = append(keys, copied)
					}
				case "api-keys":
					for _, apiKey := range anyList(value) {
						keys = append(keys, map[string]any{"api-key": apiKey})
					}
				default:
					group[field] = value
				}
			}
			group["keys"] = keys
			groups = append(groups, group)
			continue
		}
		group := map[string]any{"name": fmt.Sprintf("%s-%d", family, i+1)}
		key := map[string]any{}
		for field, value := range entry {
			switch {
			case field == "auth-index":
			case providerGroupSharedFields[field]:
				group[field] = value
			default:
				key[field] = value
			}
		}
		group["keys"] = []any{key}
		groups = append(groups, group)
	}
	return groups
}

func flattenGroups(family string, groups []map[string]any, previous []map[string]any) []map[string]any {
	indexOf := func(apiKey any) string {
		for _, entry := range previous {
			if entry["api-key"] == apiKey && entry["auth-index"] != nil {
				return fmt.Sprint(entry["auth-index"])
			}
			for _, key := range anyList(entry["api-key-entries"]) {
				if keyMap, ok := key.(map[string]any); ok && keyMap["api-key"] == apiKey && keyMap["auth-index"] != nil {
					return fmt.Sprint(keyMap["auth-index"])
				}
			}
		}
		return fmt.Sprintf("gen-%v", apiKey)
	}
	out := []map[string]any{}
	for _, group := range groups {
		keys := anyList(group["keys"])
		if family == "openai-compatibility" {
			entry := map[string]any{}
			for field, value := range group {
				if field != "keys" {
					entry[field] = value
				}
			}
			entries := []any{}
			for _, key := range keys {
				keyMap := key.(map[string]any)
				keyMap["auth-index"] = indexOf(keyMap["api-key"])
				entries = append(entries, keyMap)
			}
			entry["api-key-entries"] = entries
			out = append(out, entry)
			continue
		}
		for _, key := range keys {
			entry := map[string]any{}
			for field, value := range group {
				if field != "name" && field != "keys" {
					entry[field] = value
				}
			}
			for field, value := range key.(map[string]any) {
				entry[field] = value
			}
			entry["auth-index"] = indexOf(entry["api-key"])
			out = append(out, entry)
		}
	}
	return out
}

// genericEntries is entries as decoded JSON, whatever Go types a fixture
// declared them with.
func genericEntries(entries []map[string]any) []map[string]any {
	data, _ := json.Marshal(entries)
	var out []map[string]any
	_ = json.Unmarshal(data, &out)
	return out
}

func anyList(value any) []any {
	switch typed := value.(type) {
	case []any:
		return typed
	case []string:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = item
		}
		return out
	case []map[string]any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = item
		}
		return out
	default:
		return nil
	}
}
