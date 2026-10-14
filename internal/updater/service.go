package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
)

// Products the updater can replace. They are the whole vocabulary of the control
// interface: a caller names a product, never a container or an image.
const (
	ProductOMC = "omc"
	ProductCPA = "cpa"
)

// Whether a product can be updated from the console.
const (
	ActionAvailable   = "available"
	ActionUnavailable = "unavailable"
)

// Why a product cannot be updated from the console.
const (
	ReasonPinned               = "pinned"
	ReasonNotLocalContainer    = "not_a_local_container"
	ReasonContainerNotFound    = "container_not_found"
	ReasonAmbiguousContainer   = "ambiguous_container"
	ReasonSignatureUnavailable = "signature_unavailable"
)

// Job stages. The last four are terminal.
const (
	StagePulling        = "pulling"
	StageStopping       = "stopping"
	StageStarting       = "starting"
	StageVerifying      = "verifying"
	StageDone           = "done"
	StageAlreadyCurrent = "already_current"
	StageRolledBack     = "rolled_back"
	StageFailed         = "failed"
)

// DEFAULT_CPA_REPOSITORY is the gateway image a container is recognised by when
// nothing else identifies it.
const DEFAULT_CPA_REPOSITORY = "eceasy/cli-proxy-api"

// ROLE_COMMAND is the first argument every updater container runs with; it is how one
// is told apart from the console, which runs the same image.
const ROLE_COMMAND = "updater"

// ErrBusy is returned when a job is already running.
var ErrBusy = errors.New("an update is already running")

// UnavailableError explains why a product cannot be updated.
type UnavailableError struct{ Reason string }

func (e *UnavailableError) Error() string { return "update unavailable: " + e.Reason }

// Target describes one product as the updater sees it.
type Target struct {
	Product        string `json:"product"`
	Container      string `json:"container"`
	Image          string `json:"image"`
	RunningVersion string `json:"running_version"`
	Action         string `json:"action"`
	Reason         string `json:"reason"`
}

// Job is one replacement, running or finished.
type Job struct {
	ID           string `json:"id"`
	Product      string `json:"product"`
	Stage        string `json:"stage"`
	Error        string `json:"error"`
	FromVersion  string `json:"from_version"`
	ToVersion    string `json:"to_version"`
	StartedAtMS  int64  `json:"started_at_ms"`
	FinishedAtMS int64  `json:"finished_at_ms"`
}

// IsFinished reports whether the job reached a terminal stage.
func (j Job) IsFinished() bool {
	switch j.Stage {
	case StageDone, StageAlreadyCurrent, StageRolledBack, StageFailed:
		return true
	}
	return false
}

// Options configures a Service.
type Options struct {
	Engine *Engine
	Logger *slog.Logger
	Timing Timing
	// PublicKey verifies release manifests; empty disables console updates of OMC.
	PublicKey string
	// SelfID is this updater's own container ID, empty when it is not containerised.
	SelfID string
	// OMCContainer and CPAContainer name the targets explicitly, skipping discovery.
	OMCContainer string
	CPAContainer string
	// LinkNetwork, when set, is a network the console container is kept attached to so
	// that it can reach this updater without sharing a Compose network with it.
	LinkNetwork string
}

// Service resolves the deployment's containers and replaces them.
type Service struct {
	options Options
	mu      sync.Mutex
	job     *Job
	now     func() time.Time
	// jobs counts update jobs in flight, the updater's own replacement included, so
	// a caller can wait for one to end instead of polling for it.
	jobs sync.WaitGroup
}

// NewService builds a Service.
func NewService(options Options) *Service {
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if options.Timing == (Timing{}) {
		options.Timing = DefaultTiming()
	}
	return &Service{options: options, now: time.Now}
}

// RestoreJob installs a finished job inherited from a predecessor. A job that was
// still running there cannot be resumed, so anything unfinished is ignored.
func (s *Service) RestoreJob(encoded string) {
	var job Job
	if json.Unmarshal([]byte(encoded), &job) != nil || !job.IsFinished() {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job == nil {
		s.job = &job
	}
}

// LastJob returns the running or most recent job.
func (s *Service) LastJob() *Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job == nil {
		return nil
	}
	snapshot := *s.job
	return &snapshot
}

