package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// ClientKeyAlias is the operator-assigned name for one gateway client key.
//
// KeyFingerprint is the same keyed fingerprint usage records carry as
// `api_group_key`. That is the only usable identity here: the configuration array
// index changes when CPA's `api-keys` list is reordered, and the display mask is
// not unique (it keeps only a short head and tail), so neither can key a name
// that has to stay attached to the right key.
type ClientKeyAlias struct {
	KeyFingerprint string `json:"key_fingerprint"`
	Alias          string `json:"alias"`
	Version        int64  `json:"version"`
	CreatedAtMS    int64  `json:"created_at_ms"`
	UpdatedAtMS    int64  `json:"updated_at_ms"`
}

// MaxClientKeyAliasLength bounds an alias in runes. Aliases are labels rendered in
// a fixed-width table column, so an unbounded value would be layout input rather
// than a name.
const MaxClientKeyAliasLength = 64

// ErrClientKeyAliasVersionConflict marks a write prepared against a stale read.
//
// Callers answer 409 so the console can reload the current alias rather than
// overwrite a change another session already made - the same protection the
// configuration editor applies to its own writes.
var ErrClientKeyAliasVersionConflict = errors.New("client key alias version conflict")

// ErrClientKeyAliasInvalid marks an alias that cannot be stored.
var ErrClientKeyAliasInvalid = errors.New("client key alias is not valid")

// bidiControlRunes can visually reorder the text around them.
//
// They are Unicode category Cf (format), not Cc, so `unicode.IsControl` does not
// catch them - and an alias is rendered inside a fixed table column, a filter
// chip and a log line, where a directional override can make a name appear to be
// something other than what is stored. Only these are refused rather than every
// format character: U+200D and U+200C are legitimate in many scripts and in emoji
// sequences, so rejecting the whole category would break real names.
var bidiControlRunes = map[rune]bool{
	'\u061c': true, // Arabic letter mark
	'\u200e': true, // left-to-right mark
	'\u200f': true, // right-to-left mark
	'\u202a': true, // left-to-right embedding
	'\u202b': true, // right-to-left embedding
	'\u202c': true, // pop directional formatting
	'\u202d': true, // left-to-right override
	'\u202e': true, // right-to-left override
	'\u2066': true, // left-to-right isolate
	'\u2067': true, // right-to-left isolate
	'\u2068': true, // first strong isolate
	'\u2069': true, // pop directional isolate
}

// NormalizeClientKeyAlias trims an alias and rejects values that cannot be
// rendered safely.
//
// Control characters are refused rather than stripped. An alias reaches the DOM,
// a filter chip, an audit record and a log line; silently rewriting the
// operator's input would store something they did not type and did not see.
// Newlines and bidi overrides are the cases that matter - a right-to-left
// override in a name can visually reorder the columns around it.
func NormalizeClientKeyAlias(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	if utf8.RuneCountInString(trimmed) > MaxClientKeyAliasLength {
		return "", fmt.Errorf("%w: alias exceeds %d characters", ErrClientKeyAliasInvalid, MaxClientKeyAliasLength)
	}
	for _, char := range trimmed {
		if char == utf8.RuneError {
			return "", fmt.Errorf("%w: alias is not valid UTF-8", ErrClientKeyAliasInvalid)
		}
		if unicode.IsControl(char) || bidiControlRunes[char] {
			return "", fmt.Errorf("%w: alias contains a control character", ErrClientKeyAliasInvalid)
		}
	}
	return trimmed, nil
}

