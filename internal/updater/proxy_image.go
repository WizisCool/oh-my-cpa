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
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
)

// proxyImageTimeout bounds a stalled registry or proxy while allowing large image downloads.
const proxyImageTimeout = 30 * time.Minute

// DirectImageRoute is CPA's own spelling for an outbound route that bypasses the
// configured proxy; the updater accepts it wherever a proxy URL would go.
const DirectImageRoute = "direct"

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
	return e.pullImageWithRoute(ctx, reference, proxy)
}

// PullImageDirect downloads an image without inheriting the daemon's proxy configuration.
func (e *Engine) PullImageDirect(ctx context.Context, reference string) (string, error) {
	return e.pullImageWithRoute(ctx, reference, nil)
}

func (e *Engine) pullImageWithRoute(ctx context.Context, reference string, proxy *url.URL) (string, error) {
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

	ctx, cancel := context.WithTimeout(ctx, proxyImageTimeout)
	defer cancel()

	// This explicit transport also covers registry authentication and redirected layer downloads.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	if proxy != nil {
		transport.Proxy = http.ProxyURL(proxy)
	}
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

	// Stream to the daemon without buffering the image in memory or requiring a writable filesystem.
	reader, writer := io.Pipe()
	finished := make(chan error, 1)
	go func() {
		err := tarball.Write(nil, image, writer)
		_ = writer.CloseWithError(err)
		finished <- err
	}()

	imageID, loadErr := e.loadImageArchive(ctx, reader)
	cancel()
	_ = reader.CloseWithError(loadErr)
	downloadErr := <-finished
	if loadErr != nil {
		return "", fmt.Errorf("import the proxy-downloaded image: %w", loadErr)
	}

	if downloadErr != nil {
		return "", fmt.Errorf("download the image layers: %w", downloadErr)
	}

	return imageID, nil
}

// loadImageArchive returns Docker's image identity after checking the complete import progress stream.
func (e *Engine) loadImageArchive(ctx context.Context, archive io.Reader) (string, error) {
	response, err := e.do(ctx, http.MethodPost, "/images/load", nil, archive)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	// A layer can already be imported when a later layer fails; no container is replaced until EOF.
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	imageID := ""

	for scanner.Scan() {
		var progress struct {
			Error  string `json:"error"`
			Stream string `json:"stream"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &progress); err != nil {
			return "", fmt.Errorf("read the image import result: %w", err)
		}

		if progress.Error != "" {
			return "", errors.New(progress.Error)
		}

		// Classic and containerd stores report different IDs; use the daemon's identifier for tagging and inspection.
		for line := range strings.SplitSeq(progress.Stream, "\n") {
			if reported, ok := strings.CutPrefix(strings.TrimSpace(line), "Loaded image ID: "); ok {
				id, err := v1.NewHash(strings.TrimSpace(reported))
				if err != nil {
					return "", errors.New("the Docker daemon reported an invalid loaded image ID")
				}

				imageID = id.String()
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return "", err
	}

	if imageID == "" {
		return "", errors.New("the Docker daemon did not report the loaded image ID")
	}

	return imageID, nil
}
