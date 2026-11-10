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
	// IntervalMinutes is how often the background sweep reads the release feeds and the
	// plugin store.
	IntervalMinutes int `json:"interval_minutes"`
}

// DefaultUpdateCheckSettings is the policy of a deployment that never chose one.
func DefaultUpdateCheckSettings() UpdateCheckSettings {
	return UpdateCheckSettings{IntervalMinutes: DefaultUpdateCheckIntervalMinutes}
}

// Validate reports whether the sweep can honour the policy.
func (s UpdateCheckSettings) Validate() error {
	if s.IntervalMinutes < MinUpdateCheckIntervalMinutes || s.IntervalMinutes > MaxUpdateCheckIntervalMinutes {
		return ErrInvalidUpdateCheckSettings
	}
	return nil
}

// Interval is the schedule as the sweep uses it. An unhonourable policy falls back to the
// default rather than stopping the loop, because a schedule nobody can run is still a reason
// to keep checking.
func (s UpdateCheckSettings) Interval() time.Duration {
	if s.Validate() != nil {
		return time.Duration(DefaultUpdateCheckIntervalMinutes) * time.Minute
	}
	return time.Duration(s.IntervalMinutes) * time.Minute
}

// ParseUpdateCheckSettings strictly decodes a stored document. The field is required and
// nothing else is accepted, so a write cannot silently lose the interval to a typo and leave
// the sweep running on a default the operator never saw.
func ParseUpdateCheckSettings(raw []byte) (UpdateCheckSettings, error) {
	var document struct {
		IntervalMinutes *int `json:"interval_minutes"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil || decoder.More() || document.IntervalMinutes == nil {
		return UpdateCheckSettings{}, ErrInvalidUpdateCheckSettings
	}
	settings := UpdateCheckSettings{IntervalMinutes: *document.IntervalMinutes}

	if err := settings.Validate(); err != nil {
		return UpdateCheckSettings{}, err
	}
	return settings, nil
}

// ResolveUpdateCheckSettings reads a stored document for the sweep.
//
// Reading is lenient where writing is strict: a document a newer build wrote may carry fields
// this build does not know, and rejecting the whole document would replace the operator's
// schedule with the default. The known field is kept when it is valid, and only a missing or
// invalid one takes the default.
func ResolveUpdateCheckSettings(raw string, isStored bool) UpdateCheckSettings {
	settings := DefaultUpdateCheckSettings()
	if !isStored || strings.TrimSpace(raw) == "" {
		return settings
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &fields) != nil {
		return settings
	}
	var intervalMinutes int
	if json.Unmarshal(fields["interval_minutes"], &intervalMinutes) == nil {
		if candidate := (UpdateCheckSettings{IntervalMinutes: intervalMinutes}); candidate.Validate() == nil {
			settings = candidate
		}
	}

	return settings
}
