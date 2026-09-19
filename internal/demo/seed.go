package demo

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

const (
	// instanceID is the single CPA instance every fixture row belongs to, matching
	// the identifier the application bootstraps.
	instanceID = "default"

	// historyDays spans the dashboard's own calendar grid. The token heatmap draws
	// 53 weeks, so a fixture that stopped at the 30-day window would render a year
	// that is empty except its last column - which is exactly the "obviously a
	// fixture" look the demo has to avoid.
	historyDays = 371

	// requestsPerHour is the rate curve's anchor points, read as "this many requests
	// per hour, this many days ago". A gateway does not appear at its current size:
	// the curve rises towards the present, which is what makes the year-long token
	// grid read as a deployment that grew rather than as a flat wall of traffic.
	// The endpoints are interpolated, so the grid has no step in it.
	recentRequestsPerHour = 18.0
	recentDays            = 30
	midRequestsPerHour    = 7.0
	midDays               = 120
	oldRequestsPerHour    = 2.0
	oldDays               = 240
	oldestRequestPerHour  = 0.3
)

// ResetDatabase deletes the demo's database and its write-ahead siblings, so a
// demo instance always starts from the fixture it would build now rather than
// from the remains of an earlier boot.
//
// Only the demo database is ever removed, and it is named for that purpose: the
// self-hosted database beside it is never touched.
func ResetDatabase(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return errors.New("reset requires a database path")
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(path + suffix); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("reset demo database: %w", err)
		}
	}
	return nil
}

// SeedStats reports what the fixture wrote, so the boot log can say how long a
// cold start spent building the demonstration and a test can assert the shape of
// the history rather than only that the call succeeded.
type SeedStats struct {
	Requests   int
	Prices     int
	Aliases    int
	OldestMS   int64
	NewestMS   int64
	DurationMS int64
}

// Seed fills the demo database with the history a real deployment would have
// accumulated. It is called once, before the server starts, and its output is
// the whole of what the demonstration shows.
//
// Everything it writes goes through the ordinary repository writes - the request
// insert path that locks a price and applies the display-mask rules included - so
// the fixture cannot drift away from the schema or from the rules the live
// capture path obeys. The only exception is the price backfill the request lock
// needs; see SeedModelPriceHistoryBackfill.
func Seed(ctx context.Context, repo *repository.Repository, now time.Time) (SeedStats, error) {
	if repo == nil {
		return SeedStats{}, errors.New("demo seed requires a repository")
	}
	started := time.Now()
	stats := SeedStats{}
	now = now.UTC()
	prices, err := seedPrices(ctx, repo, now)
	if err != nil {
		return SeedStats{}, err
	}
	stats.Prices = prices
	requests, oldest, newest, err := seedRequests(ctx, repo, now)
	if err != nil {
		return SeedStats{}, err
	}
	stats.Requests, stats.OldestMS, stats.NewestMS = requests, oldest, newest
	aliases, err := seedClientKeyAliases(ctx, repo)
	if err != nil {
		return SeedStats{}, err
	}
	stats.Aliases = aliases
	if err := seedRollups(ctx, repo); err != nil {
		return SeedStats{}, err
	}
	stats.DurationMS = time.Since(started).Milliseconds()
	return stats, nil
}

// seedPrices publishes the price list the cost column is computed from, and the
// one historical version the fabricated history is priced against.
func seedPrices(ctx context.Context, repo *repository.Repository, now time.Time) (int, error) {
	rows := make([]repository.ModelPrice, 0, len(priceCatalog()))
	for _, price := range priceCatalog() {
		rows = append(rows, repository.ModelPrice{
			Model:            price.model,
			PromptPricePer1M: price.prompt,
			CompletionPer1M:  price.completion,
			CacheReadPer1M:   price.cacheRead,
			CacheWritePer1M:  price.cacheWrite,
			PriceMultiplier:  1,
			Source:           pricing.SourceManual,
			SyncedAtMS:       now.UnixMilli(),
		})
	}
	if err := repo.UpsertModelPrices(ctx, rows); err != nil {
		return 0, fmt.Errorf("seed model prices: %w", err)
	}
	historyStart := now.AddDate(0, 0, -historyDays).Add(-24 * time.Hour)
	if err := repo.SeedModelPriceHistoryBackfill(ctx, rows, historyStart.UnixMilli()); err != nil {
		return 0, fmt.Errorf("seed price history: %w", err)
	}
	return len(rows), nil
}

