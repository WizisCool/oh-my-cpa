package demo

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
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
	Audits     int
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
	if err := ensureInstance(ctx, repo, now); err != nil {
		return SeedStats{}, err
	}
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
	audits, err := seedAudit(ctx, repo, now)
	if err != nil {
		return SeedStats{}, err
	}
	stats.Audits = audits
	if err := seedRollups(ctx, repo); err != nil {
		return SeedStats{}, err
	}
	if err := seedCustomIcon(ctx, repo, now); err != nil {
		return SeedStats{}, err
	}
	if err := seedQuotaObservations(ctx, repo, now); err != nil {
		return SeedStats{}, err
	}
	stats.DurationMS = time.Since(started).Milliseconds()
	return stats, nil
}

// ensureInstance creates the CPA instance row the seeded records belong to.
//
// The application bootstraps the same row before seeding, with the key it encrypted
// from the environment, so this is a no-op there. It exists so the fixture is
// self-sufficient: a database that holds usage records without the instance they
// reference cannot be opened at all, and a fixture that only works in one call order
// is one that fails in a test rather than in the product.
func ensureInstance(ctx context.Context, repo *repository.Repository, now time.Time) error {
	if _, err := repo.GetInstance(ctx, instanceID); err == nil {
		return nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read demo instance: %w", err)
	}
	return repo.UpsertInstance(ctx, domain.CPAInstance{
		ID:      instanceID,
		Name:    fixtureInstanceName,
		BaseURL: "http://127.0.0.1:8317",
		Status:  "ok",
		// Placeholder ciphertext: the columns are NOT NULL, and the application replaces
		// this row at start-up with the key it encrypted from the environment.
		ManagementKeyCiphertext: []byte{0},
		ManagementKeyNonce:      []byte{0},
		CreatedAt:               now,
		UpdatedAt:               now,
	})
}

