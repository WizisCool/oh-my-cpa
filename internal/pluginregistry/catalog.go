package pluginregistry

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const PublicRegistryPath = "/plugin-registry/v2.json"
const MaxManifestBytes = 1024 * 1024

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var versionPattern = regexp.MustCompile(`^[0-9][0-9A-Za-z.+-]{0,127}$`)
var stableVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

var ErrFrozen = errors.New("builtin release catalog is unavailable")
var ErrImmutableArtifact = errors.New("observed plugin artifact identity is immutable")
var ErrReleaseDowngrade = errors.New("builtin release downgrade refused")

type Descriptions map[string]string

type Artifact struct {
	GOOS   string `json:"goos" yaml:"goos"`
	GOARCH string `json:"goarch" yaml:"goarch"`
	URL    string `json:"url" yaml:"url"`
	SHA256 string `json:"sha256" yaml:"sha256"`
	Size   int64  `json:"size,omitempty" yaml:"size,omitempty"`
}
type Install struct {
	Type      string     `json:"type" yaml:"type"`
	Artifacts []Artifact `json:"artifacts" yaml:"artifacts"`
}
type Version struct {
	Version string  `json:"version"`
	Install Install `json:"install"`
}
type Plugin struct {
	ID              string       `json:"id"`
	Name            string       `json:"name"`
	Description     string       `json:"description"`
	DescriptionI18n Descriptions `json:"description_i18n,omitempty"`
	Author          string       `json:"author"`
	Version         string       `json:"version"`
	Repository      string       `json:"repository,omitempty"`
	Install         Install      `json:"install"`
	Versions        []Version    `json:"versions,omitempty"`
}
type Manifest struct {
	SchemaVersion int      `json:"schema_version"`
	Plugins       []Plugin `json:"plugins"`
}
type CatalogState struct {
	Status   string
	Revision string
	Manifest Manifest
}
type CatalogStore interface {
	LoadBuiltinCatalog(context.Context) ([]byte, []Plugin, error)
	SaveBuiltinCatalog(context.Context, []byte, Manifest) error
}

// The allowlist names publishers, not versions. A normal stable GitHub release is
// enough to update a builtin; community registries cannot add managed authority.
func builtinPlugins() []Plugin {
	return []Plugin{{
		ID: "omc-zcode-oauth", Name: "ZCode OAuth", Author: "Oh My CPA",
		Description: "Z.ai and BigModel OAuth, model discovery and quota.",
		Repository:  "https://github.com/WizisCool/omc-zcode-oauth",
	}}
}

// Catalog is a local snapshot. Its public registry never calls CPA or GitHub:
// CPA reads it synchronously while an install holds the configuration write gate.
type Catalog struct {
	mu        sync.RWMutex
	refreshMu sync.Mutex
	store     CatalogStore
	state     CatalogState
	history   []Plugin
	client    *http.Client
}