func (s *Service) setStage(stage string, mutate func(job *Job)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.job.Stage = stage
	if mutate != nil {
		mutate(s.job)
	}
	if s.job.IsFinished() {
		s.job.FinishedAtMS = s.now().UnixMilli()
	}
}

// Targets reports both products. A product that cannot be resolved is still listed,
// with the reason, so the console can say why it offers no update.
func (s *Service) Targets(ctx context.Context) []Target {
	targets := make([]Target, 0, 2)
	for _, product := range []string{ProductOMC, ProductCPA} {
		target := Target{Product: product, Action: ActionUnavailable}
		container, err := s.resolve(ctx, product)
		if err != nil {
			var unavailable *UnavailableError
			if errors.As(err, &unavailable) {
				target.Reason = unavailable.Reason
			} else {
				target.Reason = ReasonContainerNotFound
				s.options.Logger.Warn("could not resolve an update target", "product", product, "error", err)
			}
			targets = append(targets, target)
			continue
		}
		target.Container = container.ContainerName()
		target.Image = container.ImageReference()
		if image, err := s.options.Engine.InspectImage(ctx, container.ImageID); err == nil {
			target.RunningVersion = image.Version()
		}
		switch {
		case ParseReference(target.Image).IsPinned():
			target.Reason = ReasonPinned
		case product == ProductOMC && strings.TrimSpace(s.options.PublicKey) == "":
			target.Reason = ReasonSignatureUnavailable
		default:
			target.Action = ActionAvailable
		}
		targets = append(targets, target)
	}
	return targets
}

// MasterKey reads the console's master key from its container, to derive the control
// token from.
func (s *Service) MasterKey(ctx context.Context) (string, error) {
	container, err := s.resolve(ctx, ProductOMC)
	if err != nil {
		return "", err
	}
	return container.Env("OMCPA_MASTER_KEY"), nil
}

func (s *Service) resolve(ctx context.Context, product string) (Container, error) {
	if product == ProductCPA {
		return s.resolveCPA(ctx)
	}
	return s.resolveOMC(ctx)
}

func (s *Service) inspectNamed(ctx context.Context, name string) (Container, error) {
	container, err := s.options.Engine.InspectContainer(ctx, name)
	if errors.Is(err, ErrNotFound) {
		return Container{}, &UnavailableError{Reason: ReasonContainerNotFound}
	}
	return container, err
}

// running lists every running container except this updater.
func (s *Service) running(ctx context.Context) ([]Container, error) {
	summaries, err := s.options.Engine.ListContainers(ctx)
	if err != nil {
		return nil, err
	}
	containers := make([]Container, 0, len(summaries))
	for _, summary := range summaries {
		if summary.State != "running" || (s.options.SelfID != "" && strings.HasPrefix(summary.ID, s.options.SelfID)) {
			continue
		}
		container, err := s.options.Engine.InspectContainer(ctx, summary.ID)
		if err != nil {
			// A container can disappear between the list and the inspect.
			continue
		}
		containers = append(containers, container)
	}
	return containers, nil
}

func isUpdaterContainer(container Container) bool {
	command := container.Command()
	return len(command) > 0 && command[0] == ROLE_COMMAND
}

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project"

// preferProject narrows candidates to one Compose project when any of them belong to
// it, so two deployments on one host do not make each other ambiguous.
func preferProject(candidates []Container, project string) []Container {
	if project == "" {
		return candidates
	}
	sameProject := make([]Container, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Label(COMPOSE_PROJECT_LABEL) == project {
			sameProject = append(sameProject, candidate)
		}
	}
	if len(sameProject) > 0 {
		return sameProject
	}
	return candidates
}

func exactlyOne(candidates []Container) (Container, error) {
	switch len(candidates) {
	case 0:
		return Container{}, &UnavailableError{Reason: ReasonContainerNotFound}
	case 1:
		return candidates[0], nil
	default:
		return Container{}, &UnavailableError{Reason: ReasonAmbiguousContainer}
	}
}

