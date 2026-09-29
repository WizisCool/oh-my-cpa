package management

import (
	"encoding/json"
	"reflect"
	"strings"
)

// wireExtras holds the fields of a CPA object that the struct decoding it does
// not model, verbatim. The console writes whole provider lists back, so a field
// it does not know (a newer CPA setting, a family-specific one) has to survive
// the round trip or an unrelated edit would silently remove it.
type wireExtras map[string]json.RawMessage

// modelledWireFields is the set of JSON names a struct type declares. It is
// derived from the tags so a newly modelled field can never also be replayed
// from the extras.
func modelledWireFields(fieldType reflect.Type) map[string]bool {
	names := map[string]bool{}
	for i := 0; i < fieldType.NumField(); i++ {
		field := fieldType.Field(i)
		if !field.IsExported() {
			continue
		}
		if name, _, _ := strings.Cut(field.Tag.Get("json"), ","); name != "" && name != "-" {
			names[name] = true
		}
	}
	return names
}

// decodeWithExtras decodes data into fields and returns what fields does not
// model. fields must point to a struct type without JSON methods.
func decodeWithExtras(data []byte, fields any, modelled map[string]bool) (wireExtras, error) {
	if err := json.Unmarshal(data, fields); err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	for name := range raw {
		if modelled[name] {
			delete(raw, name)
		}
	}
	if len(raw) == 0 {
		return nil, nil
	}
	return raw, nil
}

// encodeWithExtras encodes fields and replays the extras. A modelled field
// always wins: extras never hold a modelled name, so clearing an optional field
// (which omitempty then drops) cannot bring back its old value.
func encodeWithExtras(fields any, extra wireExtras) ([]byte, error) {
	encoded, err := json.Marshal(fields)
	if err != nil || len(extra) == 0 {
		return encoded, err
	}
	merged := map[string]json.RawMessage{}
	if err := json.Unmarshal(encoded, &merged); err != nil {
		return nil, err
	}
	for name, value := range extra {
		if _, isSet := merged[name]; !isSet {
			merged[name] = value
		}
	}
	return json.Marshal(merged)
}
