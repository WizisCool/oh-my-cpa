package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/demo"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// The public demo is served from a static host, so its API responses have to exist
// as data rather than as a running Go process. This file is the export that
// produces them, and it deliberately runs the REAL handler against a REAL seeded
// repository: the value of the exported dataset is that every response went through
// the same DTO projection the console reads from a self-hosted install. Hand-writing
// the fixtures instead would duplicate the response shapes, which is the most
// expensive thing in the repository to keep correct.
//
// It is a test rather than a command so it can use the existing test seams, and it
// writes nothing unless explicitly asked. Run it with:
//
//	OMCPA_DEMO_EXPORT_DIR=<dir> go test ./internal/api -run TestExportDemoDataset -count=1
//
// The reference instant is fixed so a repeated export is byte-identical; see
// demoExportReference for why a wall-clock seed would defeat that.

// demoExportReference is the instant the exported history is anchored to.
//
// Two properties are required of it, and both matter.
//
// It is fixed, because the seed generates traffic relative to the instant it is
// given and the windows are requested as closed ranges on it: a wall-clock anchor
// would make every export differ, and a difference is indistinguishable from drift -
// the exact failure the exported dataset exists to catch.
//
// It is in the PAST, because the server clamps a requested end to the wall clock. A
// future anchor makes every window end at "now" instead, which is neither closed nor
// stable, and it showed up as a rate that shifted in its fourth decimal between runs.
// Nothing depends on the anchor's absolute value: the Worker re-bases the whole
// history onto the viewer's clock when it serves a request, so this instant is only
// ever an origin.
var demoExportReference = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// demoExportCase is one request the exported dataset has to be able to answer.
//
// A case exists because some console surface reads it, not because the route exists.
// The parameter variants are the ones the UI actually sends: the dashboard's preset
// picker, both model groupings, the viewer's timezone for the heatmap, and the event
// list's window. A route with no case is a route the demo cannot render, and
// TestDemoExportCoversEveryReadableRoute fails on exactly that.
type demoExportCase struct {
	// Name is the file the response is written to. It is spelled out rather than
	// derived from the path so a parameterised variant can be named for the surface
	// it serves instead of for its query string.
	Name string
	// Path is the request path relative to the exported base path, with any query.
	Path string
	// Route names the router pattern this case serves, for a parameterised route. It
	// is empty for a literal route, where the pattern is the path itself.
	Route string
	// From declares that this case's path depends on a response captured earlier, which is
	// how a read that needs a real identifier stays correct when the history is reseeded.
	// It receives the cases already captured, keyed by name.
	From func(captured map[string]demoExportResponse) (string, error)
}

// Pattern is the route pattern a case covers.
func (c demoExportCase) Pattern() string {
	if c.Route != "" {
		return c.Route
	}
	return strings.SplitN(c.Path, "?", 2)[0]
}

