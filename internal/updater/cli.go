package updater

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"
)

const USAGE = `Usage: oh-my-cpa updater <command>

Applies updates the console asks for by replacing this deployment's containers.
It needs the Docker socket, which the console itself never has.

Commands:
  serve        run the updater; the console reaches it at http://oh-my-cpa-updater:8090
  install      add the updater to a deployment that is already running:
                 docker run --rm --pull always -u 0 \
                   -v /var/run/docker.sock:/var/run/docker.sock \
                   wiziscool/oh-my-cpa:latest updater install
               --container <name>      the console container, when it cannot be told apart
               --cpa-container <name>  the CLIProxyAPI container, when it is not found
  healthcheck  exit 0 when a running updater answers
`

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

// selfContainerID is this process's container, when it runs in one.
//
// The operator may name it outright. Otherwise the hostname is tried: Docker sets it
// to the container's short ID — unless the container shares another's network
// namespace, in which case it inherits the namespace owner's hostname and the lookup
// lands on the wrong container. The fallback is the one running updater container.
func selfContainerID(ctx context.Context, engine *Engine) string {
	if named := os.Getenv(ENV_SELF_CONTAINER); named != "" {
		if container, err := engine.InspectContainer(ctx, named); err == nil {
			return container.ID
		}
	}
	hostname, err := os.Hostname()
	if err == nil && hostname != "" {
		if container, err := engine.InspectContainer(ctx, hostname); err == nil && isUpdaterContainer(container) {
			return container.ID
		}
	}
	summaries, err := engine.ListContainers(ctx)
	if err != nil {
		return ""
	}
	found := ""
	for _, summary := range summaries {
		// Docker can start the process before its list snapshot says running.
		// Inspect waits for the authoritative state and excludes stopped peers.
		container, err := engine.InspectContainer(ctx, summary.ID)
		if err != nil || !container.State.Running || !isUpdaterContainer(container) {
			continue
		}
		if found != "" {
			return ""
		}
		found = container.ID
	}
	return found
}

func connect(ctx context.Context, stderr io.Writer) (*Engine, bool) {
	engine, err := NewEngine(ctx, envOr(ENV_SOCKET, DEFAULT_SOCKET_PATH))
	if err == nil {
		return engine, true
	}
	fmt.Fprintf(stderr, "Cannot use the Docker socket: %v\n", err)
	if errors.Is(err, syscall.EACCES) {
		fmt.Fprintln(stderr, "The socket belongs to root: add `-u 0` to the docker run command.")
	} else if errors.Is(err, syscall.ENOENT) {
		fmt.Fprintln(stderr, "Mount it with `-v /var/run/docker.sock:/var/run/docker.sock`.")
	}
	return nil, false
}

// Run executes an `oh-my-cpa updater` command and returns the process exit code.
func Run(ctx context.Context, arguments []string, version string, stdout, stderr io.Writer) int {
	if len(arguments) == 0 {
		fmt.Fprint(stderr, USAGE)
		return 2
	}
	switch arguments[0] {
	case "serve":
		return serve(ctx, version, stderr)
	case "install":
		flags := flag.NewFlagSet("updater install", flag.ContinueOnError)
		flags.SetOutput(stderr)
		consoleName := flags.String("container", "", "the console container")
		gatewayName := flags.String("cpa-container", "", "the CLIProxyAPI container")
		if err := flags.Parse(arguments[1:]); err != nil {
			return 2
		}
		engine, ok := connect(ctx, stderr)
		if !ok {
			return 1
		}
		err := Install(ctx, InstallOptions{
			Engine:       engine,
			Timing:       DefaultTiming(),
			SelfID:       selfContainerID(ctx, engine),
			OMCContainer: *consoleName,
			CPAContainer: *gatewayName,
			Out:          stdout,
		})
		if err != nil {
			fmt.Fprintf(stderr, "Install failed: %v\n", err)
			return 1
		}
		return 0
	case "healthcheck":
		return healthcheck(ctx)
	case "-h", "--help", "help":
		fmt.Fprint(stdout, USAGE)
		return 0
	default:
		fmt.Fprint(stderr, USAGE)
		return 2
	}
}

func listenAddr() string { return envOr(ENV_LISTEN_ADDR, DEFAULT_LISTEN_ADDR) }

func serve(ctx context.Context, version string, stderr io.Writer) int {
	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	engine, ok := connect(ctx, stderr)
	if !ok {
		return 1
	}
	service := NewService(Options{
		Engine:       engine,
		Logger:       logger,
		PublicKey:    envOr(ENV_PUBLIC_KEY, releasePublicKey),
		SelfID:       selfContainerID(ctx, engine),
		OMCContainer: os.Getenv(ENV_OMC_CONTAINER),
		CPAContainer: os.Getenv(ENV_CPA_CONTAINER),
		LinkNetwork:  os.Getenv(ENV_LINK_NETWORK),
	})
	service.RestoreJob(os.Getenv(ENV_LAST_JOB))
	sharesListener, err := service.sharesPredecessorNetwork(ctx)
	if err != nil {
		logger.Error("could not identify the updater's network namespace", "error", err)
		return 1
	}
	reconcile := func() {
		if err := service.Reconcile(ctx); err != nil {
			logger.Warn("could not finish an interrupted update", "error", err)
		}
	}
	// A successor in another namespace can bind before removing its predecessor.
	// When both share one namespace, recovery must first release the old listener.
	if sharesListener {
		reconcile()
	}
	listener, err := net.Listen("tcp", listenAddr())
	if err != nil {
		logger.Error("updater could not listen", "error", err)
		return 1
	}
	defer func() { _ = listener.Close() }()
	if !sharesListener {
		reconcile()
	}
	go service.KeepLinked(ctx, 5*time.Second)

	server := &http.Server{Addr: listenAddr(), Handler: service.Handler(version), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	logger.Info("updater started", "addr", server.Addr, "version", version)
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("updater stopped", "error", err)
		return 1
	}
	return 0
}

func healthcheck(ctx context.Context) int {
	_, port, err := net.SplitHostPort(listenAddr())
	if err != nil {
		return 1
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+port+"/v1/healthz", nil)
	if err != nil {
		return 1
	}
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		return 1
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