// seedPrices publishes the price book the cost column is computed from: the
// OpenRouter snapshot the picker reads, the catalogue that decides which rows the
// page shows, a price per served model (matched automatically, pinned, or set by
// hand), the channel multipliers, and the one historical version of each that the
// fabricated history is priced against.
//
// The catalogue is part of the fixture because a self-hosted deployment fills it
// from the gateway's own model list during a sync, and the demo deliberately runs
// no sync. Without it the pricing page would intersect the stored prices with an
// empty catalogue and render nothing at all.
func seedPrices(ctx context.Context, repo *repository.Repository, now time.Time) (int, error) {
	upstream, err := pricing.DecodeOpenRouter(openRouterSnapshot)
	if err != nil {
		return 0, fmt.Errorf("decode OpenRouter snapshot: %w", err)
	}
	if err := repo.ReplaceUpstreamCatalog(ctx, upstream); err != nil {
		return 0, fmt.Errorf("seed OpenRouter snapshot: %w", err)
	}
	catalog := pricing.NewCatalog(upstream, now)
	custom := make(map[string]priceRow, len(customPriceCatalog()))
	for _, row := range customPriceCatalog() {
		custom[row.model] = row
	}
	syncedAt := now.Add(-3 * time.Hour).UnixMilli()
	matched := int64(0)
	rows := make([]repository.ModelPrice, 0, len(modelCatalog()))
	for _, profile := range modelCatalog() {
		if row, ok := custom[profile.name]; ok {
			rows = append(rows, repository.ModelPrice{
				Model: row.model, PromptPricePer1M: row.prompt, CompletionPer1M: row.completion,
				CacheReadPer1M: row.cacheRead, CacheWritePer1M: row.cacheWrite, PriceMultiplier: 1, Source: pricing.SourceManual,
			})
			continue
		}
		if pin, ok := linkedModels[profile.name]; ok {
			model, found := catalog.Lookup(pin)
			if !found {
				return 0, fmt.Errorf("pinned model %q is not in the OpenRouter snapshot", pin)
			}
			rows = append(rows, model.PriceFor(profile.name, pricing.MatchLinked, 1, syncedAt))
			matched++
			continue
		}
		// Every other served model must match on its own, the way a sync would match
		// it; a fixture model that does not is a fixture error, not an unpriced row.
		match, found := catalog.MatchModel(profile.name)
		if !found {
			return 0, fmt.Errorf("served model %q matches nothing in the OpenRouter snapshot", profile.name)
		}
		rows = append(rows, match.Model.PriceFor(profile.name, match.Kind, 1, syncedAt))
		matched++
	}
	if _, err := repo.ReplacePricingModels(ctx, pricingCatalogTargets(), pricingProviderCatalog()...); err != nil {
		return 0, fmt.Errorf("seed pricing catalogue: %w", err)
	}
	if err := repo.UpsertModelPrices(ctx, rows); err != nil {
		return 0, fmt.Errorf("seed model prices: %w", err)
	}
	for model, pin := range linkedModels {
		for _, row := range rows {
			if row.Model == model {
				if err := repo.ApplyModelPrice(ctx, row, pin); err != nil {
					return 0, fmt.Errorf("seed model pin: %w", err)
				}
			}
		}
	}
	historyStart := now.AddDate(0, 0, -historyDays).Add(-24 * time.Hour)
	if err := repo.SeedModelPriceHistoryBackfill(ctx, rows, historyStart.UnixMilli()); err != nil {
		return 0, fmt.Errorf("seed price history: %w", err)
	}
	channels := make([]pricing.ChannelMultiplier, 0, len(channelCatalog()))
	for _, row := range channelCatalog() {
		channel := pricing.ChannelMultiplier{Channel: row.channel, Multiplier: row.multiplier, Note: row.note}
		if err := repo.UpsertChannelMultiplier(ctx, channel); err != nil {
			return 0, fmt.Errorf("seed channel multiplier: %w", err)
		}
		channels = append(channels, channel)
	}
	if err := repo.SeedChannelHistoryBackfill(ctx, channels, historyStart.UnixMilli()); err != nil {
		return 0, fmt.Errorf("seed channel history: %w", err)
	}
	// The sync bookkeeping is what the pricing page prints beside its rows. A
	// fixture that left it untouched would show "never synced" on a page whose
	// prices are present, which reads as a broken sync rather than as a demo.
	state := pricing.SyncState{
		Source:                pricing.SourceOpenRouter,
		LastSuccessAtMS:       &syncedAt,
		UpdatedAtMS:           syncedAt,
		LastMatched:           matched,
		LastUnmatched:         int64(len(unpricedCatalogModels)),
		AutoSyncIntervalHours: 24,
	}
	if err := repo.SavePricingSyncState(ctx, state); err != nil {
		return 0, fmt.Errorf("seed pricing sync state: %w", err)
	}
	return len(rows), nil
}

