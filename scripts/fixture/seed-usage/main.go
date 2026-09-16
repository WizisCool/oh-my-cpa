// Command seed-usage writes deterministic request records into a local Oh My CPA
// database so the browser acceptance suite can exercise the request list.
//
// It exists because acceptance starts the app with ingestion disabled, which
// leaves the request list empty and makes every list behaviour untestable in the
// browser. It goes through the repository rather than raw SQL on purpose: the
// real insert path owns the request-time price lock, the display-mask rules and
// the schema, so this fixture cannot drift away from them.
//
// Usage (paths are the app's own database file):
//
//	seed-usage -db <path> -scenario list     # a deterministic window for the list
//	seed-usage -db <path> -scenario append   # one more record, later than the rest
//
// The scenario names describe what the browser checks need, not what the data
// "is": `list` seeds a window whose failure share must read as routine noise,
// and `append` seeds a record that finished after the ones already on screen, so
// a live poll has something new to report.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

const (
	fixtureInstanceID = "default"
	// The failure share is chosen against the success-rate bands: 1/50 is 2%,
	// which must stay neutral, and the sample is large enough to clear the
	// minimum the verdict needs before it may escalate at all.
	totalRecords   = 50
	failingRecords = 1
	shortLatencyMS = 900
	// An agent request that thinks for minutes. The list has to render it in the
	// same colour as a fast one. It is written LAST and carries an older start
	// time than the fast records, which is the real agent case: it started early,
	// ran for minutes, and only now became a record. Under the list's request-time
	// order it therefore sorts into the middle, not to the top - which is what
	// makes it the fixture that catches a regression back to recording order.
	longLatencyMS = 9 * 60 * 1000
	// Minutes ago the slow agent request started, and the band the fast records
	// occupy. It starts before every fast record, so request-time order puts it
	// last while recording order would have put it first.
	slowRequestStartedMinutesAgo = 58
	fastRequestNewestMinutesAgo  = 3
	fastRequestOldestMinutesAgo  = 51
)

// fixtureClientKey is the gateway client key the acceptance run also configures in
// CPA. The alias scenario attributes a request to it so the request list can be
// asserted to show the operator-assigned name rather than the mask.
const fixtureClientKey = "omc-e2e-client-secret"

func main() {
	databasePath := flag.String("db", "", "path to the Oh My CPA SQLite database")
	scenario := flag.String("scenario", "list", "list | append")
	// The cipher has to match the one the app runs with, because a caller-key
	// identity is a keyed fingerprint: seeding under a different key would store an
	// identity the running application can never produce.
	masterKey := flag.String("master-key", "", "master key the application will run with")
	flag.Parse()
	if *databasePath == "" {
		fail(errors.New("-db is required"))
	}

	// The app creates its own data directory; a standalone seed run has to.
	if err := os.MkdirAll(filepath.Dir(*databasePath), 0o700); err != nil {
		fail(fmt.Errorf("create data directory: %w", err))
	}

	ctx := context.Background()
	openOptions := []repository.OpenOption{}
	if *masterKey != "" {
		cipher, cipherErr := crypto.New(*masterKey)
		if cipherErr != nil {
			fail(fmt.Errorf("create fixture cipher: %w", cipherErr))
		}
		openOptions = append(openOptions, repository.WithCipher(cipher))
	}
	db, err := repository.Open(ctx, *databasePath, openOptions...)
	if err != nil {
		fail(fmt.Errorf("open fixture database: %w", err))
	}
	defer db.Close()
	repo := repository.New(db)

	if err := ensureInstance(ctx, repo); err != nil {
		fail(err)
	}

	switch *scenario {
	case "list":
		if err := seedList(ctx, repo); err != nil {
			fail(err)
		}
	case "append":
		if err := seedAppend(ctx, repo); err != nil {
			fail(err)
		}
	default:
		fail(fmt.Errorf("unknown scenario %q", *scenario))
	}
	fmt.Println("SEED_USAGE_OK")
}

// ensureInstance creates the CPA instance row the records reference. The app
// upserts the same row at startup, so this only has to exist for the foreign key.
func ensureInstance(ctx context.Context, repo *repository.Repository) error {
	if _, err := repo.GetInstance(ctx, fixtureInstanceID); err == nil {
		return nil
	}
	now := time.Now().UTC()
	return repo.UpsertInstance(ctx, domain.CPAInstance{
		ID:      fixtureInstanceID,
		Name:    "Default CPA",
		BaseURL: "http://127.0.0.1:8317",
		Status:  "ok",
		// Placeholder ciphertext: the columns are NOT NULL, and the app replaces
		// this row at startup with the key it encrypted from the environment.
		ManagementKeyCiphertext: []byte{0},
		ManagementKeyNonce:      []byte{0},
		CreatedAt:               now,
		UpdatedAt:               now,
	})
}

