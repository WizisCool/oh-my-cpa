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
 * CPA exposes no management route for these, only the whole document, so they are
 * read from and written back into that document. Only the three keys this file owns
 * are touched: `plugins.dir` and `plugins.configs` (each plugin's own settings, which
 * CPA writes through its plugin routes) keep their nodes and comments. The `plugins`
 * section has the same path in the legacy and the v8 layouts, so no layout decision is
 * involved.
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

// ApplyPluginSettings writes the switch, the store sources and the store
// authentication rules into the document and returns the new document. An empty
// list removes its key, which is how CPA spells "none".
func ApplyPluginSettings(rawYAML string, settings PluginSettings) (string, error) {
	var document yaml.Node
	if strings.TrimSpace(rawYAML) != "" {
		if err := yaml.Unmarshal([]byte(rawYAML), &document); err != nil {
			return "", fmt.Errorf("parse yaml: %w", err)
		}
	}
	if document.Kind == 0 {
		document = yaml.Node{Kind: yaml.DocumentNode}
	}
	if len(document.Content) == 0 {
		document.Content = []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}
	}
	root := document.Content[0]
	if root.Kind != yaml.MappingNode {
		return "", fmt.Errorf("configuration must be a mapping")
	}

	section := mappingValue(root, "plugins")
	if section == nil || section.Kind != yaml.MappingNode {
		if section != nil && !(section.Kind == yaml.ScalarNode && section.Tag == "!!null") {
			return "", ErrPluginSettingsUnreadable
		}
		section = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		setMappingValue(root, "plugins", section)
	}

	setMappingValue(section, "enabled", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: fmt.Sprintf("%t", settings.Enabled)})

	if len(settings.StoreSources) == 0 {
		deleteMappingKey(section, "store-sources")
	} else {
		sources := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		for _, source := range settings.StoreSources {
			sources.Content = append(sources.Content, stringNode(source))
		}
		setMappingValue(section, "store-sources", sources)
	}

	if len(settings.StoreAuth) == 0 {
		deleteMappingKey(section, "store-auth")
	} else {
		rules := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		for _, rule := range settings.StoreAuth {
			var node yaml.Node
			if err := node.Encode(rule); err != nil {
				return "", fmt.Errorf("encode store auth rule: %w", err)
			}
			rules.Content = append(rules.Content, &node)
		}
		setMappingValue(section, "store-auth", rules)
	}

	var buffer strings.Builder
	encoder := yaml.NewEncoder(&buffer)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return "", fmt.Errorf("encode yaml: %w", err)
	}
	_ = encoder.Close()
	return buffer.String(), nil
}

func stringNode(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}

// setMappingValue replaces a key's value in place, carrying the old value's comments
// across so an operator's annotation on a setting survives the edit.
func setMappingValue(mapping *yaml.Node, key string, value *yaml.Node) {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == key {
			previous := mapping.Content[index+1]
			value.HeadComment = previous.HeadComment
			value.LineComment = previous.LineComment
			value.FootComment = previous.FootComment
			mapping.Content[index+1] = value
			return
		}
	}
	mapping.Content = append(mapping.Content, stringNode(key), value)
}

func deleteMappingKey(mapping *yaml.Node, key string) {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == key {
			mapping.Content = append(mapping.Content[:index], mapping.Content[index+2:]...)
			return
		}
	}
}
