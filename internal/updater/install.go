package updater

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
)

// SIDECAR_NAME is both the installed updater's container name and the DNS name the
// console looks for it under.
const SIDECAR_NAME = "oh-my-cpa-updater"

// LINK_NETWORK is the network an installed updater shares with the console.
//
// It is the updater's own network rather than the deployment's Compose network: a
// container Compose does not know about, attached to a Compose network, makes
// `docker compose down` fail on a network that still has an endpoint.
const LINK_NETWORK = "oh-my-cpa-updater"

// Environment variables an updater container is configured with.
const (
	ENV_LISTEN_ADDR   = "OMCPA_UPDATER_LISTEN_ADDR"
	ENV_SOCKET        = "OMCPA_UPDATER_SOCKET"
	ENV_OMC_CONTAINER = "OMCPA_UPDATER_OMC_CONTAINER"
	ENV_CPA_CONTAINER = "OMCPA_UPDATER_CPA_CONTAINER"
	ENV_LINK_NETWORK  = "OMCPA_UPDATER_LINK_NETWORK"
	// ENV_PUBLIC_KEY replaces the built-in release key, for a fork that signs its own
	// releases. It is read from the updater's environment only: whoever can set it
	// already controls the Docker daemon.
	ENV_PUBLIC_KEY = "OMCPA_UPDATER_PUBLIC_KEY"
	// ENV_LAST_JOB carries the finished job into the updater's successor. The console
	// asks how its own update went only after it restarts, by which time the updater
	// that ran the job has replaced itself and its memory is gone.
	ENV_LAST_JOB = "OMCPA_UPDATER_LAST_JOB"
)

// InstallOptions configures Install.
type InstallOptions struct {
	Engine *Engine
	Timing Timing
	// SelfID is the installer's own container; its image and socket mount are what the
	// sidecar is created from.
	SelfID       string
	OMCContainer string
	CPAContainer string
	Out          io.Writer
}

// Install gives a deployment that predates console updates its updater, without
// touching the deployment's Compose file: it creates the sidecar as a container of its
// own, joins the console to it, and brings the console up to the installer's version.
// Running it again repairs or refreshes the same installation.
func Install(ctx context.Context, options InstallOptions) error {
	engine := options.Engine
	say := func(format string, arguments ...any) { fmt.Fprintf(options.Out, format+"\n", arguments...) }

	if options.SelfID == "" {
		return errors.New("the installer must run as a container: docker run --rm --pull always -u 0 -v /var/run/docker.sock:/var/run/docker.sock <image> updater install")
	}
	self, err := engine.InspectContainer(ctx, options.SelfID)
	if err != nil {
		return fmt.Errorf("inspect the installer container: %w", err)
	}
	// The socket's path on the host is what the sidecar must mount; it is not always
	// /var/run/docker.sock (rootless Docker, Docker Desktop).
	socketSource := ""
	for _, mount := range self.Mounts {
		if mount.Destination == DEFAULT_SOCKET_PATH {
			socketSource = mount.Source
		}
	}
	if socketSource == "" {
		return fmt.Errorf("the Docker socket is not mounted at %s", DEFAULT_SOCKET_PATH)
	}

	resolver := NewService(Options{Engine: engine, SelfID: options.SelfID, OMCContainer: options.OMCContainer})
	console, err := resolver.resolveOMC(ctx)
	var unavailable *UnavailableError
	if errors.As(err, &unavailable) {
		switch unavailable.Reason {
		case ReasonAmbiguousContainer:
			return errors.New("more than one Oh My CPA container is running; name one with --container <name>")
		default:
			return errors.New("no running Oh My CPA container was found; start it first, or name it with --container <name>")
		}
	}
	if err != nil {
		return err
	}
	say("Console container: %s (%s)", console.ContainerName(), console.ImageReference())

	if err := engine.EnsureNetwork(ctx, LINK_NETWORK); err != nil {
		return fmt.Errorf("create the %s network: %w", LINK_NETWORK, err)
	}
	// Attached before the sidecar exists: once it runs it attaches the console too, and
	// two attachments racing would fail the slower one.
	if _, isAttached := console.NetworkSettings.Networks[LINK_NETWORK]; !isAttached {
		if err := engine.ConnectNetwork(ctx, LINK_NETWORK, console.ID, nil); err != nil {
			return fmt.Errorf("attach %s to the %s network: %w", console.ContainerName(), LINK_NETWORK, err)
		}
	}
	if err := engine.RemoveContainer(ctx, SIDECAR_NAME); err != nil {
		return fmt.Errorf("remove the existing %s container: %w", SIDECAR_NAME, err)
	}
	environment := []string{ENV_LINK_NETWORK + "=" + LINK_NETWORK}
	if options.OMCContainer != "" {
		environment = append(environment, ENV_OMC_CONTAINER+"="+options.OMCContainer)
	}
	if options.CPAContainer != "" {
		environment = append(environment, ENV_CPA_CONTAINER+"="+options.CPAContainer)
	}
	sidecarID, err := engine.CreateContainer(ctx, SIDECAR_NAME, map[string]any{
		"Image": self.ImageReference(),
		"Cmd":   []string{ROLE_COMMAND, "serve"},
		"Env":   environment,
		// The socket is owned by root on the host. Every capability is dropped, so this
		// is root that can open the socket it owns and nothing else.
		"User": "0:0",
		"Healthcheck": map[string]any{
			"Test":     []string{"CMD", "/usr/local/bin/oh-my-cpa", ROLE_COMMAND, "healthcheck"},
			"Interval": 10_000_000_000, "Timeout": 5_000_000_000, "StartPeriod": 5_000_000_000, "Retries": 3,
		},
		"HostConfig": map[string]any{
			"Binds":          []string{socketSource + ":" + DEFAULT_SOCKET_PATH},
			"NetworkMode":    LINK_NETWORK,
			"RestartPolicy":  map[string]any{"Name": "unless-stopped"},
			"ReadonlyRootfs": true,
			"CapDrop":        []string{"ALL"},
			"SecurityOpt":    []string{"no-new-privileges:true"},
		},
	})
	if err != nil {
		return fmt.Errorf("create the %s container: %w", SIDECAR_NAME, err)
	}
	if err := engine.StartContainer(ctx, sidecarID); err != nil {
		return fmt.Errorf("start the %s container: %w", SIDECAR_NAME, err)
	}
	if err := awaitStarted(ctx, engine, options.Timing, sidecarID); err != nil {
		return fmt.Errorf("the %s container did not start: %w", SIDECAR_NAME, err)
	}
	say("Updater container: %s (started, restarts with Docker)", SIDECAR_NAME)

	if err := upgradeConsole(ctx, options, self, console, say); err != nil {
		return err
	}
	say("")
	say("Updates can now be applied from the console's System Information page.")
	say("To undo: docker rm -f %s", SIDECAR_NAME)
	return nil
}

