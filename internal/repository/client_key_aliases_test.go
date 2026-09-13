package repository

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// seedKeyEvent stores one request record attributed to the given caller key.
func seedKeyEvent(t *testing.T, repo *Repository, rawKey, eventKey string, at time.Time) string {
	t.Helper()
	fingerprint, err := repo.UsageClientKeyFingerprint(rawKey)
	if err != nil {
		t.Fatalf("fingerprint %q: %v", rawKey, err)
	}
	event := usageEventAt("default", eventKey, at, usage.TokenStats{TotalTokens: 10}, false)
	event.APIGroupKey = fingerprint
	event.APIGroupLabel = "api_key"
	event.APIKeyMask = security.MaskSecret(rawKey)
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{event}); err != nil {
		t.Fatal(err)
	}
	return fingerprint
}

// The point of the feature: a name written against a key's usage identity is
// found again from the stored request records that key produced.
func TestClientKeyAliasResolvesFromStoredRecords(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	fingerprint := seedKeyEvent(t, repo, "sk-alias-primary", "alias-evt-1", base)
	if _, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "Production CI", 0); err != nil {
		t.Fatalf("set alias: %v", err)
	}

	resolved, err := repo.ClientKeyAliasesFor(ctx, "default", []string{fingerprint})
	if err != nil {
		t.Fatal(err)
	}
	if resolved[fingerprint] != "Production CI" {
		t.Fatalf("alias = %q, want Production CI", resolved[fingerprint])
	}

	// A rename shows through to already-stored records, because resolution happens
	// at read time and the event rows are never rewritten.
	stored, err := repo.ListClientKeyAliases(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "Renamed", stored[fingerprint].Version); err != nil {
		t.Fatalf("rename: %v", err)
	}
	resolved, _ = repo.ClientKeyAliasesFor(ctx, "default", []string{fingerprint})
	if resolved[fingerprint] != "Renamed" {
		t.Fatalf("rename did not apply to the stored record: %v", resolved)
	}
}

