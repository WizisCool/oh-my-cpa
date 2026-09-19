package repository

import (
	"context"
	"testing"
)

func TestPutPreferencesWritesAtomically(t *testing.T) {
	repo, _ := testRepository(t)
	ctx := context.Background()

	if err := repo.PutPreference(ctx, PreferenceProviderNames, `{"codex-0":"Old"}`); err != nil {
		t.Fatalf("seed preference: %v", err)
	}
	if err := repo.PutPreferences(ctx, map[string]string{
		PreferenceProviderNames:  `{"codex-0":"New"}`,
		"invalid preference key": `{}`,
	}); err == nil {
		t.Fatal("PutPreferences accepted an invalid key")
	}

	raw, found, err := repo.GetPreference(ctx, PreferenceProviderNames)
	if err != nil || !found {
		t.Fatalf("read preference: found=%v err=%v", found, err)
	}
	if raw != `{"codex-0":"Old"}` {
		t.Fatalf("preference changed after a refused transaction: %s", raw)
	}
}

func TestPutPreferencesWritesEveryDocument(t *testing.T) {
	repo, _ := testRepository(t)
	ctx := context.Background()
	values := map[string]string{
		PreferenceProviderNames:    `{"codex-0":"Name"}`,
		PreferenceProviderWebsites: `{"codex-0":"https://example.test"}`,
		PreferenceProviderIcons:    `{"codex-0":"Codex"}`,
	}
	if err := repo.PutPreferences(ctx, values); err != nil {
		t.Fatalf("PutPreferences: %v", err)
	}
	for key, want := range values {
		raw, found, err := repo.GetPreference(ctx, key)
		if err != nil || !found {
			t.Fatalf("read %s: found=%v err=%v", key, found, err)
		}
		if raw != want {
			t.Fatalf("%s = %s, want %s", key, raw, want)
		}
	}
}
