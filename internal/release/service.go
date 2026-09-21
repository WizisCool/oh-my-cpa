package release

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Product keys, matching the repository layer's stored index.
const (
	ProductOMC = repository.ReleaseProductOMC
	ProductCPA = repository.ReleaseProductCPA
)

// Product names the repository a product's releases come from.
type Product struct {
	Key        string
	Repository string
}

// FeedSource reads a repository's releases. It exists so the demonstration can answer
// from its own fixture: a demo must render this page's full capability - an available
// update and a merged change log - while performing no outbound request at all, and a
// seam at the source is what makes that a property of the code rather than a promise
// about the network.
type FeedSource interface {
	FetchReleases(ctx context.Context, repository, etag string) (Feed, error)
}

// Service observes both products' published versions.
type Service struct {
	repository *repository.Repository
	client     FeedSource
	logger     *slog.Logger
	products   []Product

	mutex sync.Mutex
	// bodies holds release notes for the current process only.
	//
	// They are deliberately not persisted - the operator chose that, and it keeps
	// untrusted remote prose out of the database that holds the audit trail. The
	// consequence is stated in the UI: after a restart the index still answers
	// "is there a newer version", while the notes themselves are unavailable until
	// the next successful check.
	bodies map[string]map[string]string
	// etags holds each product's validator, and it is only ever used while the
	// notes it describes are still in `bodies`: a validator is a claim about a
	// representation, so keeping one without its body would let a 304 assert
	// "unchanged" about notes this process cannot show.
	etags map[string]string
	// checking records which products have a check in flight, so the page can show
	// progress without waiting for one.
	checking map[string]bool
	// truncatedByProduct records whether the last stored index came from a walk that
	// stopped at its page limit.
	truncatedByProduct map[string]bool
	// checkLocks serialises checks per product. Checks are deliberately unthrottled, so
	// two of them can be in flight at once - a page load and a click, or two operators'
	// browsers - and without this the slower one would overwrite the faster one's newer
	// result with its own older snapshot. A lock rather than a cooldown: the second
	// check still runs and still fetches, it just cannot publish out of order.
	checkLocks map[string]*sync.Mutex
	// singlePageByProduct records whether the cached index came from a one-page read.
	// A validator only describes the page it came from, so a conditional request is
	// only safe while the cached snapshot was that single page.
	singlePageByProduct map[string]bool
}

// Options configures the service.
type Options struct {
	Repository *repository.Repository
	Logger     *slog.Logger
	// OMCRepository and CPARepository are validated "owner/name" identifiers.
	OMCRepository string
	CPARepository string
	// Client overrides the feed source. Tests point it at a stub server and the
	// demonstration at its fixture; production leaves it nil for the GitHub client.
	Client FeedSource
}

