package release

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// The scheduled check interval is a preference rather than configuration: it is an
// operator's running decision about how often this deployment spends GitHub requests, made
// from the console that shows what those requests found. The sweep reads it on every tick,
// so a change takes effect without a restart.

const (
	// DefaultUpdateCheckIntervalMinutes is the schedule of a deployment that never chose one:
	// hourly, which notices a release the same hour and costs a handful of requests.
	DefaultUpdateCheckIntervalMinutes = 60
	// MinUpdateCheckIntervalMinutes is the same fifteen minutes the page-load floor uses. A
	// shorter schedule would spend the per-address budget on reads the floor then answers from
	// the stored index, and four sweeps an hour already cost up to seventeen of the sixty
	// unauthenticated requests - the star count is floored at one read an hour - before any
	// page-load check runs.
	MinUpdateCheckIntervalMinutes = 15
	// MaxUpdateCheckIntervalMinutes bounds the schedule at a day: longer than that stops being
	// a schedule an open console can wait on.
	MaxUpdateCheckIntervalMinutes = 24 * 60
)

// ErrInvalidUpdateCheckSettings rejects a stored document the sweep cannot honour.
var ErrInvalidUpdateCheckSettings = errors.New("invalid_update_check")

// UpdateCheckSettings stores the deployment's scheduled update-check policy.
type UpdateCheckSettings struct {
	// IntervalMinutes is how often the background sweep reads OMC and CPA release feeds.
	// Zero disables scheduled release checks while keeping manual checks available.
	IntervalMinutes int `json:"interval_minutes"`
	// PluginIntervalMinutes is how often the background sweep observes plugin store updates.
	// Zero disables scheduled plugin update checks while keeping manual checks available.
	PluginIntervalMinutes int `json:"plugin_interval_minutes"`
}

// DefaultUpdateCheckSettings is the policy of a deployment that never chose one.
func DefaultUpdateCheckSettings() UpdateCheckSettings {
	return UpdateCheckSettings{
		IntervalMinutes:       DefaultUpdateCheckIntervalMinutes,
		PluginIntervalMinutes: DefaultUpdateCheckIntervalMinutes,
	}
}

func isValidUpdateCheckMinutes(minutes int) bool {
	return minutes == 0 || (minutes >= MinUpdateCheckIntervalMinutes && minutes <= MaxUpdateCheckIntervalMinutes)
}

// Validate reports whether the sweep can honour the policy.
func (s UpdateCheckSettings) Validate() error {
	if !isValidUpdateCheckMinutes(s.IntervalMinutes) || !isValidUpdateCheckMinutes(s.PluginIntervalMinutes) {
		return ErrInvalidUpdateCheckSettings
	}
	return nil
}

// ReleaseInterval returns the scheduled OMC/CPA release check cadence, or 0 when disabled.
func (s UpdateCheckSettings) ReleaseInterval() time.Duration {
	if s.IntervalMinutes == 0 {
		return 0
	}
	if !isValidUpdateCheckMinutes(s.IntervalMinutes) {
		return time.Duration(DefaultUpdateCheckIntervalMinutes) * time.Minute
	}
	return time.Duration(s.IntervalMinutes) * time.Minute
}

// PluginInterval returns the scheduled plugin store update check cadence, or 0 when disabled.
func (s UpdateCheckSettings) PluginInterval() time.Duration {
	if s.PluginIntervalMinutes == 0 {
		return 0
	}
	if !isValidUpdateCheckMinutes(s.PluginIntervalMinutes) {
		return time.Duration(DefaultUpdateCheckIntervalMinutes) * time.Minute
	}
	return time.Duration(s.PluginIntervalMinutes) * time.Minute
}

// Interval is the release-check schedule as the sweep uses it. Returns 0 when disabled.
func (s UpdateCheckSettings) Interval() time.Duration {
	return s.ReleaseInterval()
}

// ParseUpdateCheckSettings strictly decodes a stored document. interval_minutes is required;
// plugin_interval_minutes is optional for backward compatibility with older single-field
// callers and mirrors interval_minutes when omitted.
func ParseUpdateCheckSettings(raw []byte) (UpdateCheckSettings, error) {
	var document struct {
		IntervalMinutes       *int `json:"interval_minutes"`
		PluginIntervalMinutes *int `json:"plugin_interval_minutes"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil || decoder.More() || document.IntervalMinutes == nil {
		return UpdateCheckSettings{}, ErrInvalidUpdateCheckSettings
	}
	pluginMinutes := *document.IntervalMinutes
	if document.PluginIntervalMinutes != nil {
		pluginMinutes = *document.PluginIntervalMinutes
	}
	settings := UpdateCheckSettings{
		IntervalMinutes:       *document.IntervalMinutes,
		PluginIntervalMinutes: pluginMinutes,
	}

	if err := settings.Validate(); err != nil {
		return UpdateCheckSettings{}, err
	}
	return settings, nil
}

// ResolveUpdateCheckSettings reads a stored document for the sweep.
//
// Reading is lenient where writing is strict: a document a newer build wrote may carry fields
// this build does not know, and rejecting the whole document would replace the operator's
// schedule with the default. Older single-field documents mirror interval_minutes onto
// plugin_interval_minutes so an existing schedule stays intact on upgrade.
func ResolveUpdateCheckSettings(raw string, isStored bool) UpdateCheckSettings {
	settings := DefaultUpdateCheckSettings()
	if !isStored || strings.TrimSpace(raw) == "" {
		return settings
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &fields) != nil {
		return settings
	}
	hasValidInterval := false
	var intervalMinutes int
	if value, ok := fields["interval_minutes"]; ok && string(value) != "null" && json.Unmarshal(value, &intervalMinutes) == nil && isValidUpdateCheckMinutes(intervalMinutes) {
		settings.IntervalMinutes = intervalMinutes
		hasValidInterval = true
	}
	if value, ok := fields["plugin_interval_minutes"]; ok {
		var pluginMinutes int
		if string(value) != "null" && json.Unmarshal(value, &pluginMinutes) == nil && isValidUpdateCheckMinutes(pluginMinutes) {
			settings.PluginIntervalMinutes = pluginMinutes
		}
	} else if hasValidInterval {
		settings.PluginIntervalMinutes = settings.IntervalMinutes
	}

	return settings
}
