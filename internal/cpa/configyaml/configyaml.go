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

// UnchangedSentinel is the placeholder used for management credentials (e.g.
// remote-management.secret-key) and TLS private keys in visual configuration
// mode so those secrets are not exposed to the browser. Upstream/downstream
// API keys are intentionally returned in plaintext.
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
	if !strings.Contains(submittedYAML, UnchangedSentinel) && !strings.Contains(submittedYAML, "proxy-url") {
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
		currentPath := appendPath(parentPath, keyNode.Value)

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
		} else if item.Kind == yaml.SequenceNode {
			sanitizeSequence(item, parentPath)
		} else if isProxyURLPath(parentPath) && item.Kind == yaml.ScalarNode {
			item.Value = sanitizeProxyURL(item.Value)
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
		currentPath := appendPath(parentPath, key)

		srvVal, exists := srvMap[key]
		if !exists {
			continue
		}

		restoreNode(valNode, srvVal, currentPath)
	}
}

// restoreNode restores sentinel-protected values and proxy URLs whose sanitized
// form is unchanged. Non-sensitive fields may legitimately contain the sentinel
// as literal text, and copying a non-scalar server node into a scalar sentinel
// would destroy the field's type.
func restoreNode(subNode, srvNode *yaml.Node, currentPath []string) {
	if subNode == nil || srvNode == nil {
		return
	}
	if isProxyURLPath(currentPath) && subNode.Kind == yaml.ScalarNode && srvNode.Kind == yaml.ScalarNode &&
		sanitizeProxyURL(subNode.Value) == sanitizeProxyURL(srvNode.Value) {
		// The safe view removed userinfo/query from the proxy URL. If the
		// operator left that cleaned URL untouched, restore the original node so
		// the save cannot silently discard its credentials.
		*subNode = *srvNode
		return
	}
	if isProxyURLPath(currentPath) && subNode.Kind == yaml.SequenceNode && srvNode.Kind == yaml.SequenceNode {
		for index, item := range subNode.Content {
			if index >= len(srvNode.Content) {
				break
			}
			restoreNode(item, srvNode.Content[index], currentPath)
		}
		return
	}
	if isSensitivePath(currentPath) && nodeContainsSentinel(subNode) {
		*subNode = *srvNode
		return
	}

	switch subNode.Kind {
	case yaml.MappingNode:
		if srvNode.Kind == yaml.MappingNode {
			restoreMapping(subNode, srvNode, currentPath)
		}
	case yaml.SequenceNode:
		if srvNode.Kind != yaml.SequenceNode {
			return
		}
		// Sequence entries have no YAML key of their own, so the same path is
		// carried into every item. The server node is aligned by index.
		for index, item := range subNode.Content {
			if index >= len(srvNode.Content) {
				break
			}
			restoreNode(item, srvNode.Content[index], currentPath)
		}
	}
}

func nodeContainsSentinel(node *yaml.Node) bool {
	if node == nil {
		return false
	}
	if node.Kind == yaml.ScalarNode {
		return node.Value == UnchangedSentinel
	}
	for _, child := range node.Content {
		if nodeContainsSentinel(child) {
			return true
		}
	}
	return false
}

func appendPath(parentPath []string, key string) []string {
	path := make([]string, 0, len(parentPath)+1)
	path = append(path, parentPath...)
	return append(path, key)
}

func maskValueNode(node *yaml.Node) {
	if node.Kind == yaml.ScalarNode {
		if strings.TrimSpace(node.Value) != "" {
			node.Value = UnchangedSentinel
			node.Tag = "!!str"
		}
	} else if node.Kind == yaml.SequenceNode {
		if len(node.Content) > 0 {
			node.Content = []*yaml.Node{{
				Kind:  yaml.ScalarNode,
				Tag:   "!!str",
				Value: UnchangedSentinel,
			}}
		}
	} else if node.Kind == yaml.MappingNode {
		if len(node.Content) > 0 {
			node.Kind = yaml.ScalarNode
			node.Tag = "!!str"
			node.Value = UnchangedSentinel
			node.Content = nil
			node.Style = 0
		}
	}
}

func isSensitivePath(path []string) bool {
	joined := strings.ToLower(strings.Join(path, "."))
	joined = strings.ReplaceAll(joined, "_", "-")
	switch joined {
	case "remote-management.secret-key",
		"tls.key":
		return true
	default:
		return strings.HasSuffix(joined, ".secret-key") || strings.HasSuffix(joined, ".key")
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
	if err == nil && parsed.Host != "" {
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.Fragment = ""
		return parsed.String()
	}
	// Schemeless proxy forms such as user:pass@host:port are not a URL with a
	// host to url.Parse, but their userinfo is still secret.
	if at := strings.LastIndex(raw, "@"); at >= 0 {
		raw = raw[at+1:]
	}
	if separator := strings.IndexAny(raw, "?#"); separator >= 0 {
		raw = raw[:separator]
	}
	return raw
}
