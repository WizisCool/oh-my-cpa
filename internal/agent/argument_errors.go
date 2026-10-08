package agent

import (
	"fmt"
	"sort"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
)

// Schema validator errors can quote the whole submitted value, including HTML. Describe only
// declared field paths and expected types, keeping error feedback small and free of row values.
func describeArgumentFailure(schema *jsonschema.Schema, value any, path string) string {
	if schema == nil {
		return ""
	}
	actualType := "null"
	switch value.(type) {
	case map[string]any:
		actualType = "object"
	case []any:
		actualType = "array"
	case string:
		actualType = "string"
	case bool:
		actualType = "boolean"
	case float64:
		actualType = "number"
	}
	if schema.Type != "" && schema.Type != actualType && !(schema.Type == "integer" && actualType == "number") {
		return fmt.Sprintf("%s must have type %s", path, schema.Type)
	}
	if object, ok := value.(map[string]any); ok {
		for _, field := range schema.Required {
			if _, exists := object[field]; !exists {
				return fmt.Sprintf("%s.%s is required", path, field)
			}
		}
		keys := make([]string, 0, len(schema.Properties))
		for field := range schema.Properties {
			keys = append(keys, field)
		}
		sort.Strings(keys)
		for field := range object {
			if _, exists := schema.Properties[field]; !exists && schema.AdditionalProperties != nil && schema.AdditionalProperties.Not != nil {
				if path == "arguments.source" && field == "fields" {
					return "arguments.source.fields is not supported; put fields at the top level beside source"
				}
				return fmt.Sprintf("%s has an unsupported field; allowed fields: %s", path, strings.Join(keys, ", "))
			}
		}
		for _, field := range keys {
			if child, exists := object[field]; exists {
				if detail := describeArgumentFailure(schema.Properties[field], child, path+"."+field); detail != "" {
					return detail
				}
			}
		}
	}
	if array, ok := value.([]any); ok && schema.Items != nil {
		for index, child := range array {
			if detail := describeArgumentFailure(schema.Items, child, fmt.Sprintf("%s[%d]", path, index)); detail != "" {
				return detail
			}
		}
	}
	return ""
}