// New builds the service.
//
// A repository identifier that does not validate is refused here rather than at
// request time: it can only come from configuration, and failing at startup is
// the difference between a misconfiguration the operator sees and an update
// indicator that silently never works.
func New(options Options) (*Service, error) {
	if options.Repository == nil {
		return nil, errors.New("release service requires a repository")
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	client := options.Client
	if client == nil {
		client = NewClient()
	}
	products := make([]Product, 0, 2)
	for _, candidate := range []Product{
		{Key: ProductOMC, Repository: strings.TrimSpace(options.OMCRepository)},
		{Key: ProductCPA, Repository: strings.TrimSpace(options.CPARepository)},
	} {
		if candidate.Repository == "" {
			continue
		}
		if err := ValidateRepository(candidate.Repository); err != nil {
			return nil, fmt.Errorf("release source for %s: %w", candidate.Key, err)
		}
		products = append(products, candidate)
	}
	if len(products) == 0 {
		return nil, errors.New("release service requires at least one product source")
	}
	service := &Service{
		repository:          options.Repository,
		client:              client,
		logger:              logger,
		products:            products,
		bodies:              make(map[string]map[string]string, len(products)),
		etags:               make(map[string]string, len(products)),
		checking:            make(map[string]bool, len(products)),
		truncatedByProduct:  make(map[string]bool, len(products)),
		checkLocks:          make(map[string]*sync.Mutex, len(products)),
		singlePageByProduct: make(map[string]bool, len(products)),
	}
	for _, product := range products {
		service.checkLocks[product.Key] = &sync.Mutex{}
	}
	return service, nil
}

// Products returns the configured sources.
func (s *Service) Products() []Product {
	return append([]Product(nil), s.products...)
}

// ProductFor returns the source configured for a product key.
func (s *Service) ProductFor(key string) (Product, bool) {
	for _, product := range s.products {
		if product.Key == key {
			return product, true
		}
	}
	return Product{}, false
}

// ForgetStoredValidators drops persisted ETags at start-up.
//
// The validators describe bodies that lived in the previous process. Keeping them
// would make the first check after a restart answer 304 and leave the console
// claiming "nothing changed" about notes it cannot show.
func (s *Service) ForgetStoredValidators(ctx context.Context) error {
	return s.repository.ClearReleaseCheckValidators(ctx)
}

// CheckAll checks every product, independently.
//
// Independence is the point: one product's failure must not prevent or hide the
// other's result, because they have separate feeds, separate budgets and separate
// reasons to fail.
func (s *Service) CheckAll(ctx context.Context) {
	for _, product := range s.products {
		if ctx.Err() != nil {
			return
		}
		if _, err := s.CheckNow(ctx, product.Key); err != nil {
			s.logger.Warn("release check failed", "product", product.Key, "error", err)
		}
	}
}

// CheckNow performs a real read of the feed, ignoring the floor. It exists for the
// background sweep and for a caller that has a reason to spend a request; the page uses
// Check.
func (s *Service) CheckNow(ctx context.Context, productKey string) (Comparison, error) {
	comparison, _, err := s.check(ctx, productKey, true)
	return comparison, err
}

// Check answers a product's version question, reading the feed only when the floor has
// passed. Within the floor it returns the stored answer.
func (s *Service) Check(ctx context.Context, productKey string) (Comparison, error) {
	comparison, _, err := s.check(ctx, productKey, false)
	return comparison, err
}

// CheckReportingFreshness answers the same question and additionally reports whether the
// feed was actually read, so a caller can tell a real check from an answer the floor served.
// The flag comes from inside the check rather than from a second look at the clock, so the
// caller cannot be told "cached" about a request that was in fact spent.
func (s *Service) CheckReportingFreshness(ctx context.Context, productKey string) (bool, error) {
	_, read, err := s.check(ctx, productKey, false)
	// `read` is returned even when the check failed. A failed attempt DID spend a request, and
	// reporting it as a cached answer would tell the operator the page is showing a stored
	// result when it in fact tried the feed and was refused - the opposite of what happened.
	return read, err
}

// check reads one product's feed and records the outcome, reporting whether the feed was
// read or the stored answer served.
//
// An error means the check failed, and the stored index is left exactly as it was: the page
// then reports the previous answer with the reason the new attempt failed, rather than going
// blank or presenting stale data as current.
func (s *Service) check(ctx context.Context, productKey string, force bool) (Comparison, bool, error) {
	product, ok := s.ProductFor(productKey)
	if !ok {
		return Comparison{}, false, fmt.Errorf("unknown release product %q", productKey)
	}

	// One check per product at a time, so two concurrent checks cannot publish their
	// results out of order.
	if lock := s.checkLock(product.Key); lock != nil {
		lock.Lock()
		defer lock.Unlock()
	}

	// Reuse the stored answer rather than spending a shared budget on a question that was
	// just answered. `attempted_at_ms` is the right clock for this: a failed attempt also
	// must not be repeated immediately, or a broken feed would be hammered and the operator
	// would see the same error re-fetched on every page view.
	if !force && s.withinFloor(ctx, productKey) {
		return s.comparisonFor(ctx, productKey, ""), false, nil
	}

	// The bookkeeping below runs on a context detached from the caller's, and the reason is
	// visible in the failure it prevents: a browser that navigated away mid-check cancelled the
	// context, the `running` flag written by the attempt was never cleared by the outcome, and
	// the page then reported "checking" for a check that had stopped. Once a check has been
	// started its result is a fact about the stored index, not a favour to the caller who asked.
	//
	// Cancellation still reaches the feed read itself, which is the part that should stop when
	// nobody is waiting for it.
	bookkeeping := context.WithoutCancel(ctx)

	if err := s.repository.RecordReleaseCheckAttempt(bookkeeping, product.Key, product.Repository); err != nil {
		return Comparison{}, false, err
	}
	s.setChecking(product.Key, true)
	defer s.setChecking(product.Key, false)

	// From here the attempt is recorded as running, so every exit must record an outcome. The
	// attempt sets `running = 1`, and `Status` reports `Checking` from it, so a path that
	// returns an error without recording one leaves the page claiming a check is in progress
	// until a later check succeeds or the process restarts. Funnelling the store failures
	// through `fail` is what makes that a property of the code rather than of remembering.
	fail := func(cause error) (Comparison, bool, error) {
		recordErr := s.repository.RecordReleaseCheckFailure(bookkeeping, product.Key, cause.Error())
		if recordErr != nil {
			s.logger.Warn("could not record release check failure", "product", product.Key, "error", recordErr)
		}
		return Comparison{}, true, cause
	}

	// A conditional request is only sent while this process still holds the notes it
	// would be validating AND the cached snapshot came from a single page. A validator
	// describes one representation: page one's ETag cannot speak for page two, so a 304
	// on a multi-page read would leave the older pages unverified while the code
	// assumed the whole snapshot was current.
	etag := ""
	if s.hasBodies(product.Key) && s.isSinglePage(product.Key) {
		etag = s.currentETag(product.Key)
	}

	feed, err := s.client.FetchReleases(ctx, product.Repository, etag)
	if err != nil {
		// Redacted on the way through `fail`: the feed is remote text and the stored reason is
		// shown in the console.
		return fail(err)
	}

	if feed.NotModified {
		// The stored index is still correct and the in-memory notes are still the
		// ones it describes.
		if err := s.repository.RecordReleaseCheckSuccess(bookkeeping, product.Key, product.Repository, s.latestTag(product.Key), s.currentETag(product.Key), s.truncated(product.Key)); err != nil {
			return fail(err)
		}
		return s.comparisonFor(ctx, product.Key, ""), true, nil
	}

	releases := sortReleases(feed.Releases)
	records := make([]repository.ReleaseRecord, 0, len(releases))
	bodies := make(map[string]string, len(releases))
	for _, item := range releases {
		records = append(records, repository.ReleaseRecord{
			Product:       product.Key,
			Repository:    product.Repository,
			Tag:           item.Tag,
			Name:          item.Name,
			PublishedAtMS: item.PublishedAtMS(),
			Prerelease:    item.Prerelease,
		})
		bodies[item.Tag] = item.Body
	}

	if err := s.repository.ReplaceReleaseIndex(bookkeeping, product.Key, product.Repository, records); err != nil {
		return fail(err)
	}

	// Notes are installed only after the index that describes them is stored, so
	// the two cannot disagree about which release exists.
	s.setBodies(product.Key, bodies, feed.ETag, feed.PageCount <= 1)

	s.setTruncated(product.Key, feed.Truncated)
	if err := s.repository.RecordReleaseCheckSuccess(bookkeeping, product.Key, product.Repository, latestStableTag(releases), feed.ETag, feed.Truncated); err != nil {
		return fail(err)
	}
	return s.comparisonFor(ctx, product.Key, ""), true, nil
}

// withinFloor reports whether the last attempt is recent enough to answer from the store.
func (s *Service) withinFloor(ctx context.Context, productKey string) bool {
	product, ok := s.ProductFor(productKey)
	if !ok {
		return false
	}
	state, err := s.repository.GetReleaseCheckStateForRepository(ctx, productKey, product.Repository)
	if err != nil {
		// An unreadable store is not a reason to spend a request: the caller still gets
		// whatever the store can answer, and the next attempt will try again.
		return true
	}
	if state.LastAttemptAtMS == nil {
		return false
	}
	return time.Since(time.UnixMilli(*state.LastAttemptAtMS)) < CheckFloor
}

func (s *Service) setChecking(productKey string, checking bool) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.checking[productKey] = checking
}

