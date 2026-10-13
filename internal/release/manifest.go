package release

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Names of the signed release manifest's two attachments.
const (
	ManifestAssetName  = "release-manifest.json"
	SignatureAssetName = "release-manifest.json.sig"
)

// GitHubDownloadHost serves release attachments, and answers with a redirect to one of
// assetRedirectHosts.
const GitHubDownloadHost = "github.com"

// maxManifestBytes bounds an attachment read; a manifest is a few hundred bytes.
const maxManifestBytes = 64 << 10

// assetRedirectHosts are where GitHub stores release attachments. The list is closed
// for the reason restrictRedirects exists: a redirect must not be able to send this
// process to a host nobody named. It is not what makes a manifest trustworthy - the
// signature the updater verifies is - so a host missing here costs availability, never
// integrity.
var assetRedirectHosts = map[string]bool{
	"objects.githubusercontent.com":        true,
	"release-assets.githubusercontent.com": true,
}

// ErrManifestMissing means a release carries no signed manifest: it predates console
// updates, or its publication did not finish.
var ErrManifestMissing = errors.New("the release has no signed manifest")

// ManifestClient downloads a release's signed manifest.
type ManifestClient struct {
	httpClient *http.Client
	baseURL    string
}

// NewManifestClient returns a client for GitHub's release downloads.
func NewManifestClient() *ManifestClient {
	return &ManifestClient{httpClient: &http.Client{Timeout: requestTimeout, CheckRedirect: restrictAssetRedirects}}
}

// NewManifestClientWithTransport returns a client using the supplied transport and base
// URL. It exists for tests; the production host constant is not reached through it.
func NewManifestClientWithTransport(transport http.RoundTripper, baseURL string) *ManifestClient {
	return &ManifestClient{httpClient: &http.Client{Timeout: requestTimeout, Transport: transport, CheckRedirect: restrictAssetRedirects}, baseURL: baseURL}
}

func restrictAssetRedirects(request *http.Request, via []*http.Request) error {
	if len(via) >= 3 {
		return errors.New("release download redirected too many times")
	}
	if request.URL.Scheme != "https" || !assetRedirectHosts[request.URL.Hostname()] {
		return fmt.Errorf("release download redirected to %s, which is not a release asset host", request.URL.Host)
	}
	return nil
}

// FetchManifest returns the exact bytes of a release's manifest and its signature. The
// bytes are passed on untouched: the signature covers them as published, and this
// process is not the one that decides whether to trust them.
func (c *ManifestClient) FetchManifest(ctx context.Context, repository, tag string) ([]byte, string, error) {
	if err := ValidateRepository(repository); err != nil {
		return nil, "", err
	}
	if _, err := ParseVersion(tag); err != nil {
		return nil, "", fmt.Errorf("release tag is not a release version: %w", err)
	}
	manifest, err := c.fetchAsset(ctx, repository, tag, ManifestAssetName)
	if err != nil {
		return nil, "", err
	}
	signature, err := c.fetchAsset(ctx, repository, tag, SignatureAssetName)
	if err != nil {
		return nil, "", err
	}
	return manifest, strings.TrimSpace(string(signature)), nil
}

func (c *ManifestClient) fetchAsset(ctx context.Context, repository, tag, name string) ([]byte, error) {
	base := c.baseURL
	if base == "" {
		base = "https://" + GitHubDownloadHost
	}
	target := base + "/" + repository + "/releases/download/" + url.PathEscape(strings.TrimSpace(tag)) + "/" + name
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, fmt.Errorf("build release download: %w", err)
	}
	request.Header.Set("User-Agent", userAgent)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", name, err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, ErrManifestMissing
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: status %d", name, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxManifestBytes+1))
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", name, err)
	}
	if len(body) > maxManifestBytes {
		return nil, fmt.Errorf("%s exceeds the size limit", name)
	}
	return body, nil
}
