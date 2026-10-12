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
	AutoRefreshMinIntervalMinutes = 5
	AutoRefreshMaxIntervalMinutes = 24 * 60

	// AutoRefreshResetGrace is how long after a window's stated reset a credential is
	// re-read. Upstream counters roll over on their own clock, and a read at the exact
	// boundary can still return the cycle that just ended - which would spend the one
	// reset-driven read on the reading it was meant to replace.
	AutoRefreshResetGrace = time.Minute
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

// DefaultAutoRefreshSettings is the policy of a deployment that never chose one. The
// reset-driven read is on because it only re-reads credentials an operator has already
// read, once per boundary their own reading announced; the schedule is off because it
// would start reading every credential of the deployment on a cadence nobody chose.
func DefaultAutoRefreshSettings() AutoRefreshSettings {
	return AutoRefreshSettings{IntervalMinutes: 0, IsRefreshOnResetEnabled: true}
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
	if s.IntervalMinutes < AutoRefreshMinIntervalMinutes || s.IntervalMinutes > AutoRefreshMaxIntervalMinutes {
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

// ResolveAutoRefreshSettings reads a stored document for the scheduler: an absent or
// unreadable one falls back to the defaults rather than stopping the loop, because the
// write path already refuses anything invalid and a value written by a future build
// must not turn the feature off silently in an older one.
func ResolveAutoRefreshSettings(raw string, isStored bool) AutoRefreshSettings {
	if !isStored || strings.TrimSpace(raw) == "" {
		return DefaultAutoRefreshSettings()
	}
	settings, err := ParseAutoRefreshSettings([]byte(raw))
	if err != nil {
		return DefaultAutoRefreshSettings()
	}
	return settings
}

// Automatic refresh triggers, reported in the loop's summary.
const (
	AutoRefreshTriggerNone     = ""
	AutoRefreshTriggerReset    = "reset"
	AutoRefreshTriggerInterval = "interval"
)

// AutoRefreshCandidate is what the scheduler knows about one credential at a tick.
type AutoRefreshCandidate struct {
	Provider         string
	IsDisabled       bool
	IsSupported      bool
	LastObservedAtMS int64 // zero when the credential has never been read
	LastAttemptAtMS  int64 // zero when this process has not tried it
	ResetAtMS        []int64
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
// A reset trigger fires once per boundary: it needs a window whose reset, plus the grace,
// has passed since both the latest observation and this process's latest attempt. A read
// that fails is therefore not repeated every tick until the credential recovers; the
// scheduled interval, when enabled, is what keeps retrying it. The interval counts from
// the newer of the observation and the attempt for the same reason.
func AutoRefreshTrigger(settings AutoRefreshSettings, candidate AutoRefreshCandidate, nowMS int64) string {
	if candidate.IsDisabled || !candidate.IsSupported || !IsAutoRefreshProvider(candidate.Provider) {
		return AutoRefreshTriggerNone
	}
	lastMS := max(candidate.LastObservedAtMS, candidate.LastAttemptAtMS)
	if settings.IsRefreshOnResetEnabled && candidate.LastObservedAtMS > 0 {
		graceMS := AutoRefreshResetGrace.Milliseconds()
		for _, resetAtMS := range candidate.ResetAtMS {
			dueAtMS := resetAtMS + graceMS
			if resetAtMS > 0 && dueAtMS <= nowMS && lastMS < dueAtMS {
				return AutoRefreshTriggerReset
			}
		}
	}
	if settings.IntervalMinutes > 0 {
		intervalMS := int64(settings.IntervalMinutes) * time.Minute.Milliseconds()
		if lastMS == 0 || nowMS-lastMS >= intervalMS {
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
