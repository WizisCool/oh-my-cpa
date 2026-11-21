package release

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestUpdateCheckSettingsAreStrictOnWriteAndLenientOnRead pins the two different readings of
// one stored document: the console's write must be refused when it could not be honoured, and
// the sweep must keep a usable interval rather than silently replacing it with the default.
func TestUpdateCheckSettingsAreStrictOnWriteAndLenientOnRead(t *testing.T) {
	for _, raw := range []string{
		`{}`,
		`null`,
		`{"interval_minutes":14}`,
		`{"interval_minutes":1441}`,
		`{"interval_minutes":60,"plugin_interval_minutes":5}`,
		`{"interval_minutes":60,"plugin_interval_minutes":1441}`,
		`{"interval_minutes":0,"plugin_interval_minutes":null}`,
		`{"INTERVAL_MINUTES":0}`,
		`{"interval_minutes":60,"PLUGIN_INTERVAL_MINUTES":120}`,
		`{"interval_minutes":60,"refresh_on_reset":true}`,
		`{"interval_minutes":"60"}`,
		`{"interval_minutes":null}`,
		`{"interval_minutes":60} trailing`,
	} {
		if _, err := ParseUpdateCheckSettings([]byte(raw)); !errors.Is(err, ErrInvalidUpdateCheckSettings) {
			t.Fatalf("ParseUpdateCheckSettings(%s) = %v, want ErrInvalidUpdateCheckSettings", raw, err)
		}
	}

	// Single-field documents remain accepted and mirror onto plugins for backward compatibility.
	settings, err := ParseUpdateCheckSettings([]byte(`{"interval_minutes":360}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.ReleaseInterval() != 6*time.Hour || settings.PluginInterval() != 6*time.Hour {
		t.Fatalf("intervals = (%v, %v), want (6h, 6h)", settings.ReleaseInterval(), settings.PluginInterval())
	}

	// Independent release and plugin cadences, including 0 (disabled).
	split, err := ParseUpdateCheckSettings([]byte(`{"interval_minutes":0,"plugin_interval_minutes":120}`))
	if err != nil {
		t.Fatal(err)
	}
	if split.ReleaseInterval() != 0 || split.PluginInterval() != 2*time.Hour {
		t.Fatalf("split intervals = (%v, %v), want (0, 2h)", split.ReleaseInterval(), split.PluginInterval())
	}

	// A fresh deployment, and one whose stored document this build cannot read, both run the
	// documented default rather than not checking at all.
	defaults := DefaultUpdateCheckSettings()
	if defaults.IntervalMinutes != DefaultUpdateCheckIntervalMinutes || defaults.PluginIntervalMinutes != DefaultUpdateCheckIntervalMinutes {
		t.Fatalf("default intervals = %+v, want %d", defaults, DefaultUpdateCheckIntervalMinutes)
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

	// Older single-field stored documents preserve their interval for both checks.
	if got := ResolveUpdateCheckSettings(`{"interval_minutes":120,"future_field":true}`, true); got.IntervalMinutes != 120 || got.PluginIntervalMinutes != 120 {
		t.Fatalf("legacy intervals = %+v, want both 120", got)
	}
	// Disabled (0) stored for either check stays disabled on read.
	if got := ResolveUpdateCheckSettings(`{"interval_minutes":0,"plugin_interval_minutes":30}`, true); got.IntervalMinutes != 0 || got.PluginIntervalMinutes != 30 {
		t.Fatalf("split stored intervals = %+v, want (0, 30)", got)
	}
	// A pre-existing document with null plugin_interval_minutes keeps the valid release interval and defaults plugins.
	if got := ResolveUpdateCheckSettings(`{"interval_minutes":360,"plugin_interval_minutes":null}`, true); got.IntervalMinutes != 360 || got.PluginIntervalMinutes != DefaultUpdateCheckIntervalMinutes {
		t.Fatalf("null plugin interval = %+v, want (360, %d)", got, DefaultUpdateCheckIntervalMinutes)
	}
}

func TestProbeGitHubRateLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/rate_limit" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		auth := request.Header.Get("Authorization")
		switch auth {
		case "":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"resources":{"core":{"limit":60,"remaining":55,"used":5,"reset":1700003600}}}`))
		case "Bearer ghp_valid_fixture":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"resources":{"core":{"limit":5000,"remaining":4990,"used":10,"reset":1700003600}}}`))
		case "Bearer ghp_redirect_fixture":
			writer.Header().Set("Location", "http://example.invalid/steal")
			writer.WriteHeader(http.StatusFound)
		case "Bearer ghp_empty_budget_fixture":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{}`))
		default:
			writer.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer server.Close()

	anon := ProbeGitHubRateLimit(context.Background(), nil, server.URL, "")
	if anon.Status != RateLimitStatusAnonymous || anon.Authenticated || anon.Limit != 60 || anon.Remaining != 55 {
		t.Fatalf("anonymous probe = %+v", anon)
	}
	valid := ProbeGitHubRateLimit(context.Background(), nil, server.URL, "ghp_valid_fixture")
	if valid.Status != RateLimitStatusValid || !valid.Authenticated || valid.Limit != 5000 || valid.Remaining != 4990 || valid.ResetAtMS == nil || *valid.ResetAtMS != 1700003600*1000 {
		t.Fatalf("valid probe = %+v", valid)
	}
	invalid := ProbeGitHubRateLimit(context.Background(), nil, server.URL, "ghp_bad_fixture")
	if invalid.Status != RateLimitStatusInvalid || invalid.Authenticated {
		t.Fatalf("invalid probe = %+v", invalid)
	}
	redirected := ProbeGitHubRateLimit(context.Background(), nil, server.URL, "ghp_redirect_fixture")
	if redirected.Status != RateLimitStatusError {
		t.Fatalf("redirected probe = %+v, want error without following redirect", redirected)
	}
	noBudget := ProbeGitHubRateLimit(context.Background(), nil, server.URL, "ghp_empty_budget_fixture")
	if noBudget.Status != RateLimitStatusError || noBudget.Authenticated {
		t.Fatalf("empty budget probe = %+v, want error", noBudget)
	}
}
