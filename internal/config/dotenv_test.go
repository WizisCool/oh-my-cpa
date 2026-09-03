package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDotEnvFillsMissingVariablesOnly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	content := "# comment\n\nexport OMCPA_DOTENV_SAMPLE=\"quoted value\"  # inline comment\n" +
		"OMCPA_DOTENV_OTHER='single quoted#not a comment'\nOMCPA_DOTENV_RAW=plain\n" +
		"OMCPA_DOTENV_PRESET=from-file\nOMCPA_DOTENV_EMPTY=\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OMCPA_DOTENV_PRESET", "from-environment")

	applied, err := LoadDotEnv(path)
	if err != nil {
		t.Fatal(err)
	}
	if applied != 4 {
		t.Fatalf("applied = %d, want 4", applied)
	}
	for name, want := range map[string]string{
		"OMCPA_DOTENV_SAMPLE": "quoted value",
		"OMCPA_DOTENV_OTHER":  "single quoted#not a comment",
		"OMCPA_DOTENV_RAW":    "plain",
		"OMCPA_DOTENV_EMPTY":  "",
	} {
		if got := os.Getenv(name); got != want {
			t.Fatalf("%s = %q, want %q", name, got, want)
		}
	}
	if got := os.Getenv("OMCPA_DOTENV_PRESET"); got != "from-environment" {
		t.Fatalf("dotenv overrode a real environment variable: %q", got)
	}
}

func TestLoadDotEnvMissingFileIsNotAnError(t *testing.T) {
	applied, err := LoadDotEnv(filepath.Join(t.TempDir(), "absent.env"))
	if err != nil {
		t.Fatal(err)
	}
	if applied != 0 {
		t.Fatalf("applied = %d, want 0", applied)
	}
}

func TestLoadDotEnvRejectsMalformedLines(t *testing.T) {
	for _, content := range []string{
		"NOT_A_PAIR\n",
		"OMCPA_DOTENV_BAD=\"unterminated quote\n",
		"BAD NAME=value\n",
	} {
		path := filepath.Join(t.TempDir(), ".env")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadDotEnv(path); err == nil {
			t.Fatalf("expected an error for %q", content)
		}
	}
}

func TestDotEnvPathHonoursOverride(t *testing.T) {
	t.Setenv("OMCPA_ENV_FILE", "/tmp/custom-omc.env")
	if got := DotEnvPath(); got != "/tmp/custom-omc.env" {
		t.Fatalf("DotEnvPath = %q", got)
	}
	if got := os.Getenv("OMCPA_DOTENV_UNUSED"); got != "" {
		t.Fatalf("unexpected variable: %q", got)
	}
}
