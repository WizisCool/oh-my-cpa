package configyaml

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestPluginSettingsEditNamesOnlyItsOwnKeys(t *testing.T) {
	set, remove, err := PluginSettingsEdit(PluginSettings{
		Enabled: true,
		Dir:     "./ignored",
		StoreAuth: []PluginStoreAuthRule{{
			Match: "https://plugins.example/", ApplyTo: []string{"registry"}, Type: "github-token", TokenEnv: "GH_TOKEN",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	// `dir` and `configs` belong to CPA's own plugin routes and are never written.
	for key := range set {
		if key != "enabled" && key != "store-auth" {
			t.Fatalf("edit sets %q", key)
		}
	}
	// An empty list is removed, which is how CPA spells "none".
	if !reflect.DeepEqual(remove, []string{"store-sources"}) {
		t.Fatalf("remove = %v", remove)
	}
	// The rules travel under the field names CPA reads, without empty fields.
	encoded, _ := json.Marshal(set["store-auth"])
	if string(encoded) != `[{"apply-to":["registry"],"match":"https://plugins.example/","token-env":"GH_TOKEN","type":"github-token"}]` {
		t.Fatalf("store-auth = %s", encoded)
	}
	if set["enabled"] != true {
		t.Fatalf("enabled = %v", set["enabled"])
	}

	set, remove, err = PluginSettingsEdit(PluginSettings{StoreSources: []string{"https://r.example/registry.json"}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(set["store-sources"], []any{"https://r.example/registry.json"}) || !reflect.DeepEqual(remove, []string{"store-auth"}) {
		t.Fatalf("set = %v, remove = %v", set, remove)
	}
}

func TestPluginSettingsRefuseAShapeCPAWouldNotRead(t *testing.T) {
	for _, source := range []string{"plugins: true\n", "plugins:\n  store-sources: https://single.example\n"} {
		if _, err := ReadPluginSettings(source); !errors.Is(err, ErrPluginSettingsUnreadable) {
			t.Errorf("read %q: err = %v, want ErrPluginSettingsUnreadable", source, err)
		}
	}
}