// resolveOMC finds the console: the container running this updater's own image
// repository that is not itself an updater.
func (s *Service) resolveOMC(ctx context.Context) (Container, error) {
	if s.options.OMCContainer != "" {
		return s.inspectNamed(ctx, s.options.OMCContainer)
	}
	if s.options.SelfID == "" {
		return Container{}, &UnavailableError{Reason: ReasonContainerNotFound}
	}
	self, err := s.options.Engine.InspectContainer(ctx, s.options.SelfID)
	if err != nil {
		return Container{}, err
	}
	repository := CanonicalRepository(ParseReference(self.ImageReference()).Repository)
	containers, err := s.running(ctx)
	if err != nil {
		return Container{}, err
	}
	candidates := make([]Container, 0, 1)
	for _, container := range containers {
		if isUpdaterContainer(container) {
			continue
		}
		if CanonicalRepository(ParseReference(container.ImageReference()).Repository) == repository {
			candidates = append(candidates, container)
		}
	}
	return exactlyOne(preferProject(candidates, self.Label(COMPOSE_PROJECT_LABEL)))
}

// resolveCPA finds the gateway container. The console's own CPA address is the
// strongest evidence, because it names the gateway this deployment actually manages;
// the image repository is the fallback for an address that is not a container name.
func (s *Service) resolveCPA(ctx context.Context) (Container, error) {
	if s.options.CPAContainer != "" {
		return s.inspectNamed(ctx, s.options.CPAContainer)
	}
	console, err := s.resolveOMC(ctx)
	if err != nil {
		return Container{}, &UnavailableError{Reason: ReasonNotLocalContainer}
	}
	containers, err := s.running(ctx)
	if err != nil {
		return Container{}, err
	}
	host := ""
	if parsed, err := url.Parse(console.Env("OMCPA_CPA_BASE_URL")); err == nil {
		host = parsed.Hostname()
	}
	if host != "" && net.ParseIP(host) == nil {
		for _, container := range containers {
			if container.ID != console.ID && answersTo(container, host) {
				return container, nil
			}
		}
	}
	candidates := make([]Container, 0, 1)
	for _, container := range containers {
		if CanonicalRepository(ParseReference(container.ImageReference()).Repository) == DEFAULT_CPA_REPOSITORY {
			candidates = append(candidates, container)
		}
	}
	container, err := exactlyOne(preferProject(candidates, console.Label(COMPOSE_PROJECT_LABEL)))
	var unavailable *UnavailableError
	if errors.As(err, &unavailable) && unavailable.Reason == ReasonContainerNotFound {
		// No gateway container on this daemon: CPA runs natively or on another host.
		return Container{}, &UnavailableError{Reason: ReasonNotLocalContainer}
	}
	return container, err
}

// answersTo reports whether a container is reachable under a DNS name on one of its
// networks: its own name or a network alias.
func answersTo(container Container, host string) bool {
	if container.ContainerName() == host {
		return true
	}
	for _, settings := range container.NetworkSettings.Networks {
		for _, alias := range stringList(settings["Aliases"]) {
			if alias == host {
				return true
			}
		}
	}
	return false
}

// Start admits an update and runs it in the background. Everything that can be
// refused is checked before the job exists, so an admitted job is one that will
// actually touch the daemon.
func (s *Service) Start(ctx context.Context, product string, manifest []byte, signature string) (Job, error) {
	if product != ProductOMC && product != ProductCPA {
		return Job{}, fmt.Errorf("unknown product %q", product)
	}
	container, err := s.resolve(ctx, product)
	if err != nil {
		return Job{}, err
	}
	reference := ParseReference(container.ImageReference())
	if reference.IsPinned() {
		return Job{}, &UnavailableError{Reason: ReasonPinned}
	}
	runningVersion := ""
	if image, err := s.options.Engine.InspectImage(ctx, container.ImageID); err == nil {
		runningVersion = image.Version()
	}
	pullReference := reference.Repository + ":" + reference.EffectiveTag()
	targetVersion := ""
	if product == ProductOMC {
		verified, err := VerifyManifest(s.options.PublicKey, manifest, signature)
		if err != nil {
			return Job{}, err
		}
		if CanonicalRepository(verified.Image.Repository) != CanonicalRepository(reference.Repository) {
			return Job{}, fmt.Errorf("the release manifest is for %s, not %s", verified.Image.Repository, reference.Repository)
		}
		if release.CompareVersions(runningVersion, verified.Version).State == release.UpdateAhead {
			return Job{}, fmt.Errorf("the release manifest is for %s, older than the running %s", verified.Version, runningVersion)
		}
		// Pulling by digest is what makes the signature mean something: a tag can be
		// moved after the manifest was signed, a digest cannot.
		pullReference = reference.Repository + "@" + verified.Image.Digest
		targetVersion = verified.Version
	}

	s.mu.Lock()
	if s.job != nil && !s.job.IsFinished() {
		s.mu.Unlock()
		return Job{}, ErrBusy
	}
	startedAt := s.now()
	s.job = &Job{
		ID:          fmt.Sprintf("%s-%d", product, startedAt.UnixMilli()),
		Product:     product,
		Stage:       StagePulling,
		FromVersion: runningVersion,
		ToVersion:   targetVersion,
		StartedAtMS: startedAt.UnixMilli(),
	}
	admitted := *s.job
	s.mu.Unlock()

	// The request that admitted the job ends long before the job does.
	s.jobs.Add(1)
	go func() {
		defer s.jobs.Done()
		s.run(context.WithoutCancel(ctx), container, reference, pullReference, product)
	}()
	return admitted, nil
}

