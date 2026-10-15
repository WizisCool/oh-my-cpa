package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeDaemon is an in-memory Docker Engine speaking the endpoints the updater uses,
// over a real unix socket, so the tests exercise the production client and wire
// format rather than a mock of it.
type fakeDaemon struct {
	mu         sync.Mutex
	containers map[string]*fakeContainer
	// images is what the daemon holds locally, by reference and by ID.
	images map[string]fakeImage
	// registry is what a pull can fetch.
	registry map[string]fakeImage
	networks map[string]bool
	// crashing lists image IDs whose containers exit right after starting.
	crashing map[string]bool
	sequence int
}

type fakeImage struct {
	ID     string
	Config map[string]any
}

type fakeContainer struct {
	ID         string
	Name       string
	ImageID    string
	Config     map[string]any
	HostConfig map[string]any
	Networks   map[string]map[string]any
	Mounts     []map[string]any
	IsRunning  bool
	// Health is the health check status the daemon reports; empty means no check.
	Health string
}

// unixSocketPathLimit is the cap Windows puts on an AF_UNIX path: 107 characters bind and 108
// does not (measured). Every name chosen below leaves a wide margin under it.
const unixSocketPathLimit = 107

// shortSocketPath makes a directory whose docker.sock stays under the cap, and returns the
// socket path inside it.
//
// The OS temp root is tried first and a directory at the root of the system drive second,
// because a deep TEMP is the one thing this test cannot work under: it would then fail on the
// length of a path nobody in the test chose. A machine where neither root is short enough skips
// the test, which states the limit rather than reporting a bind failure as a defect.
func shortSocketPath(t *testing.T) string {
	t.Helper()
	bases := []string{os.TempDir()}
	if drive := os.Getenv("SystemDrive"); drive != "" {
		bases = append(bases, drive+"\\")
	}
	for _, base := range bases {
		dir, err := os.MkdirTemp(base, "omc-")
		if err != nil {
			continue
		}
		path := filepath.Join(dir, "docker.sock")
		if len(path) > unixSocketPathLimit {
			_ = os.RemoveAll(dir)
			continue
		}
		t.Cleanup(func() { _ = os.RemoveAll(dir) })
		return path
	}
	t.Skipf("no temp root short enough for a unix socket (the limit is %d characters)", unixSocketPathLimit)
	return ""
}

func newFakeDaemon(t *testing.T) (*fakeDaemon, *Engine) {
	t.Helper()
	daemon := &fakeDaemon{
		containers: map[string]*fakeContainer{},
		images:     map[string]fakeImage{},
		registry:   map[string]fakeImage{},
		networks:   map[string]bool{},
		crashing:   map[string]bool{},
	}
	// A unix-socket path is capped at 107 characters on Windows, and t.TempDir() nests the test
	// name under the OS temp root, which on a machine with a deep TEMP overruns the cap on its
	// own. A directory of our own, chosen by the length of the path it yields, keeps the fake
	// daemon listening everywhere.
	socketPath := shortSocketPath(t)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &http.Server{Handler: daemon}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	engine, err := NewEngine(context.Background(), socketPath)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	return daemon, engine
}

func imageConfig(version string, environment ...string) map[string]any {
	entries := make([]any, 0, len(environment))
	for _, entry := range environment {
		entries = append(entries, entry)
	}
	return map[string]any{
		"Env":        entries,
		"Entrypoint": []any{"/usr/local/bin/app"},
		"Labels":     map[string]any{"org.opencontainers.image.version": version},
	}
}

// addImage makes an image available locally under a reference.
func (d *fakeDaemon) addImage(reference, id, version string, environment ...string) {
	image := fakeImage{ID: id, Config: imageConfig(version, environment...)}
	d.images[reference] = image
	d.images[id] = image
}

// publish makes an image pullable without it being present locally.
func (d *fakeDaemon) publish(reference, id, version string, environment ...string) {
	d.registry[reference] = fakeImage{ID: id, Config: imageConfig(version, environment...)}
}

