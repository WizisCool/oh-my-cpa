package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"
)

// PREVIOUS_SUFFIX names the container being replaced while its replacement proves
// itself. It is what a restarted updater looks for to finish an interrupted job.
const PREVIOUS_SUFFIX = "-omc-previous"

// Timing holds every duration a replacement waits on, so tests can shrink them.
type Timing struct {
	PollInterval  time.Duration
	HealthTimeout time.Duration
	// StableWindow is how long a container without a health check must stay running,
	// without the daemon restarting it, to count as started.
	StableWindow time.Duration
	StopGrace    time.Duration
}

// DefaultTiming is the production timing.
func DefaultTiming() Timing {
	return Timing{PollInterval: time.Second, HealthTimeout: 3 * time.Minute, StableWindow: 10 * time.Second, StopGrace: 30 * time.Second}
}

// creationPlan is everything needed to create the replacement of a container.
type creationPlan struct {
	payload map[string]any
	// extraNetworks are attached after creation: an API older than 1.44 accepts only
	// one endpoint in the create call.
	extraNetworks map[string]map[string]any
}

// planReplacement derives the replacement's configuration from the container being
// replaced.
//
// An inspected container reports its configuration merged with its image's defaults.
// Copying that verbatim would freeze the old image's entrypoint, environment, health
// check and labels into the replacement, so every value the old image supplied is
// removed and the new image supplies its own.
func planReplacement(previous Container, previousImage Image, imageReference string) (creationPlan, error) {
	config, err := cloneFields(previous.Config)
	if err != nil {
		return creationPlan{}, err
	}
	hostConfig, err := cloneFields(previous.HostConfig)
	if err != nil {
		return creationPlan{}, err
	}
	defaults := previousImage.Config

	for _, field := range []string{"Cmd", "Entrypoint", "Healthcheck", "User", "WorkingDir", "StopSignal", "Shell", "OnBuild"} {
		if reflect.DeepEqual(config[field], defaults[field]) {
			delete(config, field)
		}
	}
	config["Env"] = withoutEntries(config["Env"], defaults["Env"])
	for _, field := range []string{"Labels", "ExposedPorts", "Volumes"} {
		config[field] = withoutDefaults(config[field], defaults[field])
	}
	shortID := previous.ID
	if len(shortID) > 12 {
		shortID = shortID[:12]
	}
	// A hostname the daemon generated is the old container's ID; keeping it would give
	// the replacement another container's identity.
	if stringField(config, "Hostname") == shortID {
		delete(config, "Hostname")
	}
	config["Image"] = imageReference

	// An anonymous volume belongs to the container that created it. Naming it in the
	// replacement's binds is what carries the data across.
	binds := stringList(hostConfig["Binds"])
	for _, mount := range previous.Mounts {
		if mount.Type != "volume" || mount.Name == "" || isMountDeclared(hostConfig, binds, mount.Name, mount.Destination) {
			continue
		}
		binds = append(binds, mount.Name+":"+mount.Destination)
	}
	if len(binds) > 0 {
		hostConfig["Binds"] = binds
	}

	plan := creationPlan{payload: config, extraNetworks: map[string]map[string]any{}}
	config["HostConfig"] = hostConfig
	networkMode := stringField(hostConfig, "NetworkMode")
	for name, settings := range previous.NetworkSettings.Networks {
		endpoint := endpointConfig(settings, shortID)
		if name == networkMode || (len(previous.NetworkSettings.Networks) == 1 && isUserNetworkMode(networkMode)) {
			config["NetworkingConfig"] = map[string]any{"EndpointsConfig": map[string]any{name: endpoint}}
			continue
		}
		if isUserNetworkMode(networkMode) {
			plan.extraNetworks[name] = endpoint
		}
	}
	return plan, nil
}

// isUserNetworkMode reports whether the container has endpoints of its own; "host",
// "none" and "container:<id>" modes have none to recreate.
func isUserNetworkMode(mode string) bool {
	return mode != "host" && mode != "none" && !strings.HasPrefix(mode, "container:")
}

// endpointConfig keeps what the operator configured for a network endpoint and drops
// what the daemon assigned at run time.
func endpointConfig(settings map[string]any, previousShortID string) map[string]any {
	endpoint := map[string]any{}
	for _, field := range []string{"IPAMConfig", "Links", "DriverOpts"} {
		if value := settings[field]; value != nil {
			endpoint[field] = value
		}
	}
	aliases := make([]string, 0)
	for _, alias := range stringList(settings["Aliases"]) {
		if alias != previousShortID {
			aliases = append(aliases, alias)
		}
	}
	if len(aliases) > 0 {
		endpoint["Aliases"] = aliases
	}
	return endpoint
}

func isMountDeclared(hostConfig map[string]any, binds []string, volume, destination string) bool {
	for _, bind := range binds {
		parts := strings.Split(bind, ":")
		if len(parts) >= 2 && (parts[0] == volume || parts[1] == destination) {
			return true
		}
	}
	mounts, _ := hostConfig["Mounts"].([]any)
	for _, entry := range mounts {
		mount, _ := entry.(map[string]any)
		if stringField(mount, "Target") == destination {
			return true
		}
	}
	return false
}

