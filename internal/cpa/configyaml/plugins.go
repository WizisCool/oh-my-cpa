package configyaml

import (
	"errors"
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

/**
 * The plugin system's host settings in CPA's `config.yaml`: the global switch, the
 * extra store registries and the store authentication rules.
 *
 * They are read from CPA's v8 view of the document and written as a sparse change
 * to their own paths below `plugins`. Only the three keys this file owns are written:
 * `plugins.dir` and `plugins.configs` (each plugin's own settings, which CPA writes
 * through its plugin routes) are left as they are.
 *
 * A store authentication rule never holds a secret. It names environment variables
 * CPA reads when it makes the request, which is why the rules are safe to show and
 * edit in the console.
 */

// PluginStoreAuthRule is one `plugins.store-auth` entry.
type PluginStoreAuthRule struct {
	Match          string   `yaml:"match,omitempty"`
	ApplyTo        []string `yaml:"apply-to,omitempty"`
	Type           string   `yaml:"type,omitempty"`
	TokenEnv       string   `yaml:"token-env,omitempty"`
	UsernameEnv    string   `yaml:"username-env,omitempty"`
	PasswordEnv    string   `yaml:"password-env,omitempty"`
	HeaderName     string   `yaml:"header-name,omitempty"`
	HeaderValueEnv string   `yaml:"header-value-env,omitempty"`
	AllowInsecure  bool     `yaml:"allow-insecure,omitempty"`
}

// PluginSettings is the host-owned part of the `plugins` section.
type PluginSettings struct {
	Enabled      bool                  `yaml:"enabled"`
	Dir          string                `yaml:"dir"`
	StoreSources []string              `yaml:"store-sources"`
	StoreAuth    []PluginStoreAuthRule `yaml:"store-auth"`
}

// ErrPluginSettingsUnreadable reports a `plugins` section whose shape CPA itself
// would not load, so the console refuses to rewrite it rather than guess.
var ErrPluginSettingsUnreadable = errors.New("plugins section is not in the shape CPA reads")

// ReadPluginSettings decodes the plugin host settings from a whole document.
func ReadPluginSettings(rawYAML string) (PluginSettings, error) {
	settings := PluginSettings{StoreSources: []string{}, StoreAuth: []PluginStoreAuthRule{}}
	root, err := parseRootMapping(rawYAML)
	if err != nil {
		return settings, err
	}
	section := mappingValue(root, "plugins")
	if section == nil || section.Kind == yaml.ScalarNode && section.Tag == "!!null" {
		return settings, nil
	}
	if section.Kind != yaml.MappingNode {
		return settings, ErrPluginSettingsUnreadable
	}
	var decoded PluginSettings
	if err := section.Decode(&decoded); err != nil {
		return settings, fmt.Errorf("%w: %v", ErrPluginSettingsUnreadable, err)
	}
	settings.Enabled = decoded.Enabled
	settings.Dir = strings.TrimSpace(decoded.Dir)
	if decoded.StoreSources != nil {
		settings.StoreSources = decoded.StoreSources
	}
	if decoded.StoreAuth != nil {
		settings.StoreAuth = decoded.StoreAuth
	}
	return settings, nil
}

// PluginSettingsEdit is the sparse write of the keys this file owns, as values
// to set and keys to remove below `plugins`. An empty list is removed, which is
// how CPA spells "none"; `plugins.dir` and `plugins.configs` are never named.
func PluginSettingsEdit(settings PluginSettings) (set map[string]any, remove []string, err error) {
	set = map[string]any{"enabled": settings.Enabled}
	if len(settings.StoreSources) == 0 {
		remove = append(remove, "store-sources")
	} else {
		sources := make([]any, 0, len(settings.StoreSources))
		for _, source := range settings.StoreSources {
			sources = append(sources, source)
		}
		set["store-sources"] = sources
	}
	if len(settings.StoreAuth) == 0 {
		remove = append(remove, "store-auth")
	} else {
		// Encoded through the YAML field names CPA reads, with their omitempty
		// rules, rather than through a second JSON spelling of the same struct.
		encoded, err := yaml.Marshal(settings.StoreAuth)
		if err != nil {
			return nil, nil, fmt.Errorf("encode store auth rules: %w", err)
		}
		var rules []any
		if err := yaml.Unmarshal(encoded, &rules); err != nil {
			return nil, nil, fmt.Errorf("decode store auth rules: %w", err)
		}
		set["store-auth"] = rules
	}
	return set, remove, nil
}
