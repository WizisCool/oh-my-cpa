// Package updater replaces the containers of an Oh My CPA deployment with newer images.
//
// It runs as a sidecar (`oh-my-cpa updater serve`) because it needs the Docker socket,
// which is equivalent to root on the host. Keeping that authority in a process with a
// two-verb control interface lets the console itself stay read-only, unprivileged and
// without any path to the daemon (ADR 0099).
package updater

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DEFAULT_SOCKET_PATH is where the daemon socket is mounted inside the sidecar.
const DEFAULT_SOCKET_PATH = "/var/run/docker.sock"

// MAX_API_VERSION is the newest Engine API this package was written against. Every
// daemon that is still supported serves it, so pinning it keeps inspect and create
// payloads in the shape the recreation logic expects; an older daemon is spoken to in
// its own newest version instead.
const MAX_API_VERSION = "1.44"

// ErrNotFound is returned when the daemon reports that a container, image or network
// does not exist.
var ErrNotFound = errors.New("not found")

// Engine is the part of the Docker Engine API the updater uses.
type Engine struct {
	httpClient *http.Client
	apiVersion string
}

// NewEngine connects to the daemon listening on a unix socket and negotiates the API
// version.
func NewEngine(ctx context.Context, socketPath string) (*Engine, error) {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	engine := &Engine{httpClient: &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socketPath)
		},
	}}}
	if err := engine.negotiate(ctx); err != nil {
		return nil, err
	}
	return engine, nil
}

func (e *Engine) negotiate(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/_ping", nil)
	if err != nil {
		return err
	}
	response, err := e.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("reach the Docker daemon: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("reach the Docker daemon: status %d", response.StatusCode)
	}
	e.apiVersion = olderAPIVersion(response.Header.Get("API-Version"), MAX_API_VERSION)
	return nil
}

// olderAPIVersion returns the lower of two "major.minor" API versions; an unreadable
// daemon version yields the fallback.
func olderAPIVersion(daemon, fallback string) string {
	parse := func(raw string) (int, int, bool) {
		major, minor, found := strings.Cut(strings.TrimSpace(raw), ".")
		if !found {
			return 0, 0, false
		}
		majorNumber, majorErr := strconv.Atoi(major)
		minorNumber, minorErr := strconv.Atoi(minor)
		return majorNumber, minorNumber, majorErr == nil && minorErr == nil
	}
	daemonMajor, daemonMinor, ok := parse(daemon)
	if !ok {
		return fallback
	}
	fallbackMajor, fallbackMinor, _ := parse(fallback)
	if daemonMajor < fallbackMajor || (daemonMajor == fallbackMajor && daemonMinor < fallbackMinor) {
		return strings.TrimSpace(daemon)
	}
	return fallback
}

func (e *Engine) do(ctx context.Context, method, path string, query url.Values, body any) (*http.Response, error) {
	target := "http://docker/v" + e.apiVersion + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := e.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 400 {
		defer response.Body.Close()
		var failure struct {
			Message string `json:"message"`
		}
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		_ = json.Unmarshal(raw, &failure)
		message := strings.TrimSpace(failure.Message)
		if message == "" {
			message = fmt.Sprintf("status %d", response.StatusCode)
		}
		if response.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("%s %s: %s: %w", method, path, message, ErrNotFound)
		}
		return nil, fmt.Errorf("%s %s: %s", method, path, message)
	}
	return response, nil
}

