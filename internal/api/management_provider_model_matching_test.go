package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func TestProviderModelAliasRenamesKeepTheirPolicy(t *testing.T) {
	for _, test := range []struct {
		name         string
		aliases      []string
		hasOptions   bool
		wantPolicies []any
		wantError    bool
	}{
		{name: "renamed before unchanged sibling", aliases: []string{"one-renamed", "two"}, wantPolicies: []any{false, true}},
		{name: "unchanged before renamed sibling", aliases: []string{"two", "one-renamed"}, wantPolicies: []any{true, false}},
		{name: "new sibling keeps both original routes", aliases: []string{"three", "two", "one"}, wantPolicies: []any{nil, true, false}},
		{name: "explicit options clear only renamed row", aliases: []string{"one-renamed", "two"}, hasOptions: true, wantPolicies: []any{nil, true}},
		{name: "ambiguous replacements", aliases: []string{"first-renamed", "second-renamed"}, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stored []management.ModelAlias
			if err := json.Unmarshal([]byte(`[{"name":"partner/model","alias":"one","openapi":false,"display-name":"First","future-option":"first"},{"name":"partner/model","alias":"two","openapi":true,"display-name":"Second","future-option":"second"}]`), &stored); err != nil {
				t.Fatal(err)
			}
			edited := make([]editedProviderModel, len(test.aliases))
			for index, alias := range test.aliases {
				edited[index] = editedProviderModel{model: management.ModelAlias{Name: "partner/model", Alias: alias}, hasOptions: test.hasOptions && alias == "one-renamed"}
			}
			merged, err := mergeModelEdits(stored, edited)
			if test.wantError {
				if err == nil || !strings.Contains(err.Error(), "ambiguous model alias rename") {
					t.Fatalf("ambiguous rename = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for index, model := range merged {
				if model.Alias != test.aliases[index] {
					t.Fatalf("alias %d = %q", index, model.Alias)
				}
				var policy any
				if model.OpenAPI != nil {
					policy = *model.OpenAPI
				}
				if policy != test.wantPolicies[index] {
					t.Errorf("alias %q policy = %v, want %v", model.Alias, policy, test.wantPolicies[index])
				}
				if model.Alias == "one-renamed" || model.Alias == "one" {
					raw, _ := json.Marshal(model)
					if !strings.Contains(string(raw), `"future-option":"first"`) {
						t.Errorf("renamed row lost unmodelled options: %s", raw)
					}
				}
			}
		})
	}
}
