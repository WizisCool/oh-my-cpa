package configyaml

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// UnchangedSentinel is the placeholder used for sensitive fields in visual
// configuration mode so that original secrets are not exposed to the browser.
const UnchangedSentinel = "__OMCPA_UNCHANGED__"

// ComputeRevision returns the lowercase SHA-256 hex digest of a YAML document.
func ComputeRevision(yamlContent string) string {
	sum := sha256.Sum256([]byte(yamlContent))
	return hex.EncodeToString(sum[:])
}

// ValidationError represents a YAML syntax or schema error with line and column.
type ValidationError struct {
	Message string `json:"message"`
	Line    int    `json:"line"`
	Column  int    `json:"column"`
}

func (e *ValidationError) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("line %d, column %d: %s", e.Line, e.Column, e.Message)
	}
	return e.Message
}

var lineColRegex = regexp.MustCompile(`line (\d+): (?:column (\d+): )?(.*)`)

// ValidateSyntax parses YAML and extracts precise line and column information if invalid.
func ValidateSyntax(raw []byte) *ValidationError {
	var node yaml.Node
	err := yaml.Unmarshal(raw, &node)
	if err == nil {
		return nil
	}
	msg := err.Error()
	matches := lineColRegex.FindStringSubmatch(msg)
	if len(matches) >= 4 {
		line := 0
		col := 0
		_, _ = fmt.Sscanf(matches[1], "%d", &line)
		if matches[2] != "" {
			_, _ = fmt.Sscanf(matches[2], "%d", &col)
		}
		detail := strings.TrimSpace(matches[3])
		return &ValidationError{Message: detail, Line: line, Column: col}
	}
	return &ValidationError{Message: msg, Line: 1, Column: 1}
}

// SanitizeSafeYAML takes a raw CPA YAML document, parses it into an AST,
// redacts sensitive fields and userinfo in proxy URLs, and outputs safe YAML.
// Comments and custom formatting are preserved.
func SanitizeSafeYAML(rawYAML string) (string, error) {
	if strings.TrimSpace(rawYAML) == "" {
		return "", nil
	}
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(rawYAML), &root); err != nil {
		return "", fmt.Errorf("parse yaml: %w", err)
	}
	if len(root.Content) == 0 {
		return rawYAML, nil
	}

	docNode := root.Content[0]
	if docNode.Kind == yaml.MappingNode {
		sanitizeMapping(docNode, nil)
	}

	var buf strings.Builder
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&root); err != nil {
		return "", fmt.Errorf("encode sanitized yaml: %w", err)
	}
	_ = enc.Close()
	return buf.String(), nil
}

// RestoreSentinels takes the submitted YAML and the current server YAML.
// If any sensitive field in submitted contains the UnchangedSentinel,
// its original node from current is preserved.
func RestoreSentinels(submittedYAML, serverYAML string) (string, error) {
	if !strings.Contains(submittedYAML, UnchangedSentinel) {
		return submittedYAML, nil
	}
	var submittedRoot yaml.Node
	if err := yaml.Unmarshal([]byte(submittedYAML), &submittedRoot); err != nil {
		return "", fmt.Errorf("parse submitted yaml: %w", err)
	}
	var serverRoot yaml.Node
	if err := yaml.Unmarshal([]byte(serverYAML), &serverRoot); err != nil {
		return "", fmt.Errorf("parse server yaml: %w", err)
	}

	if len(submittedRoot.Content) == 0 || len(serverRoot.Content) == 0 {
		return submittedYAML, nil
	}

	restoreMapping(submittedRoot.Content[0], serverRoot.Content[0], nil)

	var buf strings.Builder
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&submittedRoot); err != nil {
		return "", fmt.Errorf("encode restored yaml: %w", err)
	}
	_ = enc.Close()
	return buf.String(), nil
}