// seedClientKeyAliases names the caller keys the request list attributes traffic
// to. The names are Oh My CPA's own metadata, which is the point: the demo shows
// the console rendering an operator-assigned name instead of a mask.
func seedClientKeyAliases(ctx context.Context, repo *repository.Repository) (int, error) {
	for _, key := range gatewayKeyCatalog() {
		fingerprint, err := repo.UsageClientKeyFingerprint(key.value)
		if err != nil {
			return 0, fmt.Errorf("derive caller key identity: %w", err)
		}
		if _, err := repo.SetClientKeyAlias(ctx, instanceID, fingerprint, key.alias, 0); err != nil {
			return 0, fmt.Errorf("seed caller key alias: %w", err)
		}
	}
	return len(gatewayKeyCatalog()), nil
}

// seedRequests writes the request history. Records are generated hour by hour so
// the diurnal shape the dashboard's charts are read for is present, with a lower
// rate for older buckets so a year of history reads as growth rather than as a
// flat plateau.
func seedRequests(ctx context.Context, repo *repository.Repository, now time.Time) (int, int64, int64, error) {
	profiles := modelCatalog()
	keys := gatewayKeyCatalog()
	credentials := credentialAuthIndexes()
	start := now.Truncate(time.Hour).AddDate(0, 0, -historyDays)

	fingerprints := make([]string, 0, len(keys))
	for _, key := range keys {
		fingerprint, err := repo.UsageClientKeyFingerprint(key.value)
		if err != nil {
			return 0, 0, 0, fmt.Errorf("derive caller key identity: %w", err)
		}
		fingerprints = append(fingerprints, fingerprint)
	}

	random := newDeterministic(0x9E3779B97F4A7C15)
	events := make([]usage.Event, 0, 4096)
	hour := start
	for !hour.After(now) {
		// The last bucket is the hour in progress, so its count is scaled by how
		// much of it has already happened. Without that, the 15-minute window would
		// carry a full hour of requests that have not occurred yet.
		fraction := 1.0
		if hour.Equal(now.Truncate(time.Hour)) {
			fraction = float64(now.Minute()*60+now.Second()) / 3600
		}
		count := int(random.nextFloat()*2*requestsPerHour(hour, now)*trafficShape(hour)*fraction + 0.5)
		for index := 0; index < count; index++ {
			profile := pickProfile(random, profiles)
			keyIndex := pickWeighted(random, keyWeights(keys))
			event := buildEvent(random, profile, credentials, hour, now)
			event.APIGroupKey = fingerprints[keyIndex]
			event.APIGroupLabel = "api_key"
			event.APIKeyMask = security.MaskSecret(keys[keyIndex].value)
			events = append(events, event)
		}
		hour = hour.Add(time.Hour)
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		return 0, 0, 0, fmt.Errorf("seed request history: %w", err)
	}
	oldest, newest := int64(0), int64(0)
	for index, event := range events {
		if index == 0 || event.TimestampMS < oldest {
			oldest = event.TimestampMS
		}
		if index == 0 || event.TimestampMS > newest {
			newest = event.TimestampMS
		}
	}
	return len(events), oldest, newest, nil
}

