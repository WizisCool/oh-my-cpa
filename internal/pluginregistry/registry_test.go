package pluginregistry

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
)

// registryDocument is the part of CPA's registry schema this repository publishes.
type registryDocument struct {
	SchemaVersion int              `json:"schema_version"`
	Plugins       []registryPlugin `json:"plugins"`
}

type registryPlugin struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Author      string `json:"author"`
	Version     string `json:"version"`
	Repository  string `json:"repository"`
	Install     struct {
		Type string `json:"type"`
	} `json:"install"`
}

const (
	installTypeGitHubRelease = "github-release"
	installTypeDirect        = "direct"
)

var (
	pluginIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	pluginVersionPattern = regexp.MustCompile(`^[0-9][0-9A-Za-z.+-]*$`)
)

// validateRegistry applies the rules CPA applies to a published entry: the fields every
// entry must carry, and the repository address a github-release entry installs from.
//
// It is deliberately not a full mirror of CPA's registry validation. The artifact rules
// of a schema-v2 `direct` entry are absent, so add them together with the first entry
// that publishes that shape rather than assuming what it would need.
//
// It exists because a malformed document is not caught by a build: CPA refuses the whole
// source, so every installation shows an empty Oh My CPA registry and all the console
// can print is the gateway's one-line message.
func validateRegistry(raw []byte) (registryDocument, error) {
	var document registryDocument
	if errDecode := json.Unmarshal(raw, &document); errDecode != nil {
		return document, fmt.Errorf("decode registry: %w", errDecode)
	}
	if document.SchemaVersion != 1 && document.SchemaVersion != 2 {
		return document, fmt.Errorf("unsupported schema_version %d", document.SchemaVersion)
	}
	seen := make(map[string]struct{}, len(document.Plugins))
	for index, plugin := range document.Plugins {
		if document.SchemaVersion == 1 && pluginInstallType(plugin) == installTypeDirect {
			return document, fmt.Errorf("plugins[%d]: direct install requires schema_version 2", index)
		}
		if errPlugin := validatePlugin(plugin); errPlugin != nil {
			return document, fmt.Errorf("plugins[%d]: %w", index, errPlugin)
		}
		id := strings.TrimSpace(plugin.ID)
		if _, exists := seen[id]; exists {
			return document, fmt.Errorf("plugins[%d]: duplicate plugin id %q", index, id)
		}
		seen[id] = struct{}{}
	}
	return document, nil
}

// pluginInstallType is the type CPA resolves for an entry: one that names none is
// installed from its repository's releases.
func pluginInstallType(plugin registryPlugin) string {
	if installType := strings.ToLower(strings.TrimSpace(plugin.Install.Type)); installType != "" {
		return installType
	}
	return installTypeGitHubRelease
}

func validatePlugin(plugin registryPlugin) error {
	installType := pluginInstallType(plugin)
	required := map[string]string{
		"id": plugin.ID, "name": plugin.Name, "description": plugin.Description, "author": plugin.Author,
	}
	if installType == installTypeGitHubRelease {
		required["repository"] = plugin.Repository
	}
	for field, value := range required {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("missing required field %s", field)
		}
	}
	if !pluginIDPattern.MatchString(strings.TrimSpace(plugin.ID)) {
		return fmt.Errorf("invalid id %q", plugin.ID)
	}
	// The latest release is authoritative; a declared version is only a display
	// fallback, and it must not carry a tag's leading "v".
	if version := strings.TrimSpace(plugin.Version); version != "" {
		if strings.HasPrefix(version, "v") || !pluginVersionPattern.MatchString(version) {
			return fmt.Errorf("invalid version %q", plugin.Version)
		}
	}
	switch installType {
	case installTypeGitHubRelease:
		return validateRepository(plugin.Repository)
	case installTypeDirect:
		// The artifact rules of a direct entry are not mirrored yet; nothing publishes
		// this shape, so the gate checks its fields and stops there.
		return nil
	default:
		return fmt.Errorf("unsupported install type %q", plugin.Install.Type)
	}
}

// validateRepository follows CPA's GitHubRepositoryParts: the store builds release URLs
// from this field, so it reads https://github.com/{owner}/{repo} and nothing else.
// A shorthand `owner/repo`, another host, or a `.git` suffix — including a
// percent-encoded one — is refused.
func validateRepository(repository string) error {
	parsed, errParse := url.Parse(strings.TrimSpace(repository))
	if errParse != nil {
		return fmt.Errorf("invalid repository URL: %w", errParse)
	}
	if parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("repository must be https://github.com/{owner}/{repo}")
	}
	segments := strings.Split(strings.Trim(parsed.EscapedPath(), "/"), "/")
	if len(segments) != 2 || segments[0] == "" || segments[1] == "" {
		return fmt.Errorf("repository must be https://github.com/{owner}/{repo}")
	}
	repo, errUnescape := url.PathUnescape(segments[1])
	if errUnescape != nil {
		return fmt.Errorf("invalid repository name: %w", errUnescape)
	}
	if strings.HasSuffix(repo, ".git") {
		return fmt.Errorf("repository must be https://github.com/{owner}/{repo}")
	}
	return nil
}