func cloneFields(fields map[string]any) (map[string]any, error) {
	encoded, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	clone := map[string]any{}
	if err := json.Unmarshal(encoded, &clone); err != nil {
		return nil, err
	}
	return clone, nil
}

// withoutEntries removes the list entries the image default list also holds.
func withoutEntries(value, defaults any) []string {
	inherited := map[string]bool{}
	for _, entry := range stringList(defaults) {
		inherited[entry] = true
	}
	kept := make([]string, 0)
	for _, entry := range stringList(value) {
		if !inherited[entry] {
			kept = append(kept, entry)
		}
	}
	return kept
}

// withoutDefaults removes the map entries the image default map holds with the same
// value.
func withoutDefaults(value, defaults any) map[string]any {
	inherited, _ := defaults.(map[string]any)
	entries, _ := value.(map[string]any)
	kept := map[string]any{}
	for key, entry := range entries {
		if inheritedEntry, exists := inherited[key]; exists && reflect.DeepEqual(entry, inheritedEntry) {
			continue
		}
		kept[key] = entry
	}
	return kept
}

// errRolledBack marks a failed replacement whose previous container is running again.
var errRolledBack = errors.New("the previous container was restored")

// replaceContainer swaps a container for one created from imageReference.
//
// The previous container is renamed and stopped, never removed, until its replacement
// is healthy; a replacement that fails is deleted and the previous container is given
// its name back and started. onStage reports progress.
func replaceContainer(ctx context.Context, engine *Engine, timing Timing, name, imageReference string, onStage func(stage string)) error {
	previous, err := engine.InspectContainer(ctx, name)
	if err != nil {
		return fmt.Errorf("inspect %s: %w", name, err)
	}
	previousImage, err := engine.InspectImage(ctx, previous.ImageID)
	if err != nil {
		return fmt.Errorf("inspect the image of %s: %w", name, err)
	}
	plan, err := planReplacement(previous, previousImage, imageReference)
	if err != nil {
		return err
	}
	containerName := previous.ContainerName()
	previousName := containerName + PREVIOUS_SUFFIX

	onStage(StageStopping)
	if err := engine.StopContainer(ctx, previous.ID, timing.StopGrace); err != nil {
		return fmt.Errorf("stop %s: %w", containerName, err)
	}
	restore := func(cause error) error {
		// The caller's context may be what failed; restoring service must not share
		// its fate.
		restoreCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		defer cancel()
		_ = engine.RemoveContainer(restoreCtx, containerName)
		renameErr := engine.RenameContainer(restoreCtx, previous.ID, containerName)
		startErr := engine.StartContainer(restoreCtx, previous.ID)
		if renameErr != nil || startErr != nil {
			return fmt.Errorf("%w; restoring the previous container also failed: %w", cause, errors.Join(renameErr, startErr))
		}
		return fmt.Errorf("%w: %w", errRolledBack, cause)
	}
	if err := engine.RenameContainer(ctx, previous.ID, previousName); err != nil {
		startErr := engine.StartContainer(context.WithoutCancel(ctx), previous.ID)
		return errors.Join(fmt.Errorf("rename %s: %w", containerName, err), startErr)
	}

	onStage(StageStarting)
	createdID, err := engine.CreateContainer(ctx, containerName, plan.payload)
	if err != nil {
		return restore(fmt.Errorf("create the replacement: %w", err))
	}
	for network, endpoint := range plan.extraNetworks {
		if err := engine.ConnectNetwork(ctx, network, createdID, endpoint); err != nil {
			return restore(fmt.Errorf("attach the replacement to %s: %w", network, err))
		}
	}
	if err := engine.StartContainer(ctx, createdID); err != nil {
		return restore(fmt.Errorf("start the replacement: %w", err))
	}

	onStage(StageVerifying)
	if err := awaitStarted(ctx, engine, timing, createdID); err != nil {
		return restore(err)
	}
	if err := engine.RemoveContainer(ctx, previous.ID); err != nil {
		return fmt.Errorf("remove the previous container: %w", err)
	}
	return nil
}

// awaitStarted waits until a container is healthy, or, when its image defines no
// health check, until it has stayed up for the stable window.
func awaitStarted(ctx context.Context, engine *Engine, timing Timing, containerID string) error {
	deadline := time.Now().Add(timing.HealthTimeout)
	var runningSince time.Time
	for {
		container, err := engine.InspectContainer(ctx, containerID)
		if err != nil {
			return fmt.Errorf("inspect the replacement: %w", err)
		}
		switch {
		case !container.State.Running || container.RestartCount > 0:
			return errors.New("the replacement exited after starting")
		case container.State.Health != nil:
			switch container.State.Health.Status {
			case "healthy":
				return nil
			case "unhealthy":
				return errors.New("the replacement reported itself unhealthy")
			}
		default:
			if runningSince.IsZero() {
				runningSince = time.Now()
			}
			if time.Since(runningSince) >= timing.StableWindow {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return errors.New("the replacement did not become healthy in time")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(timing.PollInterval):
		}
	}
}
