package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

func sortedMapKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func boolValue(value any) bool {
	flag, _ := value.(bool)
	return flag
}

func firstBool(source map[string]any, keys ...string) bool {
	for _, key := range keys {
		if value, ok := source[key]; ok {
			return boolValue(value)
		}
	}
	return false
}

func intValue(value any) int {
	switch typed := value.(type) {
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	case float64:
		return int(typed)
	case int:
		return typed
	case int64:
		return int(typed)
	default:
		return 0
	}
}

func int64Value(value any) int64 {
	switch typed := value.(type) {
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	default:
		return 0
	}
}

func stringSliceValue(value any) []string {
	if typed, ok := value.([]string); ok {
		return typed
	}
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			result = append(result, strings.TrimSpace(text))
		}
	}
	return result
}

func equalStringSlices(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if strings.TrimSpace(left[index]) != strings.TrimSpace(right[index]) {
			return false
		}
	}
	return true
}

func numberInt64(value any) (int64, error) {
	switch typed := value.(type) {
	case json.Number:
		return typed.Int64()
	case int64:
		return typed, nil
	case int:
		return int64(typed), nil
	default:
		return 0, errors.New("not an integer")
	}
}

func decodeManagementValue(raw json.RawMessage) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func boundedText(value string, limit int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}

func nonNegative(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}
