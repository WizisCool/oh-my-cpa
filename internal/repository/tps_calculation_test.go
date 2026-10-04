package repository

import (
	"context"
	"path/filepath"
	"testing"
)

func TestTpsCalculationModeDefaultsAndSurvivesReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "preferences.db")
	database, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	repo := New(database)
	mode, err := repo.ReadTpsCalculationMode(ctx)
	if err != nil || mode != TpsExcludeTTFT {
		t.Fatalf("default=%s err=%v", mode, err)
	}
	for _, raw := range []string{`null`, `true`, `{}`, `"future_mode"`} {
		if err := repo.PutPreference(ctx, PreferenceTpsCalculationMode, raw); err != nil {
			t.Fatal(err)
		}
		mode, err := repo.ReadTpsCalculationMode(ctx)
		if err != nil || mode != TpsExcludeTTFT {
			t.Fatalf("fallback=%s err=%v", mode, err)
		}
	}
	if err := repo.PutPreference(ctx, PreferenceTpsCalculationMode, `"include_ttft"`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ReadTpsCalculationMode(ctx); err == nil {
		t.Fatal("an unreadable database must not look like an absent preference")
	}
	database, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	mode, err = New(database).ReadTpsCalculationMode(ctx)
	if err != nil || mode != TpsIncludeTTFT {
		t.Fatalf("persisted=%s err=%v", mode, err)
	}
}
