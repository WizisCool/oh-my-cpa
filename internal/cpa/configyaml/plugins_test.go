package configyaml

import (
	"errors"
	"strings"
	"testing"
)

func TestApplyPluginSettingsTouchesOnlyItsOwnKeys(t *testing.T) {
	source := `# gateway
port: 8317
plugins:
  enabled: false # set from the console
  dir: ./my-plugins
  store-sources:
    - https://old.example/registry.json
  configs:
    logger:
      enabled: true
      level: info # verbose
`
	written, err := ApplyPluginSettings(source, PluginSettings{
		Enabled: true,
		StoreAuth: []PluginStoreAuthRule{{
			Match: "https://plugins.example/", ApplyTo: []string{"registry"}, Type: "github-token", TokenEnv: "GH_TOKEN",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# gateway", "enabled: true # set from the console", "dir: ./my-plugins", "level: info # verbose", "token-env: GH_TOKEN", "type: github-token"} {
		if !strings.Contains(written, want) {
			t.Errorf("written document lacks %q:\n%s", want, written)
		}
	}
	// An empty list is written as the key's absence, which is how CPA spells "none".
	if strings.Contains(written, "store-sources") || strings.Contains(written, "old.example") {
		t.Errorf("cleared store sources are still present:\n%s", written)
	}

	settings, err := ReadPluginSettings(written)
	if err != nil {
		t.Fatal(err)
	}
	if !settings.Enabled || settings.Dir != "./my-plugins" || len(settings.StoreSources) != 0 || len(settings.StoreAuth) != 1 || settings.StoreAuth[0].TokenEnv != "GH_TOKEN" {
		t.Fatalf("read back %#v", settings)
	}
}

func TestApplyPluginSettingsCreatesTheSection(t *testing.T) {
	for _, source := range []string{"", "port: 8317\n", "port: 8317\nplugins:\n"} {
		written, err := ApplyPluginSettings(source, PluginSettings{Enabled: true, StoreSources: []string{"https://r.example/registry.json"}})
		if err != nil {
			t.Fatalf("%q: %v", source, err)
		}
		settings, err := ReadPluginSettings(written)
		if err != nil || !settings.Enabled || len(settings.StoreSources) != 1 {
			t.Fatalf("%q: read back %#v, %v from:\n%s", source, settings, err, written)
		}
	}
}

func TestPluginSettingsRefuseAShapeCPAWouldNotRead(t *testing.T) {
	for _, source := range []string{"plugins: true\n", "plugins:\n  store-sources: https://single.example\n"} {
		if _, err := ReadPluginSettings(source); !errors.Is(err, ErrPluginSettingsUnreadable) {
			t.Errorf("read %q: err = %v, want ErrPluginSettingsUnreadable", source, err)
		}
	}
	if _, err := ApplyPluginSettings("plugins: true\n", PluginSettings{}); !errors.Is(err, ErrPluginSettingsUnreadable) {
		t.Errorf("apply over a scalar section: err = %v, want ErrPluginSettingsUnreadable", err)
	}
}
