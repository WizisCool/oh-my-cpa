package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Release products. The list is closed because the console renders one panel per
// product, so an unknown product would have nowhere to appear.
const (
	ReleaseProductOMC = "omc"
	ReleaseProductCPA = "cpa"
)

// ReleaseRecord is one released version of a product, as the release feed
// described it. It carries no body: bodies stay in process memory on purpose (see
// migration 024), so a record is safe to read without deciding how much remote
// text to trust.
type ReleaseRecord struct {
	Product       string
	Repository    string
	Tag           string
	Name          string
	PublishedAtMS int64
	Prerelease    bool
	CheckedAtMS   int64
}

// ReleaseCheckState is what the last check did, recorded per product so the page
// can distinguish "current" from "stale, and here is why".
type ReleaseCheckState struct {
	Product         string
	Repository      string
	Running         bool
	LastAttemptAtMS *int64
	LastSuccessAtMS *int64
	LastError       string
	LatestTag       string
	ETag            string
	// Truncated records that the feed walk stopped at its page limit with more
	// releases available.
	Truncated   bool
	UpdatedAtMS int64
}

// ErrReleaseUnknownProduct is returned when a caller names a product the console
// does not render.
var ErrReleaseUnknownProduct = errors.New("unknown release product")

// knownReleaseProduct guards every write against a typo becoming a row the console
// never reads and never cleans up.
func knownReleaseProduct(product string) error {
	switch product {
	case ReleaseProductOMC, ReleaseProductCPA:
		return nil
	default:
		return fmt.Errorf("%w: %q", ErrReleaseUnknownProduct, product)
	}
}

// ReplaceReleaseIndex installs one product's release index as a unit.
//
// Replacing rather than merging is the point: a feed that stops listing a
// withdrawn release must stop the console claiming that release exists. The write
// is one transaction so the index is never observed half-replaced by the page.
//
// `repository` is recorded on every row, so an operator who switches the
// configured source does not get the two feeds' versions interleaved - the read
// side filters on it.
func (r *Repository) ReplaceReleaseIndex(ctx context.Context, product, repository string, releases []ReleaseRecord) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	if err := knownReleaseProduct(product); err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin release index replace: %w", err)
	}
	succeeded := false
	defer func() {
		if !succeeded {
			_ = tx.Rollback()
		}
	}()

	if _, err := tx.ExecContext(ctx, `DELETE FROM release_index WHERE product = ?`, product); err != nil {
		return fmt.Errorf("clear release index for %s: %w", product, err)
	}
	statement, err := tx.PrepareContext(ctx, `
		INSERT INTO release_index(product, repository, tag, name, published_at_ms, prerelease, checked_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(product, tag) DO UPDATE SET
			repository = excluded.repository,
			name = excluded.name,
			published_at_ms = excluded.published_at_ms,
			prerelease = excluded.prerelease,
			checked_at_ms = excluded.checked_at_ms`)
	if err != nil {
		return fmt.Errorf("prepare release index insert: %w", err)
	}
	defer statement.Close()

	for _, release := range releases {
		prerelease := 0
		if release.Prerelease {
			prerelease = 1
		}
		checkedAt := release.CheckedAtMS
		if checkedAt == 0 {
			checkedAt = now
		}
		if _, err := statement.ExecContext(ctx, product, repository, release.Tag, release.Name, release.PublishedAtMS, prerelease, checkedAt); err != nil {
			return fmt.Errorf("insert release %s %s: %w", product, release.Tag, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit release index replace: %w", err)
	}
	succeeded = true
	return nil
}

// ListReleases returns one product's stored index, newest first.
//
// Releases are ordered by publication time and then by tag so the order is stable
// when a feed reports no dates. Ordering is presentation order only: which version
// is newer is decided by version comparison, not by this ordering, because a feed
// can publish a backport after a newer release.
func (r *Repository) ListReleases(ctx context.Context, product, repository string) ([]ReleaseRecord, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	if err := knownReleaseProduct(product); err != nil {
		return nil, err
	}
	rows, err := r.SQL().QueryContext(ctx, `
		SELECT product, repository, tag, name, published_at_ms, prerelease, checked_at_ms
		FROM release_index
		WHERE product = ? AND repository = ?
		ORDER BY published_at_ms DESC, tag DESC`, product, repository)
	if err != nil {
		return nil, fmt.Errorf("list releases for %s: %w", product, err)
	}
	defer rows.Close()

	releases := make([]ReleaseRecord, 0, 32)
	for rows.Next() {
		var record ReleaseRecord
		var prerelease int
		if err := rows.Scan(&record.Product, &record.Repository, &record.Tag, &record.Name, &record.PublishedAtMS, &prerelease, &record.CheckedAtMS); err != nil {
			return nil, fmt.Errorf("scan release row: %w", err)
		}
		record.Prerelease = prerelease == 1
		releases = append(releases, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate release rows: %w", err)
	}
	return releases, nil
}

// GetReleaseCheckState reads one product's last check outcome. A missing row is
// not an error: a product that has never been checked is a normal state on first
// run, and the caller distinguishes it by a nil LastAttemptAtMS.
//
// A row recorded against a different repository than the one now configured is
// reported as absent. Otherwise switching a product's source would leave the previous
// feed's latest tag standing beside the new source's name - a version that exists in
// neither.
func (r *Repository) GetReleaseCheckState(ctx context.Context, product string) (ReleaseCheckState, error) {
	state := ReleaseCheckState{Product: product}
	if r == nil || r.SQL() == nil {
		return state, errors.New("repository is not initialized")
	}
	if err := knownReleaseProduct(product); err != nil {
		return state, err
	}
	var running, truncated int
	var attempt, success *int64
	err := r.SQL().QueryRowContext(ctx, `
		SELECT product, repository, running, last_attempt_at_ms, last_success_at_ms, last_error, latest_tag, etag, truncated, updated_at_ms
		FROM release_check_state WHERE product = ?`, product).
		Scan(&state.Product, &state.Repository, &running, &attempt, &success, &state.LastError, &state.LatestTag, &state.ETag, &truncated, &state.UpdatedAtMS)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return state, nil
		}
		return state, fmt.Errorf("read release check state for %s: %w", product, err)
	}
	state.Running = running == 1
	state.Truncated = truncated == 1
	state.LastAttemptAtMS = attempt
	state.LastSuccessAtMS = success
	return state, nil
}

