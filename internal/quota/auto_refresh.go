package quota

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Automatic quota refresh bounds. The interval is a floor and a ceiling on how often a
// credential is re-read on schedule: every read is a request upstream made with the
// credential itself, so a cadence shorter than a few minutes spends the provider's
// patience without telling the operator anything a window's own countdown does not.
const (
	AUTO_REFRESH_MIN_INTERVAL_MINUTES = 5
	AUTO_REFRESH_MAX_INTERVAL_MINUTES = 24 * 60

	// AUTO_REFRESH_RESET_GRACE is how long after a window's stated reset a credential is
	// re-read. Upstream counters roll over on their own clock, and a read at the exact
	// boundary can still return the cycle that just ended - which would spend the
	// reset-driven read on the reading it was meant to replace.
	AUTO_REFRESH_RESET_GRACE = time.Minute

	// AUTO_REFRESH_INTERVAL_SLACK lets a scheduled read fire on the tick that lands on its
	// interval. A stored observation is stamped when its read finishes, a little after the
	// tick that started it, so the next whole interval measured from it always ends just
	// after a tick; without the slack every interval would run one tick long.
	AUTO_REFRESH_INTERVAL_SLACK = 30 * time.Second

	// A reset-driven read that fails is retried at this backoff, but only within the
	// window after the reset. The reset is the moment an operator is waiting on, so one
	// transient failure must not leave an exhausted reading in place until the next manual
	// click; a credential that keeps failing (one that needs signing in again) stops
	// costing requests once the window has passed.
	AUTO_REFRESH_RESET_RETRY_BACKOFF = 10 * time.Minute
	AUTO_REFRESH_RESET_RETRY_WINDOW  = time.Hour
)

// ErrInvalidAutoRefreshSettings rejects a stored document the scheduler cannot honour.
var ErrInvalidAutoRefreshSettings = errors.New("invalid_quota_auto_refresh")

// AutoRefreshSettings is the deployment-wide automatic quota refresh policy.
//
// The two triggers are independent on purpose. A scheduled interval keeps every reading
// young, at a cost proportional to the fleet; a reset-driven read costs one request per
// window boundary and answers the question an operator actually waits on - "has this
// exhausted credential come back?" - minutes after it has, instead of at the next manual
// click.
type AutoRefreshSettings struct {
	// IntervalMinutes re-reads a credential once its latest observation is this old; zero
	// disables the scheduled refresh.
	IntervalMinutes int `json:"interval_minutes"`
	// IsRefreshOnResetEnabled re-reads a credential once a window its latest observation
	// reported has reset.
	IsRefreshOnResetEnabled bool `json:"refresh_on_reset"`
}

// AUTO_REFRESH_DEFAULT_INTERVAL_MINUTES is the schedule of a deployment that never chose
// one. Six hours keeps every reading younger than the shortest common window (five hours)
// is long, so a credential nobody has looked at still has a recent reading, at a cost of
// four reads per credential a day.
const AUTO_REFRESH_DEFAULT_INTERVAL_MINUTES = 6 * 60

// DefaultAutoRefreshSettings is the policy of a deployment that never chose one: both
// triggers on, the reset-driven read for the moment an operator waits on and the six-hour
// schedule so no reading goes stale for long.
func DefaultAutoRefreshSettings() AutoRefreshSettings {
	return AutoRefreshSettings{IntervalMinutes: AUTO_REFRESH_DEFAULT_INTERVAL_MINUTES, IsRefreshOnResetEnabled: true}
}

// IsEnabled reports whether either trigger can schedule a read.
func (s AutoRefreshSettings) IsEnabled() bool {
	return s.IntervalMinutes > 0 || s.IsRefreshOnResetEnabled
}

// Validate refuses an interval outside the supported bounds.
func (s AutoRefreshSettings) Validate() error {
	if s.IntervalMinutes == 0 {
		return nil
	}
	if s.IntervalMinutes < AUTO_REFRESH_MIN_INTERVAL_MINUTES || s.IntervalMinutes > AUTO_REFRESH_MAX_INTERVAL_MINUTES {
		return ErrInvalidAutoRefreshSettings
	}
	return nil
}

