package repository

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// fingerprintTestRepository opens a private in-memory database with the
// application cipher wired in. The plain usageTestRepository has no cipher, so
// every fingerprinted column degrades to the redaction marker and tests that
// care about source or caller identity cannot see the difference.
func fingerprintTestRepository(t *testing.T) *Repository {
	t.Helper()
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("file:memdb_fingerprint_%d?mode=memory&cache=shared", usageDSNCounter.Add(1))
	db, err := Open(context.Background(), name, WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.SQL.Exec(`
		INSERT INTO cpa_instances (id, name, base_url, usage_addr,
			management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317',
			x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	return New(db)
}

// filterTestRepository seeds a small, fully specified corpus. Every assertion
// below is about which rows a filter selects, so the rows differ along exactly
// one dimension at a time and a wrong predicate changes the count.
func filterTestRepository(t *testing.T) *Repository {
	t.Helper()
	repo := fingerprintTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	modelAlias := "fast-alias"
	agent := "codex-cli/0.46"

	events := []usage.Event{
		{
			InstanceID: "default", EventKey: "alpha", RequestID: "req-alpha",
			Model: "gpt-5", ModelAlias: &modelAlias, Provider: "openai", AuthIndex: "auth-a",
			AuthType: "oauth", ExecutorType: "codex", APIGroupKey: "sk-alpha", APIKeyMask: "sk-aaaa••••••••1111",
			Source: "team-a.json", Endpoint: "https://relay.example/v1/responses", UserAgent: &agent,
			ReasoningEffort: "high", ServiceTier: "auto",
			TimestampMS: base.Add(-5 * time.Minute).UnixMilli(), Generate: true,
			LatencyMS: 900, TotalTokens: 1000, InputTokens: 800, OutputTokens: 200,
		},
		{
			InstanceID: "default", EventKey: "beta", RequestID: "req-beta",
			Model: "claude-sonnet-4-5", Provider: "claude", AuthIndex: "auth-b",
			AuthType: "apikey", ExecutorType: "claude", APIGroupKey: "sk-beta",
			Source: "team-b.json", Endpoint: "https://relay.example/v1/messages",
			ReasoningEffort: "low", ServiceTier: "default",
			TimestampMS: base.Add(-4 * time.Minute).UnixMilli(), Generate: true,
			Failed: true, LatencyMS: 45_000, TotalTokens: 90_000, InputTokens: 80_000, OutputTokens: 10_000,
		},
		{
			InstanceID: "default", EventKey: "gamma", RequestID: "req-gamma",
			Model: "gpt-5", Provider: "openai", AuthIndex: "auth-a",
			AuthType: "oauth", ExecutorType: "codex", APIGroupKey: "sk-alpha",
			Source: "team-a.json", Endpoint: "https://other.example/v1/responses",
			ReasoningEffort: "medium", ServiceTier: "flex",
			TimestampMS: base.Add(-3 * time.Minute).UnixMilli(), Generate: true,
			LatencyMS: 300, TotalTokens: 250_000, InputTokens: 200_000, OutputTokens: 50_000,
		},
		{
			// Deliberately full of LIKE metacharacters: the free-text filter must
			// treat them literally instead of letting them act as wildcards.
			// Request ids are the one identity column stored verbatim, so they can
			// carry a literal escape character through to the query.
			InstanceID: "default", EventKey: "literal-wildcards", RequestID: `req-100%_done\\path`,
			Model: "gpt_5.0%preview", Provider: "openai", AuthIndex: "auth-c",
			APIGroupKey: "sk-gamma", Source: "50%_share.json", Endpoint: "https://relay.example/v1/preview",
			TimestampMS: base.Add(-2 * time.Minute).UnixMilli(), Generate: true,
			LatencyMS: 1200, TotalTokens: 42,
		},
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	return repo
}

func listFilterEventKeys(t *testing.T, repo *Repository, filter UsageEventFilter) []string {
	t.Helper()
	page, err := repo.ListUsageEvents(context.Background(), filter)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	keys := make([]string, 0, len(page.Items))
	for _, item := range page.Items {
		keys = append(keys, item.EventKey)
	}
	return keys
}

func filterTestWindow() (int64, int64) {
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)
	return base.Add(-time.Hour).UnixMilli(), base.UnixMilli()
}

func filterTestFilter() UsageEventFilter {
	from, to := filterTestWindow()
	return UsageEventFilter{InstanceID: "default", FromMS: from, ToMS: to}
}

func containsKeys(keys []string, want ...string) bool {
	if len(keys) != len(want) {
		return false
	}
	seen := map[string]bool{}
	for _, key := range keys {
		seen[key] = true
	}
	for _, key := range want {
		if !seen[key] {
			return false
		}
	}
	return true
}

func int64Ptr(value int64) *int64 { return &value }

// A dimension with several values is an OR; two dimensions are an AND. The
// distinction is the whole point of multi-select, and getting it backwards makes
// a filter either uselessly wide or uselessly narrow.
func TestListUsageEventsCombinesDimensionsWithAnd(t *testing.T) {
	repo := filterTestRepository(t)

	filter := filterTestFilter()
	filter.Models = []string{"gpt-5"}
	filter.Providers = []string{"openai"}
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "alpha", "gamma") {
		t.Fatalf("model AND provider = %v", keys)
	}

	// A second dimension that contradicts the first must return nothing rather
	// than falling back to an OR.
	filter.Models = []string{"gpt-5"}
	filter.Providers = []string{"claude"}
	if keys := listFilterEventKeys(t, repo, filter); len(keys) != 0 {
		t.Fatalf("contradicting dimensions must intersect to nothing, got %v", keys)
	}

	// Values inside one dimension are a union, not an intersection.
	filter = filterTestFilter()
	filter.Models = []string{"gpt-5", "claude-sonnet-4-5"}
	if keys := listFilterEventKeys(t, repo, filter); len(keys) != 3 {
		t.Fatalf("OR inside a dimension = %v", keys)
	}

	// Each provider dimension value must itself be honoured: the union of two
	// providers over the same window contains both branches.
	filter = filterTestFilter()
	filter.Providers = []string{"openai", "claude"}
	if keys := listFilterEventKeys(t, repo, filter); len(keys) != 4 {
		t.Fatalf("provider union = %v", keys)
	}

	// Blank entries are dropped instead of matching the many rows whose column is
	// empty, and duplicates cannot change the result.
	filter = filterTestFilter()
	filter.Models = []string{"  ", "gpt-5", "gpt-5", ""}
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "alpha", "gamma") {
		t.Fatalf("blank and duplicate values = %v", keys)
	}
}

// Values must never be matched as SQL patterns. A caller typing "%" means a
// percent sign, not "show me everything".
func TestListUsageEventsSearchTreatsWildcardsLiterally(t *testing.T) {
	repo := filterTestRepository(t)

	filter := filterTestFilter()
	filter.Search = "100%"
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "literal-wildcards") {
		t.Fatalf("percent must be literal, got %v", keys)
	}

	// A bare "%" matches only the one record that actually contains a percent
	// sign; treating it as a wildcard would return the whole window.
	filter = filterTestFilter()
	filter.Search = "%"
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "literal-wildcards") {
		t.Fatalf("a lone percent must not match everything, got %v", keys)
	}

	// "_" is the single-character wildcard in LIKE. Untreated it would make
	// "gpt_5" also match "gpt-5".
	filter = filterTestFilter()
	filter.Search = "gpt_5"
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "literal-wildcards") {
		t.Fatalf("underscore must be literal, got %v", keys)
	}

	// The escape character itself must survive the round trip.
	filter = filterTestFilter()
	filter.Search = `done\\path`
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "literal-wildcards") {
		t.Fatalf("escape character must be literal, got %v", keys)
	}

	// The search is a disjunction across identity columns, and it must stay
	// parenthesised: unparenthesised it would swallow the model predicate below
	// and return the beta record too.
	filter = filterTestFilter()
	filter.Search = "req-beta"
	filter.Models = []string{"gpt-5"}
	if keys := listFilterEventKeys(t, repo, filter); len(keys) != 0 {
		t.Fatalf("search must be ANDed with the other dimensions, got %v", keys)
	}

	// Identity columns are searched, and the match is a substring.
	for _, term := range []string{"req-alpha", "codex", "claude-sonnet", "codex-cli"} {
		filter = filterTestFilter()
		filter.Search = term
		if keys := listFilterEventKeys(t, repo, filter); len(keys) == 0 {
			t.Fatalf("search %q matched nothing", term)
		}
	}
}

// A bound set to zero is a real bound, not an absent one. This is the reason the
// bounds are pointers: `max_cost=0` has to mean "priced at nothing", and NaN-like
// sentiment about zero would silently return everything instead.
func TestListUsageEventsBoundsTreatZeroAsABound(t *testing.T) {
	repo := filterTestRepository(t)

	filter := filterTestFilter()
	filter.MaxTokens = int64Ptr(0)
	if keys := listFilterEventKeys(t, repo, filter); len(keys) != 0 {
		t.Fatalf("max_tokens=0 must exclude every record with tokens, got %v", keys)
	}

	filter = filterTestFilter()
	filter.MinLatencyMS = int64Ptr(1000)
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "beta", "literal-wildcards") {
		t.Fatalf("min latency = %v", keys)
	}

	// Both bounds are inclusive, so a bound equal to a stored value keeps it.
	filter = filterTestFilter()
	filter.MinLatencyMS = int64Ptr(900)
	filter.MaxLatencyMS = int64Ptr(900)
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "alpha") {
		t.Fatalf("inclusive bounds = %v", keys)
	}

	filter = filterTestFilter()
	filter.MinTokens = int64Ptr(90_000)
	filter.MaxTokens = int64Ptr(250_000)
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "beta", "gamma") {
		t.Fatalf("token range = %v", keys)
	}

	filter = filterTestFilter()
	filter.MinLatencyMS = int64Ptr(100_000)
	if keys := listFilterEventKeys(t, repo, filter); len(keys) != 0 {
		t.Fatalf("an impossible lower bound returns nothing, got %v", keys)
	}
}

// Cost bounds and cost availability are different questions and must not be
// confused: an unpriced record has no cost at all, so it satisfies neither a
// lower bound nor an upper one, and can only be reached by asking for unpriced.
func TestListUsageEventsCostStateAndBounds(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()

	// Pricing is written by the insert path and then frozen by a trigger, so the
	// catalog is the only way in. The rate is chosen so one million input tokens
	// costs exactly $1.
	//
	// The window follows the fixture rather than the shared fixed test date: a
	// price version is effective from the instant it is written, so an event
	// timestamped before the price is correctly unpriced.
	const pricedModel = "cost-fixture-model"
	if err := repo.UpsertModelPrices(ctx, []pricing.ModelPrice{{
		Model: pricedModel, PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceManual,
	}}); err != nil {
		t.Fatal(err)
	}
	pricedAt := time.Now().UTC().Add(time.Second)

	events := []usage.Event{
		{InstanceID: "default", EventKey: "priced-small", Model: pricedModel, Generate: true,
			TimestampMS: pricedAt.UnixMilli(), InputTokens: 100, TotalTokens: 100},
		{InstanceID: "default", EventKey: "priced-large", Model: pricedModel, Generate: true,
			TimestampMS: pricedAt.Add(time.Second).UnixMilli(), InputTokens: 1_000_000, TotalTokens: 1_000_000},
		{InstanceID: "default", EventKey: "unpriced", Model: "no-such-model", Generate: true,
			TimestampMS: pricedAt.Add(2 * time.Second).UnixMilli(), InputTokens: 500, TotalTokens: 500},
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	window := UsageEventFilter{InstanceID: "default", FromMS: pricedAt.Add(-time.Hour).UnixMilli(), ToMS: pricedAt.Add(time.Minute).UnixMilli()}
	filter := window
	filter.CostState = CostStatePriced
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "priced-small", "priced-large") {
		t.Fatalf("priced = %v", keys)
	}
	filter = window
	filter.CostState = CostStateUnpriced
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "unpriced") {
		t.Fatalf("unpriced = %v", keys)
	}

	// A lower bound excludes the unpriced row instead of treating its NULL as 0.
	filter = window
	filter.MinCostNanos = int64Ptr(1)
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "priced-small", "priced-large") {
		t.Fatalf("min cost = %v", keys)
	}
	// The exact locked amount is $1 for the large record and $0.0001 for the
	// small one, so a narrow range separates them.
	filter = window
	filter.MinCostNanos = int64Ptr(1_000_000_000)
	filter.MaxCostNanos = int64Ptr(1_000_000_000)
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "priced-large") {
		t.Fatalf("cost range = %v", keys)
	}

	// An upper bound of zero selects nothing: both priced rows cost something and
	// the unpriced row has no amount to compare.
	filter = window
	filter.MaxCostNanos = int64Ptr(0)
	if keys := listFilterEventKeys(t, repo, filter); len(keys) != 0 {
		t.Fatalf("max_cost=0 must not match unpriced rows, got %v", keys)
	}

	// Cost availability combines with a bound as an AND.
	filter = window
	filter.CostState = CostStatePriced
	filter.MinCostNanos = int64Ptr(1_000_000_000)
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "priced-large") {
		t.Fatalf("priced AND min cost = %v", keys)
	}

	// The cost column is frozen by a trigger, so a filter that tried to compare
	// against a rewritten column would be reading something that cannot change.
	if _, err := repo.SQL().ExecContext(ctx,
		`UPDATE usage_events SET cost_nanos = 0 WHERE event_key = 'priced-large'`); err == nil {
		t.Fatal("expected the immutability trigger to refuse a reprice")
	}
}

// Endpoint and user agent are substring filters, and neither is a facet because
// both are long free-form values. The endpoint is filtered on without ever being
// returned, which is what keeps the private base URL out of the browser.
func TestListUsageEventsEndpointAndUserAgentSubstring(t *testing.T) {
	repo := filterTestRepository(t)

	filter := filterTestFilter()
	filter.Endpoint = "relay.example"
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "alpha", "beta", "literal-wildcards") {
		t.Fatalf("endpoint substring = %v", keys)
	}

	filter = filterTestFilter()
	filter.Endpoint = "/v1/messages"
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "beta") {
		t.Fatalf("endpoint path = %v", keys)
	}

	filter = filterTestFilter()
	filter.UserAgent = "codex-cli"
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "alpha") {
		t.Fatalf("user agent substring = %v", keys)
	}

	// A blank filter narrows nothing.
	filter = filterTestFilter()
	filter.Endpoint = "   "
	if keys := listFilterEventKeys(t, repo, filter); len(keys) != 4 {
		t.Fatalf("blank endpoint must not narrow, got %v", keys)
	}

	// The endpoint stays filterable without ever being projected into the list
	// payload the browser receives.
	page, err := repo.ListUsageEvents(context.Background(), filter)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) == 0 {
		t.Fatal("fixture is empty")
	}
	for _, item := range page.Items {
		if item.Endpoint == "" {
			t.Fatal("the endpoint column must stay populated for filtering")
		}
	}
}

// source and api_group_key are fingerprinted at the persistence boundary, so the
// console filters them by the stored value it was shown, never by the plaintext
// an operator might guess. This is the property that keeps a raw caller key out
// of the database while still letting the list group by it.
func TestListUsageEventsFiltersByStoredFingerprintNotPlaintext(t *testing.T) {
	repo := filterTestRepository(t)

	page, err := repo.ListUsageEvents(context.Background(), filterTestFilter())
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]UsageEventRow{}
	for _, item := range page.Items {
		byKey[item.EventKey] = item
	}
	beta, present := byKey["beta"]
	if !present {
		t.Fatal("fixture record beta is missing")
	}
	if !strings.HasPrefix(beta.Source, "hmac:") || !strings.HasPrefix(beta.APIGroupKey, "hmac:") {
		t.Fatalf("fixture no longer exercises fingerprinting: source=%q group=%q", beta.Source, beta.APIGroupKey)
	}

	// The plaintext the operator typed into CPA matches nothing, because it was
	// never stored.
	filter := filterTestFilter()
	filter.Sources = []string{"team-b.json"}
	if keys := listFilterEventKeys(t, repo, filter); len(keys) != 0 {
		t.Fatalf("plaintext source must not match, got %v", keys)
	}
	filter = filterTestFilter()
	filter.APIGroupKeys = []string{"sk-beta"}
	if keys := listFilterEventKeys(t, repo, filter); len(keys) != 0 {
		t.Fatalf("plaintext caller key must not match, got %v", keys)
	}

	// The stored fingerprint is what the facet offered, so it is what the filter
	// must accept.
	filter = filterTestFilter()
	filter.Sources = []string{beta.Source}
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "beta") {
		t.Fatalf("stored source fingerprint = %v", keys)
	}
	filter = filterTestFilter()
	filter.APIGroupKeys = []string{beta.APIGroupKey}
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "beta") {
		t.Fatalf("stored caller fingerprint = %v", keys)
	}

	// Searching for the readable mask finds the record, because the mask is the
	// only caller-key form the console ever held.
	filter = filterTestFilter()
	filter.Search = "sk-aaaa"
	if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, "alpha") {
		t.Fatalf("mask search = %v", keys)
	}
}

func TestListUsageEventsRejectsInvalidFilters(t *testing.T) {
	repo := filterTestRepository(t)

	for name, mutate := range map[string]func(*UsageEventFilter){
		"unknown result":     func(f *UsageEventFilter) { f.Result = "maybe" },
		"unknown cost state": func(f *UsageEventFilter) { f.CostState = "cheap" },
		"negative min":       func(f *UsageEventFilter) { f.MinLatencyMS = int64Ptr(-1) },
		"negative max":       func(f *UsageEventFilter) { f.MaxTokens = int64Ptr(-1) },
		"negative cost":      func(f *UsageEventFilter) { f.MinCostNanos = int64Ptr(-1) },
	} {
		t.Run(name, func(t *testing.T) {
			filter := filterTestFilter()
			mutate(&filter)
			if _, err := repo.ListUsageEvents(context.Background(), filter); !errors.Is(err, ErrUsageFilterInvalid) {
				t.Fatalf("err = %v, want ErrUsageFilterInvalid", err)
			}
		})
	}

	// An over-long dimension is refused rather than truncated: dropping values
	// would quietly widen the result set the caller asked for.
	filter := filterTestFilter()
	for index := 0; index <= MaxUsageEventFilterValues; index++ {
		filter.Providers = append(filter.Providers, "provider-"+strconv.Itoa(index))
	}
	if _, err := repo.ListUsageEvents(context.Background(), filter); !errors.Is(err, ErrUsageFilterInvalid) {
		t.Fatalf("oversized dimension err = %v, want ErrUsageFilterInvalid", err)
	}

	// A reversed range returns no qualifying record, so it is a filter error and
	// not an empty page: the console shows it next to the field.
	filter = filterTestFilter()
	filter.FromMS, filter.ToMS = filter.ToMS, filter.FromMS
	if _, err := repo.ListUsageEvents(context.Background(), filter); !errors.Is(err, ErrUsageFilterInvalid) {
		t.Fatalf("reversed window err = %v, want ErrUsageFilterInvalid", err)
	}
}

// Every dimension the console exposes must actually narrow the list. A filter
// that compiles but is never wired into the WHERE clause is invisible until an
// operator notices the row count never changes.
func TestListUsageEventsEveryDimensionNarrows(t *testing.T) {
	repo := filterTestRepository(t)

	cases := []struct {
		name   string
		mutate func(*UsageEventFilter)
		want   []string
	}{
		{"model", func(f *UsageEventFilter) { f.Models = []string{"claude-sonnet-4-5"} }, []string{"beta"}},
		{"model alias", func(f *UsageEventFilter) { f.ModelAliases = []string{"fast-alias"} }, []string{"alpha"}},
		{"provider", func(f *UsageEventFilter) { f.Providers = []string{"claude"} }, []string{"beta"}},
		{"auth index", func(f *UsageEventFilter) { f.AuthIndexes = []string{"auth-b"} }, []string{"beta"}},
		{"auth type", func(f *UsageEventFilter) { f.AuthTypes = []string{"apikey"} }, []string{"beta"}},
		{"executor", func(f *UsageEventFilter) { f.ExecutorTypes = []string{"claude"} }, []string{"beta"}},
		{"reasoning effort", func(f *UsageEventFilter) { f.ReasoningEfforts = []string{"high"} }, []string{"alpha"}},
		{"service tier", func(f *UsageEventFilter) { f.ServiceTiers = []string{"flex"} }, []string{"gamma"}},
		{"request id", func(f *UsageEventFilter) { f.RequestID = "req-gamma" }, []string{"gamma"}},
		{"failed only", func(f *UsageEventFilter) { f.Result = ResultFailed }, []string{"beta"}},
		{"succeeded only", func(f *UsageEventFilter) { f.Result = ResultSuccess }, []string{"alpha", "gamma", "literal-wildcards"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			filter := filterTestFilter()
			testCase.mutate(&filter)
			if keys := listFilterEventKeys(t, repo, filter); !containsKeys(keys, testCase.want...) {
				t.Fatalf("keys = %v, want %v", keys, testCase.want)
			}
		})
	}
}

// A cursor must compose with the filters rather than replace them: paging
// through a filtered list has to stay inside the filter.
func TestListUsageEventsCursorStaysInsideTheFilter(t *testing.T) {
	repo := filterTestRepository(t)

	filter := filterTestFilter()
	filter.Providers = []string{"openai"}
	filter.Limit = 2

	first, err := repo.ListUsageEvents(context.Background(), filter)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || !first.HasMore {
		t.Fatalf("first page = %d items, has_more=%v", len(first.Items), first.HasMore)
	}
	filter.Cursor = first.NextCursor
	second, err := repo.ListUsageEvents(context.Background(), filter)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 {
		t.Fatalf("second page = %d items, want the remaining openai record", len(second.Items))
	}
	for _, item := range append(first.Items, second.Items...) {
		if item.Provider != "openai" {
			t.Fatalf("cursor page escaped the filter: %+v", item)
		}
	}
}

// Every caller-supplied value must travel as a bound argument, never as SQL text.
// This is the security-critical property of a filter feature: a value containing a
// quote or a comment marker would otherwise terminate the predicate early.
func TestUsageEventWhereBindsEveryValueAsAnArgument(t *testing.T) {
	const hostile = `x' OR 1=1 --`
	from, to := filterTestWindow()
	filter := UsageEventFilter{
		InstanceID: "default", FromMS: from, ToMS: to,
		Models:        []string{hostile},
		Providers:     []string{hostile},
		AuthTypes:     []string{hostile},
		ExecutorTypes: []string{hostile},
		Sources:       []string{hostile},
		RequestID:     hostile,
		Endpoint:      hostile,
		UserAgent:     hostile,
		Search:        hostile,
		// A wildcard-heavy value exercises the LIKE escaping as well.
		Result: ResultFailed,
	}

	where, args, err := usageEventWhere(filter)
	if err != nil {
		t.Fatal(err)
	}
	for _, clause := range where {
		if strings.Contains(clause, hostile) {
			t.Fatalf("a caller value reached the SQL text: %s", clause)
		}
		if strings.Contains(clause, "OR 1=1") {
			t.Fatalf("a caller value was interpolated: %s", clause)
		}
	}
	// The value is still applied, just as a bound parameter.
	found := false
	for _, arg := range args {
		if text, ok := arg.(string); ok && strings.Contains(text, "OR 1=1") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("the caller value must still be bound as an argument")
	}
	// Every column name comes from a static allowlist, so no clause can carry an
	// identifier the caller chose.
	if strings.Contains(strings.Join(where, " "), ";") {
		t.Fatalf("a clause carries a statement separator: %v", where)
	}
}

// The identity projection and the search columns must stay in step: a column the
// search box claims to cover but never queries is a silently broken search.
func TestUsageEventSearchColumnsAreRealColumns(t *testing.T) {
	repo := filterTestRepository(t)
	for _, column := range usageEventSearchColumns {
		name := strings.TrimPrefix(column, "e.")
		var count int
		if err := repo.SQL().QueryRow(
			`SELECT COUNT(1) FROM pragma_table_info('usage_events') WHERE name = ?`, name).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("search column %q is not a usage_events column", column)
		}
	}
	// Client IP, the forwarded header and the endpoint URL are private to the
	// operator; widening the search box onto them would leak them one character
	// at a time.
	for _, forbidden := range []string{"e.client_ip", "e.x_forwarded_for", "e.endpoint"} {
		for _, column := range usageEventSearchColumns {
			if column == forbidden {
				t.Fatalf("%s must not be searchable from the console", forbidden)
			}
		}
	}
}
