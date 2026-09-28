package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

// ListChannelMultipliers returns every channel multiplier ordered by channel.
func (r *Repository) ListChannelMultipliers(ctx context.Context) ([]pricing.ChannelMultiplier, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return nil, err
	}
	rows, err := r.SQL().QueryContext(ctx, `SELECT channel, multiplier, note, updated_at_ms FROM pricing_channels ORDER BY channel`)
	if err != nil {
		return nil, fmt.Errorf("list channel multipliers: %w", err)
	}
	defer rows.Close()
	result := make([]pricing.ChannelMultiplier, 0, 16)
	for rows.Next() {
		var channel pricing.ChannelMultiplier
		if err := rows.Scan(&channel.Channel, &channel.Multiplier, &channel.Note, &channel.UpdatedAtMS); err != nil {
			return nil, fmt.Errorf("scan channel multiplier: %w", err)
		}
		result = append(result, channel)
	}
	return result, rows.Err()
}

// UpsertChannelMultiplier stores one channel. The version trigger records a new
// effective multiplier only when the value changes; editing the note alone
// reprices nothing and mints nothing.
func (r *Repository) UpsertChannelMultiplier(ctx context.Context, channel pricing.ChannelMultiplier) error {
	if err := r.requirePricingSchema(ctx); err != nil {
		return err
	}
	if err := channel.Validate(); err != nil {
		return err
	}
	_, err := r.SQL().ExecContext(ctx, `INSERT INTO pricing_channels(channel, multiplier, note, updated_at_ms) VALUES (?, ?, ?, ?)
 ON CONFLICT(channel) DO UPDATE SET multiplier = excluded.multiplier, note = excluded.note, updated_at_ms = excluded.updated_at_ms`,
		channel.Channel, channel.Multiplier, channel.Note, time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("save channel multiplier: %w", err)
	}
	return nil
}

// DeleteChannelMultiplier returns a channel to 1x; the delete trigger writes the
// tombstone that stops the old multiplier applying to later requests.
func (r *Repository) DeleteChannelMultiplier(ctx context.Context, channel string) (bool, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return false, err
	}
	result, err := r.SQL().ExecContext(ctx, `DELETE FROM pricing_channels WHERE channel = ?`, strings.TrimSpace(channel))
	if err != nil {
		return false, fmt.Errorf("delete channel multiplier: %w", err)
	}
	deleted, _ := result.RowsAffected()
	return deleted > 0, nil
}

// SeedChannelHistoryBackfill writes one channel version per row effective at
// effectiveFromMS. Like SeedModelPriceHistoryBackfill it exists for fabricated
// history only: the trigger stamps the moment of the write, so requests the
// fixture places in the past would otherwise see no multiplier.
func (r *Repository) SeedChannelHistoryBackfill(ctx context.Context, channels []pricing.ChannelMultiplier, effectiveFromMS int64) error {
	if err := r.requirePricingSchema(ctx); err != nil {
		return err
	}
	if effectiveFromMS <= 0 {
		return errors.New("channel backfill requires a positive effective time")
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin channel backfill: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, channel := range channels {
		if err := channel.Validate(); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO pricing_channel_versions(channel, effective_from_ms, available, multiplier) VALUES (?, ?, 1, ?)`,
			channel.Channel, effectiveFromMS, channel.Multiplier); err != nil {
			return fmt.Errorf("backfill channel %q: %w", channel.Channel, err)
		}
	}
	return tx.Commit()
}
