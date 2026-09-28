package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// lockedPrice is what the insert transaction stores beside a usage event.
type lockedPrice struct {
	cost           *int64
	version        *int64
	channelVersion *int64
	tier           *int64
	status         string
}

// queryer is satisfied by both *sql.Tx and *sql.DB, so the lock and the read-time
// breakdown load versions through the same statements.
type queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

const priceVersionSelect = `SELECT id, available, effective_from_ms, model, prompt_price_per_1m, completion_price_per_1m,
 cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source, tiers_json, upstream_id
 FROM model_price_versions`

// PriceVersion is one immutable price snapshot. Price carries only what a version
// records; the bookkeeping fields of a current row (when it was synced or edited)
// do not exist on a version and are left out of its JSON.
type PriceVersion struct {
	ID              int64        `json:"id"`
	Available       bool         `json:"available"`
	EffectiveFromMS int64        `json:"effective_from_ms"`
	Price           VersionPrice `json:"price"`
}

// VersionPrice is the price a version locked.
type VersionPrice struct {
	pricing.ModelPrice
	MatchKind   string `json:"match_kind,omitempty"`
	Mode        string `json:"mode,omitempty"`
	SyncedAtMS  int64  `json:"synced_at_ms,omitempty"`
	UpdatedAtMS int64  `json:"updated_at_ms,omitempty"`
}

// errCorruptTiers marks a stored version whose tier list cannot be read, which
// prices as invalid rather than failing the insert.
var errCorruptTiers = errors.New("stored price tiers are unreadable")

func scanPriceVersion(row *sql.Row) (PriceVersion, error) {
	var version PriceVersion
	var tiers string
	p := &version.Price
	if err := row.Scan(&version.ID, &version.Available, &version.EffectiveFromMS, &p.Model, &p.PromptPricePer1M, &p.CompletionPer1M,
		&p.CacheReadPer1M, &p.CacheWritePer1M, &p.PriceMultiplier, &p.Source, &tiers, &p.UpstreamID); err != nil {
		return version, err
	}
	var err error
	if p.Tiers, err = pricing.DecodeTiers(tiers); err != nil {
		return version, fmt.Errorf("%w: %v", errCorruptTiers, err)
	}
	return version, nil
}

// ChannelVersion is one immutable channel multiplier snapshot.
type ChannelVersion struct {
	ID              int64   `json:"id"`
	Channel         string  `json:"channel"`
	Available       bool    `json:"available"`
	EffectiveFromMS int64   `json:"effective_from_ms"`
	Multiplier      float64 `json:"multiplier"`
}

func scanChannelVersion(row *sql.Row) (ChannelVersion, error) {
	var version ChannelVersion
	err := row.Scan(&version.ID, &version.Channel, &version.Available, &version.EffectiveFromMS, &version.Multiplier)
	return version, err
}

const channelVersionSelect = `SELECT id, channel, available, effective_from_ms, multiplier FROM pricing_channel_versions`

// lockUsagePrice runs inside the event insert transaction. Both the price and
// the channel multiplier are selected by request time, not ingestion time, so
// delayed queue delivery cannot reprice an older request. A tombstone stops a
// removed price from leaking forward; a missing or tombstoned channel is 1x.
func lockUsagePrice(ctx context.Context, tx *sql.Tx, event usage.Event) (lockedPrice, error) {
	version, err := scanPriceVersion(tx.QueryRowContext(ctx, priceVersionSelect+`
 WHERE model = ? AND effective_from_ms <= ? ORDER BY effective_from_ms DESC, id DESC LIMIT 1`, event.Model, event.TimestampMS))
	if errors.Is(err, sql.ErrNoRows) {
		return lockedPrice{status: "unpriced"}, nil
	}
	if errors.Is(err, errCorruptTiers) {
		// A corrupt stored tier list is an invalid price, not a lost event.
		return lockedPrice{version: &version.ID, status: "invalid_price"}, nil
	}
	if err != nil {
		return lockedPrice{}, fmt.Errorf("read request price: %w", err)
	}
	if !version.Available {
		return lockedPrice{status: "unpriced"}, nil
	}
	locked := lockedPrice{version: &version.ID}
	multiplier := 1.0
	if event.Provider != "" {
		channel, err := scanChannelVersion(tx.QueryRowContext(ctx, channelVersionSelect+`
 WHERE channel = ? AND effective_from_ms <= ? ORDER BY effective_from_ms DESC, id DESC LIMIT 1`, event.Provider, event.TimestampMS))
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			return lockedPrice{}, fmt.Errorf("read request channel multiplier: %w", err)
		case channel.Available:
			multiplier = channel.Multiplier
			locked.channelVersion = &channel.ID
		}
	}
	breakdown, err := pricing.Quote(version.Price.ModelPrice, multiplier, eventTokens(event.InputTokens, event.OutputTokens, event.CacheReadTokens, event.CacheCreationTokens), event.TimestampMS)
	// Invalid or overflowing prices must not lose usage telemetry or look free.
	if err != nil {
		locked.channelVersion = nil
		locked.status = "invalid_price"
		return locked, nil
	}
	locked.cost = &breakdown.TotalNanos
	locked.status = "priced"
	if breakdown.TierIndex != nil {
		tier := int64(*breakdown.TierIndex)
		locked.tier = &tier
	}
	return locked, nil
}

