package configyaml

import (
	"fmt"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// V8_CONFIG_VERSION is the `config-version` CPA writes when it migrates a file
// to the v8 layout.
const V8_CONFIG_VERSION = 8

// IsV8Document reports whether a stored configuration file is already in the
// v8 layout. CPA marks a migrated file with `config-version: 8`; a file without
// it is still in the legacy layout even when CPA serves a v8 view of it, and the
// first v8 configuration write rewrites it.
func IsV8Document(rawYAML string) (bool, error) {
	if strings.TrimSpace(rawYAML) == "" {
		return false, nil
	}
	root, err := parseRootMapping(rawYAML)
	if err != nil {
		return false, err
	}
	marker := mappingValue(root, "config-version")
	if marker == nil {
		return false, nil
	}
	version, err := strconv.Atoi(strings.TrimSpace(marker.Value))
	return err == nil && version >= V8_CONFIG_VERSION, nil
}

// RestoreSentinelsAt is RestoreSentinels for one value of a sparse write: the
// value the console submits for `path` has its masked secrets and cleaned proxy
// URLs put back from the stored document at the same path, under the same
// entry-order proof. A value with nothing to restore is returned unchanged.
func RestoreSentinelsAt(value any, path []string, serverYAML string) (any, error) {
	encoded, err := yaml.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode value: %w", err)
	}
	var submitted yaml.Node
	if err := yaml.Unmarshal(encoded, &submitted); err != nil {
		return nil, fmt.Errorf("parse value: %w", err)
	}
	if len(submitted.Content) == 0 {
		return value, nil
	}
	node := submitted.Content[0]
	// A scalar at a proxy-url path is handled by restoreNode even without a
	// sentinel, which is what documentRestoresValues reports for it.
	if !documentRestoresValues(node, path) {
		return value, nil
	}
	stored, err := nodeAt(serverYAML, path)
	if err != nil {
		return nil, err
	}
	if stored != nil {
		if err := restoreNode(node, stored, path); err != nil {
			return nil, err
		}
	}
	// A sentinel the stored copy could not replace - under a list entry past the
	// stored length, or a key the stored mapping lacks - would otherwise be
	// written as the secret itself.
	if unrestored, found := unrestoredSentinelPath(node, path); found {
		return nil, fmt.Errorf("%s has no stored value to keep", unrestored)
	}
	var restored any
	if err := node.Decode(&restored); err != nil {
		return nil, fmt.Errorf("decode value: %w", err)
	}
	return restored, nil
}

// unrestoredSentinelPath finds a sensitive value that still holds the sentinel.
// Only sensitive paths count: anywhere else the sentinel is ordinary text.
func unrestoredSentinelPath(node *yaml.Node, path []string) (string, bool) {
	if node == nil {
		return "", false
	}
	if isSensitivePath(path) && nodeContainsSentinel(node) {
		return pathLabel(path), true
	}
	switch node.Kind {
	case yaml.MappingNode:
		for index := 0; index+1 < len(node.Content); index += 2 {
			if label, found := unrestoredSentinelPath(node.Content[index+1], appendPath(path, node.Content[index].Value)); found {
				return label, true
			}
		}
	case yaml.SequenceNode:
		for _, item := range node.Content {
			if label, found := unrestoredSentinelPath(item, path); found {
				return label, true
			}
		}
	}
	return "", false
}

// nodeAt finds the node a mapping path names, or nil when any step is absent.
func nodeAt(rawYAML string, path []string) (*yaml.Node, error) {
	node, err := parseRootMapping(rawYAML)
	if err != nil {
		return nil, fmt.Errorf("parse server yaml: %w", err)
	}
	for _, key := range path {
		if node == nil {
			return nil, nil
		}
		node = mappingValue(node, key)
	}
	return node, nil
}