// demoExportCases is the readable surface the console actually reads.
//
// This is intentionally not "every allowed GET". Routes like the audit export or the
// error-log listing return content the console only reaches from a control the demo
// does not offer, and exporting a response nothing reads would claim coverage the
// demo does not have.
func demoExportCases() []demoExportCase {
	cases := []demoExportCase{
		{Name: "healthz", Path: "/api/healthz"},
		{Name: "session", Path: "/api/auth/session"},
		{Name: "resources", Path: "/api/v1/resources"},
		{Name: "preferences", Path: "/api/v1/preferences"},
		{Name: "overview", Path: "/api/v1/management/overview"},
		{Name: "system", Path: "/api/v1/management/system"},
		{Name: "system-releases", Path: "/api/v1/management/system/releases"},
		{Name: "system-maintenance", Path: "/api/v1/management/system/maintenance"},
		{Name: "config", Path: "/api/v1/management/config"},
		{Name: "config-source", Path: "/api/v1/management/config/source"},
		{Name: "providers", Path: "/api/v1/management/providers"},
		{Name: "providers-with-keys", Path: "/api/v1/management/providers?include_keys=true"},
		{Name: "api-keys", Path: "/api/v1/management/api-keys"},
		{Name: "api-keys-with-keys", Path: "/api/v1/management/api-keys?include_keys=true"},
		{Name: "client-key-aliases", Path: "/api/v1/management/client-key-aliases"},
		{Name: "pricing", Path: "/api/v1/pricing"},
		{Name: "plugins", Path: "/api/v1/management/plugins"},
		{Name: "plugin-store", Path: "/api/v1/management/plugin-store"},
		{Name: "auth-files", Path: "/api/v1/management/auth-files"},
		// The model and alias lists are asked for per credential; `auth-files-models`
		// without a name is what the console's own model picker sends.
		{Name: "auth-files-model-aliases", Path: "/api/v1/management/auth-files/model-aliases"},
		{Name: "auth-files-models", Path: "/api/v1/management/auth-files/models?name=antigravity-studio.json"},
		// The capability probe is keyed by a fixed catalogue name rather than by a
		// credential; `oauth` is the one the console asks for.
		{Name: "capabilities-oauth", Path: "/api/v1/management/capabilities/oauth"},
		{Name: "oauth-providers", Path: "/api/v1/management/oauth/providers"},
		// The status read is polled while a sign-in is in progress, and it needs the
		// state it was started with. The fixture has no flow running, which is the
		// answer the page renders between flows, so the exported response is the one
		// for a state the fixture can describe.
		{Name: "oauth-status", Path: "/api/v1/management/oauth/status?state=demo-idle"},
		{Name: "quota", Path: "/api/v1/management/quota"},
		// One credential's quota detail, for the page the quota list links into.
		{Name: "quota-codex", Path: "/api/v1/management/quota/auth-codex-01"},
		{Name: "logs", Path: "/api/v1/management/logs?limit=200"},
		{Name: "logs-status", Path: "/api/v1/management/logs/status"},
		{Name: "request-error-logs", Path: "/api/v1/management/request-error-logs"},
		{Name: "audit-events", Path: "/api/v1/management/audit/events"},
		{Name: "usage-ingest-status", Path: "/api/v1/usage/ingest-status"},
		// The window is closed on the reference for the same reason the dashboard's is:
		// without it the server resolves its default against the wall clock, which is
		// not where the seeded history sits, and the list comes back empty.
		{Name: "usage-facets", Path: "/api/v1/usage/facets?" + demoExportWindow("24h")},
		{Name: "usage-events", Path: "/api/v1/usage/events?" + demoExportWindow("24h") + "&limit=100&result=all"},
		// The record drawer asks for one event by id, and that id has to come from the list
		// above rather than be written here. A literal id was correct until the history was
		// reseeded, at which point it named nothing and the export captured the 404 as the
		// drawer's data - which passed every test, because a captured 404 is still a
		// captured response. Deriving it means reseeding cannot break it.
		{Name: "usage-event-detail", Route: "/api/v1/usage/events/{id}", From: demoExportFirstEventPath},
		{Name: "audit-export", Path: "/api/v1/management/audit/export"},
	}
	// The dashboard's window picker. Each position is a distinct response and the
	// console offers all of them, so exporting only the default would leave the rest
	// of the picker blank.
	//
	// Each window is requested as an explicit `from`/`to` pair rather than as its
	// preset name. A preset is resolved against the wall clock, so two exports would
	// disagree by whatever the run took: the seeded history is dense, so a few seconds
	// at the boundary moves a request in or out of the window and the totals change by
	// one. A closed window is fixed, so the aggregate is the same every time. The
	// Worker restores the preset label the picker expects when it re-bases the window
	// onto the viewer's clock.
	for _, preset := range []string{"15m", "1h", "6h", "24h", "7d", "30d", "90d"} {
		window := demoExportWindow(preset)
		cases = append(cases,
			demoExportCase{Name: "dashboard-" + preset, Path: "/api/v1/management/dashboard?" + window},
			demoExportCase{Name: "dashboard-tail-" + preset, Path: "/api/v1/management/dashboard/tail?" + window},
			demoExportCase{Name: "dashboard-models-call-" + preset, Path: "/api/v1/management/dashboard/models?" + window + "&group_by=call"},
			demoExportCase{Name: "dashboard-models-model-" + preset, Path: "/api/v1/management/dashboard/models?" + window + "&group_by=model"},
			demoExportCase{Name: "dashboard-providers-" + preset, Path: "/api/v1/management/dashboard/providers?" + window},
			demoExportCase{Name: "client-key-usage-" + preset, Path: "/api/v1/management/client-key-usage?" + window},
		)
	}
	// The heatmap is asked for in the viewer's own zone; the export keeps a UTC and a
	// non-UTC zone so the Worker's calendar maths has a reference for both an offset
	// that is a whole number of hours and one that is not.
	cases = append(cases,
		demoExportCase{Name: "dashboard-token-heatmap-utc", Path: "/api/v1/management/dashboard/token-heatmap?tz=UTC"},
		demoExportCase{Name: "dashboard-token-heatmap-kuala-lumpur", Path: "/api/v1/management/dashboard/token-heatmap?tz=Asia%2FKuala_Lumpur"},
	)
	return cases
}

// demoExportRouteGaps names the readable routes this export does NOT answer, with the
// reason, so the coverage contract can stay total without pretending they work.
//
// A gap is recorded rather than silently skipped: the alternative is a contract test
// that passes because it never asks, which is how a broken page ships unnoticed.
//
// `/api/v1/management/auth-files/safe-fields` is the only entry. The application
// learns a credential's allowlisted fields by downloading the file and projecting the
// safe subset out of it, and the fixture refuses downloads on purpose - a security
// test asserts that refusal, because a fixture which hands back a credential body
// teaches that the boundary is somewhere other than the field allowlist. So the read
// answers 502 in the demonstration today.
//
// That is a pre-existing defect this export surfaced rather than caused, and closing
// it means changing how the application reads safe fields, which is not a deployment
// change. The replacement Worker serves the route as a clean refusal, which is what
// the console already renders for a refused operation.
var demoExportRouteGaps = map[string]string{
	"/api/v1/management/auth-files/safe-fields": "the fixture refuses the download the projection reads, by design and under test",
}