func eventTokens(input, output, cacheRead, cacheWrite int64) pricing.Tokens {
	return pricing.Tokens{Input: input, Output: output, CacheRead: cacheRead, CacheWrite: cacheWrite}
}

// RequestCostBreakdown explains one stored request cost. The stored amount is
// authoritative; Quote is the same computation re-run from the immutable
// versions the request locked, and RecomputedMatches says whether it agrees.
// A disagreement would mean the pricing rules changed after the request was
// stored, which the stored amount survives unchanged.
type RequestCostBreakdown struct {
	Status            string             `json:"status"`
	StoredNanos       *int64             `json:"stored_nanos,omitempty"`
	StoredTier        *int64             `json:"stored_tier,omitempty"`
	Version           *PriceVersion      `json:"price_version,omitempty"`
	Channel           *ChannelVersion    `json:"channel,omitempty"`
	Quote             *pricing.Breakdown `json:"quote,omitempty"`
	RecomputedMatches bool               `json:"recomputed_matches"`
	InvalidReason     string             `json:"invalid_reason,omitempty"`
}

// GetUsageEventCostBreakdown loads the versions a stored request locked. An
// unpriced request has nothing to explain and returns only its status.
func (r *Repository) GetUsageEventCostBreakdown(ctx context.Context, id int64) (RequestCostBreakdown, error) {
	var result RequestCostBreakdown
	if err := r.requirePricingSchema(ctx); err != nil {
		return result, err
	}
	var versionID, channelID, storedNanos, storedTier sql.NullInt64
	var timestampMS int64
	var input, output, cacheRead, cacheWrite int64
	err := r.SQL().QueryRowContext(ctx, `SELECT pricing_status, cost_nanos, price_version_id, channel_version_id, price_tier,
 timestamp_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage_events WHERE id = ?`, id).Scan(
		&result.Status, &storedNanos, &versionID, &channelID, &storedTier, &timestampMS, &input, &output, &cacheRead, &cacheWrite)
	if errors.Is(err, sql.ErrNoRows) {
		return result, ErrNotFound
	}
	if err != nil {
		return result, fmt.Errorf("read request cost: %w", err)
	}
	if storedNanos.Valid {
		result.StoredNanos = &storedNanos.Int64
	}
	if storedTier.Valid {
		result.StoredTier = &storedTier.Int64
	}
	if !versionID.Valid {
		return result, nil
	}
	version, err := scanPriceVersion(r.SQL().QueryRowContext(ctx, priceVersionSelect+` WHERE id = ?`, versionID.Int64))
	if errors.Is(err, errCorruptTiers) {
		result.Version = &version
		result.InvalidReason = err.Error()
		return result, nil
	}
	if err != nil {
		return result, fmt.Errorf("read request price version: %w", err)
	}
	result.Version = &version
	multiplier := 1.0
	if channelID.Valid {
		channel, err := scanChannelVersion(r.SQL().QueryRowContext(ctx, channelVersionSelect+` WHERE id = ?`, channelID.Int64))
		if err != nil {
			return result, fmt.Errorf("read request channel version: %w", err)
		}
		result.Channel = &channel
		multiplier = channel.Multiplier
	}
	quote, err := pricing.Quote(version.Price.ModelPrice, multiplier, eventTokens(input, output, cacheRead, cacheWrite), timestampMS)
	if err != nil {
		result.InvalidReason = err.Error()
		return result, nil
	}
	result.Quote = &quote
	result.RecomputedMatches = storedNanos.Valid && storedNanos.Int64 == quote.TotalNanos
	return result, nil
}

// ListModelPriceVersions returns a model's price history, newest first,
// tombstones included.
func (r *Repository) ListModelPriceVersions(ctx context.Context, model string, limit int) ([]PriceVersion, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.SQL().QueryContext(ctx, priceVersionSelect+` WHERE model = ? ORDER BY effective_from_ms DESC, id DESC LIMIT ?`, model, limit)
	if err != nil {
		return nil, fmt.Errorf("list price versions: %w", err)
	}
	defer rows.Close()
	var versions []PriceVersion
	for rows.Next() {
		var version PriceVersion
		var tiers string
		p := &version.Price
		if err := rows.Scan(&version.ID, &version.Available, &version.EffectiveFromMS, &p.Model, &p.PromptPricePer1M, &p.CompletionPer1M,
			&p.CacheReadPer1M, &p.CacheWritePer1M, &p.PriceMultiplier, &p.Source, &tiers, &p.UpstreamID); err != nil {
			return nil, fmt.Errorf("scan price version: %w", err)
		}
		if p.Tiers, err = pricing.DecodeTiers(tiers); err != nil {
			return nil, err
		}
		versions = append(versions, version)
	}
	return versions, rows.Err()
}