// seedList writes one window of records: failures inside a large sample
// (routine noise, never amber) followed by one slow agent request.
//
// Every record lands inside the default one-hour window. The slow request is
// written LAST and carries the oldest start time of them all, which is the real
// agent case: it started early, ran for minutes, and only now became a record. It
// therefore belongs at the END of a request-time-ordered list even though it was
// recorded last - and an assertion that it is not the first row is exactly what
// catches a regression back to recording order.
func seedList(ctx context.Context, repo *repository.Repository) error {
	now := time.Now().UTC()
	fastRecords := totalRecords - 2
	span := fastRequestOldestMinutesAgo - fastRequestNewestMinutesAgo
	events := make([]usage.Event, 0, totalRecords)
	for index := 0; index < fastRecords; index++ {
		minutesAgo := fastRequestNewestMinutesAgo
		if fastRecords > 1 {
			minutesAgo += (index * span) / (fastRecords - 1)
		}
		events = append(events, fixtureEvent(
			fmt.Sprintf("fixture-list-%02d", index),
			now.Add(-time.Duration(minutesAgo)*time.Minute),
			int64(shortLatencyMS+index*7),
			index < failingRecords,
		))
	}
	events = append(events, fixtureEvent(
		"fixture-agent-slow",
		now.Add(-slowRequestStartedMinutesAgo*time.Minute),
		longLatencyMS,
		false,
	))
	// One request attributed to the fixture gateway key, so the alias checks have a
	// record to label. It is seeded unnamed on purpose: the browser test performs
	// the rename through the UI, which makes the later assertion evidence that the
	// write path works rather than that a fixture was pre-named. Keeping it inside
	// this scenario rather than adding a second seed keeps the record count the rest
	// of the audit asserts on unchanged.
	callerKey := fixtureEvent("fixture-key-caller", now.Add(-4*time.Minute), shortLatencyMS+25, false)
	fingerprint, err := repo.UsageClientKeyFingerprint(fixtureClientKey)
	if err != nil {
		return fmt.Errorf("derive caller key identity: %w", err)
	}
	callerKey.APIGroupKey = fingerprint
	callerKey.APIGroupLabel = "api_key"
	callerKey.APIKeyMask = security.MaskSecret(fixtureClientKey)
	callerKey.Source = "fixture-caller"
	events = append(events, callerKey)

	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		return fmt.Errorf("seed list scenario: %w", err)
	}
	return nil
}

// seedAppend writes one more record than the list scenario, with the newest
// timestamp, so a poll after this point has exactly one new row to report.
func seedAppend(ctx context.Context, repo *repository.Repository) error {
	event := fixtureEvent("fixture-append-00", time.Now().UTC(), shortLatencyMS, false)
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{event}); err != nil {
		return fmt.Errorf("seed append scenario: %w", err)
	}
	// The acceptance app owns a long-lived WAL connection. Force the external
	// writer's committed frames to the database before it exits so the next poll
	// observes the record even when no checkpoint happened at startup.
	if _, err := repo.SQL().ExecContext(ctx, `PRAGMA wal_checkpoint(PASSIVE)`); err != nil {
		return fmt.Errorf("checkpoint append scenario: %w", err)
	}
	return nil
}

func fixtureEvent(eventKey string, startedAt time.Time, latencyMS int64, failed bool) usage.Event {
	ttftMS := latencyMS / 10
	return usage.Event{
		InstanceID:  fixtureInstanceID,
		EventKey:    eventKey,
		RequestID:   eventKey,
		APIGroupKey: "fixture-agent",
		Provider:    "codex",
		Endpoint:    "/v1/responses",
		AuthType:    "oauth",
		AuthIndex:   "fixture-auth-index",
		Model:       "gpt-5-codex",
		TimestampMS: startedAt.UnixMilli(),
		Failed:      failed,
		Generate:    true,
		LatencyMS:   latencyMS,
		TTFTMS:      &ttftMS,
		TotalTokens: 1234,
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "seed-usage:", err)
	os.Exit(1)
}