// demoExportFirstEventPath builds the detail path for the first event the list carried.
//
// The console reaches the drawer from a row, so any id the list holds is one it can ask
// for; taking the first is enough and keeps the choice reproducible.
func demoExportFirstEventPath(captured map[string]demoExportResponse) (string, error) {
	list, ok := captured["usage-events"]
	if !ok {
		return "", errors.New("the event list must be captured before its detail")
	}
	var payload struct {
		Items []struct {
			ID int64 `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(list.Body), &payload); err != nil {
		return "", fmt.Errorf("decode the event list: %w", err)
	}
	if len(payload.Items) == 0 {
		return "", errors.New("the event list is empty, so no detail can be captured")
	}
	return fmt.Sprintf("/api/v1/usage/events/%d", payload.Items[0].ID), nil
}

// demoExportPresetSpans is how far back each dashboard preset reaches. It mirrors the
// spans the server accepts, and the export requests the same windows by their bounds
// so the aggregate does not depend on when the export ran.
var demoExportPresetSpans = map[string]time.Duration{
	"15m": 15 * time.Minute,
	"1h":  time.Hour,
	"6h":  6 * time.Hour,
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
	"30d": 30 * 24 * time.Hour,
	"90d": 90 * 24 * time.Hour,
}

// demoExportWindow renders one preset as a closed epoch-millisecond window ending at
// the export's reference instant.
func demoExportWindow(preset string) string {
	span, known := demoExportPresetSpans[preset]
	if !known {
		panic("unknown export preset: " + preset)
	}
	to := demoExportReference
	from := to.Add(-span)
	return "from=" + strconv.FormatInt(from.UnixMilli(), 10) +
		"&to=" + strconv.FormatInt(to.UnixMilli(), 10)
}

// TestExportDemoDataset writes the dataset the public demo is served from.
//
// It is skipped unless an output directory is given, because writing files from a
// test that runs by default would make the ordinary suite mutate the worktree.
func TestExportDemoDataset(t *testing.T) {
	outDir := strings.TrimSpace(os.Getenv("OMCPA_DEMO_EXPORT_DIR"))
	if outDir == "" {
		t.Skip("set OMCPA_DEMO_EXPORT_DIR to export the demo dataset")
	}

	router, seededAt := demoExportRouter(t)
	server := httptest.NewServer(router)
	defer server.Close()

	// Captured before the first request so the re-base delta describes the responses
	// collectively rather than each one separately.
	exportedAt := time.Now().UTC()

	responses := make(map[string]demoExportResponse)
	for _, one := range demoExportCases() {
		// A case whose path depends on an earlier capture is resolved against what has
		// been captured so far, so the dependency is explicit in the case list rather
		// than in the order the list happens to be written in.
		if one.From != nil {
			resolved, err := one.From(responses)
			if err != nil {
				t.Fatalf("%s: %v", one.Name, err)
			}
			one.Path = resolved
		}
		responses[one.Name] = demoExportFetch(t, server.URL, one)
	}

	// Every response was rendered against the wall clock, so the history it describes
	// ends "now". One delta moves all of it onto the reference instant, which keeps
	// the span internally consistent and makes the export reproducible.
	_ = exportedAt
	// One table across every response, so the same generated id becomes the same
	// stand-in wherever it appears, and one delta for the whole dataset, so every
	// interval inside it survives the move and the panels that have to agree still do.
	//
	// The delta is rounded to whole seconds, and that is what makes the export
	// reproducible rather than nearly reproducible. Serving seventy-nine responses takes
	// a couple of seconds, so the raw difference between the reference and the moment the
	// requests were made is a few milliseconds different every run - and every instant in
	// the dataset inherits that difference, which is a diff that looks like drift in
	// fifty-four responses. Rounding discards only precision no panel draws: the finest
	// bucket the console renders is a minute wide.
	deltaMS := (seededAt.Sub(exportedAt).Milliseconds() / 1000) * 1000
	requestIDs := make(map[string]int)
	normalised := make(map[string]demoExportResponse, len(responses))
	names := make([]string, 0, len(responses))
	for name := range responses {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		response := responses[name]
		var decoded any
		decoder := json.NewDecoder(strings.NewReader(response.Body))
		decoder.UseNumber()
		if err := decoder.Decode(&decoded); err != nil {
			// A body that is not JSON (a download, an empty export) is kept as it is.
			normalised[name] = response
			continue
		}
		encoded, err := json.Marshal(demoExportMirrorTailAsOfMS(demoExportRebase(decoded, deltaMS, requestIDs)))
		if err != nil {
			t.Fatalf("re-base %s: %v", name, err)
		}
		// The scrub runs over the serialised body because the values it targets sit
		// inside strings that the walk above does not classify - a file name and an
		// address - and a text pass is the only way to reach them.
		response.Body = demoExportScrub(string(encoded))
		normalised[name] = response
	}

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatalf("create export directory: %v", err)
	}
	writeDemoExportJSON(t, filepath.Join(outDir, "responses.json"), demoExportResponses{
		ReferenceMS: seededAt.UnixMilli(),
		Responses:   normalised,
	})
}

// demoExportResponse is one exported response, kept as the bytes the handler wrote
// rather than as a decoded structure.
//
// Storing the raw body keeps the export honest: a decode-and-re-encode would let a
// field be dropped without the export noticing, and the JSON the console parses is
// exactly what is captured here.
type demoExportResponse struct {
	Status      int    `json:"status"`
	ContentType string `json:"content_type"`
	Body        string `json:"body"`
}

type demoExportResponses struct {
	// ReferenceMS is the instant the seeded history is anchored to, so the Worker can
	// re-base it onto the viewer's clock.
	ReferenceMS int64                         `json:"reference_ms"`
	Responses   map[string]demoExportResponse `json:"responses"`
}

// demoExportShiftedMillisKeys are the fields carrying an epoch-millisecond instant.
//
// They are shifted by one delta rather than normalised individually, because the
// exported dataset has to be reproducible AND internally consistent: the dashboard's
// window boundaries, its bucket timestamps and the event rows all have to describe
// the same span, or the Worker that re-bases them onto a viewer's clock would move
// some of them and not others. Shifting everything by the same delta preserves every
// relationship the console renders while making two exports of the same history
// byte-identical.
//
// The set is explicit rather than "any number that looks like a timestamp": latency,
// token counts, prices, IDs and schema versions are numbers too, and shifting one of
// them would corrupt the data quietly.
var demoExportShiftedMillisKeys = map[string]bool{
	// The evidence for this list is an experiment rather than a reading of the handlers:
	// two exports were taken with shifting disabled and diffed, and only the fields below
	// varied. Everything else in the dataset - the seeded history's bucket timestamps
	// (`t`), its window bounds (`from`/`to`), the event rows' `timestamp_ms`, the
	// heatmap's day boundaries - was already deterministic, because the seed is anchored
	// at a fixed instant.
	//
	// That distinction is the bug this list exists to encode. An earlier revision shifted
	// every field it considered a timestamp, which replaced forty-nine distinct bucket
	// timestamps with one value and collapsed the dashboard's token trend into a vertical
	// line; it also zeroed the heatmap's day boundaries, freezing that grid at the capture
	// date. Both rendered in the demonstration and neither failed a test.
	"occurred_at_ms":        true,
	"probed_at_ms":          true,
	"observed_at_ms":        true,
	"created_at_ms":         true,
	"updated_at_ms":         true,
	"as_of_ms":              true,
	"checked_at_ms":         true,
	"attempted_at_ms":       true,
	"catalog_updated_at_ms": true,
	"latest_after":          true,
	// Seconds rather than milliseconds: the error-log listing reports file times through
	// the platform's own stat call.
	"modified": true,
}

// demoExportShiftedTextKeys are the fields carrying an RFC3339 instant.
var demoExportShiftedTextKeys = map[string]bool{
	"exported_at":     true,
	"time":            true,
	"last_capture_at": true,
	"last_run_at":     true,
}

// demoExportMeasuredKeys are values measured while the response was produced rather
// than read from the seeded history. They vary with the machine, so they are stated
// as a constant: the demonstration is not reporting a real measurement.
var demoExportMeasuredKeys = map[string]bool{
	"latency_ms":       true,
	"pid":              true,
	"size_bytes":       true,
	"seed_duration_ms": true,
	// The system page reports the process it is running in. These are real
	// measurements of the export run, so they change every time - and a public
	// demonstration should not present them as though they described the service a
	// visitor is looking at.
	"alloc_mb":      true,
	"sys_mb":        true,
	"heap_mb":       true,
	"num_gc":        true,
	"num_goroutine": true,
	"uptime_ms":     true,
	"rss_mb":        true,
	"num_cpu":       true,
	"memory_mb":     true,
	"started_at_ms": true,
}

// demoExportLogInstant matches an RFC3339 instant inside a rendered log line. The
// log tail embeds its timestamps in prose, so they cannot be reached by key.
var demoExportLogInstant = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z`)

// demoExportLogName matches the timestamp inside an error-log file name, which is
// stamped when the listing is asked for rather than when the file was written.
var demoExportLogName = regexp.MustCompile(`request-error-[0-9T:-]+Z\.log`)

// demoExportFixtureURL matches the loopback address the fixture is listening on. The
// port is chosen by the operating system, so it identifies the run and not the data.
// It is replaced rather than removed because the page renders it as the gateway's
// address, and a missing field would be a different response shape.
var demoExportFixtureURL = regexp.MustCompile(`http://127\.0\.0\.1:\d+`)

// demoExportScrub replaces the values that identify a run rather than the history.
func demoExportScrub(text string) string {
	text = demoExportLogName.ReplaceAllString(text, "request-error-demo.log")
	return demoExportFixtureURL.ReplaceAllString(text, "http://127.0.0.1:0")
}

// demoExportRebase moves the instants the handler stamped onto the export's reference
// instant, and leaves the seeded history where it is. Two exports of the same history
// therefore agree.
func demoExportRebase(value any, deltaMS int64, requestIDs map[string]int) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			switch {
			case demoExportMeasuredKeys[key]:
				typed[key] = 0
			case key == demoExportRequestID:
				typed[key] = demoExportStableRequestID(requestIDs, item)
			case demoExportDayBoundaryKeys[key]:
				typed[key] = demoExportNormaliseDayBoundary(typed, key, item)
			case demoExportShiftedMillisKeys[key]:
				typed[key] = demoExportShiftMillis(item, deltaMS)
			case demoExportShiftedTextKeys[key]:
				typed[key] = demoExportShiftText(item, deltaMS)
			default:
				typed[key] = demoExportRebase(item, deltaMS, requestIDs)
			}
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = demoExportRebase(item, deltaMS, requestIDs)
		}
		return typed
	case string:
		return demoExportShiftText(typed, deltaMS)
	default:
		return value
	}
}

