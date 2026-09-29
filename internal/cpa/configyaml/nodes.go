package configyaml

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

func parseRootMapping(rawYAML string) (*yaml.Node, error) {
	if strings.TrimSpace(rawYAML) == "" {
		return nil, nil
	}
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(rawYAML), &document); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}
	if len(document.Content) == 0 {
		return nil, nil
	}
	root := resolveAlias(document.Content[0])
	if root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("configuration must be a mapping")
	}
	return root, nil
}

func mappingValue(node *yaml.Node, key string) *yaml.Node {
	node = resolveAlias(node)
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for index := 0; index+1 < len(node.Content); index += 2 {
		if node.Content[index].Value == key {
			return resolveAlias(node.Content[index+1])
		}
	}
	return nil
}

func resolveAlias(node *yaml.Node) *yaml.Node {
	for node != nil && node.Kind == yaml.AliasNode {
		node = node.Alias
	}
	return node
}