// The registry is read over HTTPS by every installation's gateway, so a broken
// document is caught here or nowhere: this test is the gate.
func TestPublishedRegistryIsReadable(t *testing.T) {
	raw, err := os.ReadFile("../../plugins/registry.json")
	if err != nil {
		t.Fatalf("read the plugin registry: %v", err)
	}
	if _, errValidate := validateRegistry(raw); errValidate != nil {
		t.Fatalf("the published registry would be refused by the gateway: %v", errValidate)
	}
}

// The gate above has to fail for the right reason, or a drifting check accepts
// everything silently.
func TestValidateRegistryRefusesWhatTheGatewayRefuses(t *testing.T) {
	const validPlugin = `{"id":"sample","name":"Sample","description":"Sample plugin.","author":"author","version":"1.2.0","repository":"https://github.com/owner/repo","install":{"type":"github-release"}}`
	document := func(schemaVersion int, plugins string) []byte {
		return []byte(fmt.Sprintf(`{"schema_version":%d,"plugins":[%s]}`, schemaVersion, plugins))
	}
	// The shorthand is what made the published Oh My CPA source unreadable: every other
	// field was valid, so only the repository rule could have caught it.
	shorthand := strings.Replace(validPlugin, "https://github.com/owner/repo", "owner/repo", 1)

	testCases := []struct {
		name    string
		raw     []byte
		wantErr string
	}{
		{name: "a valid github-release entry", raw: document(2, validPlugin)},
		{name: "an owner/repo shorthand repository", raw: document(2, shorthand), wantErr: "repository must be"},
		{
			name:    "a percent-encoded .git suffix",
			raw:     document(2, strings.Replace(validPlugin, "owner/repo\"", "owner/repo%2Egit\"", 1)),
			wantErr: "repository must be",
		},
		{
			name:    "a repository outside github.com",
			raw:     document(2, strings.Replace(validPlugin, "https://github.com/", "https://gitlab.com/", 1)),
			wantErr: "repository must be",
		},
		{
			name:    "a version carrying the tag's leading v",
			raw:     document(2, strings.Replace(validPlugin, `"version":"1.2.0"`, `"version":"v1.2.0"`, 1)),
			wantErr: "invalid version",
		},
		{
			name:    "a missing description",
			raw:     document(2, strings.Replace(validPlugin, `"description":"Sample plugin.",`, "", 1)),
			wantErr: "missing required field description",
		},
		{
			name:    "a duplicate id",
			raw:     document(2, validPlugin+","+validPlugin),
			wantErr: "duplicate plugin id",
		},
		{
			name:    "an id duplicated after trimming",
			raw:     document(2, validPlugin+","+strings.Replace(validPlugin, `"id":"sample"`, `"id":" sample "`, 1)),
			wantErr: "duplicate plugin id",
		},
		{
			name:    "a direct install under schema_version 1",
			raw:     []byte(`{"schema_version":1,"plugins":[{"id":"sample","name":"Sample","description":"Sample.","author":"a","version":"1.0.0","install":{"type":"direct"}}]}`),
			wantErr: "direct install requires schema_version 2",
		},
		{
			name:    "an unknown schema_version",
			raw:     document(3, validPlugin),
			wantErr: "unsupported schema_version 3",
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			_, errValidate := validateRegistry(testCase.raw)
			if testCase.wantErr == "" {
				if errValidate != nil {
					t.Fatalf("validateRegistry() = %v, want no error", errValidate)
				}
				return
			}
			if errValidate == nil || !strings.Contains(errValidate.Error(), testCase.wantErr) {
				t.Fatalf("validateRegistry() = %v, want an error containing %q", errValidate, testCase.wantErr)
			}
		})
	}
}

// The source id is derived from the URL, so changing the address silently changes
// which registry CPA thinks a saved install came from. Pinning it makes that a
// deliberate edit to this value rather than an accident in a constant.
func TestSourceIDPinsThePublishedRegistry(t *testing.T) {
	if got := SourceID(OMCSourceURL); got != "source-91d6a8a15335" {
		t.Fatalf("SourceID(%q) = %q; a new registry address means a new source id, so update this value with the URL", OMCSourceURL, got)
	}
	if got := SourceID("  https://example.test/registry.json  "); got != SourceID("https://example.test/registry.json") {
		t.Fatalf("SourceID should trim the URL, got %q", got)
	}
}