// demoExportShiftMillis moves an instant by the export's delta, keeping the unit the
// field already used so the response shape does not change.
//
// It SHIFTS rather than replacing the value with a constant, and the difference is the
// whole point. Replacing every instant with the reference looks equivalent for a field
// that records when something was asked ("this page was read at T") but destroys a field
// that records a series: a dashboard response carries forty-nine bucket timestamps, and
// collapsing them onto one instant made the token trend plot forty-nine points at a
// single x position - a vertical line - while the heatmap's day boundaries collapsed to
// zero and the grid froze at the capture date. Both were visible in the demonstration and
// neither was caught by a test, because the values were still plausible numbers.
//
// A shift preserves every interval the console renders, which is what makes the re-based
// history internally consistent. The Worker applies the same delta again at serve time, so
// the two shifts compose and the viewer sees a history ending now.
// demoExportMirrorTailAsOfMS restores a dashboard tail's own equality after the re-base.
//
// The tail handler sets `live.as_of_ms` to the window's own end (`AsOfMS: window.ToMS`), and those
// two have to move together: the console's `applyTail` compares them
// (`patch.live.as_of_ms < base.window.to`) and discards a tail whose mark precedes the window it
// describes. The re-base moves them apart - the window bounds are seed-anchored and deliberately
// not shifted, while `as_of_ms` is a stamped instant that is - so the served demonstration was
// dropping every tail patch as stale.
//
// Writing the window's end into the mark is what the handler itself does, so this restores the
// handler's invariant rather than inventing one. It keys off the response's shape (a tail is the
// only read carrying both a `live` mark and a `window`) rather than off the field name, because
// the heatmap's `as_of_ms` is the read instant rather than a window bound and must keep its shift.
// It runs after the re-base, so the value it writes is not shifted a second time.
func demoExportMirrorTailAsOfMS(decoded any) any {
	root, ok := decoded.(map[string]any)
	if !ok {
		return decoded
	}
	live, ok := root["live"].(map[string]any)
	if !ok {
		return decoded
	}
	window, ok := root["window"].(map[string]any)
	if !ok {
		return decoded
	}
	if _, ok := live["as_of_ms"]; !ok {
		return decoded
	}
	if to, ok := window["to"]; ok {
		live["as_of_ms"] = to
	}
	return decoded
}

