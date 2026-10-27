package repository

import (
	"context"
	"reflect"
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

// The inverse labels must not reverse an operator's existing scrolling choice on upgrade.
func TestReducedMotionPreferenceMigration(t *testing.T) {
	for _, entry := range []struct {
		name, oldValue, existingValue, wantValue string
	}{
		{name: "fresh"},
		{name: "full motion", oldValue: `"on"`, wantValue: `"off"`},
		{name: "reduced motion", oldValue: `"off"`, wantValue: `"on"`},
		{name: "system", oldValue: `"system"`, wantValue: `"system"`},
		{name: "formatted JSON", oldValue: " \n\t\"off\" ", wantValue: `"on"`},
		{name: "invalid", oldValue: `true`},
		{name: "existing choice", oldValue: `"on"`, existingValue: `"on"`, wantValue: `"on"`},
	} {
		t.Run(entry.name, func(t *testing.T) {
			ctx := context.Background()
			db := openDatabaseAtMigration(t, 48)
			for key, value := range map[string]string{"omc_scroll_smoothing": entry.oldValue, PreferenceReducedMotion: entry.existingValue} {
				if value != "" {
					if _, err := db.SQL.ExecContext(ctx, `INSERT INTO ui_preferences(pref_key, pref_value, updated_at_ms) VALUES (?, ?, 1234)`, key, value); err != nil {
						t.Fatal(err)
					}
				}
			}
			db.migrateUntil = 0
			if err := db.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			rows, err := db.SQL.QueryContext(ctx, `SELECT pref_key, pref_value, updated_at_ms FROM ui_preferences`)
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			got := map[string]string{}
			for rows.Next() {
				var key, value string
				var updatedAt int64
				if err := rows.Scan(&key, &value, &updatedAt); err != nil {
					t.Fatal(err)
				}
				if updatedAt != 1234 {
					t.Fatalf("preference timestamp changed: %d", updatedAt)
				}
				got[key] = value
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			want := map[string]string{}
			if entry.wantValue != "" {
				want[PreferenceReducedMotion] = entry.wantValue
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("preferences after upgrade = %v, want %v", got, want)
			}
		})
	}
}