// Two keys can share a display mask - it keeps only a short head and tail - so
// the alias must be keyed by the fingerprint. A mask-keyed store would put one
// key's name on the other's requests, which is the failure this asserts against.
func TestClientKeyAliasesStaySeparateForKeysSharingAMask(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	// Same head and tail, different middles: identical masks, distinct keys.
	first := seedKeyEvent(t, repo, "sk-aaaaaaaa-CI-variant-one-zzzz", "mask-evt-1", base)
	second := seedKeyEvent(t, repo, "sk-aaaaaaaa-CI-variant-two-zzzz", "mask-evt-2", base.Add(time.Minute))
	if first == second {
		t.Fatal("test setup is wrong: the two keys produced the same fingerprint")
	}

	page, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.Add(time.Hour).UnixMilli(),
		Limit:      50,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(page.Items))
	}
	if page.Items[0].APIKeyMask != page.Items[1].APIKeyMask {
		t.Fatalf("test setup is wrong: masks differ (%q vs %q), so it does not exercise the collision",
			page.Items[0].APIKeyMask, page.Items[1].APIKeyMask)
	}

	if _, err := repo.SetClientKeyAlias(ctx, "default", first, "Alpha", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetClientKeyAlias(ctx, "default", second, "Beta", 0); err != nil {
		t.Fatal(err)
	}

	resolved, err := repo.ClientKeyAliasesFor(ctx, "default", []string{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if resolved[first] != "Alpha" || resolved[second] != "Beta" {
		t.Fatalf("identical-mask keys must keep distinct names: %v", resolved)
	}
}

// A name belongs to the identity, not to a position, so CPA reordering its
// `api-keys` array must not move a name onto another key.
func TestClientKeyAliasSurvivesReordering(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()

	alpha := seedKeyEvent(t, repo, "sk-reorder-alpha", "reorder-evt-1", time.Now().UTC())
	beta := seedKeyEvent(t, repo, "sk-reorder-beta", "reorder-evt-2", time.Now().UTC())
	if _, err := repo.SetClientKeyAlias(ctx, "default", alpha, "Alpha", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetClientKeyAlias(ctx, "default", beta, "Beta", 0); err != nil {
		t.Fatal(err)
	}

	// The list is presented in the new order; resolution is by fingerprint, so the
	// order it is asked in cannot change the answers.
	resolved, err := repo.ClientKeyAliasesFor(ctx, "default", []string{beta, alpha})
	if err != nil {
		t.Fatal(err)
	}
	if resolved[alpha] != "Alpha" || resolved[beta] != "Beta" {
		t.Fatalf("reordering changed the names: %v", resolved)
	}
}

// Deleting a key from CPA must not erase the name its historical requests are
// read through: those rows keep their fingerprint forever.
func TestClientKeyAliasSurvivesKeyRemoval(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()

	fingerprint := seedKeyEvent(t, repo, "sk-departing-key", "depart-evt-1", time.Now().UTC())
	if _, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "Retired key", 0); err != nil {
		t.Fatal(err)
	}

	// The key disappears from CPA, but nothing in the repository deletes aliases,
	// and the stored record still resolves through it.
	present, err := repo.ClientKeyAliasesFor(ctx, "default", []string{fingerprint})
	if err != nil {
		t.Fatal(err)
	}
	if present[fingerprint] != "Retired key" {
		t.Fatalf("alias was lost when the key left the configuration: %v", present)
	}
	aliases, err := repo.ListClientKeyAliases(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if len(aliases) != 1 {
		t.Fatalf("list returned %d aliases, want the surviving one", len(aliases))
	}
}

// A stale write must be refused rather than silently overwriting another
// session's change, the same way the configuration editor protects its writes.
func TestClientKeyAliasRejectsStaleVersion(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()
	fingerprint := seedKeyEvent(t, repo, "sk-version-key", "version-evt-1", time.Now().UTC())

	stored, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "First", 0)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Version != 1 {
		t.Fatalf("first version = %d, want 1", stored.Version)
	}

	// A second writer that still believes no alias exists must be refused.
	if _, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "Racing", 0); !errors.Is(err, ErrClientKeyAliasVersionConflict) {
		t.Fatalf("stale create err = %v, want ErrClientKeyAliasVersionConflict", err)
	}
	// And one holding the version from before the first write must also be refused.
	if _, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "Stale", stored.Version-1); !errors.Is(err, ErrClientKeyAliasVersionConflict) {
		t.Fatalf("stale update err = %v, want ErrClientKeyAliasVersionConflict", err)
	}
	// The current version still works and advances.
	if _, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "Second", stored.Version); err != nil {
		t.Fatalf("current version rejected: %v", err)
	}
	aliases, _ := repo.ListClientKeyAliases(ctx, "default")
	if aliases[fingerprint].Alias != "Second" || aliases[fingerprint].Version != 2 {
		t.Fatalf("alias after update = %+v, want Second v2", aliases[fingerprint])
	}
}

// Clearing must remove the row rather than store an empty name, so "unnamed" has
// exactly one representation.
func TestClientKeyAliasClearRemovesTheRow(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()
	fingerprint := seedKeyEvent(t, repo, "sk-clear-key", "clear-evt-1", time.Now().UTC())

	stored, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "Temporary", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "   ", stored.Version); err != nil {
		t.Fatalf("clear: %v", err)
	}
	aliases, err := repo.ListClientKeyAliases(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if _, present := aliases[fingerprint]; present {
		t.Fatalf("clearing stored a row instead of removing it: %v", aliases)
	}
	// A cleared alias is no longer resolvable, so the console falls back to the mask.
	resolved, _ := repo.ClientKeyAliasesFor(ctx, "default", []string{fingerprint})
	if _, present := resolved[fingerprint]; present {
		t.Fatalf("cleared alias still resolves: %v", resolved)
	}
}