func demoExportShiftMillis(item any, deltaMS int64) any {
	millis, ok := demoExportNumericMillis(item)
	if !ok {
		return item
	}
	// A field reported in seconds rather than milliseconds is one whose magnitude is
	// three orders smaller, so it takes the delta in its own unit.
	if math.Abs(millis) < 1e11 {
		return math.Floor(millis + float64(deltaMS)/1000)
	}
	// Truncated to the MINUTE, and that resolution comes from the arithmetic rather than
	// from taste. These instants are stamped while the export is answering - an audit row
	// per read, a probe per capability, the tail's own "as of" mark - so each is captured a
	// little later than the run began, and the shifted value arrives as the reference plus
	// however long the run had been going. Truncating to the second left that elapsed time
	// in: two exports disagreed by five seconds in seven responses.
	//
	// A minute absorbs it, but it has to be the NEAREST minute rather than the one below.
	// The reference is minute-aligned and the stamped values land within seconds of it, so
	// rounding puts every one of them on the reference - whereas truncating sends a value a
	// few milliseconds below it into the previous minute, which is a whole minute of
	// difference between two exports of identical history. Observed, not anticipated: that
	// was the last field to disagree.
	return math.Round((millis+float64(deltaMS))/60000) * 60000
}

// demoExportShiftText moves an instant written as text by the delta, leaving anything
// that is not an instant alone.
func demoExportStampText(item any, referenceMS int64) any {
	text, ok := item.(string)
	if !ok {
		return item
	}
	stamped := time.UnixMilli(referenceMS).UTC().Format(time.RFC3339)
	if _, err := time.Parse(time.RFC3339, text); err == nil {
		return stamped
	}
	// A log line carries its instants in prose, so they are rewritten in place.
	return demoExportLogInstant.ReplaceAllString(text, stamped)
}

// demoExportDayBoundaryKeys are the heatmap's calendar-cell boundaries.
//
// They are left as the handler produced them, with one exception, and the reasoning is
// worth stating because the obvious alternatives are both wrong. Shifting them by the
// dataset's delta destroys a timezone offset - a Kuala Lumpur day runs 16:00Z to 15:59Z,
// and snapping that to a UTC day made a cell's boundary disagree with its own label.
// Snapping them to any grid we choose has the same problem. What the console actually
// reads from this response is the `day` string; the numbers beside it are unused, so the
// safest thing is to leave them exactly as captured.
//
// The exception is the one cell that is still in progress. Its end boundary is literally
// the moment the export ran, so it moves by seconds between runs and would make the whole
// dataset fail its own reproducibility check over a field nothing displays. It is marked
// with the same zero the cells beyond it already use, which says "this day is not
// complete" rather than inventing an end for it.
var demoExportDayBoundaryKeys = map[string]bool{
	"from_ms": true,
	"to_ms":   true,
}

// demoExportNormaliseDayBoundary blanks the end boundary of an incomplete day.
func demoExportNormaliseDayBoundary(owner map[string]any, key string, item any) any {
	if key != "to_ms" {
		return item
	}
	millis, ok := demoExportNumericMillis(item)
	if !ok || millis == 0 {
		return item
	}
	from, ok := demoExportNumericMillis(owner["from_ms"])
	if !ok || from == 0 {
		return item
	}
	const dayMS = 86400000.0
	if millis-from < dayMS {
		// An incomplete day: its end is the moment of the export, not a boundary.
		return float64(0)
	}
	return item
}