// GetReleaseCheckStateForRepository reads a product's check state only when it belongs
// to the given source.
func (r *Repository) GetReleaseCheckStateForRepository(ctx context.Context, product, expectedRepository string) (ReleaseCheckState, error) {
	state, err := r.GetReleaseCheckState(ctx, product)
	if err != nil {
		return state, err
	}
	if expectedRepository != "" && state.Repository != "" && state.Repository != expectedRepository {
		// Stale metadata from a previous source. Reporting it as absent is what makes
		// the next check refill it rather than the page presenting two feeds at once.
		return ReleaseCheckState{Product: product}, nil
	}
	return state, nil
}

// RecordReleaseCheckAttempt marks a check as started. It is written before the
// outbound request so an aborted check is visible rather than invisible.
func (r *Repository) RecordReleaseCheckAttempt(ctx context.Context, product, repository string) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	if err := knownReleaseProduct(product); err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	// A changed source retires the previous snapshot in the same statement. Overwriting
	// `repository` while keeping `latest_tag` and `last_success_at_ms` would relabel the old
	// feed's newest version as belonging to the new source, and `GetReleaseCheckStateForRepository`
	// - which compares that column - would then accept it: the page would name a version that
	// exists only in the feed it just stopped reading. Clearing the snapshot means the new source's
	// first check starts from "nothing known" and any failure reports that honestly.
	if _, err := r.SQL().ExecContext(ctx, `
		INSERT INTO release_check_state(product, repository, running, last_attempt_at_ms, last_error, updated_at_ms)
		VALUES (?, ?, 1, ?, '', ?)
		ON CONFLICT(product) DO UPDATE SET
			repository = excluded.repository,
			running = 1,
			last_attempt_at_ms = excluded.last_attempt_at_ms,
			last_error = CASE WHEN release_check_state.repository = excluded.repository
				THEN release_check_state.last_error ELSE '' END,
			latest_tag = CASE WHEN release_check_state.repository = excluded.repository
				THEN release_check_state.latest_tag ELSE '' END,
			last_success_at_ms = CASE WHEN release_check_state.repository = excluded.repository
				THEN release_check_state.last_success_at_ms ELSE NULL END,
			etag = CASE WHEN release_check_state.repository = excluded.repository
				THEN release_check_state.etag ELSE '' END,
			updated_at_ms = excluded.updated_at_ms`, product, repository, now, now); err != nil {
		return fmt.Errorf("record release check attempt for %s: %w", product, err)
	}
	return nil
}