func (s *Service) isChecking(productKey string) bool {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.checking[productKey]
}

func (s *Service) hasBodies(productKey string) bool {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return len(s.bodies[productKey]) > 0
}

func (s *Service) setBodies(productKey string, bodies map[string]string, etag string, singlePage bool) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.bodies[productKey] = bodies
	s.etags[productKey] = etag
	s.singlePageByProduct[productKey] = singlePage
}

func (s *Service) isSinglePage(productKey string) bool {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.singlePageByProduct[productKey]
}

func (s *Service) checkLock(productKey string) *sync.Mutex {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.checkLocks[productKey]
}

func (s *Service) bodyFor(productKey, tag string) (string, bool) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	body, ok := s.bodies[productKey][tag]
	return body, ok
}

func (s *Service) currentETag(productKey string) string {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.etags[productKey]
}

// setBodies records whether the walk that produced this index was truncated.
//
// The fact is kept in memory beside the notes and also stored, because the page has
// to be able to state that the interval it shows is not fully known - and only the
// reader of the feed knows whether it stopped early.
func (s *Service) setTruncated(productKey string, truncated bool) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.truncatedByProduct[productKey] = truncated
}

func (s *Service) truncated(productKey string) bool {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.truncatedByProduct[productKey]
}

// latestTag returns the newest stored tag for a product, used when a 304 confirms
// the index without restating it.
func (s *Service) latestTag(productKey string) string {
	product, ok := s.ProductFor(productKey)
	if !ok {
		return ""
	}
	records, err := s.repository.ListReleases(context.Background(), productKey, product.Repository)
	if err != nil {
		return ""
	}
	releases := make([]Release, 0, len(records))
	for _, record := range records {
		releases = append(releases, Release{Tag: record.Tag, Prerelease: record.Prerelease})
	}
	return latestStableTag(sortReleases(releases))
}