// pricingCatalogTargets is the model catalogue the pricing page resolves prices
// against, keyed by the model the gateway serves and valued by the identity a
// price is matched under. The fixture serves every model under its own name.
func pricingCatalogTargets() map[string]string {
	targets := make(map[string]string)
	for _, model := range modelCatalog() {
		targets[model.name] = model.name
	}
	for _, model := range unpricedCatalogModels {
		targets[model] = model
	}
	return targets
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
	session := workSession{}
	hour := start
	for !hour.After(now) {
		// The last bucket is the hour in progress, so its count is scaled by how
		// much of it has already happened. Without that, the 15-minute window would
		// carry a full hour of requests that have not occurred yet.
		fraction := 1.0
		if hour.Equal(now.Truncate(time.Hour)) {
			fraction = float64(now.Minute()*60+now.Second()) / 3600
		}
		session = session.advance(random, profiles, hour, now)
		count := drawRequestCount(random, requestsPerHour(hour, now)*trafficShape(hour)*daySwing(hour)*fraction)
		for index := 0; index < count; index++ {
			profile := session.pickProfile(random, profiles)
			keyIndex := pickWeighted(random, keyWeights(keys))
			event := buildEvent(random, profile, credentials, hour, now)
			event.APIGroupKey = fingerprints[keyIndex]
			event.APIGroupLabel = "api_key"
			event.APIKeyMask = security.MaskSecret(keys[keyIndex].value)
			events = append(events, event)
		}
		hour = hour.Add(time.Hour)
	}
	// The fifteen-minute window is the shortest the dashboard offers and the first one a
	// visitor reads, and random placement inside the current hour can leave it empty: at
	// an hour boundary the partial-hour share is zero, and a little past one the events
	// that do exist were placed at random offsets that may all be older than the window.
	// It is filled explicitly rather than left to chance, because an empty shortest
	// window is indistinguishable from a demo that is not working.
	events = append(events, fillRecentWindow(random, session, profiles, credentials, fingerprints, keys, events, now)...)
	events = append(events, recentSubstitutions(random, profiles, credentials, fingerprints, keys, now)...)
	// Keep the adjacent-cycle reference backed by captured traffic even when
	// random history happens to route every Codex request to the first account.
	for _, profile := range profiles {
		if profile.provider != "codex" {
			continue
		}
		for _, offset := range []time.Duration{4 * time.Hour, 5 * time.Hour, 6 * time.Hour} {
			event := buildEventAt(random, profile, credentials, now.Add(-offset))
			event.AuthIndex = "auth-codex-02"
			event.APIGroupKey = fingerprints[0]
			event.APIGroupLabel = "api_key"
			event.APIKeyMask = security.MaskSecret(keys[0].value)
			events = append(events, event)
		}
		break
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

// seedRollups folds the seeded history into the usage facts through the
// ordinary fold, so the dashboard reads a year of history from the same tables
// a live deployment would have.
func seedRollups(ctx context.Context, repo *repository.Repository) error {
	for {
		folded, err := repo.AggregateUsageFacts(ctx, 20000)
		if err != nil {
			return fmt.Errorf("fold demo usage facts: %w", err)
		}
		if folded < 20000 {
			return nil
		}
	}
}

// recentWindow is the shortest window the dashboard offers.
const recentWindow = 15 * time.Minute

// recentWindowFloor is how many requests the shortest window always carries.
//
// Four rather than one: the window prints a success rate and a per-minute rate, and a
// single sample makes both of them the same number as the sample itself.
const recentWindowFloor = 4

// fillRecentWindow tops the seeded history up so the most recent window is never empty.
//
// It reads what was already generated rather than guessing, so a boot during a busy hour
// adds nothing: the guarantee is a floor, not a fixed shape.
func fillRecentWindow(random *deterministic, session workSession, profiles []modelProfile, credentials map[string]string, fingerprints []string, keys []gatewayKey, events []usage.Event, now time.Time) []usage.Event {
	from := now.Add(-recentWindow)
	existing := 0
	for _, event := range events {
		if event.TimestampMS >= from.UnixMilli() {
			existing++
		}
	}
	missing := recentWindowFloor - existing
	if missing <= 0 {
		return nil
	}
	added := make([]usage.Event, 0, missing)
	for index := 0; index < missing; index++ {
		// Spread across the window rather than clustered at its end, so the sparkline has
		// a shape instead of one spike at the right edge.
		offset := time.Duration(float64(recentWindow) * (float64(index) + random.nextFloat()) / float64(missing))
		at := now.Add(-offset)
		profile := session.pickProfile(random, profiles)
		keyIndex := pickWeighted(random, keyWeights(keys))
		event := buildEventAt(random, profile, credentials, at)
		event.APIGroupKey = fingerprints[keyIndex]
		event.APIGroupLabel = "api_key"
		event.APIKeyMask = security.MaskSecret(keys[keyIndex].value)
		added = append(added, event)
	}
	return added
}

// recentSubstitutionsPerModel is how many substituted requests each affected model
// carries in the newest part of the history.
const recentSubstitutionsPerModel = 2

// recentSubstitutions places requests an upstream answered as another model among
// the newest rows of the history.
//
// The affected models carry little traffic, so the substituted share of an
// ordinary draw almost never lands on the first page of the request list, and a
// visitor would have to know which filter to set before seeing one. These are
// placed explicitly, minutes apart, so the list shows them between ordinary rows.
func recentSubstitutions(random *deterministic, profiles []modelProfile, credentials map[string]string, fingerprints []string, keys []gatewayKey, now time.Time) []usage.Event {
	added := make([]usage.Event, 0, recentSubstitutionsPerModel*2)
	for _, profile := range profiles {
		if profile.servedAs == "" {
			continue
		}
		for placed := 0; placed < recentSubstitutionsPerModel; {
			at := now.Add(-time.Duration(len(added)*4+2)*time.Minute - time.Duration(random.nextFloat()*float64(time.Minute)))
			event := buildEventAt(random, profile, credentials, at)
			// A failed request has no served model to show; draw again.
			if event.Failed {
				continue
			}
			keyIndex := pickWeighted(random, keyWeights(keys))
			event.APIGroupKey = fingerprints[keyIndex]
			event.APIGroupLabel = "api_key"
			event.APIKeyMask = security.MaskSecret(keys[keyIndex].value)
			event.ResponseModel = profile.servedAs
			event.ModelSubstituted = usage.IsModelSubstituted(event.Model, event.ResponseModel)
			added = append(added, event)
			placed++
		}
	}
	return added
}

// drawRequestCount turns one hour's expected number of requests into the count it
// actually carried.
//
// The expected rate is small for the early history - the curve starts at a few requests
// an hour - and the obvious `int(mean + 0.5)` rounds every one of those hours to zero.
// That is not a low-traffic day, it is an empty one, and it showed up as a token-activity
// grid whose first third was blank while the rest was full: a fixture that reads as
// broken rather than as quiet. Drawing the integer part and then the fraction keeps the
// mean exactly and leaves a quiet hour quiet without emptying the day around it.
//
// The draw is skewed rather than uniform, because traffic arrives in bursts: an agent
// run, a deploy, a batch job. A uniform draw gives every hour within a factor of two of
// its neighbour, which is what made the token trend repeat an identical sawtooth every
// day. The skew lets one hour in ten carry several times its mean while the quiet hours
// stay near zero.
func drawRequestCount(random *deterministic, mean float64) int {
	if mean <= 0 {
		return 0
	}
	drawn := mean
	// One hour in eight carries several times its share, which is what an agent run, a
	// deploy or a batch job looks like. The rest is divided by the expected excess so the
	// mean survives the skew: scaling only the bursts up would quietly raise the rate, and
	// subtracting a flat correction afterwards (which is what this did first) rounds to
	// nothing at the quiet end of the curve and drains the history instead.
	const burstShare = 0.125
	// The mean multiplier a burst carries, so the correction below is a subtraction of the
	// same number: using half of it here left the whole curve 22% above its anchor.
	const burstMean = 3.5
	if random.nextFloat() < burstShare {
		drawn = mean * burstMean * 2 * random.nextFloat()
	} else {
		drawn = mean * (1 - burstShare*burstMean) / (1 - burstShare)
	}
	// The integer part first and then the fraction, so a quiet hour stays quiet without
	// rounding a whole day of them to nothing.
	whole := int(drawn)
	if random.nextFloat() < drawn-float64(whole) {
		whole++
	}
	if whole < 0 {
		return 0
	}
	return whole
}

// daySwing varies one day's traffic against the trend it sits on.
//
// Without it the rate curve and the working-day shape decide every day exactly, so the
// history is a smooth envelope with an identical sawtooth inside it. A real deployment
// has quiet Mondays and busy Wednesdays for reasons no curve knows: the swing multiplies
// a whole day by a stable factor drawn from its own date, so rewatching the same day
// gives the same number and the export stays reproducible.
func daySwing(day time.Time) float64 {
	// Hashed from the calendar date alone, so every hour of that day agrees.
	key := uint64(day.Year())*10000 + uint64(day.Month())*100 + uint64(day.Day())
	// A cheap integer hash: multiply by an odd constant and take the high bits, which
	// spreads consecutive dates apart rather than clustering them.
	mixed := (key * 0x9E3779B97F4A7C15) >> 56
	return 0.6 + float64(mixed)/255*0.9
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
	// A compatibility provider's records carry the provider label CPA writes, and the
	// credential that answers them is that provider's first key. Both are derived from
	// the same catalog entry, so renaming a provider in the fixture cannot leave a
	// request pointing at an index its credential list no longer publishes.
	for _, provider := range compatibilityCatalog() {
		if len(provider.keys) == 0 {
			continue
		}
		indexes[compatibilityRecordLabel(provider.name)] = compatibilityAuthIndex(provider.prefix, 1)
	}
	return indexes
}

// trafficShape is the multiplier for one hour that is not about history: a
// working day with a near-silent night, and a lighter weekend. The gateway is one
// person's, so the night carries only what an unattended job sends.
func trafficShape(hour time.Time) float64 {
	local := hour.UTC()
	diurnal := 0.04 + 0.96*peakWeight(local.Hour())
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
	weight := 0.08
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

// buildEvent turns one request into the record CPA would have published, at an instant
// inside the hour it belongs to.
func buildEvent(random *deterministic, profile modelProfile, credentials map[string]string, hour, now time.Time) usage.Event {
	started := hour.Add(time.Duration(random.nextFloat() * float64(time.Hour)))
	if started.After(now) {
		started = now.Add(-time.Duration(random.nextFloat() * 30 * float64(time.Second)))
	}
	return buildEventAt(random, profile, credentials, started)
}

// buildEventAt is the same record at a chosen instant.
func buildEventAt(random *deterministic, profile modelProfile, credentials map[string]string, started time.Time) usage.Event {
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
	// An upstream reports the model it served only when it answered. The
	// substituted share is derived from the latency already drawn, so adding it
	// leaves every other generated value where it was.
	if !failed {
		event.ResponseModel = profile.name
		if profile.servedAs != "" && latency%4 == 0 {
			event.ResponseModel = profile.servedAs
		}
		event.ModelSubstituted = usage.IsModelSubstituted(event.Model, event.ResponseModel)
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

// workSession is the sitting of work an hour belongs to.
//
// The gateway is one person's, and a person works on one model at a time: an agent
// run or an editing session sends almost everything to the model it was started
// with. Drawing every request from the catalogue independently gave each model the
// same spikes at the same instants, so the per-model trend read as a tangle of
// identical lines rather than as one model busy while the others sit low.
type workSession struct {
	focus     modelProfile
	hoursLeft int
}

// focusShare is the part of a session's requests its own model carries. The rest is
// the background a personal gateway always has - an editor's completion model, a
// script on another key - drawn from the whole catalogue, which is also what keeps
// every configured model in the history.
const focusShare = 0.85

// advance moves the session on by one hour, starting a new one when the current
// sitting has run out.
func (s workSession) advance(random *deterministic, profiles []modelProfile, hour, now time.Time) workSession {
	if s.hoursLeft > 0 {
		s.hoursLeft--
		return s
	}
	// One to four hours: long enough that a session reads as a block on the hourly
	// trend, short enough that a working day holds more than one of them.
	length := 1 + int(random.nextUint64()%4)
	return workSession{focus: pickFocus(random, profiles, hour, now), hoursLeft: length - 1}
}

// pickProfile chooses the model one request of the session went to.
func (s workSession) pickProfile(random *deterministic, profiles []modelProfile) modelProfile {
	if s.focus.name != "" && random.nextFloat() < focusShare {
		return s.focus
	}
	return pickProfile(random, profiles)
}

// focusChoice is one model a period of the history worked on, and how often.
type focusChoice struct {
	model  string
	weight int
}

// focusEra is the set of models sessions were started with up to a given age.
type focusEra struct {
	untilDaysAgo float64
	choices      []focusChoice
}

// focusEras is what the operator worked with, newest first. A person's main model
// changes every few months rather than every hour, so the year-long views show one
// model handing over to the next instead of the same mix throughout. Each era keeps
// a dominant model and a heavier one reached for on hard problems.
func focusEras() []focusEra {
	return []focusEra{
		{untilDaysAgo: 45, choices: []focusChoice{
			{"glm-5.3-flash", 55}, {"claude-opus-5.5", 22}, {"gpt-5.6-luna", 15}, {"deepseek-v4-flash", 8},
		}},
		{untilDaysAgo: 160, choices: []focusChoice{
			{"gpt-5.6-luna", 50}, {"claude-sonnet-5", 25}, {"glm-5.3-flash", 15}, {"kimi-k3", 10},
		}},
		{untilDaysAgo: math.MaxFloat64, choices: []focusChoice{
			{"claude-sonnet-5", 45}, {"gpt-5.6-luna", 30}, {"deepseek-v4-flash", 15}, {"gemini-3.7-flash", 10},
		}},
	}
}

// pickFocus chooses the model a session starting at this hour works on.
func pickFocus(random *deterministic, profiles []modelProfile, hour, now time.Time) modelProfile {
	daysAgo := now.Sub(hour).Hours() / 24
	eras := focusEras()
	era := eras[len(eras)-1]
	for _, candidate := range eras {
		if daysAgo < candidate.untilDaysAgo {
			era = candidate
			break
		}
	}
	weights := make([]int, 0, len(era.choices))
	for _, choice := range era.choices {
		weights = append(weights, choice.weight)
	}
	name := era.choices[pickWeighted(random, weights)].model
	for _, profile := range profiles {
		if profile.name == name {
			return profile
		}
	}
	// An era naming a model the catalogue dropped falls back to the ordinary draw
	// rather than to an empty profile; the test on the eras keeps this unreached.
	return pickProfile(random, profiles)
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

// pricingProviderCatalog uses the same fixture sources as CPA's discovery endpoints.
func pricingProviderCatalog() []pricing.CatalogProvider {
	providers := []pricing.CatalogProvider{}
	for _, family := range familyCatalog() {
		for index, key := range family.keys {
			provider := pricing.CatalogProvider{ID: fmt.Sprintf("%s-%d", family.family, index), Family: family.family, Channel: family.family, EndpointHost: demoEndpointHost(key.baseURL), Priority: key.priority, Models: []string{}}
			for _, model := range key.models {
				provider.Models = append(provider.Models, model.name)
				if model.alias != "" {
					provider.Models = append(provider.Models, model.alias)
				}
			}
			providers = append(providers, provider)
		}
	}
	for index, relay := range compatibilityCatalog() {
		provider := pricing.CatalogProvider{ID: fmt.Sprintf("openai-compat-%d", index), Family: "openai-compatibility", Name: relay.name, EndpointHost: demoEndpointHost(relay.baseURL), Channel: compatibilityRecordLabel(relay.name), Priority: relay.priority, Models: []string{}}
		for _, model := range relay.models {
			provider.Models = append(provider.Models, model.name)
			if model.alias != "" {
				provider.Models = append(provider.Models, model.alias)
			}
		}
		providers = append(providers, provider)
	}
	oauth := make(map[string]*pricing.CatalogProvider)
	for _, credential := range credentialCatalog() {
		if credential.isDisabled {
			continue
		}
		provider := oauth[credential.provider]
		if provider == nil {
			provider = &pricing.CatalogProvider{ID: "oauth:" + credential.provider, Family: credential.provider, Name: credential.provider, Channel: credential.provider, Priority: credential.priority, IsOAuth: true, Models: []string{}}
			oauth[credential.provider] = provider
		}
		if credential.priority > provider.Priority {
			provider.Priority = credential.priority
		}
		provider.Models = append(provider.Models, credential.models...)
	}
	for _, provider := range oauth {
		providers = append(providers, *provider)
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i].ID < providers[j].ID })
	return providers
}

func demoEndpointHost(rawURL string) string {
	endpoint, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return endpoint.Hostname()
}

func seedCustomIcon(ctx context.Context, repo *repository.Repository, now time.Time) error {
	const identity = "00000000000000000000000000000001"
	if _, err := repo.GetCustomIcon(ctx, identity); err == nil {
		return nil
	} else if !errors.Is(err, repository.ErrCustomIconMissing) {
		return err
	}
	artwork := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#64748b" d="M12 1L23 12L12 23L1 12Z"/></svg>`
	icon, err := repo.CreateCustomIcon(ctx, "Team Relay", base64.StdEncoding.EncodeToString([]byte(artwork)))
	if err != nil {
		return err
	}
	_, err = repo.SQL().ExecContext(ctx, `UPDATE custom_icons SET id=?,created_at_ms=?,updated_at_ms=? WHERE id=?`, identity, now.UnixMilli(), now.UnixMilli(), icon.ID)
	if err != nil {
		return fmt.Errorf("pin demo custom icon identity: %w", err)
	}
	return nil
}