// ParseAutoRefreshSettings strictly decodes a stored settings document. Both fields are
// required and nothing else is accepted, so a write cannot silently lose a field to a
// typo and leave the scheduler running on a default the operator never saw.
func ParseAutoRefreshSettings(raw []byte) (AutoRefreshSettings, error) {
	var document struct {
		IntervalMinutes *int  `json:"interval_minutes"`
		RefreshOnReset  *bool `json:"refresh_on_reset"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil || decoder.More() {
		return AutoRefreshSettings{}, ErrInvalidAutoRefreshSettings
	}
	if document.IntervalMinutes == nil || document.RefreshOnReset == nil {
		return AutoRefreshSettings{}, ErrInvalidAutoRefreshSettings
	}
	settings := AutoRefreshSettings{IntervalMinutes: *document.IntervalMinutes, IsRefreshOnResetEnabled: *document.RefreshOnReset}
	if err := settings.Validate(); err != nil {
		return AutoRefreshSettings{}, err
	}
	return settings, nil
}

// ResolveAutoRefreshSettings reads a stored document for the scheduler, field by field.
//
// Reading is lenient where writing is strict: a document a newer build wrote may carry
// fields this build does not know, and rejecting the whole document would replace an
// operator's "off" with the defaults - turning on reads they had turned off. Each known
// field is kept when it is valid, and only a missing or invalid field takes its default.
func ResolveAutoRefreshSettings(raw string, isStored bool) AutoRefreshSettings {
	settings := DefaultAutoRefreshSettings()
	if !isStored || strings.TrimSpace(raw) == "" {
		return settings
	}
	// Fields are decoded one at a time so that a malformed one cannot discard the other.
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &fields) != nil {
		return settings
	}
	var intervalMinutes int
	if json.Unmarshal(fields["interval_minutes"], &intervalMinutes) == nil && (AutoRefreshSettings{IntervalMinutes: intervalMinutes}).Validate() == nil {
		settings.IntervalMinutes = intervalMinutes
	}
	// A JSON null decodes into a bool as false without an error; it is not a stated "off".
	var isRefreshOnResetEnabled bool
	if value := fields["refresh_on_reset"]; string(value) != "null" && json.Unmarshal(value, &isRefreshOnResetEnabled) == nil {
		settings.IsRefreshOnResetEnabled = isRefreshOnResetEnabled
	}
	return settings
}

// Automatic refresh triggers, reported in the loop's summary.
const (
	AutoRefreshTriggerNone            = ""
	AutoRefreshTriggerReset           = "reset"
	AutoRefreshTriggerInterval        = "interval"
	AutoRefreshTriggerCooldownExpired = "cooldown_expired"
)

// AutoRefreshCandidate is what the scheduler knows about one credential at a tick.
type AutoRefreshCandidate struct {
	Provider         string
	IsDisabled       bool
	IsSupported      bool
	LastObservedAtMS int64 // zero when the credential has never been read
	LastAttemptAtMS  int64 // zero when this process has not tried it
	ResetAtMS        []int64
	// ActiveCooldownExpiredAtMS is the latest recovery time of stored cooldown evidence once
	// every one of them has passed, or zero. CPA keeps the credential blocked until that
	// evidence is cleared, whatever the clock says.
	ActiveCooldownExpiredAtMS int64
}

// IsAutoRefreshProvider reports whether the scheduler may read a provider on its own.
//
// Meta is excluded because its observation exchanges the stored DCA token for a key
// upstream: that read is audited per attempt as an operator's action, and a process that
// minted keys on a timer would turn an audited decision into background noise.
func IsAutoRefreshProvider(provider string) bool {
	return provider != "meta"
}

// AutoRefreshTrigger decides whether a credential is due for an automatic read.
//
// A reset trigger needs a window whose reset, plus the grace, has passed since the latest
// stored observation. It fires on the first tick after that instant; when that read
// fails - it is not stored, so the observation stays older than the reset - it is retried
// at a backoff for a bounded window rather than on every tick. The interval counts from
// the newer of the observation and the attempt, so a failing scheduled read waits a
// whole interval too.
func AutoRefreshTrigger(settings AutoRefreshSettings, candidate AutoRefreshCandidate, nowMS int64) string {
	if candidate.IsDisabled {
		return AutoRefreshTriggerNone
	}
	// Clearing a cooldown is not a read: it needs no probe and exchanges no key, so it
	// applies to every enabled credential. A due reset read still goes first, because a
	// read that finds capacity releases the cooldown as well.
	isReadable := candidate.IsSupported && IsAutoRefreshProvider(candidate.Provider)
	if isReadable && settings.IsRefreshOnResetEnabled && candidate.LastObservedAtMS > 0 {
		graceMS := AUTO_REFRESH_RESET_GRACE.Milliseconds()
		for _, resetAtMS := range candidate.ResetAtMS {
			dueAtMS := resetAtMS + graceMS
			if resetAtMS <= 0 || dueAtMS > nowMS || candidate.LastObservedAtMS >= dueAtMS {
				continue
			}
			if candidate.LastAttemptAtMS < dueAtMS {
				return AutoRefreshTriggerReset
			}
			isInRetryWindow := nowMS-dueAtMS < AUTO_REFRESH_RESET_RETRY_WINDOW.Milliseconds()
			if isInRetryWindow && nowMS-candidate.LastAttemptAtMS >= AUTO_REFRESH_RESET_RETRY_BACKOFF.Milliseconds() {
				return AutoRefreshTriggerReset
			}
		}
	}
	// A clear that failed leaves the evidence in place, so it waits out the same backoff a
	// failed reset read does instead of repeating every minute and filling the round.
	isClearBackedOff := candidate.LastAttemptAtMS > 0 && nowMS-candidate.LastAttemptAtMS < AUTO_REFRESH_RESET_RETRY_BACKOFF.Milliseconds()
	if candidate.ActiveCooldownExpiredAtMS > 0 && candidate.ActiveCooldownExpiredAtMS <= nowMS && !isClearBackedOff {
		return AutoRefreshTriggerCooldownExpired
	}
	if isReadable && settings.IntervalMinutes > 0 {
		lastMS := max(candidate.LastObservedAtMS, candidate.LastAttemptAtMS)
		intervalMS := int64(settings.IntervalMinutes) * time.Minute.Milliseconds()
		if lastMS == 0 || nowMS-lastMS+AUTO_REFRESH_INTERVAL_SLACK.Milliseconds() >= intervalMS {
			return AutoRefreshTriggerInterval
		}
	}
	return AutoRefreshTriggerNone
}

// WindowResetTimes lists the stated reset instants of a reading's windows.
func WindowResetTimes(windows []QuotaWindow) []int64 {
	resets := make([]int64, 0, len(windows))
	for _, window := range windows {
		if window.ResetAtMS != nil && *window.ResetAtMS > 0 {
			resets = append(resets, *window.ResetAtMS)
		}
	}
	return resets
}
