package configyaml

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
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
	var submittedRoot yaml.Node
	if err := yaml.Unmarshal([]byte(submittedYAML), &submittedRoot); err != nil {
		return "", fmt.Errorf("parse submitted yaml: %w", err)
	}
	if len(submittedRoot.Content) == 0 {
		return submittedYAML, nil
	}
	// The decision is made on the parsed document rather than on the raw text:
	// a proxy key may be spelled with an underscore or in another case, and a
	// quoted key hides the literal text, so a textual filter can skip a restore
	// and silently discard stored credentials on the next save.
	if !documentRestoresValues(submittedRoot.Content[0], nil) {
		return submittedYAML, nil
	}

	var serverRoot yaml.Node
	if err := yaml.Unmarshal([]byte(serverYAML), &serverRoot); err != nil {
		return "", fmt.Errorf("parse server yaml: %w", err)
	}

	if len(serverRoot.Content) == 0 {
		return submittedYAML, nil
	}

	if err := restoreMapping(submittedRoot.Content[0], serverRoot.Content[0], nil); err != nil {
		return "", err
	}

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

// ErrUnprovableEntryRestore reports a sequence whose entries changed shape or
// order while at least one of them still carried a hidden value. Entries are
// paired with the stored document by position, so accepting such a document
// could attach one entry's secret to another entry.
var ErrUnprovableEntryRestore = errors.New("sequence entries with hidden values must keep their original count and order")

func restoreMapping(subNode, srvNode *yaml.Node, parentPath []string) error {
	if subNode.Kind != yaml.MappingNode || srvNode.Kind != yaml.MappingNode {
		return nil
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

		if err := restoreNode(valNode, srvVal, currentPath); err != nil {
			return err
		}
	}
	return nil
}

// restoreNode restores sentinel-protected values and proxy URLs whose sanitized
// form is unchanged. Non-sensitive fields may legitimately contain the sentinel
// as literal text, and copying a non-scalar server node into a scalar sentinel
// would destroy the field's type.
func restoreNode(subNode, srvNode *yaml.Node, currentPath []string) error {
	if subNode == nil || srvNode == nil {
		return nil
	}
	if isProxyURLPath(currentPath) && subNode.Kind == yaml.ScalarNode && srvNode.Kind == yaml.ScalarNode {
		// The safe view removed userinfo/query from the proxy URL. The submitted
		// value is compared against the cleaned form the operator was shown, not
		// against the stored value: an untouched cleaned URL restores the original
		// credentials, while a value the operator filled in - new credentials, a
		// new query, or a different endpoint - is an explicit edit and is kept.
		sanitizedServer := sanitizeProxyURL(srvNode.Value)
		if subNode.Value == sanitizedServer {
			*subNode = *srvNode
			return nil
		}
	}
	if isSensitivePath(currentPath) && nodeContainsSentinel(subNode) {
		*subNode = *srvNode
		return nil
	}

	switch subNode.Kind {
	case yaml.MappingNode:
		if srvNode.Kind == yaml.MappingNode {
			return restoreMapping(subNode, srvNode, currentPath)
		}
	case yaml.SequenceNode:
		if srvNode.Kind != yaml.SequenceNode {
			return nil
		}
		// Sequence entries have no YAML key of their own, so the same path is
		// carried into every item and the stored entry is found by position.
		// Position only identifies the stored entry while the submitted list is
		// still the list the operator was shown.
		if sequenceTakesStoredValues(subNode, currentPath) {
			if err := requireSameEntriesByPosition(subNode, srvNode, currentPath); err != nil {
				return err
			}
		}
		for index, item := range subNode.Content {
			if index >= len(srvNode.Content) {
				break
			}
			if err := restoreNode(item, srvNode.Content[index], currentPath); err != nil {
				return err
			}
		}
	}
	return nil
}

// sequenceTakesStoredValues reports whether restoring this sequence copies a
// stored value into it - through a sentinel somewhere in its subtree, or through
// the credentials of a proxy URL, which the safe view strips without leaving a
// sentinel behind.
func sequenceTakesStoredValues(node *yaml.Node, currentPath []string) bool {
	// The predicate is the same one that decides whether the document needs a
	// restore at all, so it already looks inside mapping entries: a list of
	// servers that each carry their own proxy-url is as position-dependent as one
	// whose values are masked with a sentinel.
	return documentRestoresValues(node, currentPath)
}

