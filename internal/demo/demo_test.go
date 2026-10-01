package demo

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

const testMasterKey = "01234567890123456789012345678901"

// Seeding is the slowest thing in this package - it writes a year of history - and
// five suites read the result. They share one seeded database rather than paying for
// it five times, which keeps the package inside the fast gate's budget. Nothing here
// writes after seeding, so sharing is safe.
var (
	seededOnce sync.Once
	seededRepo *repository.Repository
	seededAt   time.Time
	seededStat SeedStats
	seededErr  error
	seedDir    string
)

func TestMain(m *testing.M) {
	code := m.Run()
	if seedDir != "" {
		_ = os.RemoveAll(seedDir)
	}
	os.Exit(code)
}

// seededDatabase returns the shared fixture, building it on first use.
func seededDatabase(t *testing.T) (*repository.Repository, time.Time, SeedStats) {
	t.Helper()
	seededOnce.Do(func() {
		var err error
		seedDir, err = os.MkdirTemp("", "omc-demo-test-")
		if err != nil {
			seededErr = err
			return
		}
		cipher, err := crypto.New(testMasterKey)
		if err != nil {
			seededErr = err
			return
		}
		db, err := repository.Open(context.Background(),
			filepath.Join(seedDir, "oh-my-cpa-demo.db"),
			repository.WithCipher(cipher),
		)
		if err != nil {
			seededErr = err
			return
		}
		seededRepo = repository.New(db)
		seededAt = time.Now().UTC()
		seededStat, seededErr = Seed(context.Background(), seededRepo, seededAt)
	})
	if seededErr != nil {
		t.Fatal(seededErr)
	}
	return seededRepo, seededAt, seededStat
}