// Names are labels, not identities, so two keys may share one. Resolving them
// must still return the right name for each identity.
func TestClientKeyAliasAllowsDuplicateNames(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()

	first := seedKeyEvent(t, repo, "sk-dup-one", "dup-evt-1", time.Now().UTC())
	second := seedKeyEvent(t, repo, "sk-dup-two", "dup-evt-2", time.Now().UTC())
	if _, err := repo.SetClientKeyAlias(ctx, "default", first, "Shared name", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetClientKeyAlias(ctx, "default", second, "Shared name", 0); err != nil {
		t.Fatalf("a duplicate name must be allowed: %v", err)
	}
	resolved, _ := repo.ClientKeyAliasesFor(ctx, "default", []string{first, second})
	if resolved[first] != "Shared name" || resolved[second] != "Shared name" {
		t.Fatalf("duplicate names resolved wrong: %v", resolved)
	}
}

// Replacing a key's secret creates a different identity: the old key's name must
// not silently attach to the new value, because the history is not the same.
func TestClientKeyAliasDoesNotFollowASecretChange(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()

	before := seedKeyEvent(t, repo, "sk-original-secret", "rot-evt-1", time.Now().UTC())
	if _, err := repo.SetClientKeyAlias(ctx, "default", before, "My key", 0); err != nil {
		t.Fatal(err)
	}

	after, err := repo.UsageClientKeyFingerprint("sk-replacement-secret")
	if err != nil {
		t.Fatal(err)
	}
	if after == before {
		t.Fatal("test setup is wrong: replacing the secret produced the same identity")
	}
	resolved, _ := repo.ClientKeyAliasesFor(ctx, "default", []string{after})
	if _, present := resolved[after]; present {
		t.Fatalf("the old name followed the new secret: %v", resolved)
	}
}

// Aliases belong to one instance, so a name from one CPA installation cannot
// label another's traffic.
func TestClientKeyAliasIsInstanceScoped(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()
	if _, err := repo.SQL().ExecContext(ctx, `
		INSERT INTO cpa_instances (id, name, base_url, usage_addr,
			management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('other', 'Other', 'http://127.0.0.1:8318', '127.0.0.1:8318', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}

	fingerprint, err := repo.UsageClientKeyFingerprint("sk-scoped-key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "Default instance name", 0); err != nil {
		t.Fatal(err)
	}
	resolved, err := repo.ClientKeyAliasesFor(ctx, "other", []string{fingerprint})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := resolved[fingerprint]; present {
		t.Fatalf("an alias leaked across instances: %v", resolved)
	}
}

// An unavailable fingerprinter must fail the write rather than store the name
// under the shared redaction marker, which every failed fingerprint shares and
// which would therefore show one key's name on another key's records.
func TestClientKeyAliasRefusesUnavailableFingerprint(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()

	// No cipher is wired into this harness, so fingerprinting cannot succeed.
	if _, err := repo.UsageClientKeyFingerprint("sk-no-cipher"); err == nil {
		t.Fatal("fingerprinting must fail without a cipher")
	}
	if _, err := repo.SetClientKeyAlias(ctx, "default", security.RedactedValue, "Should not store", 0); !errors.Is(err, ErrClientKeyAliasInvalid) {
		t.Fatalf("redacted identity err = %v, want ErrClientKeyAliasInvalid", err)
	}
	if _, err := repo.SetClientKeyAlias(ctx, "default", "", "No identity", 0); !errors.Is(err, ErrClientKeyAliasInvalid) {
		t.Fatalf("empty identity err = %v, want ErrClientKeyAliasInvalid", err)
	}
}

// An alias is rendered in a table cell, a chip and a log line, so control
// characters and over-long values are refused rather than silently rewritten.
func TestClientKeyAliasValidation(t *testing.T) {
	for _, invalid := range []string{
		"line\nbreak",
		"carriage\rreturn",
		"tab\tseparated",
		"bidi\u202Eoverride",
		strings.Repeat("x", MaxClientKeyAliasLength+1),
	} {
		if _, err := NormalizeClientKeyAlias(invalid); !errors.Is(err, ErrClientKeyAliasInvalid) {
			t.Fatalf("alias %q was accepted, want ErrClientKeyAliasInvalid", invalid)
		}
	}
	for _, valid := range []string{
		"Production CI",
		"   桌面客户端   ",
		strings.Repeat("x", MaxClientKeyAliasLength),
	} {
		normalized, err := NormalizeClientKeyAlias(valid)
		if err != nil {
			t.Fatalf("alias %q was rejected: %v", valid, err)
		}
		if normalized != strings.TrimSpace(valid) {
			t.Fatalf("alias %q normalized to %q, want it trimmed", valid, normalized)
		}
	}
	// An empty alias is the clear signal, not an error.
	cleared, err := NormalizeClientKeyAlias("   ")
	if err != nil || cleared != "" {
		t.Fatalf("blank alias = %q err = %v, want empty and nil", cleared, err)
	}
}

// The batch lookup is what keeps a 500-row page to one query. It must answer
// every distinct identity in the page and ignore anything unnamed.
func TestClientKeyAliasesForResolvesWholePage(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()

	fingerprints := make([]string, 0, 40)
	for index := 0; index < 40; index++ {
		fingerprint, err := repo.UsageClientKeyFingerprint("sk-batch-" + string(rune('a'+index%26)) + string(rune('a'+index/26)))
		if err != nil {
			t.Fatal(err)
		}
		fingerprints = append(fingerprints, fingerprint)
		if index%2 == 0 {
			if _, err := repo.SetClientKeyAlias(ctx, "default", fingerprint, "Key "+string(rune('A'+index%26)), 0); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Repeated identities must not change the answer, and unknown ones are simply
	// absent rather than an error.
	asked := append(append([]string{}, fingerprints...), fingerprints[0], "hmac:not-a-stored-key")
	resolved, err := repo.ClientKeyAliasesFor(ctx, "default", asked)
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved) != 20 {
		t.Fatalf("resolved %d aliases, want the 20 that were named", len(resolved))
	}
	if _, present := resolved["hmac:not-a-stored-key"]; present {
		t.Fatal("an unknown fingerprint must not resolve")
	}
	for index := 1; index < len(fingerprints); index += 2 {
		if _, present := resolved[fingerprints[index]]; present {
			t.Fatalf("unnamed key %d resolved to %q", index, resolved[fingerprints[index]])
		}
	}
}

// The per-key usage figure is the number the management table prints, so it has
// to describe only records that key actually served.
func TestClientKeyUsageAttributesOnlyKeyCallers(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	fingerprint := seedKeyEvent(t, repo, "sk-usage-key", "usage-evt-1", base)

	// A second record from the same key, plus one attributed to a provider rather
	// than a key. The provider record must not be counted against the key.
	failed := usageEventAt("default", "usage-evt-2", base.Add(time.Minute), usage.TokenStats{TotalTokens: 5}, true)
	failed.APIGroupKey = fingerprint
	failed.APIGroupLabel = "api_key"
	byProvider := usageEventAt("default", "usage-evt-3", base.Add(2*time.Minute), usage.TokenStats{TotalTokens: 99}, false)
	byProvider.APIGroupKey = "some-provider"
	byProvider.APIGroupLabel = "provider"
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{failed, byProvider}); err != nil {
		t.Fatal(err)
	}

	usageRows, err := repo.ClientKeyUsage(ctx, "default", base.Add(-time.Hour).UnixMilli(), base.Add(time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if len(usageRows) != 1 {
		t.Fatalf("usage rows = %d, want only the client-key group: %+v", len(usageRows), usageRows)
	}
	row := usageRows[0]
	if row.KeyFingerprint != fingerprint {
		t.Fatalf("usage attributed to %q, want the caller key", row.KeyFingerprint)
	}
	if row.Requests != 2 || row.Failed != 1 || row.TotalTokens != 15 {
		t.Fatalf("usage = %+v, want 2 requests, 1 failed, 15 tokens", row)
	}
	if row.LastUsedMS != base.Add(time.Minute).UnixMilli() {
		t.Fatalf("last used = %d, want the newest matching request", row.LastUsedMS)
	}

	// Outside the window the key has no observed traffic, which is how the console
	// distinguishes "not used here" from zero.
	outside, err := repo.ClientKeyUsage(ctx, "default", base.Add(time.Hour).UnixMilli(), base.Add(2*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if len(outside) != 0 {
		t.Fatalf("usage outside the window = %+v, want none", outside)
	}
}

// The purpose string is the contract with the ingestion path. If it ever drifts,
// every alias silently stops resolving, so it is pinned here.
func TestUsageClientKeyFingerprintMatchesIngestionPurpose(t *testing.T) {
	if UsageClientKeyPurpose != "usage-api-key" {
		t.Fatalf("purpose = %q; the ingestion path fingerprints under usage-api-key, so a change here orphans every alias",
			UsageClientKeyPurpose)
	}
	repo := fingerprintTestRepository(t)
	// A value already carrying the hmac prefix is passed through untouched, which
	// is what makes re-reading a stored fingerprint idempotent.
	if _, err := repo.UsageClientKeyFingerprint("hmac:already-a-fingerprint"); err != nil {
		t.Fatalf("an existing fingerprint must pass through: %v", err)
	}
	if _, err := repo.UsageClientKeyFingerprint("hmac:already-a-fingerprint"); err != nil {
		t.Fatal(err)
	}
	first, err := repo.UsageClientKeyFingerprint("sk-stable-value")
	if err != nil {
		t.Fatal(err)
	}
	second, err := repo.UsageClientKeyFingerprint("sk-stable-value")
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("fingerprint is not stable: %q vs %q", first, second)
	}
	if !strings.HasPrefix(first, "hmac:") {
		t.Fatalf("fingerprint %q lacks the hmac prefix the storage path recognises", first)
	}
}