// demoExportNumericMillis reads an epoch instant held as a JSON number.
func demoExportNumericMillis(item any) (float64, bool) {
	switch number := item.(type) {
	case float64:
		return number, true
	case json.Number:
		parsed, err := number.Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// demoExportRequestID is the key whose value is generated per request rather than
// seeded, so it differs on every export.
const demoExportRequestID = "request_id"

// demoExportStableRequestID maps a generated id to one derived from its position in
// the export, so the field is present and plausible without changing between runs.
func demoExportStableRequestID(seen map[string]int, value any) any {
	text, ok := value.(string)
	if !ok {
		return value
	}
	index, known := seen[text]
	if !known {
		index = len(seen) + 1
		seen[text] = index
	}
	return fmt.Sprintf("req_demo%08d", index)
}

// demoExportShiftText moves an instant written as text, leaving anything that is not
// an instant alone.
func demoExportShiftText(item any, deltaMS int64) any {
	text, ok := item.(string)
	if !ok {
		return item
	}
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		return demoExportLogInstant.ReplaceAllStringFunc(text, func(match string) string {
			at, parseErr := time.Parse(time.RFC3339, match)
			if parseErr != nil {
				return match
			}
			return at.Add(time.Duration(deltaMS) * time.Millisecond).UTC().Format(time.RFC3339)
		})
	}
	return parsed.Add(time.Duration(deltaMS) * time.Millisecond).UTC().Format(time.RFC3339)
}

// demoExportRouter builds the real handler over a freshly seeded demo repository.
//
// It reproduces what `internal/app` does for a demo deployment - start the fixture,
// point the gateway configuration at it, seed the history - because the console's
// read paths go through a management client rather than straight to the repository.
// A harness that skipped the fixture would export 500s for every endpoint that reads
// the gateway (quota, logs, auth files), and the demo would serve those errors.
func demoExportRouter(t *testing.T) (http.Handler, time.Time) {
	t.Helper()

	// The cipher is built before the repository is opened, because opening it with the
	// cipher is what lets the fixture fingerprint and encrypt the caller keys it seeds.
	// Without it the seed fails on the first key identity, which is how this was found.
	cipher, err := appcrypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatalf("build export cipher: %v", err)
	}

	db, err := repository.Open(context.Background(), "file::memory:?cache=shared",
		repository.WithCipher(cipher))
	if err != nil {
		t.Fatalf("open export repository: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)

	// Seeding into memory keeps the export from touching the worktree, and the fixed
	// instant keeps it reproducible.
	if _, err := demo.Seed(context.Background(), repo, demoExportReference); err != nil {
		t.Fatalf("seed export fixture: %v", err)
	}

	// The fixture listens on loopback only, and it answers the gateway's own paths
	// rather than dialling the URL it is handed, so the export performs no outbound
	// request.
	upstream, err := demo.StartUpstream(nil)
	if err != nil {
		t.Fatalf("start export fixture: %v", err)
	}
	t.Cleanup(func() { _ = upstream.Close() })

	// The console reads the gateway through a management client, and that client is
	// built from the instance row rather than from configuration - see
	// managementClientOrError. `internal/app` bootstraps that row during start-up, so
	// the export reproduces it here; without it every gateway-backed read exports a
	// 500 and the demo would serve those errors as if they were data.
	now := demoExportReference
	ciphertext, nonce, err := cipher.Encrypt([]byte(upstream.ManagementKey()))
	if err != nil {
		t.Fatalf("encrypt export fixture key: %v", err)
	}
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default CPA",
		BaseURL:                 strings.TrimRight(upstream.BaseURL(), "/"),
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		Status:                  "ok",
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatalf("bootstrap export instance: %v", err)
	}

	// Two services are attached after construction in the real application, and the
	// pages that read them answer 503 without it. They are built the same way here -
	// including the demo's own release service, which answers the version page from the
	// fixture - so the exported responses are the ones the console actually renders.
	// The model lister `internal/app` attaches is unexported, and it only feeds the
	// sync path; the demo reads the prices the seed wrote, so the service is built
	// without one.
	pricingService := pricing.NewService(repo, nil, nil)

	releaseService, err := demo.BuildReleaseService(repo, nil, now)
	if err != nil {
		t.Fatalf("build export release service: %v", err)
	}
	releaseService.CheckAll(context.Background())

	// The exported base path is the demo's own: the public demonstration serves the
	// console at the site root, and the exported paths are relative to it.
	authManager, err := auth.New(upstream.ManagementKey(), "", "")
	if err != nil {
		t.Fatalf("build export session manager: %v", err)
	}
	handler := NewHandler(
		config.Config{
			BasePath:   "",
			Version:    "v0.1.0-demo",
			IsDemoMode: true,
			CPA:        config.CPAConfig{BaseURL: upstream.BaseURL(), ManagementKey: upstream.ManagementKey()},
		},
		repo, cipher, nil, authManager,
	)
	handler.SetPricing(pricingService)
	handler.SetRelease(releaseService)
	return handler.routes(), demoExportReference
}

// demoExportFetch performs one case against the running handler.
func demoExportFetch(t *testing.T, baseURL string, one demoExportCase) demoExportResponse {
	t.Helper()

	request, err := http.NewRequest(http.MethodGet, baseURL+one.Path, nil)
	if err != nil {
		t.Fatalf("%s: build request: %v", one.Name, err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("%s: perform request: %v", one.Name, err)
	}
	defer response.Body.Close()

	buf := new(strings.Builder)
	if _, err := io.Copy(buf, response.Body); err != nil {
		t.Fatalf("%s: read body: %v", one.Name, err)
	}
	return demoExportResponse{
		Status:      response.StatusCode,
		ContentType: response.Header.Get("Content-Type"),
		Body:        buf.String(),
	}
}

// writeDemoExportJSON writes sorted, indented JSON so two exports of the same
// history compare byte for byte.
func writeDemoExportJSON(t *testing.T, path string, payload any) {
	t.Helper()

	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		t.Fatalf("encode %s: %v", filepath.Base(path), err)
	}
	if err := os.WriteFile(path, append(encoded, '\n'), 0o644); err != nil {
		t.Fatalf("write %s: %v", filepath.Base(path), err)
	}
}

// TestDemoExportCoversEveryReadableRoute is the contract that keeps the exported
// dataset in step with the console.
//
// It walks the router the server actually serves, keeps the GETs the demo policy
// allows, and requires each of them to be either exported or explicitly not
// exported with a reason. A new console read therefore fails this test until its
// dataset entry exists - which is what turns "keep the mock up to date" from an
// instruction into a gate.
//
// The comparison is by route PATTERN, not by URL: a route registered as
// `/quota/{authIndex}` is exported as a concrete `/quota/auth-codex-01`, and matching
// the two literally would report every parameterised read as uncovered. Cases
// therefore declare the pattern they serve, and the concrete path is only what gets
// fetched.
func TestDemoExportCoversEveryReadableRoute(t *testing.T) {
	const basePath = "/omc"
	handler := demoHandler(t, basePath)
	routes := handler.routes()

	exported := make(map[string]bool, len(demoExportCases()))
	for _, one := range demoExportCases() {
		exported[one.Pattern()] = true
	}

	missing := make([]string, 0)
	seen := 0
	if err := chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method != http.MethodGet {
			return nil
		}
		path := stripBasePath(basePath, route)
		// Only the allowed half of the table is a read the console can reach.
		if rule, match := demoVerdictFor(method, path); match != demoMatchVerdict || rule.verdict != demoAllow {
			return nil
		}
		// The SPA and asset catch-alls are not API reads.
		if !strings.HasPrefix(path, "/api/") {
			return nil
		}
		seen++
		if exported[path] {
			return nil
		}
		if _, recorded := demoExportRouteGaps[path]; recorded {
			return nil
		}
		// A parameterised route is covered when some case serves its concrete form,
		// which is how the export list stays readable while the gate stays total.
		for pattern := range exported {
			if demoExportPatternMatches(path, pattern) {
				return nil
			}
		}
		missing = append(missing, path)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if seen == 0 {
		t.Fatal("no readable routes were walked, so this test proves nothing")
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Fatalf("%d readable route(s) have no exported response; add them to demoExportCases:\n  %s",
			len(missing), strings.Join(missing, "\n  "))
	}
}

// demoExportPatternMatches reports whether a registered route pattern is served by
// an exported case that names a concrete identifier.
//
// It is the same rule the router applies: a parameterised route matches when the
// concrete path sits under the route's literal prefix.
func demoExportPatternMatches(route, pattern string) bool {
	if route == pattern {
		return true
	}
	prefix, _, found := strings.Cut(route, "{")
	return found && strings.HasPrefix(pattern, prefix)
}

// TestDemoExportKeepsSeriesAndDayGridsIntact guards the two defects that reached the
// public demonstration and were visible only in a browser.
//
// Both came from the same mistake - treating every timestamp as the moment the export
// answered - and both produced values that were still plausible numbers, which is why
// nothing failed: a series collapsed onto one instant, and a calendar cell whose boundary
// contradicted its own label. The assertions are about STRUCTURE rather than about
// particular instants, so they hold whatever the reference is.
// TestDemoExportTailsAgreeWithTheirWindow pins the dashboard tail's own equality in the exported
// dataset.
//
// The tail handler marks `live.as_of_ms` with the window's end (`AsOfMS: window.ToMS`), and the
// console discards a tail whose mark precedes the window it describes
// (`applyTail`: `patch.live.as_of_ms < base.window.to`). The re-base moves the two apart - window
// bounds are seed-anchored and deliberately unshifted, while `as_of_ms` is a stamped instant that
// is shifted - so the served demonstration was treating every tail as stale and dropping it. This
// is invisible from the console, which simply keeps the full response, which is why it is asserted
// on the dataset rather than left to the demo smoke.
func TestDemoExportTailsAgreeWithTheirWindow(t *testing.T) {
	outDir := strings.TrimSpace(os.Getenv("OMCPA_DEMO_EXPORT_DIR"))
	if outDir == "" {
		t.Skip("set OMCPA_DEMO_EXPORT_DIR to check the exported dataset")
	}
	raw, err := os.ReadFile(filepath.Join(outDir, "responses.json"))
	if err != nil {
		t.Fatalf("read exported dataset: %v", err)
	}
	var exported demoExportResponses
	if err := json.Unmarshal(raw, &exported); err != nil {
		t.Fatalf("decode exported dataset: %v", err)
	}

	checked := 0
	for name, entry := range exported.Responses {
		var payload struct {
			Live struct {
				AsOfMS *int64 `json:"as_of_ms"`
			} `json:"live"`
			Window struct {
				To *int64 `json:"to"`
			} `json:"window"`
		}
		if err := json.Unmarshal([]byte(entry.Body), &payload); err != nil {
			continue
		}
		// Only a tail carries both, and that shape is what identifies one: keying off the field name
		// alone would also catch the heatmap, whose `as_of_ms` is the read instant rather than a
		// window bound and is meant to differ from it.
		if payload.Live.AsOfMS == nil || payload.Window.To == nil {
			continue
		}
		checked++
		if *payload.Live.AsOfMS < *payload.Window.To {
			t.Errorf("%s: live.as_of_ms (%d) precedes window.to (%d); the console drops this tail as stale",
				name, *payload.Live.AsOfMS, *payload.Window.To)
		}
	}
	if checked == 0 {
		t.Fatal("no tail-shaped response was checked, so this assertion proved nothing")
	}
}

func TestDemoExportKeepsSeriesAndDayGridsIntact(t *testing.T) {
	outDir := strings.TrimSpace(os.Getenv("OMCPA_DEMO_EXPORT_DIR"))
	if outDir == "" {
		t.Skip("set OMCPA_DEMO_EXPORT_DIR to check the exported dataset")
	}
	raw, err := os.ReadFile(filepath.Join(outDir, "responses.json"))
	if err != nil {
		t.Fatalf("read exported dataset: %v", err)
	}
	var exported demoExportResponses
	if err := json.Unmarshal(raw, &exported); err != nil {
		t.Fatalf("decode exported dataset: %v", err)
	}

	// A plotted series has to advance. One distinct `t` across a whole window is a vertical
	// line on the dashboard's token trend, which is what the demonstration drew.
	for _, name := range []string{"dashboard-models-call-24h", "dashboard-models-model-24h"} {
		body := exported.Responses[name].Body
		if body == "" {
			t.Fatalf("%s is missing from the dataset", name)
		}
		var payload struct {
			Models []struct {
				Series []struct {
					T int64 `json:"t"`
				} `json:"series"`
			} `json:"models"`
		}
		if err := json.Unmarshal([]byte(body), &payload); err != nil {
			t.Fatalf("%s is not the expected shape: %v", name, err)
		}
		if len(payload.Models) == 0 {
			t.Fatalf("%s has no models", name)
		}
		series := payload.Models[0].Series
		if len(series) < 2 {
			t.Fatalf("%s: the first model has %d series points, too few to plot", name, len(series))
		}
		distinct := make(map[int64]bool, len(series))
		for _, point := range series {
			distinct[point.T] = true
		}
		if len(distinct) != len(series) {
			t.Fatalf("%s: %d series points share only %d distinct timestamps; the trend renders as a vertical line",
				name, len(series), len(distinct))
		}
	}

	// A calendar cell's boundary and its label describe the same day, or one of them is
	// wrong. This is the contradiction the day-aligned shift introduced.
	for _, name := range []string{"dashboard-token-heatmap-utc", "dashboard-token-heatmap-kuala-lumpur"} {
		var payload struct {
			Days []struct {
				Day    string `json:"day"`
				FromMS int64  `json:"from_ms"`
			} `json:"days"`
		}
		if err := json.Unmarshal([]byte(exported.Responses[name].Body), &payload); err != nil {
			t.Fatalf("%s is not the expected shape: %v", name, err)
		}
		if len(payload.Days) == 0 {
			t.Fatalf("%s has no days", name)
		}
		checked := 0
		for _, day := range payload.Days {
			if day.FromMS == 0 {
				// The sentinel for a cell outside the measured range.
				continue
			}
			checked++
			// The boundary is where the VIEWER'S day starts, so it is only equal to the
			// label's date in UTC. For any other zone it is offset by that zone - a Kuala
			// Lumpur day begins at 16:00Z on the previous date. What has to hold either way
			// is that the boundary is a real instant that lands within a day of its label,
			// which is what catches a boundary that was overwritten or zeroed.
			got := time.UnixMilli(day.FromMS).UTC()
			label, err := time.Parse("2006-01-02", day.Day)
			if err != nil {
				t.Fatalf("%s: cell label %q is not a date: %v", name, day.Day, err)
			}
			if offset := got.Sub(label); offset < -26*time.Hour || offset > 26*time.Hour {
				t.Fatalf("%s: a cell labelled %s has its boundary %s away, at %s",
					name, day.Day, offset.Round(time.Hour), got.Format(time.RFC3339))
			}
		}
		if checked == 0 {
			t.Fatalf("%s: every day boundary is zero, so the grid has no measured range", name)
		}
	}
}

// The exported response must never carry an error, because an error captured at
// export time would be served to every visitor as if it were data.
func TestDemoExportCasesAllSucceed(t *testing.T) {
	outDir := strings.TrimSpace(os.Getenv("OMCPA_DEMO_EXPORT_DIR"))
	if outDir == "" {
		t.Skip("set OMCPA_DEMO_EXPORT_DIR to check the exported dataset")
	}
	raw, err := os.ReadFile(filepath.Join(outDir, "responses.json"))
	if err != nil {
		t.Fatalf("read exported dataset: %v", err)
	}
	var exported demoExportResponses
	if err := json.Unmarshal(raw, &exported); err != nil {
		t.Fatalf("decode exported dataset: %v", err)
	}
	if exported.ReferenceMS == 0 {
		t.Fatal("exported dataset has no reference instant")
	}
	failed := make([]string, 0)
	names := make([]string, 0, len(exported.Responses))
	for name := range exported.Responses {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		response := exported.Responses[name]
		if response.Status != http.StatusOK {
			failed = append(failed, fmt.Sprintf("%s -> %d", name, response.Status))
		}
	}
	if len(failed) > 0 {
		t.Fatalf("exported responses that are not 200:\n  %s", strings.Join(failed, "\n  "))
	}
}