// upgradeConsole moves the console to the installer's image when that is a newer
// release of the image the console is configured with.
//
// The operator pulled this image themselves to run the installer, which is the same
// act of trust as `docker compose pull`, so no manifest is involved. A console too old
// to have the update page would otherwise be left unable to use what was just
// installed.
func upgradeConsole(ctx context.Context, options InstallOptions, self, console Container, say func(string, ...any)) error {
	engine := options.Engine
	consoleReference := ParseReference(console.ImageReference())
	selfReference := ParseReference(self.ImageReference())
	if console.ImageID == self.ImageID {
		say("Console image: already the installer's version")
		return nil
	}
	if consoleReference.IsPinned() {
		say("Console image: pinned to %s and left as it is. Console updates stay unavailable until the pin is changed to a floating tag such as latest.", console.ImageReference())
		return nil
	}
	isSameReference := CanonicalRepository(consoleReference.Repository) == CanonicalRepository(selfReference.Repository) &&
		consoleReference.EffectiveTag() == selfReference.EffectiveTag()
	if !isSameReference {
		say("Console image: %s differs from the installer's %s and was left as it is.", console.ImageReference(), self.ImageReference())
		return nil
	}
	consoleImage, err := engine.InspectImage(ctx, console.ImageID)
	if err != nil {
		return err
	}
	selfImage, err := engine.InspectImage(ctx, self.ImageID)
	if err != nil {
		return err
	}
	if release.CompareVersions(consoleImage.Version(), selfImage.Version()).State != release.UpdateAvailable {
		say("Console image: %s is not older than the installer's %s and was left as it is.", consoleImage.Version(), selfImage.Version())
		return nil
	}
	say("Updating the console from %s to %s ...", consoleImage.Version(), selfImage.Version())
	if err := replaceContainer(ctx, engine, options.Timing, console.ID, console.ImageReference(), func(string) {}); err != nil {
		return fmt.Errorf("update the console: %w", err)
	}
	say("Console image: updated to %s", selfImage.Version())
	return nil
}
