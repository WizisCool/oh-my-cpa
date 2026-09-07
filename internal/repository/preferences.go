package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// PreferenceDashboardRange and PreferenceLogFilters are the stored console
// settings. Named here so the API and every page agree on the key instead of
// each hardcoding its own string.
const (
	PreferenceDashboardRange     = "dashboard_range"
	PreferenceLogFilters         = "log_filters"
	PreferenceProviderIcons      = "provider_icons"
	PreferenceProviderNames      = "provider_names"
	PreferenceDisabledProviders  = "disabled_providers"
	PreferenceUsageEventsView    = "usage_events_view"
)

// MaxPreferenceValueBytes bounds a stored value. Preferences are small UI
// state; anything larger is a client bug or an attempt to use this table as a
// data dump.
const MaxPreferenceValueBytes = 32 * 1024

// GetPreference returns the stored JSON for one key. The boolean is false when
// nothing has been saved yet, which is a normal state, not an error: the first
// run of a fresh install has no preferences at all.
func (r *Repository) GetPreference(ctx context.Context, key string) (string, bool, error) {
	if r == nil || r.SQL() == nil {
		return "", false, errors.New("repository is not initialized")
	}
	var value string
	err := r.SQL().QueryRowContext(ctx,
		`SELECT pref_value FROM ui_preferences WHERE pref_key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read preference %q: %w", key, err)
	}
	return value, true, nil
}

// ListPreferences returns every stored preference, keyed by name.
func (r *Repository) ListPreferences(ctx context.Context) (map[string]string, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	rows, err := r.SQL().QueryContext(ctx, `SELECT pref_key, pref_value FROM ui_preferences`)
	if err != nil {
		return nil, fmt.Errorf("list preferences: %w", err)
	}
	defer rows.Close()

	result := map[string]string{}
	for rows.Next() {
		var key, value string
		if errScan := rows.Scan(&key, &value); errScan != nil {
			return nil, fmt.Errorf("scan preference: %w", errScan)
		}
		result[key] = value
	}
	if errRows := rows.Err(); errRows != nil {
		return nil, fmt.Errorf("iterate preferences: %w", errRows)
	}
	return result, nil
}

// PutPreference stores one preference, overwriting any previous value.
func (r *Repository) PutPreference(ctx context.Context, key, value string) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	if !validPreferenceKey(key) {
		return fmt.Errorf("invalid preference key %q", key)
	}
	if len(value) > MaxPreferenceValueBytes {
		return fmt.Errorf("preference %q exceeds %d bytes", key, MaxPreferenceValueBytes)
	}
	if _, err := r.SQL().ExecContext(ctx, `
		INSERT INTO ui_preferences (pref_key, pref_value, updated_at_ms)
		VALUES (?, ?, ?)
		ON CONFLICT(pref_key) DO UPDATE SET pref_value = excluded.pref_value, updated_at_ms = excluded.updated_at_ms`,
		key, value, time.Now().UTC().UnixMilli()); err != nil {
		return fmt.Errorf("write preference %q: %w", key, err)
	}
	return nil
}

// validPreferenceKey keeps the table a flat namespace of known UI settings
// rather than an arbitrary blob store reachable through the API.
func validPreferenceKey(key string) bool {
	if key == "" || len(key) > 64 {
		return false
	}
	for _, char := range key {
		between := (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '_'
		if !between {
			return false
		}
	}
	return !strings.HasPrefix(key, "_")
}
