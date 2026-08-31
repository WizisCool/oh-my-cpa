package config

import "testing"

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

func TestNormalizeBasePathRejectsURLSyntax(t *testing.T) {
	for _, value := range []string{"/omc?x=1", "/omc#fragment", "/../omc"} {
		if _, err := NormalizeBasePath(value); err == nil {
			t.Fatalf("NormalizeBasePath(%q) unexpectedly succeeded", value)
		}
	}
}
