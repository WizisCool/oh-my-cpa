package updater

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
)

// ParseImagePullProxy accepts the HTTP and SOCKS5 routes supported by CPA's network configuration.
func ParseImagePullProxy(raw string) (*url.URL, error) {
	proxy, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || proxy.Hostname() == "" {
		return nil, errors.New("a valid HTTP or SOCKS5 proxy is required for image downloads")
	}

	// Query strings and paths have no meaning to a forward proxy and may contain credentials.
	switch proxy.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return nil, errors.New("the image download proxy must use HTTP, HTTPS, SOCKS5 or SOCKS5H")
	}

	if (proxy.Path != "" && proxy.Path != "/") ||
		proxy.RawQuery != "" ||
		proxy.Fragment != "" {
		return nil, errors.New("the image download proxy must contain only its address and optional authentication")
	}

	return proxy, nil
}

// PullImageThroughProxy downloads a verified image and imports it into the local daemon by image ID.
func (e *Engine) PullImageThroughProxy(ctx context.Context, reference, proxyURL string) (string, error) {
	proxy, err := ParseImagePullProxy(proxyURL)
	if err != nil {
		return "", err
	}

	// Select the daemon's platform, which can differ from the updater process's own platform.
	var platform struct {
		OS   string `json:"Os"`
		Arch string `json:"Arch"`
	}
	if err := e.call(ctx, http.MethodGet, "/version", nil, nil, &platform); err != nil {
		return "", fmt.Errorf("read the Docker platform: %w", err)
	}

	if platform.OS == "" || platform.Arch == "" {
		return "", errors.New("the Docker daemon did not report its operating system and architecture")
	}

	ref, err := name.ParseReference(reference)
	if err != nil {
		return "", fmt.Errorf("parse the image reference: %w", err)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// This explicit transport also covers registry authentication and redirected layer downloads.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = http.ProxyURL(proxy)
	defer transport.CloseIdleConnections()

	descriptor, err := remote.Get(ref,
		remote.WithContext(ctx),
		remote.WithTransport(transport),
		remote.WithPlatform(v1.Platform{OS: platform.OS, Architecture: platform.Arch}),
	)
	if err != nil {
		return "", fmt.Errorf("download the image manifest: %w", err)
	}

	// A signed OMC release names the index digest; check it before selecting its platform image.
	if pinned, ok := ref.(name.Digest); ok && descriptor.Digest.String() != pinned.DigestStr() {
		return "", errors.New("the downloaded image manifest does not match the requested digest")
	}

	image, err := descriptor.Image()
	if err != nil {
		return "", fmt.Errorf("select the image platform: %w", err)
	}

	config, err := image.ConfigFile()
	if err != nil {
		return "", fmt.Errorf("verify the image configuration: %w", err)
	}

	if config.OS != platform.OS || config.Architecture != platform.Arch {
		return "", errors.New("the downloaded image does not match the Docker daemon's platform")
	}

	imageID, err := image.ConfigName()
	if err != nil {
		return "", fmt.Errorf("read the image identity: %w", err)
	}

	// Stream to the daemon without buffering the image in memory or requiring a writable filesystem.
	reader, writer := io.Pipe()
	finished := make(chan error, 1)
	go func() {
		err := tarball.Write(nil, image, writer)
		_ = writer.CloseWithError(err)
		finished <- err
	}()

	loadErr := e.loadImageArchive(ctx, reader)
	cancel()
	_ = reader.CloseWithError(loadErr)
	downloadErr := <-finished
	if loadErr != nil {
		return "", fmt.Errorf("import the proxy-downloaded image: %w", loadErr)
	}

	if downloadErr != nil {
		return "", fmt.Errorf("download the image layers: %w", downloadErr)
	}

	return imageID.String(), nil
}

// loadImageArchive checks the entire progress stream because Docker can report failures after HTTP 200.
func (e *Engine) loadImageArchive(ctx context.Context, archive io.Reader) error {
	response, err := e.do(ctx, http.MethodPost, "/images/load", nil, archive)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	// A layer can already be imported when a later layer fails; no container is replaced until EOF.
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for scanner.Scan() {
		var progress struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &progress); err != nil {
			return fmt.Errorf("read the image import result: %w", err)
		}

		if progress.Error != "" {
			return errors.New(progress.Error)
		}
	}

	return scanner.Err()
}