// comparisonFor compares a running version against the stored index.
func (s *Service) comparisonFor(ctx context.Context, productKey, runningVersion string) Comparison {
	product, ok := s.ProductFor(productKey)
	if !ok {
		return Comparison{State: UpdateIndeterminate, Why: ReasonNoData}
	}
	state, err := s.repository.GetReleaseCheckStateForRepository(ctx, productKey, product.Repository)
	if err != nil {
		return Comparison{State: UpdateIndeterminate, Why: ReasonNoData}
	}
	latest := state.LatestTag
	if latest == "" {
		records, err := s.repository.ListReleases(ctx, productKey, product.Repository)
		if err == nil {
			releases := make([]Release, 0, len(records))
			for _, record := range records {
				releases = append(releases, Release{Tag: record.Tag, Prerelease: record.Prerelease})
			}
			latest = latestStableTag(sortReleases(releases))
		}
	}
	comparison := CompareVersions(runningVersion, latest)
	if comparison.State == UpdateIndeterminate && comparison.Why == ReasonNoReleases {
		if state.LastAttemptAtMS == nil {
			comparison.Why = ReasonNoData
		}
	}
	return comparison
}

// ProductStatus is one product's version answer, for the page's cards.
type ProductStatus struct {
	Product        string
	Repository     string
	RepositoryURL  string
	RunningVersion string
	LatestVersion  string
	Comparison     Comparison
	CheckedAtMS    *int64
	AttemptedAtMS  *int64
	CheckError     string
	Checking       bool
	// MergeCount is how many releases the merged change log would contain.
	MergeCount int
	// RangeComplete is false when the feed walk stopped early, so the console can
	// say the interval is not fully known instead of implying it is.
	RangeComplete bool
	// NotesAvailable is false when this process holds no release notes, which is
	// the normal state after a restart or while offline.
	NotesAvailable bool
}

