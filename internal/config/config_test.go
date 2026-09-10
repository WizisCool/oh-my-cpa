package config

import (
	"os"
	"testing"
	"time"
)

func TestNormalizeBasePath(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "default", in: "", want: "/omc"},
		{name: "plain", in: "omc", want: "/omc"},
		{name: "trailing", in: "/omc/", want: "/omc"},
		{name: "nested", in: "/tools/omc/", want: "/tools/omc"},
		{name: "root", in: "/", want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := NormalizeBasePath(test.in)
			if err != nil {
				t.Fatalf("NormalizeBasePath(%q): %v", test.in, err)
			}
			if got != test.want {
				t.Fatalf("NormalizeBasePath(%q) = %q, want %q", test.in, got, test.want)
			}
		})
	}
}

func TestLoadReadsAuthenticationConfiguration(t *testing.T) {
	t.Setenv("OMCPA_BASE_PATH", "/omc")

	t.Setenv("OMCPA_MASTER_KEY", "01234567890123456789012345678901")
	t.Setenv("OMCPA_PUBLIC_URL", "https://example.test/omc")
	for _, name := range []string{"OMCPA_DATA_DIR", "OMCPA_LISTEN_ADDR", "OMCPA_CPA_BASE_URL", "OMCPA_CPA_USAGE_ADDR", "OMCPA_REQUEST_TIMEOUT", "OMCPA_CPA_TLS_SKIP_VERIFY", "OMCPA_CPA_MANAGEMENT_KEY", "OMCPA_VERSION"} {
		_ = os.Unsetenv(name)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicURL != "https://example.test/omc" {
		t.Fatalf("authentication config = %#v", cfg)
	}
}

func TestNormalizeBasePathRejectsURLSyntax(t *testing.T) {
	for _, value := range []string{"/omc?x=1", "/omc#fragment", "/../omc"} {
		if _, err := NormalizeBasePath(value); err == nil {
			t.Fatalf("NormalizeBasePath(%q) unexpectedly succeeded", value)
		}
	}
}

func TestUsageIdleIntervals(t *testing.T) {
	for _, tc := range []struct {
		name, base, maximum string
		wantBase, wantMax   time.Duration
		invalid             bool
	}{
		{"defaults", "", "", time.Second, 10 * time.Second, false},
		{"custom", "2s", "5s", 2 * time.Second, 5 * time.Second, false},
		{"fixed", "1s", "1s", time.Second, time.Second, false},
		{"slow base", "30s", "", 30 * time.Second, 30 * time.Second, false},
		{"too small", "2s", "1s", 0, 0, true},
		{"zero", "1s", "0s", 0, 0, true},
		{"invalid", "1s", "abc", 0, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OMCPA_USAGE_IDLE_INTERVAL", tc.base)
			t.Setenv("OMCPA_USAGE_MAX_IDLE_INTERVAL", tc.maximum)
			cfg, err := loadUsageConfig()
			if tc.invalid {
				if err == nil {
					t.Fatal("invalid interval accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.IdleInterval != tc.wantBase || cfg.MaxIdleInterval != tc.wantMax {
				t.Fatalf("intervals %v / %v", cfg.IdleInterval, cfg.MaxIdleInterval)
			}
		})
	}
}