// RecordReleaseCheckSuccess records a completed check.
//
// The ETag is written only when the caller still holds the body representation it
// belongs to. A validator without its body would make the next conditional request
// answer 304 and leave the console with nothing to show, so the checker passes an
// empty validator when it cannot keep the body.
func (r *Repository) RecordReleaseCheckSuccess(ctx context.Context, product, repository, latestTag, etag string, truncated bool) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	if err := knownReleaseProduct(product); err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	truncatedValue := 0
	if truncated {
		truncatedValue = 1
	}
	if _, err := r.SQL().ExecContext(ctx, `
		INSERT INTO release_check_state(product, repository, running, last_attempt_at_ms, last_success_at_ms, last_error, latest_tag, etag, truncated, updated_at_ms)
		VALUES (?, ?, 0, ?, ?, '', ?, ?, ?, ?)
		ON CONFLICT(product) DO UPDATE SET
			repository = excluded.repository,
			running = 0,
			last_attempt_at_ms = excluded.last_attempt_at_ms,
			last_success_at_ms = excluded.last_success_at_ms,
			last_error = '',
			latest_tag = excluded.latest_tag,
			etag = excluded.etag,
			truncated = excluded.truncated,
			updated_at_ms = excluded.updated_at_ms`, product, repository, now, now, latestTag, etag, truncatedValue, now); err != nil {
		return fmt.Errorf("record release check success for %s: %w", product, err)
	}
	return nil
}

// RecordReleaseCheckFailure records a failed check without touching the stored
// index or the last-success stamp.
//
// This is the property the page depends on: a failure must leave the previously
// known versions readable and must not present them as current. Keeping
// `last_success_at_ms` is what lets the console say "these came from 40 minutes
// ago and the last attempt failed" instead of either lying or going blank.
func (r *Repository) RecordReleaseCheckFailure(ctx context.Context, product, reason string) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	if err := knownReleaseProduct(product); err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	if _, err := r.SQL().ExecContext(ctx, `
		INSERT INTO release_check_state(product, running, last_attempt_at_ms, last_error, updated_at_ms)
		VALUES (?, 0, ?, ?, ?)
		ON CONFLICT(product) DO UPDATE SET
			running = 0,
			last_attempt_at_ms = excluded.last_attempt_at_ms,
			last_error = excluded.last_error,
			updated_at_ms = excluded.updated_at_ms`, product, now, reason, now); err != nil {
		return fmt.Errorf("record release check failure for %s: %w", product, err)
	}
	return nil
}

// ClearReleaseCheckValidators drops stored ETags and any stale in-progress marker.
//
// Called at start-up, because a validator is only meaningful beside the body it
// describes: this process begins with no bodies in memory, so a 304 would claim
// "unchanged" about content it cannot render. Clearing them makes the first check
// after a restart unconditional, which costs one request and keeps the answer
// truthful.
func (r *Repository) ClearReleaseCheckValidators(ctx context.Context) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	// The running flag is cleared in the same statement, and for the same reason: it
	// describes work this process is doing, and no process is doing any at start-up. A
	// flag left set by a crash would make the page report a check in progress forever.
	if _, err := r.SQL().ExecContext(ctx, `UPDATE release_check_state SET etag = '', running = 0`); err != nil {
		return fmt.Errorf("clear release check validators: %w", err)
	}
	return nil
}