// requireAliasIdentity guards the two inputs every alias operation joins on.
//
// A blank or redacted fingerprint is refused instead of stored. `security`
// substitutes the fixed `[redacted]` marker when the fingerprinter is
// unavailable, and accepting it would put every key whose fingerprint failed
// under one shared row, so one key's name would appear on another's requests.
func requireAliasIdentity(instanceID, keyFingerprint string) (string, string, error) {
	instanceID = strings.TrimSpace(instanceID)
	keyFingerprint = strings.TrimSpace(keyFingerprint)
	if instanceID == "" {
		return "", "", fmt.Errorf("%w: instance id is required", ErrClientKeyAliasInvalid)
	}
	if keyFingerprint == "" {
		return "", "", fmt.Errorf("%w: key fingerprint is required", ErrClientKeyAliasInvalid)
	}
	if keyFingerprint == security.RedactedValue {
		return "", "", fmt.Errorf("%w: key fingerprint is unavailable", ErrClientKeyAliasInvalid)
	}
	return instanceID, keyFingerprint, nil
}

// ListClientKeyAliases returns every stored alias for one instance, keyed by
// fingerprint. The management page uses this to label the key table, and the
// usage surfaces use it to resolve a page of records in one read.
func (r *Repository) ListClientKeyAliases(ctx context.Context, instanceID string) (map[string]ClientKeyAlias, error) {
	result := map[string]ClientKeyAlias{}
	if r == nil || r.SQL() == nil {
		return result, errors.New("repository is not initialized")
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return result, nil
	}
	rows, err := r.SQL().QueryContext(ctx, `
		SELECT key_fingerprint, alias, version, created_at_ms, updated_at_ms
		FROM client_key_aliases
		WHERE instance_id = ?`, instanceID)
	if err != nil {
		return nil, fmt.Errorf("list client key aliases: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var entry ClientKeyAlias
		if errScan := rows.Scan(&entry.KeyFingerprint, &entry.Alias, &entry.Version, &entry.CreatedAtMS, &entry.UpdatedAtMS); errScan != nil {
			return nil, fmt.Errorf("scan client key alias: %w", errScan)
		}
		result[entry.KeyFingerprint] = entry
	}
	if errRows := rows.Err(); errRows != nil {
		return nil, fmt.Errorf("iterate client key aliases: %w", errRows)
	}
	return result, nil
}

// ClientKeyAliasesFor returns the aliases for one page of fingerprints.
//
// This is the batch form the request list needs: a page carries up to 500
// records and resolving them one query at a time would add a round trip per row
// for a label. Lookups are chunked so a large page cannot exceed SQLite's
// parameter limit, and a missing fingerprint is simply absent from the result
// rather than an error - most keys are never named.
func (r *Repository) ClientKeyAliasesFor(ctx context.Context, instanceID string, keyFingerprints []string) (map[string]string, error) {
	resolved := map[string]string{}
	if r == nil || r.SQL() == nil {
		return resolved, errors.New("repository is not initialized")
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return resolved, nil
	}

	// Deduplicate before querying: one page can hold hundreds of records from the
	// same key, and the IN list only needs the distinct identities.
	unique := make([]string, 0, len(keyFingerprints))
	seen := make(map[string]bool, len(keyFingerprints))
	for _, fingerprint := range keyFingerprints {
		trimmed := strings.TrimSpace(fingerprint)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		unique = append(unique, trimmed)
	}
	if len(unique) == 0 {
		return resolved, nil
	}

	for start := 0; start < len(unique); start += maxSQLiteParameters {
		end := start + maxSQLiteParameters
		if end > len(unique) {
			end = len(unique)
		}
		chunk := unique[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		args := make([]any, 0, len(chunk)+1)
		args = append(args, instanceID)
		for _, fingerprint := range chunk {
			args = append(args, fingerprint)
		}
		rows, err := r.SQL().QueryContext(ctx, `
			SELECT key_fingerprint, alias
			FROM client_key_aliases
			WHERE instance_id = ? AND key_fingerprint IN (`+placeholders+`)`, args...)
		if err != nil {
			return nil, fmt.Errorf("resolve client key aliases: %w", err)
		}
		for rows.Next() {
			var fingerprint, alias string
			if errScan := rows.Scan(&fingerprint, &alias); errScan != nil {
				rows.Close()
				return nil, fmt.Errorf("scan client key alias: %w", errScan)
			}
			if alias != "" {
				resolved[fingerprint] = alias
			}
		}
		if errRows := rows.Err(); errRows != nil {
			rows.Close()
			return nil, fmt.Errorf("iterate client key aliases: %w", errRows)
		}
		rows.Close()
	}
	return resolved, nil
}

// maxSQLiteParameters keeps an IN list well inside SQLite's 999-parameter
// default, leaving room for the instance id.
const maxSQLiteParameters = 500

// SetClientKeyAlias stores or clears one alias.
//
// expectedVersion is the version the caller read. Zero means "this key has no
// alias yet", which fails if one has since appeared; a positive value must match
// the stored row. An empty alias deletes the row, so "unnamed" has exactly one
// representation in storage rather than an empty string that reads as a name.
//
// The write is a single transaction so the returned version and the audit record
// the caller writes beside it describe the same state.
func (r *Repository) SetClientKeyAlias(ctx context.Context, instanceID, keyFingerprint, alias string, expectedVersion int64) (ClientKeyAlias, error) {
	var stored ClientKeyAlias
	instanceID, keyFingerprint, err := requireAliasIdentity(instanceID, keyFingerprint)
	if err != nil {
		return stored, err
	}
	if r == nil || r.SQL() == nil {
		return stored, errors.New("repository is not initialized")
	}
	normalized, err := NormalizeClientKeyAlias(alias)
	if err != nil {
		return stored, err
	}

	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return stored, fmt.Errorf("begin client key alias write: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var currentVersion int64
	err = tx.QueryRowContext(ctx, `
		SELECT version FROM client_key_aliases
		WHERE instance_id = ? AND key_fingerprint = ?`, instanceID, keyFingerprint).Scan(&currentVersion)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		currentVersion = 0
	case err != nil:
		return stored, fmt.Errorf("read client key alias version: %w", err)
	}
	if currentVersion != expectedVersion {
		return stored, fmt.Errorf("%w: stored version %d, expected %d",
			ErrClientKeyAliasVersionConflict, currentVersion, expectedVersion)
	}

	nowMS := time.Now().UnixMilli()
	if normalized == "" {
		// Clearing an alias that is already absent is a no-op rather than a
		// conflict: the caller asked for the state that already holds.
		if _, errDelete := tx.ExecContext(ctx, `
			DELETE FROM client_key_aliases
			WHERE instance_id = ? AND key_fingerprint = ?`, instanceID, keyFingerprint); errDelete != nil {
			return stored, fmt.Errorf("clear client key alias: %w", errDelete)
		}
		if errCommit := tx.Commit(); errCommit != nil {
			return stored, fmt.Errorf("commit client key alias clear: %w", errCommit)
		}
		return ClientKeyAlias{}, nil
	}

	nextVersion := currentVersion + 1
	if _, errUpsert := tx.ExecContext(ctx, `
		INSERT INTO client_key_aliases (instance_id, key_fingerprint, alias, version, created_at_ms, updated_at_ms)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(instance_id, key_fingerprint) DO UPDATE SET
			alias = excluded.alias,
			version = excluded.version,
			updated_at_ms = excluded.updated_at_ms`,
		instanceID, keyFingerprint, normalized, nextVersion, nowMS, nowMS); errUpsert != nil {
		return stored, fmt.Errorf("write client key alias: %w", errUpsert)
	}

	stored = ClientKeyAlias{
		KeyFingerprint: keyFingerprint,
		Alias:          normalized,
		Version:        nextVersion,
		UpdatedAtMS:    nowMS,
	}
	if errScan := tx.QueryRowContext(ctx, `
		SELECT created_at_ms FROM client_key_aliases
		WHERE instance_id = ? AND key_fingerprint = ?`, instanceID, keyFingerprint).Scan(&stored.CreatedAtMS); errScan != nil {
		return stored, fmt.Errorf("read client key alias created time: %w", errScan)
	}
	if errCommit := tx.Commit(); errCommit != nil {
		return stored, fmt.Errorf("commit client key alias write: %w", errCommit)
	}
	return stored, nil
}