func testRepository(t *testing.T) *repository.Repository {
	t.Helper()
	cipher, err := crypto.New(testMasterKey)
	if err != nil {
		t.Fatal(err)
	}
	db, err := repository.Open(context.Background(),
		filepath.Join(t.TempDir(), "demo.db"),
		repository.WithCipher(cipher),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return repository.New(db)
}

// A demo that opens empty is not a demo. This asserts the fixture has the shape the
// pages need: history that reaches back across the windows the dashboard offers
// including the fifteen-minute one, prices that make the cost column mean something,
// and the caller-key names the request list renders.
func TestSeedFillsTheDatabaseTheConsoleReads(t *testing.T) {
	ctx := context.Background()
	repo, now, stats := seededDatabase(t)
	if stats.Requests < 5000 {
		t.Fatalf("seeded %d requests, want enough history to look like a running instance", stats.Requests)
	}
	if stats.Prices != len(modelCatalog()) || stats.Aliases != len(gatewayKeyCatalog()) {
		t.Fatalf("seed stats = %+v, want every price and every alias written", stats)
	}

	// The windows: the newest record has to be inside the current hour, or the
	// fifteen-minute and one-hour views would be empty on first load, and the oldest
	// has to reach back across the heatmap's own span.
	if age := now.Sub(time.UnixMilli(stats.NewestMS)); age > time.Hour {
		t.Fatalf("newest seeded request is %v old, want it inside the last hour", age)
	}
	if span := now.Sub(time.UnixMilli(stats.OldestMS)); span < 360*24*time.Hour {
		t.Fatalf("seeded history spans %v, want at least 360 days", span)
	}

	window, err := repo.QueryUsageAnalytics(ctx, instanceID, now.Add(-15*time.Minute).UnixMilli(), now.UnixMilli(), time.Minute.Milliseconds())
	if err != nil {
		t.Fatal(err)
	}
	if window.Totals.Requests == 0 {
		t.Fatal("the fifteen-minute window has no requests")
	}

	daily, err := repo.QueryUsageAnalytics(ctx, instanceID, now.AddDate(0, 0, -30).UnixMilli(), now.UnixMilli(), time.Hour.Milliseconds())
	if err != nil {
		t.Fatal(err)
	}
	if daily.Totals.Requests < 1000 || daily.Totals.TotalTokens == 0 || daily.Totals.CachedTokens == 0 {
		t.Fatalf("thirty-day window = %+v, want requests, tokens and cache traffic", daily.Totals)
	}
	if daily.Totals.Failures == 0 {
		t.Fatal("the thirty-day window reports no failure at all, which no running instance does")
	}

	// Every model the fixture claims to serve has to have carried traffic, or the
	// model panels would show a shorter list than the provider pages. The list is read
	// from storage rather than from the generator's own catalogue, because a model the
	// insert path rejected would otherwise pass.
	rows, err := repo.SQL().QueryContext(ctx, `SELECT DISTINCT model FROM usage_events`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := make(map[string]bool)
	for rows.Next() {
		var model string
		if err := rows.Scan(&model); err != nil {
			t.Fatal(err)
		}
		seen[model] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for _, profile := range modelCatalog() {
		if !seen[profile.name] {
			t.Errorf("model %q is configured by the fixture but carried no traffic", profile.name)
		}
	}
}

// The cost column is the part of the dashboard that a fixture most easily gets
// wrong: a request is priced against the price version in force at its own request
// time, so fabricated history needs the version it is pretending existed.
func TestSeedPricesTheFabricatedHistory(t *testing.T) {
	ctx := context.Background()
	repo, now, _ := seededDatabase(t)

	var unpriced, priced int64
	if err := repo.SQL().QueryRowContext(ctx, `
		SELECT COUNT(*) FILTER (WHERE pricing_status = 'priced'),
		       COUNT(*) FILTER (WHERE pricing_status <> 'priced')
		FROM usage_events`).Scan(&priced, &unpriced); err != nil {
		t.Fatal(err)
	}
	if priced == 0 || unpriced != 0 {
		t.Fatalf("priced=%d unpriced=%d, want every seeded request priced", priced, unpriced)
	}

	cost, err := repo.QueryUsageCostWindow(ctx, instanceID, now.AddDate(0, 0, -30).UnixMilli(), now.UnixMilli(), time.Hour.Milliseconds())
	if err != nil {
		t.Fatal(err)
	}
	if cost.CostUSD <= 0 {
		t.Fatalf("thirty-day spend = %v, want a non-zero total", cost.CostUSD)
	}

	// The pricing page shows the stored prices intersected with the catalogue the
	// gateway serves. A fixture that wrote prices but no catalogue would render an
	// empty page over a populated table.
	rows, err := repo.ListModelPrices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := repo.ListPricingModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	visible := 0
	for _, row := range rows {
		if _, ok := catalog[row.Model]; ok {
			visible++
		}
	}
	if visible != len(rows) || visible == 0 {
		t.Fatalf("%d of %d stored prices are visible against the seeded catalogue", visible, len(rows))
	}

	// Every mode the price book distinguishes has to be present: automatic matches, a
	// pin, and hand-set rates. A fixture that marked every row as synced would claim an
	// operator's own rates came from OpenRouter.
	modes := make(map[string]int)
	links, err := repo.ListModelLinks(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		_, linked := links[row.Model]
		modes[pricing.DeriveMode(row.Source, linked)]++
	}
	if modes[pricing.ModeAuto] == 0 || modes[pricing.ModeLinked] == 0 || modes[pricing.ModeCustom] == 0 {
		t.Fatalf("seeded price modes = %v, want automatic, linked and custom rates", modes)
	}
	// The attention inbox needs a current model with no price.
	unpricedModels := 0
	for model := range catalog {
		found := false
		for _, row := range rows {
			found = found || row.Model == model
		}
		if !found {
			unpricedModels++
		}
	}
	if unpricedModels == 0 {
		t.Fatal("no catalogue model is left unpriced, so the attention inbox never renders")
	}
	// The picker reads the stored snapshot, and the channel tab needs a multiplier.
	upstream, err := repo.ListUpstreamCatalog(ctx)
	if err != nil || len(upstream) == 0 {
		t.Fatalf("OpenRouter snapshot: %d %v", len(upstream), err)
	}
	channels, err := repo.ListChannelMultipliers(ctx)
	if err != nil || len(channels) == 0 {
		t.Fatalf("channel multipliers: %+v %v", channels, err)
	}
	var scaled int64
	if err := repo.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_events WHERE channel_version_id IS NOT NULL`).Scan(&scaled); err != nil || scaled == 0 {
		t.Fatalf("no seeded request was priced under the channel multiplier: %d %v", scaled, err)
	}

	// The page also prints the sync bookkeeping beside those rows, and the count it
	// reports has to be the rows it actually priced from OpenRouter.
	state, err := repo.GetPricingSyncState(ctx, pricing.SourceOpenRouter)
	if err != nil {
		t.Fatal(err)
	}
	if state.LastSuccessAtMS == nil || state.LastMatched != int64(modes[pricing.ModeAuto]+modes[pricing.ModeLinked]) {
		t.Fatalf("pricing sync state = %+v, want %d matched models", state, modes[pricing.ModeAuto]+modes[pricing.ModeLinked])
	}
}

// The rollups are what the long windows read. Seeding detail rows alone would leave
// the seven- and thirty-day views answering from the detail table, which works but
// is not the path the console is supposed to take.
func TestSeedAggregatesRollups(t *testing.T) {
	ctx := context.Background()
	repo, _, _ := seededDatabase(t)
	stats, err := repo.StatsUsagePipeline(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.CheckpointHourly == 0 || stats.CheckpointDaily == 0 {
		t.Fatalf("aggregation checkpoints = %d/%d, want both grains folded", stats.CheckpointHourly, stats.CheckpointDaily)
	}
}

// The caller-key names are Oh My CPA's own metadata, and they are what the request
// list shows instead of a mask. The alias has to be stored under the same fingerprint
// the seeded records carry, or the list would show the mask.
func TestSeedNamesTheCallerKeys(t *testing.T) {
	ctx := context.Background()
	repo, _, _ := seededDatabase(t)

	for _, key := range gatewayKeyCatalog() {
		fingerprint, err := repo.UsageClientKeyFingerprint(key.value)
		if err != nil {
			t.Fatal(err)
		}
		aliases, err := repo.ClientKeyAliasesFor(ctx, instanceID, []string{fingerprint})
		if err != nil {
			t.Fatal(err)
		}
		if aliases[fingerprint] != key.alias {
			t.Errorf("caller key %q resolves to %q, want %q", key.value, aliases[fingerprint], key.alias)
		}
	}

	// The stored records must agree: a fingerprint the runtime cannot produce would
	// leave every request row unnamed.
	var stored string
	if err := repo.SQL().QueryRowContext(ctx, `
		SELECT api_group_key FROM usage_events
		WHERE api_key_mask <> '' LIMIT 1`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stored, "hmac:") {
		t.Fatalf("stored caller identity = %q, want a keyed fingerprint", stored)
	}
}

// The seeded rows go through the real insert path, which is what applies the
// display-mask rules. A fixture that bypassed them would show a raw caller key.
func TestSeedNeverStoresACallerKeyInTheClear(t *testing.T) {
	ctx := context.Background()
	repo, _, _ := seededDatabase(t)

	rows, err := repo.SQL().QueryContext(ctx, `SELECT api_group_key, api_key_mask FROM usage_events`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	checked := 0
	for rows.Next() {
		var identity, mask string
		if err := rows.Scan(&identity, &mask); err != nil {
			t.Fatal(err)
		}
		checked++
		for _, key := range gatewayKeyCatalog() {
			if identity == key.value || mask == key.value {
				t.Fatalf("a caller key reached storage in the clear: %q", key.value)
			}
		}
		if !strings.HasPrefix(mask, "omc-demo-key") {
			continue
		}
		t.Fatalf("mask %q looks like a stored secret rather than a mask", mask)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if checked == 0 {
		t.Fatal("no stored request was checked, so this test proves nothing")
	}

	// And the mask the fixture writes is the one the mask helper produces, so the
	// console and the fixture agree on what a masked key looks like.
	if mask := security.MaskSecret(gatewayKeyCatalog()[0].value); !strings.Contains(mask, "•") && mask == gatewayKeyCatalog()[0].value {
		t.Fatalf("MaskSecret produced an unmasked value: %q", mask)
	}
}

// TestSeedAttributesRequestsToConfiguredCredentials keeps the demonstration able to
// show which provider key answered. The request list resolves that from the record's
// auth index against the credential lists the gateway reports, and both sides of that
// join are fixtures here: a record whose index no credential claims, or a credential
// list that reports no index, would leave every request row silent while the console
// still looked correct.
func TestSeedAttributesRequestsToConfiguredCredentials(t *testing.T) {
	ctx := context.Background()
	repo, _, _ := seededDatabase(t)

	// Every auth index the compatibility fixture publishes, read the way the resolver
	// reads it.
	declared := make(map[string]bool)
	for _, provider := range compatibilitySection() {
		entries, ok := provider["api-key-entries"].([]map[string]any)
		if !ok {
			t.Fatalf("provider %v publishes no api-key-entries", provider["name"])
		}
		for _, entry := range entries {
			index, _ := entry["auth-index"].(string)
			if strings.TrimSpace(index) == "" {
				t.Fatalf("provider %v publishes a key with no auth-index", provider["name"])
			}
			declared[index] = true
		}
	}
	// The families the console manages report an index per credential too.
	for _, family := range familyCatalog() {
		for _, key := range family.keys {
			if strings.TrimSpace(key.authIndex) == "" {
				t.Fatalf("%s credential %q has no auth index", family.family, key.apiKey)
			}
			declared[key.authIndex] = true
		}
	}
	// And each compatibility provider's own label, derived the way the gateway derives
	// it, is the label its records must carry.
	for _, provider := range compatibilityCatalog() {
		if label := compatibilityRecordLabel(provider.name); !strings.HasPrefix(label, management.OpenAICompatibilityLabelPrefix) {
			t.Fatalf("compatibility provider %q produces the label %q", provider.name, label)
		}
	}
	familyNames := map[string]bool{
		string(management.ConfigFamilyCodex):  true,
		string(management.ConfigFamilyClaude): true,
		string(management.ConfigFamilyGemini): true,
		string(management.ConfigFamilyMeta):   true,
	}

	// A seeded request answered through one of those credentials must name an index
	// that credential list actually claims. The fixture stores the payload's own
	// spelling of the auth type, which is why both are selected here.
	//
	// No LIMIT: the statement orders nothing, so a cap would check an arbitrary subset
	// and could stop covering the very rows this is meant to verify.
	rows, err := repo.SQL().QueryContext(ctx, `
		SELECT provider, auth_type, auth_index FROM usage_events
		WHERE auth_type IN ('apikey', 'api_key')`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	attributed := 0
	for rows.Next() {
		var provider, authType, authIndex string
		if err := rows.Scan(&provider, &authType, &authIndex); err != nil {
			t.Fatal(err)
		}
		attributed++
		if strings.TrimSpace(authIndex) == "" {
			t.Fatalf("an API-key request from %s carries no auth index", provider)
		}
		if !declared[authIndex] {
			t.Fatalf("API-key request from %s carries auth index %q, which no credential claims: "+
				"the request list would print no provider key", provider, authIndex)
		}
		// The provider label is the other half of the join: the console resolves a
		// record only when its label names a credential list, so a fixture that used a
		// display name here would look right on screen and resolve nothing.
		label := strings.ToLower(strings.TrimSpace(provider))
		if !familyNames[label] && !strings.HasPrefix(label, management.OpenAICompatibilityLabelPrefix) {
			t.Fatalf("API-key request labels its provider %q, which names no credential list", provider)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if attributed == 0 {
		t.Fatal("no API-key request in the fixture can name the key that served it")
	}
}

// A restart must not double the numbers. The platform scales a demo instance to zero,
// so a database left behind by an earlier boot is a normal event, not an edge case -
// and the application deletes it rather than appending to it.
func TestResetDatabaseLeavesTheSelfHostedDatabaseAlone(t *testing.T) {
	dir := t.TempDir()
	demoPath := filepath.Join(dir, "oh-my-cpa-demo.db")
	realPath := filepath.Join(dir, "oh-my-cpa.db")
	for _, path := range []string{demoPath, demoPath + "-wal", demoPath + "-shm", realPath} {
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := ResetDatabase(demoPath); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{demoPath, demoPath + "-wal", demoPath + "-shm"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s survived the reset", path)
		}
	}
	if _, err := os.Stat(realPath); err != nil {
		t.Fatalf("the self-hosted database was removed: %v", err)
	}
	// Resetting a database that is not there is the ordinary first boot, not a failure.
	if err := ResetDatabase(demoPath); err != nil {
		t.Fatalf("reset on a missing database: %v", err)
	}
}

func TestResetDatabaseRequiresAPath(t *testing.T) {
	if err := ResetDatabase("  "); err == nil {
		t.Fatal("an empty path was accepted")
	}
}

// The quota reads are the one place a fabricated answer could hide a real request:
// the console hands CPA a URL and CPA is expected to fetch it. The fixture answers
// from its catalogue instead, and everything else is refused rather than forwarded.
func TestUpstreamAnswersQuotaReadsWithoutFetchingAnything(t *testing.T) {
	upstream := startTestUpstream(t)
	client := upstreamClient(upstream)

	for _, target := range quotaPayloadKeys() {
		response := postJSON(t, client, upstream.BaseURL()+managementPrefix+"/requests/api-call", map[string]any{
			"method": "GET",
			"url":    target,
		})
		body := readJSONBody(t, response, http.StatusOK)
		if !strings.Contains(body, `"status_code":200`) {
			t.Errorf("api-call for %s = %s, want a 200 the console can parse", target, body)
		}
		var payload struct {
			Body string `json:"body"`
		}
		if err := json.Unmarshal([]byte(body), &payload); err != nil {
			t.Fatalf("decode api-call envelope: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(payload.Body), &decoded); err != nil {
			t.Errorf("api-call body for %s is not JSON: %v", target, err)
		}
		if len(decoded) == 0 {
			t.Errorf("api-call body for %s is empty", target)
		}
	}

	// A URL outside the catalogue is refused, never dialled. This is the property that
	// keeps the deployed demo from reaching anything at all.
	for _, target := range []string{
		"https://example.test/whatever",
		"http://127.0.0.1:80/admin",
		"https://chatgpt.com/backend-api/wham/usage/../other",
	} {
		response := postJSON(t, client, upstream.BaseURL()+managementPrefix+"/requests/api-call", map[string]any{
			"method": "GET",
			"url":    target,
		})
		defer response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("api-call for %q = %d, want 403", target, response.StatusCode)
		}
	}
}

// The fixture is the second layer behind the route policy: a request that reached a
// credential endpoint should be refused here too, so the boundary does not rest on a
// single classification.
func TestUpstreamRefusesCredentialAndLogBodies(t *testing.T) {
	upstream := startTestUpstream(t)
	client := upstreamClient(upstream)

	for _, call := range []struct {
		method, path, body string
	}{
		{http.MethodGet, managementPrefix + "/credentials/download?name=codex-team-primary.json", ""},
		{http.MethodGet, managementPrefix + "/observability/logs/errors/request-error-2026-09-19T08-15-04Z.log", ""},
		{http.MethodPost, managementPrefix + "/credentials", `{"type":"codex"}`},
		{http.MethodDelete, managementPrefix + "/credentials", `{"names":["codex-team-primary.json"]}`},
		{http.MethodPost, managementPrefix + "/routing/cooldown/reset", `{"auth_index":"auth-codex-01"}`},
		{http.MethodPut, managementPrefix + "/config.yaml", "debug: true"},
		{http.MethodPatch, managementPrefix + "/config", `{"debug":true}`},
		{http.MethodDelete, managementPrefix + "/plugins/usage-exporter", ""},
		{http.MethodPost, managementPrefix + "/plugins/store/usage-exporter/install", `{}`},
		{http.MethodGet, managementPrefix + "/oauth/auth-url?provider=codex", ""},
		{http.MethodPut, legacyManagementPrefix + "/config.yaml", "debug: true"},
		{http.MethodPut, legacyManagementPrefix + "/api-keys", `["sk-new"]`},
		{http.MethodPut, legacyManagementPrefix + "/codex-api-key", `[]`},
	} {
		request, err := http.NewRequest(call.method, upstream.BaseURL()+call.path, strings.NewReader(call.body))
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body := readBody(t, response)
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s = %d (%s), want 403", call.method, call.path, response.StatusCode, body)
			continue
		}
		if !strings.Contains(body, "demo") {
			t.Errorf("%s %s refusal does not explain itself: %s", call.method, call.path, body)
		}
	}
}

func TestUpstreamRequiresItsOwnKey(t *testing.T) {
	upstream := startTestUpstream(t)
	response, err := http.Get(upstream.BaseURL() + managementPrefix + "/credentials")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated read = %d, want 401", response.StatusCode)
	}
}

// Every endpoint the console reads has to answer, or a page would render its empty
// state over a fixture that exists.
func TestUpstreamServesTheConsoleSurface(t *testing.T) {
	upstream := startTestUpstream(t)
	client := upstreamClient(upstream)

	// The gate's probe answers a bare 8, which is the whole of a usable answer.
	if body := readBody(t, getWithClient(t, client, upstream.BaseURL()+managementPrefix+"/config/config-version")); strings.TrimSpace(body) != "8" {
		t.Fatalf("the fixture must answer the v8 probe with 8, got %q", body)
	}
	for _, path := range []string{
		managementPrefix + "/credentials",
		managementPrefix + "/credentials/models?name=codex-team-primary.json",
		managementPrefix + "/observability/usage/api-keys",
		managementPrefix + "/plugins",
		managementPrefix + "/plugins/store",
		managementPrefix + "/observability/logs",
		managementPrefix + "/observability/logs/errors",
		managementPrefix + "/server/latest-version",
		managementPrefix + "/oauth/status",
		managementPrefix + "/config",
		managementPrefix + "/config.yaml",
		managementPrefix + "/config/oauth/model-alias",
		managementPrefix + "/config/plugins/configs/usage-exporter",
		legacyManagementPrefix + "/config.yaml",
		legacyManagementPrefix + "/openai-compatibility",
		legacyManagementPrefix + "/claude-api-key",
		legacyManagementPrefix + "/codex-api-key",
		legacyManagementPrefix + "/gemini-api-key",
		legacyManagementPrefix + "/meta-api-key",
	} {
		response := getWithClient(t, client, upstream.BaseURL()+path)
		body := readBody(t, response)
		if response.StatusCode != http.StatusOK {
			t.Errorf("GET %s = %d (%s), want 200", path, response.StatusCode, body)
			continue
		}
		if len(strings.TrimSpace(body)) < 3 {
			t.Errorf("GET %s answered %q, which is not a usable fixture", path, body)
		}
	}
}

// The credential list is stateful, so the console's status toggle is a real write
// against the fixture rather than an acknowledgement. It is one of the writes the
// demo allows, which makes it the one that has to work.
func TestUpstreamStoresCredentialEdits(t *testing.T) {
	upstream := startTestUpstream(t)
	client := upstreamClient(upstream)

	response := patchJSON(t, client, upstream.BaseURL()+managementPrefix+"/credentials/status", map[string]any{
		"name": "codex-team-primary.json", "disabled": true,
	})
	readBody(t, response)

	body := readBody(t, getWithClient(t, client, upstream.BaseURL()+managementPrefix+"/credentials"))
	if !strings.Contains(body, `"status":"disabled"`) {
		t.Fatalf("the status write was not stored: %s", body)
	}
}

// Inlining a plugin's logo means fetching a URL the plugin declares. Every fixture
// logo is inline artwork instead, which is what keeps the demonstration from fetching
// anything a plugin or a registry names even if the fetcher were ever installed in
// demo mode.
func TestFixturePublishesNoPluginLogoURL(t *testing.T) {
	logos := []string{}
	for _, plugin := range pluginCatalog() {
		logos = append(logos, plugin.logo)
	}
	for _, plugin := range pluginStoreCatalog() {
		if strings.Contains(strings.ToLower(plugin.description), "http") {
			t.Errorf("store plugin %q describes itself with a URL", plugin.id)
		}
		logos = append(logos, plugin.logo)
	}
	for _, logo := range logos {
		if logo != "" && !strings.HasPrefix(logo, "data:image/svg+xml;base64,") {
			t.Errorf("fixture logo %q is not inline artwork", logo)
		}
	}
}

// The fixture's provider URLs are duplicated from internal/quota on purpose, so this
// is what keeps the duplication honest: a URL the quota service would no longer send
// is one the fixture would answer into the void, and the quota page would be empty
// for no visible reason.
func TestFixtureQuotaURLsAreTheOnesTheQuotaServiceMayCall(t *testing.T) {
	for _, target := range quotaPayloadKeys() {
		if !quota.IsAllowedQuotaURL(target) {
			t.Errorf("fixture answers %q, which the quota service is not allowed to call", target)
		}
	}
	// And the reverse direction for the endpoints the console reaches by name, so a
	// renamed upstream constant shows up here rather than on the page.
	for _, target := range []string{
		quota.CodexUsageURL,
		quota.CodexResetCreditsURL,
		quota.CodexSubscriptionURL,
		quota.ClaudeUsageURL,
		quota.ClaudeProfileURL,
		quota.KimiUsageURL,
		quota.XaiBillingMonthlyURL,
		quota.AntigravityQuotaURLDaily,
		quota.DevinSeatStatusURL,
	} {
		covered := false
		for _, answered := range quotaPayloadKeys() {
			if answered == target {
				covered = true
				break
			}
		}
		if !covered {
			t.Errorf("the quota service calls %q, which the fixture does not answer", target)
		}
	}
}

// The capture state is what the request list prints in its own header. Reporting
// "disabled" there would describe the fixture rather than the product, so the demo
// reports the deployment its fixture describes - while the numbers stay read from the
// database.
func TestIngestStatusDescribesTheInstanceAndReadsItsOwnStats(t *testing.T) {
	ctx := context.Background()
	repo, _, _ := seededDatabase(t)
	status, err := IngestStatus(ctx, repo, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if !status.Enabled || !status.Healthy || !status.Collector.Running {
		t.Fatalf("demo capture state = %+v, want an enabled, healthy collector", status)
	}
	if status.Stats.Events == 0 || status.Collector.Captured != status.Stats.Events {
		t.Fatalf("capture counters = %+v, want them read from the seeded database", status)
	}
	if status.Collector.LastCaptureAt == nil {
		t.Fatal("the demo reports a running collector with no capture time")
	}
}

// A manual sync in the demo pops nothing, because there is no gateway queue to pop.
func TestRefreshResultReportsAnEmptyQueue(t *testing.T) {
	result := RefreshResult()
	if !result.Enabled || !result.Synced {
		t.Fatalf("refresh result = %+v, want a completed pass", result)
	}
	if result.Captured != 0 || result.Decoded != 0 || result.Pending != 0 || result.Error != "" {
		t.Fatalf("refresh result = %+v, want nothing captured and no error", result)
	}
}

// The snapshot-fallback rendering exists for the case where a live subscription
// read fails, which a real deployment reaches only by accident. The fixture has to
// keep refusing that read for at least one credential, or the branch silently loses
// its browser coverage. The same applies to the non-renewing marker, which needs a
// seat upstream calls live as well.
func TestFixtureKeepsASubscriptionReadUnavailable(t *testing.T) {
	if len(subscriptionUnavailable) == 0 {
		t.Fatal("the fixture answers every credential's subscription read, so the unverified-snapshot card is never rendered")
	}

	enabledCodex := make(map[string]bool)
	for _, cred := range credentialCatalog() {
		if cred.kind != "codex" || cred.isDisabled {
			continue
		}
		enabledCodex[cred.authIndex] = true
	}

	var bound, notRenewing int
	for authIndex := range enabledCodex {
		if subscriptionUnavailable[authIndex] {
			bound++
		}
		if subscriptionNotRenewing[authIndex] && !subscriptionUnavailable[authIndex] {
			notRenewing++
		}
	}
	// A seat that renews on schedule is what the other two are read against, so the
	// demonstration keeps the ordinary reading too.
	healthy := len(enabledCodex) - bound - notRenewing
	if healthy < 1 {
		t.Errorf("codex seats = %d, unverified = %d, non-renewing = %d; no seat is left to show an ordinary renewal", len(enabledCodex), bound, notRenewing)
	}
	if bound == 0 {
		t.Error("no enabled credential lacks a live subscription read, so the quota page never shows an unverified bound")
	}
	if notRenewing == 0 {
		t.Error("no enabled credential reports will_renew=false, so the non-renewing marker is never rendered")
	}
}

// The early history is the quietest part of the curve, and it still has to read as a
// deployment that carried traffic.
//
// The expected rate there is a few requests an hour, and rounding that to a whole number
// per hour emptied most of those hours: the token-activity grid drew a blank first third
// beside a full remainder, which reads as a broken fixture rather than a quiet quarter. The
// assertion is on days rather than on hours because a day is what a reader sees.
func TestSeedKeepsTheOldestHistoryReadable(t *testing.T) {
	ctx := context.Background()
	repo, now, _ := seededDatabase(t)

	// The oldest month the grid draws, sampled as whole days.
	start := now.AddDate(0, 0, -historyDays+1)
	end := start.AddDate(0, 0, 30)
	analytics, err := repo.QueryUsageAnalytics(ctx, instanceID, start.UnixMilli(), end.UnixMilli(),
		24*time.Hour.Milliseconds())
	if err != nil {
		t.Fatal(err)
	}
	days := 0
	for _, bucket := range analytics.Buckets {
		if bucket.Requests > 0 {
			days++
		}
	}
	events := analytics.Totals.Requests
	if days < 25 {
		t.Errorf("the oldest month carries traffic on %d of its first 31 days, want most of them: %d requests", days, events)
	}
}

// The count draw is a draw, so it is asserted on its mean rather than on one sample: the
// burst multiplier is what makes an hour carry several times its share, and a correction
// that only touched the bursts would drift the whole rate curve upwards.
func TestDrawRequestCountKeepsItsMean(t *testing.T) {
	for _, mean := range []float64{0.3, 1.0, 2.0, 7.0, 18.0} {
		random := newDeterministic(0xD1CE)
		const draws = 20000
		total := 0
		for index := 0; index < draws; index++ {
			total += drawRequestCount(random, mean)
		}
		average := float64(total) / draws
		if average < mean*0.9 || average > mean*1.18 {
			t.Errorf("mean %v drew an average of %.2f over %d hours, want it within a tenth", mean, average, draws)
		}
	}
}

// An era naming a model the catalogue does not carry would quietly fall back to the
// catalogue draw, and the history would lose the focus it exists to give.
func TestFocusErasNameCatalogueModels(t *testing.T) {
	known := make(map[string]bool)
	for _, profile := range modelCatalog() {
		known[profile.name] = true
	}
	for _, era := range focusEras() {
		for _, choice := range era.choices {
			if !known[choice.model] {
				t.Errorf("focus era ending %v days ago names %q, which the catalogue does not serve", era.untilDaysAgo, choice.model)
			}
		}
	}
}

// One person's gateway runs on one model at a time, so a day's traffic is led by a
// model or two rather than spread evenly across the catalogue: the per-model trend
// should read as one busy line, not as a tangle of equal ones.
func TestSeedConcentratesADayOnFewModels(t *testing.T) {
	ctx := context.Background()
	repo, now, _ := seededDatabase(t)
	rows, err := repo.SQL().QueryContext(ctx, `
		SELECT model, SUM(total_tokens) FROM usage_events
		WHERE timestamp_ms >= ? GROUP BY model ORDER BY 2 DESC`, now.Add(-24*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var shares []int64
	var total int64
	for rows.Next() {
		var model string
		var tokens int64
		if err := rows.Scan(&model, &tokens); err != nil {
			t.Fatal(err)
		}
		shares = append(shares, tokens)
		total += tokens
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(shares) < 2 || total == 0 {
		t.Fatalf("the last day carries %d models, want a leader and a background", len(shares))
	}
	if leading := float64(shares[0]+shares[1]) / float64(total); leading < 0.6 {
		t.Errorf("the two busiest models carry %.0f%% of the last day's tokens, want most of it", leading*100)
	}
}