type containerSpec struct {
	name        string
	image       string
	environment []string
	command     []string
	labels      map[string]string
	networks    map[string][]string
}

// addContainer creates a running container the way the daemon reports one: with the
// image's defaults merged into its configuration.
func (d *fakeDaemon) addContainer(spec containerSpec) *fakeContainer {
	config := map[string]any{"Image": spec.image}
	if len(spec.environment) > 0 {
		config["Env"] = toAny(spec.environment)
	}
	if len(spec.command) > 0 {
		config["Cmd"] = toAny(spec.command)
	}
	labels := map[string]any{}
	for key, value := range spec.labels {
		labels[key] = value
	}
	config["Labels"] = labels
	hostConfig := map[string]any{"NetworkMode": "bridge", "RestartPolicy": map[string]any{"Name": "unless-stopped"}}
	networks := map[string]map[string]any{}
	for network, aliases := range spec.networks {
		networks[network] = map[string]any{"Aliases": toAny(aliases), "IPAddress": "172.18.0.9"}
		hostConfig["NetworkMode"] = network
	}
	container := d.create(spec.name, config, hostConfig, networks)
	container.IsRunning = true
	return container
}

func toAny(values []string) []any {
	list := make([]any, 0, len(values))
	for _, value := range values {
		list = append(list, value)
	}
	return list
}

func (d *fakeDaemon) create(name string, config, hostConfig map[string]any, networks map[string]map[string]any) *fakeContainer {
	d.sequence++
	image := d.images[stringField(config, "Image")]
	merged := map[string]any{}
	for key, value := range image.Config {
		merged[key] = value
	}
	for key, value := range config {
		switch key {
		case "Env":
			merged[key] = append(append([]any{}, value.([]any)...), image.Config["Env"].([]any)...)
		case "Labels":
			labels := map[string]any{}
			for label, labelValue := range image.Config["Labels"].(map[string]any) {
				labels[label] = labelValue
			}
			for label, labelValue := range value.(map[string]any) {
				labels[label] = labelValue
			}
			merged[key] = labels
		default:
			merged[key] = value
		}
	}
	container := &fakeContainer{
		ID:         fmt.Sprintf("%064d", d.sequence),
		Name:       name,
		ImageID:    image.ID,
		Config:     merged,
		HostConfig: hostConfig,
		Networks:   networks,
	}
	d.containers[container.ID] = container
	return container
}

func (d *fakeDaemon) find(nameOrID string) *fakeContainer {
	for _, container := range d.containers {
		if container.Name == nameOrID || strings.HasPrefix(container.ID, nameOrID) {
			return container
		}
	}
	return nil
}

// named returns the container currently holding a name, for assertions.
func (d *fakeDaemon) named(name string) *fakeContainer {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.find(name)
}

func (d *fakeDaemon) inspection(container *fakeContainer) map[string]any {
	state := map[string]any{"Running": container.IsRunning}
	if container.Health != "" {
		state["Health"] = map[string]any{"Status": container.Health}
	}
	return map[string]any{
		"Id":              container.ID,
		"Name":            "/" + container.Name,
		"Image":           container.ImageID,
		"Config":          container.Config,
		"HostConfig":      container.HostConfig,
		"State":           state,
		"Mounts":          container.Mounts,
		"NetworkSettings": map[string]any{"Networks": container.Networks},
	}
}