// Status answers one product's version question.
func (s *Service) Status(ctx context.Context, productKey, runningVersion string) (ProductStatus, error) {
	product, ok := s.ProductFor(productKey)
	if !ok {
		return ProductStatus{}, fmt.Errorf("unknown release product %q", productKey)
	}
	state, err := s.repository.GetReleaseCheckStateForRepository(ctx, productKey, product.Repository)
	if err != nil {
		return ProductStatus{}, err
	}
	status := ProductStatus{
		Product:        product.Key,
		Repository:     product.Repository,
		RepositoryURL:  RepositoryURL(product.Repository),
		RunningVersion: strings.TrimSpace(runningVersion),
		LatestVersion:  state.LatestTag,
		CheckedAtMS:    state.LastSuccessAtMS,
		AttemptedAtMS:  state.LastAttemptAtMS,
		CheckError:     state.LastError,
		Checking:       s.isChecking(productKey) || state.Running,
		NotesAvailable: s.hasBodies(productKey),
	}
	status.Comparison = s.comparisonFor(ctx, productKey, runningVersion)
	if status.Comparison.LatestVersion == "" {
		status.Comparison.LatestVersion = state.LatestTag
	}

	releases, err := s.selectNotes(ctx, productKey, runningVersion, status.Comparison.LatestVersion)
	if err != nil {
		return status, err
	}
	status.MergeCount = len(releases)
	records, err := s.repository.ListReleases(ctx, productKey, product.Repository)
	if err != nil {
		return status, err
	}
	status.RangeComplete = rangeIsComplete(state, records, runningVersion, status.Comparison.LatestVersion)
	return status, nil
}

// ReleaseEntry is one release in the merged change log.
type ReleaseEntry struct {
	Tag           string
	Name          string
	PublishedAtMS int64
	Prerelease    bool
	Body          string
	HTMLURL       string
	// InRange is true when this release is part of the interval between the running
	// version and the newest one.
	InRange bool
	// BodyAvailable is false when the notes are not held by this process. The entry
	// still names the release and links to it, which is what keeps the page honest
	// rather than empty.
	BodyAvailable bool
}

// MergedLog is a product's releases plus the comparison that selected them.
type MergedLog struct {
	Product        string
	Repository     string
	RepositoryURL  string
	RunningVersion string
	LatestVersion  string
	Comparison     Comparison
	Releases       []ReleaseEntry
	// RangeComplete is false when the feed walk was truncated.
	RangeComplete bool
	CheckedAtMS   *int64
	AttemptedAtMS *int64
	CheckError    string
	Checking      bool
}

