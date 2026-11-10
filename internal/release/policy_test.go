package release

import (
	"errors"
	"testing"
	"time"
)

// TestUpdateCheckSettingsAreStrictOnWriteAndLenientOnRead pins the two different readings of
// one stored document: the console's write must be refused when it could not be honoured, and
// the sweep must keep a usable interval rather than silently replacing it with the default.
func TestUpdateCheckSettingsAreStrictOnWriteAndLenientOnRead(t *testing.T) {
	for _, raw := range []string{
		`{}`,
		`{"interval_minutes":14}`,
		`{"interval_minutes":1441}`,
		`{"interval_minutes":60,"refresh_on_reset":true}`,
		`{"interval_minutes":"60"}`,
		`{"interval_minutes":null}`,
		`{"interval_minutes":60} trailing`,
		`{"interval_minutes":60,"use_proxy_for_image_pull":"true"}`,
		`{"interval_minutes":60,"use_proxy_for_image_pull":null}`,
	} {
		if _, err := ParseUpdateCheckSettings([]byte(raw)); !errors.Is(err, ErrInvalidUpdateCheckSettings) {
			t.Fatalf("ParseUpdateCheckSettings(%s) = %v, want ErrInvalidUpdateCheckSettings", raw, err)
		}
	}

	settings, err := ParseUpdateCheckSettings([]byte(`{"interval_minutes":360}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.Interval() != 6*time.Hour {
		t.Fatalf("interval = %v, want 6h", settings.Interval())
	}

	// A fresh deployment, and one whose stored document this build cannot read, both run the
	// documented default rather than not checking at all.
	defaults := DefaultUpdateCheckSettings()
	if defaults.IntervalMinutes != DefaultUpdateCheckIntervalMinutes {
		t.Fatalf("default interval = %d, want %d", defaults.IntervalMinutes, DefaultUpdateCheckIntervalMinutes)
	}

	// Both new and existing deployments keep the daemon's ordinary pull route until opted in.
	if defaults.UseProxyForImagePull || settings.UseProxyForImagePull {
		t.Fatal("proxy image downloads must default to off")
	}

	proxySettings, err := ParseUpdateCheckSettings([]byte(`{"interval_minutes":120,"use_proxy_for_image_pull":true}`))
	if err != nil || !proxySettings.UseProxyForImagePull || proxySettings.Interval() != 2*time.Hour {
		t.Fatalf("proxy settings = %+v, error = %v", proxySettings, err)
	}

	if got := ResolveUpdateCheckSettings(`{"interval_minutes":120,"use_proxy_for_image_pull":true}`, true); got != proxySettings {
		t.Fatalf("resolved settings = %+v, want %+v", got, proxySettings)
	}
	for _, stored := range []struct {
		raw      string
		isStored bool
	}{
		{raw: "", isStored: false},
		{raw: "", isStored: true},
		{raw: `not json`, isStored: true},
		{raw: `{"interval_minutes":1}`, isStored: true},
	} {
		if got := ResolveUpdateCheckSettings(stored.raw, stored.isStored); got != defaults {
			t.Fatalf("ResolveUpdateCheckSettings(%q, %v) = %+v, want the default %+v", stored.raw, stored.isStored, got, defaults)
		}
	}

	// A document a newer build wrote keeps its known field, because discarding it would
	// replace the operator's schedule with one they never chose.
	if got := ResolveUpdateCheckSettings(`{"interval_minutes":120,"future_field":true}`, true); got.IntervalMinutes != 120 {
		t.Fatalf("interval from a newer document = %d, want 120", got.IntervalMinutes)
	}
}