// seedRollups folds the seeded history into both rollup grains through the
// ordinary aggregation path, so the dashboard's long windows read a year of
// history from the same pre-aggregated buckets a live deployment would have.
func seedRollups(ctx context.Context, repo *repository.Repository) error {
	for _, grain := range []struct {
		name     string
		bucketMS int64
	}{
		{repository.CheckpointHourly, repository.HourBucketMS},
		{repository.CheckpointDaily, repository.DayBucketMS},
	} {
		if _, err := repo.AggregateUsageGrain(ctx, grain.name, grain.bucketMS, 20000); err != nil {
			return fmt.Errorf("aggregate demo rollup %s: %w", grain.name, err)
		}
	}
	return nil
}

// credentialAuthIndexes maps a provider to the credential that answers it, so a
// request row and the credential page cannot disagree about which account served
// the traffic.
func credentialAuthIndexes() map[string]string {
	indexes := make(map[string]string)
	for _, item := range credentialCatalog() {
		if _, exists := indexes[item.provider]; !exists {
			indexes[item.provider] = item.authIndex
		}
	}
	indexes["deepseek"] = "auth-ds-01"
	indexes["qwen"] = "auth-qwen-01"
	return indexes
}

// trafficShape is the multiplier for one hour that is not about history: a
// working day with a quiet night, and a lighter weekend.
func trafficShape(hour time.Time) float64 {
	local := hour.UTC()
	diurnal := 0.18 + 0.82*peakWeight(local.Hour())
	switch local.Weekday() {
	case time.Saturday, time.Sunday:
		diurnal *= 0.45
	}
	return diurnal
}

// peakWeight is the share of the day's traffic that falls in one hour. The
// working day peaks in the late afternoon UTC, which is where a Europe-based
// operator's traffic actually peaks.
func peakWeight(hourOfDay int) float64 {
	weight := 0.35
	switch {
	case hourOfDay >= 7 && hourOfDay < 12:
		weight = 0.75 + float64(hourOfDay-7)*0.06
	case hourOfDay >= 12 && hourOfDay < 19:
		weight = 1.0
	case hourOfDay >= 19 && hourOfDay < 23:
		weight = 0.55
	}
	return weight
}

// requestsPerHour is the mean rate one hour of history carries, interpolated
// between the anchors so that neither the rate nor its history shows a step. The
// daily window and the heatmap are both read as trends, and a step would read as
// a change in behaviour that never happened.
func requestsPerHour(hour, now time.Time) float64 {
	daysAgo := now.Sub(hour).Hours() / 24
	points := [][2]float64{{0, recentRequestsPerHour}, {recentDays, midRequestsPerHour}, {midDays, oldRequestsPerHour}, {oldDays, oldestRequestPerHour}}
	// Beyond the last anchor the gateway keeps its oldest rate rather than decaying
	// to nothing: a deployment that carried traffic a year ago carried it.
	if daysAgo <= points[0][0] {
		return points[0][1]
	}
	for index := 1; index < len(points); index++ {
		from, to := points[index-1], points[index]
		if daysAgo > to[0] {
			continue
		}
		progress := (daysAgo - from[0]) / (to[0] - from[0])
		return from[1] + progress*(to[1]-from[1])
	}
	return points[len(points)-1][1]
}