// Releases returns the merged change log for one product.
//
// The set shown is the interval from the running version to the newest release.
// When the running version cannot be compared - a development or fork build - no
// interval is claimed: the newest release is shown alone and the comparison says
// why. Inventing a range in that case would describe changes the operator may
// already have.
func (s *Service) Releases(ctx context.Context, productKey, runningVersion string) (MergedLog, error) {
	product, ok := s.ProductFor(productKey)
	if !ok {
		return MergedLog{}, fmt.Errorf("unknown release product %q", productKey)
	}
	state, err := s.repository.GetReleaseCheckStateForRepository(ctx, productKey, product.Repository)
	if err != nil {
		return MergedLog{}, err
	}
	log := MergedLog{
		Product:        product.Key,
		Repository:     product.Repository,
		RepositoryURL:  RepositoryURL(product.Repository),
		RunningVersion: strings.TrimSpace(runningVersion),
		LatestVersion:  state.LatestTag,
		CheckedAtMS:    state.LastSuccessAtMS,
		AttemptedAtMS:  state.LastAttemptAtMS,
		CheckError:     state.LastError,
		Checking:       s.isChecking(productKey) || state.Running,
	}
	log.Comparison = s.comparisonFor(ctx, productKey, runningVersion)
	if log.Comparison.LatestVersion == "" {
		log.Comparison.LatestVersion = state.LatestTag
	}
	records, err := s.repository.ListReleases(ctx, productKey, product.Repository)
	if err != nil {
		return log, err
	}
	log.RangeComplete = rangeIsComplete(state, records, runningVersion, log.Comparison.LatestVersion)
	candidates := make([]rangeCandidate, 0, len(records))
	for _, record := range records {
		candidates = append(candidates, rangeCandidate{Tag: record.Tag, Prerelease: record.Prerelease})
	}
	inRange := make(map[string]bool)
	for _, tag := range SelectRange(candidates, runningVersion, log.Comparison.LatestVersion) {
		inRange[tag] = true
	}

	selected := make([]repository.ReleaseRecord, 0, len(records))
	if len(inRange) == 0 {
		// No computable interval: show the newest stable release alone rather than
		// asserting a range.
		if newest, ok := newestStable(records); ok {
			selected = append(selected, newest)
		}
	} else {
		for _, record := range records {
			if inRange[record.Tag] {
				selected = append(selected, record)
			}
		}
	}

	// Order by version, not by the order the rows came back in. The stored index is
	// ordered by publication time, and a feed can publish a backport after a newer
	// release - which would otherwise render the change log with a patch release above
	// the release that supersedes it, contradicting what the interval claims to show.
	sortRecordsByVersion(selected)

	log.Releases = make([]ReleaseEntry, 0, len(selected))
	for _, record := range selected {
		body, held := s.bodyFor(productKey, record.Tag)
		log.Releases = append(log.Releases, ReleaseEntry{
			Tag:           record.Tag,
			Name:          record.Name,
			PublishedAtMS: record.PublishedAtMS,
			Prerelease:    record.Prerelease,
			Body:          body,
			HTMLURL:       ReleaseURL(product.Repository, record.Tag),
			InRange:       inRange[record.Tag],
			BodyAvailable: held,
		})
	}
	return log, nil
}

// selectNotes counts the releases the merged log would contain, for the card.
func (s *Service) selectNotes(ctx context.Context, productKey, runningVersion, latestVersion string) ([]string, error) {
	product, ok := s.ProductFor(productKey)
	if !ok {
		return nil, nil
	}
	records, err := s.repository.ListReleases(ctx, productKey, product.Repository)
	if err != nil {
		return nil, err
	}
	candidates := make([]rangeCandidate, 0, len(records))
	for _, record := range records {
		candidates = append(candidates, rangeCandidate{Tag: record.Tag, Prerelease: record.Prerelease})
	}
	selected := SelectRange(candidates, runningVersion, latestVersion)
	if len(selected) == 0 {
		if _, ok := newestStable(records); ok {
			return []string{"newest"}, nil
		}
	}
	return selected, nil
}

// rangeIsComplete reports whether the interval the change log claims is fully known.
//
// A truncated walk means the feed stopped at its page limit, but that alone does not make
// the interval incomplete, and treating it as incomplete raised a false alarm on the page.
// The walk keeps the NEWEST releases, so anything it dropped is OLDER than the oldest
// release it kept: when the running version is at or below that oldest release, every
// release after the running version was read, and the interval is complete whatever was
// left behind. The uncertainty is real only while the running version sits above the
// oldest release read - that is, when the missing older releases could still be inside the
// interval - or when the running version cannot be placed on the version line at all.
func rangeIsComplete(state repository.ReleaseCheckState, records []repository.ReleaseRecord, runningVersion, latestVersion string) bool {
	if !state.Truncated {
		return true
	}
	running, err := ParseVersion(runningVersion)
	if err != nil {
		return false
	}
	var oldest repository.ReleaseRecord
	found := false
	for _, record := range records {
		if record.Prerelease {
			continue
		}
		parsed, parseErr := ParseVersion(record.Tag)
		if parseErr != nil {
			continue
		}
		if !found {
			oldest, found = record, true
			continue
		}
		oldestParsed, _ := ParseVersion(oldest.Tag)
		if parsed.Compare(oldestParsed) < 0 {
			oldest = record
		}
	}
	if !found {
		return false
	}
	oldestParsed, err := ParseVersion(oldest.Tag)
	if err != nil {
		return false
	}
	// Complete when the running version is at or above the oldest release that was read:
	// everything after the running version is then inside what was read. It is incomplete
	// when the running version is older, because the releases the walk dropped sit between
	// the running version and the oldest release read, which is exactly the part of the
	// interval that is missing.
	return running.Compare(oldestParsed) >= 0
}