func (e *Engine) call(ctx context.Context, method, path string, query url.Values, body, into any) error {
	response, err := e.do(ctx, method, path, query, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if into == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	return json.NewDecoder(response.Body).Decode(into)
}

// ContainerSummary is one row of the container list.
type ContainerSummary struct {
	ID    string   `json:"Id"`
	Names []string `json:"Names"`
	State string   `json:"State"`
}

// Container is an inspected container. Config and HostConfig stay as decoded JSON so
// that a setting this package has never heard of is carried into the replacement
// instead of being dropped by a typed round trip.
type Container struct {
	ID           string         `json:"Id"`
	Name         string         `json:"Name"`
	ImageID      string         `json:"Image"`
	RestartCount int            `json:"RestartCount"`
	Config       map[string]any `json:"Config"`
	HostConfig   map[string]any `json:"HostConfig"`
	State        struct {
		Running bool `json:"Running"`
		Health  *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
	} `json:"Mounts"`
	NetworkSettings struct {
		Networks map[string]map[string]any `json:"Networks"`
	} `json:"NetworkSettings"`
}

// ContainerName is the name without the leading slash the daemon reports it with.
func (c Container) ContainerName() string { return strings.TrimPrefix(c.Name, "/") }

// ImageReference is the image as the container was configured, for example
// "wiziscool/oh-my-cpa:latest".
func (c Container) ImageReference() string { return stringField(c.Config, "Image") }

// Label returns one container label.
func (c Container) Label(name string) string {
	labels, _ := c.Config["Labels"].(map[string]any)
	value, _ := labels[name].(string)
	return value
}

// Env returns one environment variable of the container's configuration.
func (c Container) Env(name string) string {
	entries, _ := c.Config["Env"].([]any)
	for _, entry := range entries {
		text, _ := entry.(string)
		if key, value, found := strings.Cut(text, "="); found && key == name {
			return value
		}
	}
	return ""
}

// Command returns the container's configured command.
func (c Container) Command() []string { return stringList(c.Config["Cmd"]) }

// Image is an inspected image.
type Image struct {
	ID     string         `json:"Id"`
	Config map[string]any `json:"Config"`
}

// Version is the release the image was built as, from its OCI label.
func (i Image) Version() string {
	labels, _ := i.Config["Labels"].(map[string]any)
	value, _ := labels["org.opencontainers.image.version"].(string)
	return value
}

func stringField(fields map[string]any, name string) string {
	value, _ := fields[name].(string)
	return value
}

func stringList(value any) []string {
	entries, _ := value.([]any)
	list := make([]string, 0, len(entries))
	for _, entry := range entries {
		if text, ok := entry.(string); ok {
			list = append(list, text)
		}
	}
	return list
}

// ListContainers lists containers, including stopped ones.
func (e *Engine) ListContainers(ctx context.Context) ([]ContainerSummary, error) {
	var containers []ContainerSummary
	err := e.call(ctx, http.MethodGet, "/containers/json", url.Values{"all": {"1"}}, nil, &containers)
	return containers, err
}

// InspectContainer reads one container by name or ID.
func (e *Engine) InspectContainer(ctx context.Context, nameOrID string) (Container, error) {
	var container Container
	err := e.call(ctx, http.MethodGet, "/containers/"+url.PathEscape(nameOrID)+"/json", nil, nil, &container)
	return container, err
}

// InspectImage reads one image by reference or ID.
func (e *Engine) InspectImage(ctx context.Context, reference string) (Image, error) {
	var image Image
	err := e.call(ctx, http.MethodGet, "/images/"+reference+"/json", nil, nil, &image)
	return image, err
}

// PullImage pulls a reference such as "repo:tag" or "repo@sha256:...".
//
// The daemon answers 200 before the pull has happened and reports a failure inside the
// progress stream, so the stream is read to its end and scanned for an error.
func (e *Engine) PullImage(ctx context.Context, reference string) error {
	response, err := e.do(ctx, http.MethodPost, "/images/create", url.Values{"fromImage": {reference}}, nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for scanner.Scan() {
		var progress struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &progress) == nil && progress.Error != "" {
			return fmt.Errorf("pull %s: %s", reference, progress.Error)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("pull %s: %w", reference, err)
	}
	return nil
}

// TagImage gives an image another repository and tag.
func (e *Engine) TagImage(ctx context.Context, source, repository, tag string) error {
	return e.call(ctx, http.MethodPost, "/images/"+source+"/tag", url.Values{"repo": {repository}, "tag": {tag}}, nil, nil)
}

// CreateContainer creates a container from a create payload and returns its ID.
func (e *Engine) CreateContainer(ctx context.Context, name string, payload map[string]any) (string, error) {
	var created struct {
		ID string `json:"Id"`
	}
	err := e.call(ctx, http.MethodPost, "/containers/create", url.Values{"name": {name}}, payload, &created)
	return created.ID, err
}

// StartContainer starts a created or stopped container.
func (e *Engine) StartContainer(ctx context.Context, nameOrID string) error {
	return e.call(ctx, http.MethodPost, "/containers/"+url.PathEscape(nameOrID)+"/start", nil, nil, nil)
}

// StopContainer stops a container, giving it the grace period before it is killed.
func (e *Engine) StopContainer(ctx context.Context, nameOrID string, grace time.Duration) error {
	query := url.Values{"t": {strconv.Itoa(int(grace.Seconds()))}}
	return e.call(ctx, http.MethodPost, "/containers/"+url.PathEscape(nameOrID)+"/stop", query, nil, nil)
}

// RenameContainer renames a container.
func (e *Engine) RenameContainer(ctx context.Context, nameOrID, name string) error {
	return e.call(ctx, http.MethodPost, "/containers/"+url.PathEscape(nameOrID)+"/rename", url.Values{"name": {name}}, nil, nil)
}

// RemoveContainer force-removes a container. Its volumes are kept: an anonymous volume
// is carried into the replacement by name, and deleting it here would delete the data
// the replacement is about to open.
func (e *Engine) RemoveContainer(ctx context.Context, nameOrID string) error {
	err := e.call(ctx, http.MethodDelete, "/containers/"+url.PathEscape(nameOrID), url.Values{"force": {"1"}}, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// EnsureNetwork creates a bridge network unless one with that name exists.
func (e *Engine) EnsureNetwork(ctx context.Context, name string) error {
	err := e.call(ctx, http.MethodGet, "/networks/"+url.PathEscape(name), nil, nil, nil)
	if err == nil || !errors.Is(err, ErrNotFound) {
		return err
	}
	return e.call(ctx, http.MethodPost, "/networks/create", nil, map[string]any{"Name": name, "Driver": "bridge"}, nil)
}

// ConnectNetwork attaches a container to a network with the given endpoint settings.
func (e *Engine) ConnectNetwork(ctx context.Context, network, container string, endpoint map[string]any) error {
	payload := map[string]any{"Container": container}
	if len(endpoint) > 0 {
		payload["EndpointConfig"] = endpoint
	}
	return e.call(ctx, http.MethodPost, "/networks/"+url.PathEscape(network)+"/connect", nil, payload, nil)
}

// WatchContainerStarts calls onStart with the container ID each time a container
// starts, until the context ends or the event stream breaks.
func (e *Engine) WatchContainerStarts(ctx context.Context, onStart func(containerID string)) error {
	filters, _ := json.Marshal(map[string][]string{"type": {"container"}, "event": {"start"}})
	response, err := e.do(ctx, http.MethodGet, "/events", url.Values{"filters": {string(filters)}}, nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	decoder := json.NewDecoder(response.Body)
	for {
		var event struct {
			Actor struct {
				ID string `json:"ID"`
			} `json:"Actor"`
		}
		if err := decoder.Decode(&event); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		onStart(event.Actor.ID)
	}
}