// buildEvent turns one request into the record CPA would have published.
func buildEvent(random *deterministic, profile modelProfile, credentials map[string]string, hour, now time.Time) usage.Event {
	started := hour.Add(time.Duration(random.nextFloat() * float64(time.Hour)))
	if started.After(now) {
		started = now.Add(-time.Duration(random.nextFloat() * 30 * float64(time.Second)))
	}
	failed := random.nextFloat() < profile.failureRate

	input := scaled(random, profile.inputMean)
	output := scaled(random, profile.outputMean)
	reasoning := int64(float64(output) * profile.reasonShare)
	cacheRead := int64(float64(input) * profile.cacheRead * (0.75 + random.nextFloat()*0.5))
	cacheCreation := int64(float64(input) * profile.cacheCreate * (0.6 + random.nextFloat()*0.8))
	latency := scaled(random, profile.latencyMS)
	ttft := int64(float64(latency) * profile.ttftRatio * (0.7 + random.nextFloat()*0.6))

	if failed {
		// A refused request produced no answer. Reporting completion tokens for one
		// would make the request list contradict its own status column.
		output = 0
		reasoning = 0
		cacheCreation = 0
		// A failure still costs the wait that led to it.
		ttft = min64(ttft, latency)
	}

	streamed := true
	event := usage.Event{
		InstanceID:          instanceID,
		EventKey:            fmt.Sprintf("demo-%d-%d", started.UnixMilli(), random.nextUint64()%1_000_000),
		RequestID:           fmt.Sprintf("req_%013x", random.nextUint64()%0xFFFFFFFFFFFFF),
		Provider:            profile.provider,
		Endpoint:            profile.endpoint,
		AuthType:            profile.authType,
		AuthIndex:           credentials[profile.provider],
		Model:               profile.name,
		TimestampMS:         started.UnixMilli(),
		Failed:              failed,
		Generate:            true,
		Stream:              &streamed,
		LatencyMS:           latency,
		TTFTMS:              &ttft,
		InputTokens:         input,
		OutputTokens:        output,
		ReasoningTokens:     reasoning,
		CachedTokens:        cacheRead,
		CacheReadTokens:     cacheRead,
		CacheCreationTokens: cacheCreation,
		TotalTokens:         input + output,
		ExecutorType:        "gateway",
		ServiceTier:         "default",
	}
	// A reasoning model's traces are what make the request detail panel readable,
	// so the effort is recorded for the models that actually think.
	if profile.reasonShare >= 0.4 {
		event.ReasoningEffort = []string{"low", "medium", "high"}[int(random.nextUint64()%3)]
	}
	return event
}

func scaled(random *deterministic, mean int64) int64 {
	if mean <= 0 {
		return 0
	}
	factor := 0.35 + random.nextFloat()*1.45
	return int64(float64(mean) * factor)
}

func min64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}

// pickProfile chooses a model in proportion to its configured traffic share.
func pickProfile(random *deterministic, profiles []modelProfile) modelProfile {
	total := 0
	for _, profile := range profiles {
		total += profile.weight
	}
	target := int(random.nextUint64() % uint64(total))
	for _, profile := range profiles {
		target -= profile.weight
		if target < 0 {
			return profile
		}
	}
	return profiles[len(profiles)-1]
}

func keyWeights(keys []gatewayKey) []int {
	weights := make([]int, 0, len(keys))
	for _, key := range keys {
		weights = append(weights, key.usageWeight)
	}
	return weights
}

func pickWeighted(random *deterministic, weights []int) int {
	total := 0
	for _, weight := range weights {
		total += weight
	}
	target := int(random.nextUint64() % uint64(total))
	for index, weight := range weights {
		target -= weight
		if target < 0 {
			return index
		}
	}
	return len(weights) - 1
}

// deterministic is a small splitmix64 generator.
//
// It is deliberately not math/rand: the fixture must produce the same history on
// every boot, so a reader comparing two demo deployments compares the same
// instance, and a state-carrying generator whose sequence depends on how many
// values were drawn before it is the wrong shape for that. It is not a security
// primitive and is never used for anything a visitor should not be able to
// predict.
type deterministic struct{ state uint64 }

func newDeterministic(seed uint64) *deterministic { return &deterministic{state: seed} }

func (d *deterministic) nextUint64() uint64 {
	d.state += 0x9E3779B97F4A7C15
	value := d.state
	value = (value ^ (value >> 30)) * 0xBF58476D1CE4E5B9
	value = (value ^ (value >> 27)) * 0x94D049BB133111EB
	return value ^ (value >> 31)
}

func (d *deterministic) nextFloat() float64 {
	return float64(d.nextUint64()>>11) / float64(1<<53)
}