// sortRecordsByVersion orders records newest-first by version, using the tag text as
// a stable tie-break so equal versions keep a deterministic order.
func sortRecordsByVersion(records []repository.ReleaseRecord) {
	sort.SliceStable(records, func(left, right int) bool {
		return compareTagStrings(records[left].Tag, records[right].Tag) > 0
	})
}

// RepositoryURL is the human-facing repository page.
func RepositoryURL(repository string) string {
	return "https://github.com/" + repository
}

// ReleaseURL is the human-facing release page.
func ReleaseURL(repository, tag string) string {
	return "https://github.com/" + repository + "/releases/tag/" + tag
}

// sortReleases orders releases newest-first by version, so a backport published
// after a newer release does not appear above it.
func sortReleases(releases []Release) []Release {
	sorted := make([]Release, len(releases))
	copy(sorted, releases)
	sort.SliceStable(sorted, func(left, right int) bool {
		return compareTagStrings(sorted[left].Tag, sorted[right].Tag) > 0
	})
	return sorted
}

// latestStableTag returns the newest non-prerelease tag, which is the version an
// operator would be offered.
func latestStableTag(releases []Release) string {
	for _, item := range releases {
		if !item.Prerelease {
			return item.Tag
		}
	}
	return ""
}

func newestStable(records []repository.ReleaseRecord) (repository.ReleaseRecord, bool) {
	releases := make([]Release, 0, len(records))
	for _, record := range records {
		releases = append(releases, Release{Tag: record.Tag, Prerelease: record.Prerelease})
	}
	tags := make([]string, 0, len(releases))
	for _, item := range releases {
		if !item.Prerelease {
			tags = append(tags, item.Tag)
		}
	}
	if len(tags) == 0 {
		return repository.ReleaseRecord{}, false
	}
	newest := SortTagsDescending(tags)[0]
	for _, record := range records {
		if record.Tag == newest {
			return record, true
		}
	}
	return repository.ReleaseRecord{}, false
}

// CheckFloor is the shortest interval between two real requests to the feed.
//
// It exists because "unthrottled" was measured and found wrong. The feed is one shared,
// per-address budget - sixty requests an hour for the unauthenticated GitHub API - and one
// check costs up to two requests per product, because a walk may read two pages. The page
// checks on load and is loaded far more often than a release is published, so fifteen page
// views could spend the whole allowance for every client behind that address, including
// other tools the operator runs. That is not hypothetical: it is what happened, and the
// console reported the exhausted limit instead of a version.
//
// The arithmetic is what sets the value. A check is at most two requests per product and
// there are two products, so one refresh costs at most four requests; at a fifteen-minute
// floor that is at most four refreshes an hour, sixteen requests, leaving well over half of
// the shared budget for everything else on the address. A shorter floor does not fit: five
// minutes allows forty-eight requests an hour and leaves almost no headroom, which is the
// state that produced the failure.
//
// It is measured from the last *attempt*, not the last success, so a feed that is failing is
// not retried on every page view either - a broken feed is exactly when an operator reloads
// most, and re-learning the same error spends the budget twice over.
const CheckFloor = 15 * time.Minute

// SweepInterval is how often the background check runs.
//
// Six hours is a deliberate compromise for a self-hosted deployment: frequent
// enough that a release is noticed the same day, rare enough that the
// unauthenticated GitHub budget of sixty requests per hour is never a concern from
// the sweep itself - two products twice a day is eight requests.
const SweepInterval = 6 * time.Hour

// Run sweeps until the context ends.
//
// The first sweep is delayed rather than run at start-up so that a restart loop
// cannot turn into a request loop against a rate-limited endpoint.
func (s *Service) Run(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		interval = SweepInterval
	}
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
			s.CheckAll(ctx)
			timer.Reset(interval)
		}
	}
}