func (s *Service) run(ctx context.Context, container Container, reference Reference, pullReference, product string) {
	logger := s.options.Logger.With("product", product, "container", container.ContainerName())
	fail := func(err error) {
		stage := StageFailed
		if errors.Is(err, errRolledBack) {
			stage = StageRolledBack
		}
		logger.Error("update failed", "stage", stage, "error", err)
		s.setStage(stage, func(job *Job) { job.Error = err.Error() })
	}
	engine := s.options.Engine
	if err := engine.PullImage(ctx, pullReference); err != nil {
		fail(err)
		return
	}
	if reference.Digest == "" && strings.Contains(pullReference, "@") {
		// Point the container's own tag at the verified image, so a later
		// `docker compose up` sees the image it expects and leaves the container alone.
		if err := engine.TagImage(ctx, pullReference, reference.Repository, reference.EffectiveTag()); err != nil {
			fail(err)
			return
		}
	}
	pulled, err := engine.InspectImage(ctx, pullReference)
	if err != nil {
		fail(err)
		return
	}
	if pulled.ID == container.ImageID {
		logger.Info("the container already runs the newest image")
		s.setStage(StageAlreadyCurrent, func(job *Job) { job.ToVersion = pulled.Version() })
		return
	}
	err = replaceContainer(ctx, engine, s.options.Timing, container.ID, container.ImageReference(), func(stage string) { s.setStage(stage, nil) })
	if err != nil {
		if errors.Is(err, errRolledBack) {
			// Give the tag back to the image that works. Left on the rejected image,
			// the next `docker compose up` would recreate the container from it.
			if tagErr := engine.TagImage(ctx, container.ImageID, reference.Repository, reference.EffectiveTag()); tagErr != nil {
				logger.Warn("could not point the image tag back at the previous image", "error", tagErr)
			}
		}
		fail(err)
		return
	}
	logger.Info("update finished", "version", pulled.Version())
	s.setStage(StageDone, func(job *Job) { job.ToVersion = pulled.Version() })
	if product == ProductOMC {
		if err := s.replaceSelf(ctx); err != nil {
			logger.Warn("the updater could not replace itself with the new image", "error", err)
		}
	}
}

// replaceSelf starts a successor from the image the console was just updated to, so
// the updater never falls behind the console that calls it.
//
// A container cannot recreate itself, so it hands over instead: it gives up its name,
// starts the successor under it, and the successor removes it during Reconcile.
func (s *Service) replaceSelf(ctx context.Context) error {
	if s.options.SelfID == "" {
		return nil
	}
	engine := s.options.Engine
	self, err := engine.InspectContainer(ctx, s.options.SelfID)
	if err != nil {
		return err
	}
	if ParseReference(self.ImageReference()).IsPinned() {
		return nil
	}
	current, err := engine.InspectImage(ctx, self.ImageReference())
	if err != nil || current.ID == self.ImageID {
		return err
	}
	selfImage, err := engine.InspectImage(ctx, self.ImageID)
	if err != nil {
		return err
	}
	plan, err := planReplacement(self, selfImage, self.ImageReference())
	if err != nil {
		return err
	}
	if job := s.LastJob(); job != nil {
		encoded, err := json.Marshal(job)
		if err != nil {
			return err
		}
		environment := make([]string, 0)
		for _, entry := range stringList(plan.payload["Env"]) {
			if !strings.HasPrefix(entry, ENV_LAST_JOB+"=") {
				environment = append(environment, entry)
			}
		}
		plan.payload["Env"] = append(environment, ENV_LAST_JOB+"="+string(encoded))
	}
	name := self.ContainerName()
	if err := engine.RenameContainer(ctx, self.ID, name+PREVIOUS_SUFFIX); err != nil {
		return err
	}
	abandon := func(cause error) error {
		_ = engine.RemoveContainer(ctx, name)
		return errors.Join(cause, engine.RenameContainer(ctx, self.ID, name))
	}
	successorID, err := engine.CreateContainer(ctx, name, plan.payload)
	if err != nil {
		return abandon(err)
	}
	for network, endpoint := range plan.extraNetworks {
		if err := engine.ConnectNetwork(ctx, network, successorID, endpoint); err != nil {
			return abandon(err)
		}
	}
	if err := engine.StartContainer(ctx, successorID); err != nil {
		return abandon(err)
	}
	return nil
}