func (d *fakeDaemon) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path == "/_ping" {
		writer.Header().Set("API-Version", "1.52")
		return
	}
	path := strings.TrimPrefix(request.URL.Path, "/v"+MAX_API_VERSION)
	if path == "/events" {
		writer.WriteHeader(http.StatusOK)
		writer.(http.Flusher).Flush()
		select {
		case <-request.Context().Done():
		case <-time.After(time.Minute):
		}
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	reply := func(status int, payload any) {
		writer.WriteHeader(status)
		_ = json.NewEncoder(writer).Encode(payload)
	}
	missing := func() { reply(http.StatusNotFound, map[string]string{"message": "no such object"}) }
	query := request.URL.Query()
	segments := strings.Split(strings.Trim(path, "/"), "/")

	switch {
	case path == "/containers/json":
		list := make([]map[string]any, 0, len(d.containers))
		for _, container := range d.containers {
			state := "exited"
			if container.IsRunning {
				state = "running"
			}
			list = append(list, map[string]any{"Id": container.ID, "Names": []string{"/" + container.Name}, "State": state})
		}
		reply(http.StatusOK, list)
	case path == "/containers/create":
		var payload map[string]any
		_ = json.NewDecoder(request.Body).Decode(&payload)
		if d.find(query.Get("name")) != nil {
			reply(http.StatusConflict, map[string]string{"message": "name is already in use"})
			return
		}
		if _, exists := d.images[stringField(payload, "Image")]; !exists {
			missing()
			return
		}
		hostConfig, _ := payload["HostConfig"].(map[string]any)
		networks := map[string]map[string]any{}
		if networking, ok := payload["NetworkingConfig"].(map[string]any); ok {
			endpoints, _ := networking["EndpointsConfig"].(map[string]any)
			for network, endpoint := range endpoints {
				networks[network], _ = endpoint.(map[string]any)
			}
		}
		delete(payload, "HostConfig")
		delete(payload, "NetworkingConfig")
		if payload["Labels"] == nil {
			payload["Labels"] = map[string]any{}
		}
		if payload["Env"] == nil {
			payload["Env"] = []any{}
		}
		reply(http.StatusCreated, map[string]string{"Id": d.create(query.Get("name"), payload, hostConfig, networks).ID})
	case segments[0] == "containers" && len(segments) >= 2:
		container := d.find(segments[1])
		if container == nil {
			missing()
			return
		}
		action := ""
		if len(segments) > 2 {
			action = segments[2]
		}
		switch {
		case request.Method == http.MethodDelete:
			delete(d.containers, container.ID)
			writer.WriteHeader(http.StatusNoContent)
		case action == "json":
			reply(http.StatusOK, d.inspection(container))
		case action == "start":
			container.IsRunning = !d.crashing[container.ImageID]
			writer.WriteHeader(http.StatusNoContent)
		case action == "stop":
			container.IsRunning = false
			writer.WriteHeader(http.StatusNoContent)
		case action == "rename":
			container.Name = query.Get("name")
			writer.WriteHeader(http.StatusNoContent)
		}
	case path == "/images/create":
		image, exists := d.registry[query.Get("fromImage")]
		if !exists {
			reply(http.StatusOK, map[string]string{"error": "manifest unknown"})
			return
		}
		d.images[query.Get("fromImage")] = image
		d.images[image.ID] = image
		reply(http.StatusOK, map[string]string{"status": "Downloaded"})
	case segments[0] == "images":
		reference := strings.Join(segments[1:len(segments)-1], "/")
		image, exists := d.images[reference]
		if !exists {
			missing()
			return
		}
		if segments[len(segments)-1] == "tag" {
			d.images[query.Get("repo")+":"+query.Get("tag")] = image
			writer.WriteHeader(http.StatusCreated)
			return
		}
		reply(http.StatusOK, map[string]any{"Id": image.ID, "Config": image.Config})
	case path == "/networks/create":
		var payload map[string]any
		_ = json.NewDecoder(request.Body).Decode(&payload)
		d.networks[stringField(payload, "Name")] = true
		reply(http.StatusCreated, map[string]string{"Id": "network"})
	case segments[0] == "networks" && len(segments) == 2:
		if !d.networks[segments[1]] {
			missing()
			return
		}
		reply(http.StatusOK, map[string]string{"Name": segments[1]})
	case segments[0] == "networks" && segments[2] == "connect":
		var payload map[string]any
		_ = json.NewDecoder(request.Body).Decode(&payload)
		container := d.find(stringField(payload, "Container"))
		if container == nil {
			missing()
			return
		}
		endpoint, _ := payload["EndpointConfig"].(map[string]any)
		if endpoint == nil {
			endpoint = map[string]any{}
		}
		container.Networks[segments[1]] = endpoint
		writer.WriteHeader(http.StatusOK)
	default:
		missing()
	}
}
