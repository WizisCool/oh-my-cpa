package exchangerate

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	// DefaultRefreshIntervalHours matches the historical daily Frankfurter cadence.
	DefaultRefreshIntervalHours = 24
	// MinRefreshIntervalHours prevents tight loops against the public rate feed.
	MinRefreshIntervalHours = 1
	// MaxRefreshIntervalHours bounds the schedule to one week, matching pricing sync.
	MaxRefreshIntervalHours = 168
)

// ErrInvalidRefreshSettings rejects an exchange-rate refresh document outside bounds.
var ErrInvalidRefreshSettings = errors.New("invalid_exchange_rate_refresh")

// RefreshSettings stores the deployment's scheduled exchange-rate refresh cadence.
type RefreshSettings struct {
	// IntervalHours refreshes display FX rates at this interval; 0 disables scheduled refreshes.
	IntervalHours int `json:"interval_hours"`
}

// DefaultRefreshSettings returns the daily default when no preference is stored.
func DefaultRefreshSettings() RefreshSettings {
	return RefreshSettings{IntervalHours: DefaultRefreshIntervalHours}
}

// Validate reports whether the refresh schedule is valid.
func (s RefreshSettings) Validate() error {
	if s.IntervalHours == 0 {
		return nil
	}
	if s.IntervalHours < MinRefreshIntervalHours || s.IntervalHours > MaxRefreshIntervalHours {
		return ErrInvalidRefreshSettings
	}
	return nil
}

// Interval returns the refresh cadence, or 0 when automatic refresh is disabled.
func (s RefreshSettings) Interval() time.Duration {
	if s.IntervalHours == 0 {
		return 0
	}
	if s.Validate() != nil {
		return time.Duration(DefaultRefreshIntervalHours) * time.Hour
	}
	return time.Duration(s.IntervalHours) * time.Hour
}

// ParseRefreshSettings strictly decodes a stored exchange-rate refresh preference.
func ParseRefreshSettings(raw []byte) (RefreshSettings, error) {
	var fields map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&fields); err != nil || decoder.More() || fields == nil || len(fields) != 1 {
		return RefreshSettings{}, ErrInvalidRefreshSettings
	}
	rawHours, ok := fields["interval_hours"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawHours), []byte("null")) {
		return RefreshSettings{}, ErrInvalidRefreshSettings
	}
	var hours int
	if err := json.Unmarshal(rawHours, &hours); err != nil {
		return RefreshSettings{}, ErrInvalidRefreshSettings
	}
	settings := RefreshSettings{IntervalHours: hours}
	if err := settings.Validate(); err != nil {
		return RefreshSettings{}, err
	}
	return settings, nil
}

// ResolveRefreshSettings reads a stored preference leniently for the background loop.
func ResolveRefreshSettings(raw string, isStored bool) RefreshSettings {
	settings := DefaultRefreshSettings()
	if !isStored || strings.TrimSpace(raw) == "" {
		return settings
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &fields) != nil {
		return settings
	}
	var hours int
	if value, ok := fields["interval_hours"]; ok && !bytes.Equal(bytes.TrimSpace(value), []byte("null")) && json.Unmarshal(value, &hours) == nil {
		if candidate := (RefreshSettings{IntervalHours: hours}); candidate.Validate() == nil {
			settings = candidate
		}
	}
	return settings
}
