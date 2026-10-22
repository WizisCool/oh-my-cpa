package management

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/testkit"
)

// keyGroupCase is the body of a key-group golden case: one family as the v8 file
// stores it and the v0 runtime lists it, and the edits the console sends back.
type keyGroupCase struct {
	Family  ConfigKeyFamily `json:"family"`
	Stored  json.RawMessage `json:"stored"`
	Runtime json.RawMessage `json:"runtime"`
	// Edits merge into the entry at each position as the console's form would send
	// it: objects merge field by field, arrays element by element, and null clears.
	Edits map[string]json.RawMessage `json:"edits"`
	// Append adds entries after the runtime's, as a newly created key.
	Append []json.RawMessage `json:"append"`
}

// TestKeyGroupsGolden reads a grouped family, applies the case's edits and records
// both the editable list and the groups the write sent. The written groups are
// asserted whole, so an edit that rewrote anything the operator did not change
// shows in the diff.
func TestKeyGroupsGolden(t *testing.T) {
	testkit.Cases(t, "testdata/golden/key-groups", func(t *testing.T, input testkit.Case) any {
		var body keyGroupCase
		if err := json.Unmarshal(input.Body, &body); err != nil {
			t.Fatalf("decode case body: %v", err)
		}
		gateway := &groupsGateway{family: string(body.Family), stored: string(body.Stored), runtime: string(body.Runtime)}
		client := newGroupsClient(t, gateway)
		read, err := client.EditableConfigAPIKeys(context.Background(), body.Family)
		if err != nil {
			t.Fatal(err)
		}
		edited := make([]ConfigAPIKey, len(read))
		copy(edited, read)
		for position, patch := range body.Edits {
			index, err := strconv.Atoi(position)
			if err != nil || index < 0 || index >= len(edited) {
				t.Fatalf("edit position %q is not an entry", position)
			}
			edited[index] = mergedEntry(t, read[index], patch)
		}
		for _, entry := range body.Append {
			var created ConfigAPIKey
			if err := json.Unmarshal(entry, &created); err != nil {
				t.Fatal(err)
			}
			edited = append(edited, created)
		}
		if err := client.UpdateConfigAPIKeys(context.Background(), body.Family, edited); err != nil {
			t.Fatal(err)
		}
		gateway.mu.Lock()
		defer gateway.mu.Unlock()
		return map[string]any{"read": read, "written": gateway.written}
	})
}

// mergedEntry decodes entry with patch merged into its wire form, through the same
// decoder a console edit takes, and keeps the read-side state that says where the
// entry came from. The result shares no slice with entry, so an edit cannot reach
// the stored group it is compared against.
func mergedEntry(t *testing.T, entry ConfigAPIKey, patch json.RawMessage) ConfigAPIKey {
	t.Helper()
	encoded, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	var base, change any
	if err := json.Unmarshal(encoded, &base); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(patch, &change); err != nil {
		t.Fatal(err)
	}
	merged, err := json.Marshal(mergeJSON(base, change))
	if err != nil {
		t.Fatal(err)
	}
	var edited ConfigAPIKey
	if err := json.Unmarshal(merged, &edited); err != nil {
		t.Fatal(err)
	}
	edited.origin, edited.runtimeBaseURL = entry.origin, entry.runtimeBaseURL
	return edited
}

func mergeJSON(base, change any) any {
	switch change := change.(type) {
	case map[string]any:
		object, _ := base.(map[string]any)
		merged := map[string]any{}
		for name, value := range object {
			merged[name] = value
		}
		for name, value := range change {
			if value == nil {
				delete(merged, name)
				continue
			}
			merged[name] = mergeJSON(object[name], value)
		}
		return merged
	case []any:
		list, _ := base.([]any)
		merged := make([]any, len(change))
		for index, value := range change {
			var previous any
			if index < len(list) {
				previous = list[index]
			}
			merged[index] = mergeJSON(previous, value)
		}
		return merged
	default:
		return change
	}
}
