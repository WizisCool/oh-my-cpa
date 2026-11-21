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
	var document struct {
		IntervalHours *int `json:"interval_hours"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil || decoder.More() || document.IntervalHours == nil {
		return RefreshSettings{}, ErrInvalidRefreshSettings
	}
	settings := RefreshSettings{IntervalHours: *document.IntervalHours}
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
	if json.Unmarshal(fields["interval_hours"], &hours) == nil {
		if candidate := (RefreshSettings{IntervalHours: hours}); candidate.Validate() == nil {
			settings = candidate
		}
	}
	return settings
}