// requireSameEntriesByPosition refuses a submitted sequence that no longer
// describes the same entries, in the same order, as the stored document. Only
// the values the operator could see are compared, so an entry whose hidden value
// was re-entered explicitly still matches, while an edit that shifted the
// entries is rejected instead of being paired with another entry's secret.
func requireSameEntriesByPosition(subNode, srvNode *yaml.Node, currentPath []string) error {
	if len(subNode.Content) != len(srvNode.Content) {
		return fmt.Errorf("%w (%s: %d submitted, %d stored)",
			ErrUnprovableEntryRestore, pathLabel(currentPath), len(subNode.Content), len(srvNode.Content))
	}
	for index := range subNode.Content {
		if publicFingerprint(subNode.Content[index], currentPath) != publicFingerprint(srvNode.Content[index], currentPath) {
			return fmt.Errorf("%w (%s: entry %d)", ErrUnprovableEntryRestore, pathLabel(currentPath), index+1)
		}
	}
	return nil
}

// publicFingerprint renders a node using only the content the operator could
// read in the console: a sensitive value collapses to a constant on both sides
// and a proxy URL compares in its cleaned form. Reordering entries that share a
// fingerprint is harmless because the operator cannot tell them apart either.
func publicFingerprint(node *yaml.Node, currentPath []string) string {
	if node == nil {
		return "<nil>"
	}
	if isSensitivePath(currentPath) {
		return "<hidden>"
	}
	switch node.Kind {
	case yaml.ScalarNode:
		if isProxyURLPath(currentPath) {
			return "!" + sanitizeProxyURL(node.Value)
		}
		return "!" + node.Value
	case yaml.SequenceNode:
		parts := make([]string, 0, len(node.Content))
		for _, item := range node.Content {
			parts = append(parts, publicFingerprint(item, currentPath))
		}
		return "[" + strings.Join(parts, ",") + "]"
	case yaml.MappingNode:
		// A mapping is unordered, so keys are sorted to keep a reordered entry
		// from being mistaken for a different one.
		parts := make([]string, 0, len(node.Content)/2)
		for index := 0; index+1 < len(node.Content); index += 2 {
			parts = append(parts, node.Content[index].Value+"="+
				publicFingerprint(node.Content[index+1], appendPath(currentPath, node.Content[index].Value)))
		}
		sort.Strings(parts)
		return "{" + strings.Join(parts, ",") + "}"
	}
	return "?"
}

func pathLabel(currentPath []string) string {
	if len(currentPath) == 0 {
		return "top level"
	}
	return strings.Join(currentPath, ".")
}

// documentRestoresValues reports whether the submitted document holds a value
// that only the stored server document can supply: a masked sensitive field
// (its sentinel) or a proxy URL whose credentials the safe view removed. When
// nothing qualifies, the operator's document is forwarded byte for byte so a
// save does not reformat YAML it had no reason to touch.
func documentRestoresValues(node *yaml.Node, parentPath []string) bool {
	if node == nil {
		return false
	}
	if node.Kind == yaml.ScalarNode {
		return isSensitivePath(parentPath) && node.Value == UnchangedSentinel || isProxyURLPath(parentPath)
	}
	if len(parentPath) > 0 && isSensitivePath(parentPath) && nodeContainsSentinel(node) {
		return true
	}
	switch node.Kind {
	case yaml.MappingNode:
		for index := 0; index+1 < len(node.Content); index += 2 {
			if documentRestoresValues(node.Content[index+1], appendPath(parentPath, node.Content[index].Value)) {
				return true
			}
		}
	case yaml.SequenceNode:
		// Sequence entries carry no key, so the same path reaches every item -
		// the same rule the restore walk uses.
		for _, item := range node.Content {
			if documentRestoresValues(item, parentPath) {
				return true
			}
		}
	}
	return false
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