// Reconcile finishes what an interrupted run left behind: a predecessor updater is
// removed, and a target that was mid-replacement is either cleaned up or restored.
func (s *Service) Reconcile(ctx context.Context) error {
	engine := s.options.Engine
	summaries, err := engine.ListContainers(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, summary := range summaries {
		for _, listed := range summary.Names {
			previousName := strings.TrimPrefix(listed, "/")
			if !strings.HasSuffix(previousName, PREVIOUS_SUFFIX) {
				continue
			}
			name := strings.TrimSuffix(previousName, PREVIOUS_SUFFIX)
			replacement, replacementErr := engine.InspectContainer(ctx, name)
			hasReplacement := replacementErr == nil && replacement.State.Running
			isSelf := s.isSelf(summary.ID)
			if hasReplacement && !isSelf && !s.isSelf(replacement.ID) {
				// The previous container is the only rollback target, so it goes only once
				// its replacement passed the check awaitStarted applies. One still starting
				// was cut off mid-verification. The updater's own pair is exempt: a
				// successor running this code is up, whatever its health check says yet.
				hasReplacement = replacement.State.Health == nil || replacement.State.Health.Status == "healthy"
			}
			switch {
			case isSelf && hasReplacement:
				// A successor holds the name and will remove this container.
			case hasReplacement:
				failures = append(failures, engine.RemoveContainer(ctx, summary.ID))
			default:
				// The replacement never came up: put the previous container back.
				failures = append(failures,
					engine.RemoveContainer(ctx, name),
					engine.RenameContainer(ctx, summary.ID, name))
				if !isSelf {
					failures = append(failures, engine.StartContainer(ctx, summary.ID))
				}
			}
		}
	}
	return errors.Join(failures...)
}

func (s *Service) isSelf(containerID string) bool {
	return s.options.SelfID != "" && strings.HasPrefix(containerID, s.options.SelfID)
}

// EnsureLinked attaches the console container to the link network when it is not on
// it, which happens whenever Compose recreates the console.
func (s *Service) EnsureLinked(ctx context.Context) error {
	if s.options.LinkNetwork == "" {
		return nil
	}
	console, err := s.resolveOMC(ctx)
	if err != nil {
		return err
	}
	if _, isAttached := console.NetworkSettings.Networks[s.options.LinkNetwork]; isAttached {
		return nil
	}
	return s.options.Engine.ConnectNetwork(ctx, s.options.LinkNetwork, console.ID, nil)
}

// KeepLinked re-attaches the console after every container start until the context
// ends. The event stream is re-opened after a break, with a pause so a daemon that is
// restarting is not hammered.
func (s *Service) KeepLinked(ctx context.Context, retryDelay time.Duration) {
	if s.options.LinkNetwork == "" {
		return
	}
	link := func() {
		if err := s.EnsureLinked(ctx); err != nil && ctx.Err() == nil {
			s.options.Logger.Warn("could not attach the console to the updater network", "error", err)
		}
	}
	for ctx.Err() == nil {
		link()
		err := s.options.Engine.WatchContainerStarts(ctx, func(string) { link() })
		if ctx.Err() != nil {
			return
		}
		s.options.Logger.Warn("the Docker event stream ended", "error", err)
		select {
		case <-ctx.Done():
		case <-time.After(retryDelay):
		}
	}
}