func sanitizeMapping(node *yaml.Node, parentPath []string) {
	if node.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i < len(node.Content)-1; i += 2 {
		keyNode := node.Content[i]
		valNode := node.Content[i+1]
		currentPath := append(parentPath, keyNode.Value)

		if isSensitivePath(currentPath) {
			maskValueNode(valNode)
			continue
		}

		if isProxyURLPath(currentPath) && valNode.Kind == yaml.ScalarNode {
			valNode.Value = sanitizeProxyURL(valNode.Value)
			continue
		}

		if valNode.Kind == yaml.MappingNode {
			sanitizeMapping(valNode, currentPath)
		} else if valNode.Kind == yaml.SequenceNode {
			sanitizeSequence(valNode, currentPath)
		}
	}
}

func sanitizeSequence(node *yaml.Node, parentPath []string) {
	for _, item := range node.Content {
		if isSensitivePath(parentPath) {
			maskValueNode(item)
		} else if item.Kind == yaml.MappingNode {
			sanitizeMapping(item, parentPath)
		}
	}
}

func restoreMapping(subNode, srvNode *yaml.Node, parentPath []string) {
	if subNode.Kind != yaml.MappingNode || srvNode.Kind != yaml.MappingNode {
		return
	}
	srvMap := make(map[string]*yaml.Node)
	for i := 0; i < len(srvNode.Content)-1; i += 2 {
		srvMap[srvNode.Content[i].Value] = srvNode.Content[i+1]
	}

	for i := 0; i < len(subNode.Content)-1; i += 2 {
		key := subNode.Content[i].Value
		valNode := subNode.Content[i+1]
		currentPath := append(parentPath, key)

		srvVal, exists := srvMap[key]
		if !exists {
			continue
		}

		if valNode.Kind == yaml.ScalarNode && valNode.Value == UnchangedSentinel {
			// Restore original value from server node
			valNode.Value = srvVal.Value
			valNode.Tag = srvVal.Tag
			continue
		}

		if valNode.Kind == yaml.SequenceNode && srvVal.Kind == yaml.SequenceNode && isSensitivePath(currentPath) {
			hasSentinel := false
			for _, item := range valNode.Content {
				if item.Value == UnchangedSentinel {
					hasSentinel = true
					break
				}
			}
			if hasSentinel {
				valNode.Content = srvVal.Content
				continue
			}
		}

		if valNode.Kind == yaml.MappingNode && srvVal.Kind == yaml.MappingNode {
			restoreMapping(valNode, srvVal, currentPath)
		}
	}
}

func maskValueNode(node *yaml.Node) {
	if node.Kind == yaml.ScalarNode {
		if strings.TrimSpace(node.Value) != "" {
			node.Value = UnchangedSentinel
		}
	} else if node.Kind == yaml.SequenceNode {
		if len(node.Content) > 0 {
			node.Content = []*yaml.Node{{
				Kind:  yaml.ScalarNode,
				Tag:   "!!str",
				Value: UnchangedSentinel,
			}}
		}
	}
}

func isSensitivePath(path []string) bool {
	joined := strings.ToLower(strings.Join(path, "."))
	joined = strings.ReplaceAll(joined, "_", "-")
	switch joined {
	case "remote-management.secret-key",
		"tls.key",
		"api-keys",
		"codex-api-key.api-key",
		"openai-compatibility.api-key",
		"openai-compatibility.api-keys",
		"openai-compatibility.api-key-entries.api-key":
		return true
	default:
		return strings.HasSuffix(joined, ".secret-key") || strings.HasSuffix(joined, ".key") || strings.HasSuffix(joined, ".api-key")
	}
}

func isProxyURLPath(path []string) bool {
	joined := strings.ToLower(strings.Join(path, "."))
	joined = strings.ReplaceAll(joined, "_", "-")
	return joined == "proxy-url" || strings.HasSuffix(joined, ".proxy-url")
}

func sanitizeProxyURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return raw
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}