func NewCatalog(store CatalogStore) *Catalog {
	return &Catalog{
		store:  store,
		state:  CatalogState{Status: "unavailable", Manifest: Manifest{SchemaVersion: 2, Plugins: builtinPlugins()}},
		client: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
}

func (c *Catalog) Load(ctx context.Context) error {
	if c.store == nil {
		return errors.New("builtin catalog persistence is required")
	}
	raw, history, err := c.store.LoadBuiltinCatalog(ctx)
	if err != nil || len(raw) == 0 {
		return err
	}
	manifest, err := decodeSnapshot(raw)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state = catalogState(manifest, raw)
	c.history = history
	return nil
}

// Accept commits a locally resolved release snapshot before making it executable.
// Remote discovery goes through Refresh, whose targets and asset paths are fixed.
func (c *Catalog) Accept(ctx context.Context, raw []byte) error {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()
	manifest, err := decodeSnapshot(raw)
	if err != nil {
		return err
	}
	return c.accept(ctx, raw, manifest)
}

func (c *Catalog) accept(ctx context.Context, raw []byte, manifest Manifest) error {
	if c.store == nil {
		return errors.New("builtin catalog persistence is required")
	}
	if err := c.store.SaveBuiltinCatalog(ctx, raw, manifest); err != nil {
		return err
	}
	c.mu.Lock()
	c.state = CatalogState{Status: "unavailable", Manifest: manifest}
	c.mu.Unlock()
	_, history, err := c.store.LoadBuiltinCatalog(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state = catalogState(manifest, raw)
	c.history = history
	return nil
}

func (c *Catalog) Refresh(ctx context.Context) error {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()
	manifest := Manifest{SchemaVersion: 2, Plugins: builtinPlugins()}
	for index := range manifest.Plugins {
		plugin, err := c.resolveRelease(ctx, manifest.Plugins[index])
		if err != nil {
			return err
		}
		manifest.Plugins[index] = plugin
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	return c.accept(ctx, raw, manifest)
}

func (c *Catalog) State() CatalogState {
	if c == nil {
		return CatalogState{Status: "unavailable"}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	raw, _ := json.Marshal(c.state.Manifest)
	var manifest Manifest
	_ = json.Unmarshal(raw, &manifest)
	return CatalogState{Status: c.state.Status, Revision: c.state.Revision, Manifest: manifest}
}

func catalogState(manifest Manifest, raw []byte) CatalogState {
	sum := sha256.Sum256(raw)
	return CatalogState{Status: "ready", Revision: hex.EncodeToString(sum[:]), Manifest: manifest}
}

func decodeSnapshot(raw []byte) (Manifest, error) {
	var manifest Manifest
	if len(raw) > MaxManifestBytes {
		return manifest, errors.New("builtin snapshot is too large")
	}
	if err := decodeStrict(raw, &manifest); err != nil {
		return manifest, err
	}
	if manifest.SchemaVersion != 2 || len(manifest.Plugins) == 0 {
		return manifest, errors.New("invalid builtin snapshot")
	}
	seen := map[string]bool{}
	for _, plugin := range manifest.Plugins {
		if seen[plugin.ID] {
			return manifest, errors.New("duplicate builtin id")
		}
		seen[plugin.ID] = true
		if err := validateReleasePlugin(plugin); err != nil {
			return manifest, err
		}
	}
	return manifest, nil
}

func (c *Catalog) resolveRelease(ctx context.Context, plugin Plugin) (Plugin, error) {
	repository := strings.TrimPrefix(plugin.Repository, "https://github.com/")
	address := "https://api.github.com/repos/" + repository + "/releases/latest"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return plugin, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "oh-my-cpa-builtin-plugins")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := c.client.Do(request)
	if err != nil {
		return plugin, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return plugin, fmt.Errorf("builtin release HTTP %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, MaxManifestBytes+1))
	if err != nil {
		return plugin, err
	}
	if len(raw) > MaxManifestBytes {
		return plugin, errors.New("builtin release response is too large")
	}
	var release struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
		Assets     []struct {
			Name   string `json:"name"`
			State  string `json:"state"`
			Digest string `json:"digest"`
			Size   int64  `json:"size"`
			URL    string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(raw, &release); err != nil {
		return plugin, err
	}
	version := strings.TrimPrefix(release.Tag, "v")
	if release.Draft || release.Prerelease || !stableVersionPattern.MatchString(version) {
		return plugin, errors.New("builtin release is not a stable version")
	}
	plugin.Version = version
	plugin.Install = Install{Type: "direct"}
	// Require the complete supported set so a partially uploaded release cannot
	// silently remove another installation's platform from the local snapshot.
	for _, platform := range []string{"darwin/amd64", "darwin/arm64", "linux/amd64", "linux/arm64", "windows/amd64", "windows/arm64"} {
		parts := strings.Split(platform, "/")
		name := plugin.ID + "_" + version + "_" + parts[0] + "_" + parts[1] + ".zip"
		expectedURL := plugin.Repository + "/releases/download/" + release.Tag + "/" + name
		found := false
		for _, asset := range release.Assets {
			if asset.Name != name {
				continue
			}
			digest := strings.TrimPrefix(asset.Digest, "sha256:")
			if found || asset.State != "uploaded" || !strings.HasPrefix(asset.Digest, "sha256:") || !digestPattern.MatchString(digest) || asset.Size <= 0 || asset.Size > 256<<20 || asset.URL != expectedURL {
				return plugin, errors.New("invalid builtin release asset")
			}
			found = true
			plugin.Install.Artifacts = append(plugin.Install.Artifacts, Artifact{GOOS: parts[0], GOARCH: parts[1], URL: expectedURL, SHA256: digest, Size: asset.Size})
		}
		if !found {
			return plugin, errors.New("builtin release is missing a supported platform")
		}
	}
	if err := validateReleasePlugin(plugin); err != nil {
		return plugin, err
	}
	return plugin, nil
}

func decodeStrict(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode plugin document: %w", err)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("trailing plugin document data")
	}
	return nil
}
func validateReleasePlugin(plugin Plugin) error {
	known := false
	for _, builtin := range builtinPlugins() {
		known = known || (builtin.ID == plugin.ID && builtin.Repository == plugin.Repository)
	}
	if !known {
		return errors.New("plugin publisher is not in the builtin allowlist")
	}
	if !idPattern.MatchString(plugin.ID) || !versionPattern.MatchString(plugin.Version) || strings.TrimSpace(plugin.Name) == "" || strings.TrimSpace(plugin.Author) == "" || !IsPlainText(plugin.Description, 8192) {
		return errors.New("invalid builtin plugin identity")
	}
	if err := ValidateDescriptions(plugin.DescriptionI18n); err != nil {
		return err
	}
	if plugin.Repository != "" && !IsGitHubRepository(plugin.Repository) {
		return errors.New("invalid plugin repository")
	}
	if err := validateInstall(plugin.Install); err != nil {
		return err
	}
	seen := map[string]bool{plugin.Version: true}
	for _, version := range plugin.Versions {
		if !versionPattern.MatchString(version.Version) || seen[version.Version] {
			return errors.New("invalid builtin plugin version")
		}
		seen[version.Version] = true
		if err := validateInstall(version.Install); err != nil {
			return err
		}
	}
	return nil
}
func validateInstall(install Install) error {
	if install.Type != "direct" || len(install.Artifacts) == 0 || len(install.Artifacts) > 16 {
		return errors.New("builtin releases require direct artifacts")
	}
	seen := map[string]bool{}
	for _, artifact := range install.Artifacts {
		platform := artifact.GOOS + "/" + artifact.GOARCH
		address, err := url.Parse(artifact.URL)
		if err != nil || address.Scheme != "https" || address.Host == "" || address.User != nil || address.Fragment != "" || address.RawQuery != "" || address.ForceQuery || address.Opaque != "" || !digestPattern.MatchString(artifact.SHA256) || artifact.Size < 0 || !idPattern.MatchString(artifact.GOOS) || !idPattern.MatchString(artifact.GOARCH) || seen[platform] {
			return errors.New("invalid immutable plugin artifact")
		}
		seen[platform] = true
	}
	return nil
}
func ValidateDescriptions(descriptions Descriptions) error {
	for locale, value := range descriptions {
		if locale != "zh" && locale != "en" && locale != "zh-Hant" && locale != "ms" {
			return errors.New("unsupported plugin description locale")
		}
		if !IsPlainText(value, 8192) {
			return errors.New("plugin description must be bounded plain text")
		}
	}
	return nil
}
func IsPlainText(value string, limit int) bool {
	if len(value) > limit || strings.ContainsAny(value, "<>\x00") {
		return false
	}
	for _, r := range value {
		if r < 32 && r != '\n' && r != '\r' && r != '\t' {
			return false
		}
	}
	return true
}
func IsGitHubRepository(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	return len(parts) == 2 && idPattern.MatchString(parts[0]) && idPattern.MatchString(parts[1])
}
func (c *Catalog) Registry(pluginID, version string) ([]byte, error) {
	if c == nil {
		return nil, ErrFrozen
	}
	c.mu.RLock()
	state := c.state
	history := append([]Plugin(nil), c.history...)
	c.mu.RUnlock()
	if state.Status != "ready" {
		return nil, ErrFrozen
	}
	plugins := []Plugin{}
	for _, plugin := range state.Manifest.Plugins {
		plugin.Versions = append([]Version(nil), plugin.Versions...)
		if pluginID != "" && plugin.ID != pluginID {
			continue
		}
		seen := map[string]bool{plugin.Version: true}
		for _, candidate := range plugin.Versions {
			seen[candidate.Version] = true
		}
		for _, old := range history {
			if old.ID != plugin.ID || seen[old.Version] {
				continue
			}
			plugin.Versions = append(plugin.Versions, Version{Version: old.Version, Install: old.Install})
			seen[old.Version] = true
		}
		if version != "" && version != plugin.Version {
			found := false
			for _, candidate := range plugin.Versions {
				if candidate.Version == version {
					plugin.Version = candidate.Version
					plugin.Install = candidate.Install
					found = true
					break
				}
			}
			if !found {
				continue
			}
			plugin.Versions = nil
		}
		sort.Slice(plugin.Versions, func(i, j int) bool { return plugin.Versions[i].Version < plugin.Versions[j].Version })
		plugins = append(plugins, plugin)
	}
	if pluginID != "" && len(plugins) == 0 {
		return nil, errors.New("builtin plugin version not found")
	}
	return json.Marshal(struct {
		SchemaVersion int      `json:"schema_version"`
		Plugins       []Plugin `json:"plugins"`
	}{2, plugins})
}
func ArtifactIdentity(artifact Artifact) string {
	sum := sha256.Sum256([]byte(artifact.URL + "\n" + artifact.SHA256 + fmt.Sprint("\n", artifact.Size)))
	return hex.EncodeToString(sum[:])
}

// CompareVersions refuses unknown version ordering rather than risking a downgrade.
func CompareVersions(left, right string) (int, bool) {
	parse := func(value string) ([]int, bool) {
		if strings.ContainsAny(value, "-+") {
			return nil, false
		}
		var numbers []int
		for _, part := range strings.Split(value, ".") {
			var n int
			if part == "" {
				return nil, false
			}
			for _, r := range part {
				if r < '0' || r > '9' {
					return nil, false
				}
				n = n*10 + int(r-'0')
				if n > 100000000 {
					return nil, false
				}
			}
			numbers = append(numbers, n)
		}
		return numbers, true
	}
	a, ok := parse(left)
	if !ok {
		return 0, false
	}
	b, ok := parse(right)
	if !ok {
		return 0, false
	}
	for i := 0; i < len(a) || i < len(b); i++ {
		x, y := 0, 0
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x < y {
			return -1, true
		}
		if x > y {
			return 1, true
		}
	}
	return 0, true
}
