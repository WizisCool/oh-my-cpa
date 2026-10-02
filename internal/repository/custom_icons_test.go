package repository

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func iconTestData() string {
	return base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L24 24"/></svg>`))
}
func TestCustomIconsCRUDAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "icons.db")
	database, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	repo := New(database)
	icon, err := repo.CreateCustomIcon(ctx, " Test ", iconTestData())
	if err != nil {
		t.Fatal(err)
	}
	if icon.Name != "Test" || icon.Revision != 1 {
		t.Fatalf("%+v", icon)
	}
	name := "Updated"
	replacement := base64.StdEncoding.EncodeToString([]byte(`<svg><circle r="5"/></svg>`))
	updated, err := repo.UpdateCustomIcon(ctx, icon.ID, &name, &replacement)
	if err != nil || updated.Revision != 2 {
		t.Fatalf("%+v %v", updated, err)
	}
	raw, _ := json.Marshal(map[string]string{"openai-compat-0": "custom:" + icon.ID, "legacy-name": "custom:" + icon.ID, "another": "DeepSeek"})
	if err := repo.PutPreference(ctx, PreferenceProviderIcons, string(raw)); err != nil {
		t.Fatal(err)
	}
	listed, err := repo.ListCustomIcons(ctx)
	if err != nil || len(listed) != 1 || listed[0].ReferenceCount != 2 || len(listed[0].Content) != 0 {
		t.Fatalf("%+v %v", listed, err)
	}
	updated, err = repo.UpdateCustomIcon(ctx, icon.ID, &name, nil)
	if err != nil || updated.ReferenceCount != 2 {
		t.Fatalf("updated reference counts: %+v %v", updated, err)
	}
	if err := repo.PutPreference(ctx, PreferenceProviderIcons, `{"provider":"custom:missing"}`); !errors.Is(err, ErrCustomIconMissing) {
		t.Fatalf("%v", err)
	}
	stored, _, _ := repo.GetPreference(ctx, PreferenceProviderIcons)
	if stored != string(raw) {
		t.Fatal("invalid reference changed preferences")
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repo = New(database)
	restored, err := repo.GetCustomIcon(ctx, icon.ID)
	if err != nil || string(restored.Content) != string(updated.Content) {
		t.Fatalf("%+v %v", restored, err)
	}
	if err := repo.DeleteCustomIconChecked(ctx, icon.ID, 1); err == nil || err.Error() != "resource_conflict" {
		t.Fatalf("stale approval: %v", err)
	}
	stored, _, err = repo.GetPreference(ctx, PreferenceProviderIcons)
	if err != nil || stored != string(raw) {
		t.Fatalf("stale approval changed assignments: %s %v", stored, err)
	}
	if err := repo.DeleteCustomIcon(ctx, icon.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.GetCustomIcon(ctx, icon.ID); !errors.Is(err, ErrCustomIconMissing) {
		t.Fatalf("%v", err)
	}
	stored, _, err = repo.GetPreference(ctx, PreferenceProviderIcons)
	if err != nil || stored != `{"another":"DeepSeek"}` {
		t.Fatalf("all matching ID and legacy-name overrides must be cleared: %s %v", stored, err)
	}
	if err := repo.DeleteCustomIcon(ctx, icon.ID); !errors.Is(err, ErrCustomIconMissing) {
		t.Fatalf("repeat deletion must report missing: %v", err)
	}
	stored, _, err = repo.GetPreference(ctx, PreferenceProviderIcons)
	if err != nil || stored != `{"another":"DeepSeek"}` {
		t.Fatalf("missing deletion changed unrelated assignments: %s %v", stored, err)
	}
}
func TestCustomIconValidationAndLimit(t *testing.T) {
	ctx := context.Background()
	database, err := Open(ctx, filepath.Join(t.TempDir(), "icons.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repo := New(database)
	for _, name := range []string{"", strings.Repeat("界", 81)} {
		if _, err := repo.CreateCustomIcon(ctx, name, iconTestData()); !errors.Is(err, ErrCustomIconName) {
			t.Fatalf("%v", err)
		}
	}
	for i := 0; i < MaxCustomIcons; i++ {
		if _, err := repo.CreateCustomIcon(ctx, "Icon", iconTestData()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := repo.CreateCustomIcon(ctx, "Overflow", iconTestData()); !errors.Is(err, ErrCustomIconLimit) {
		t.Fatalf("%v", err)
	}
}
func TestCustomIconDeleteAndAssignmentCannotLeaveDanglingReference(t *testing.T) {
	ctx := context.Background()
	database, err := Open(ctx, filepath.Join(t.TempDir(), "icons.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repo := New(database)
	for i := 0; i < 20; i++ {
		if err := repo.PutPreference(ctx, PreferenceProviderIcons, `{}`); err != nil {
			t.Fatal(err)
		}
		icon, err := repo.CreateCustomIcon(ctx, "Concurrent", iconTestData())
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var writes sync.WaitGroup
		writes.Add(2)
		var assignmentError, deleteError error
		go func() {
			defer writes.Done()
			<-start
			assignmentError = repo.PutPreference(ctx, PreferenceProviderIcons, `{"provider":"custom:`+icon.ID+`"}`)
		}()
		go func() { defer writes.Done(); <-start; deleteError = repo.DeleteCustomIcon(ctx, icon.ID) }()
		close(start)
		writes.Wait()
		if assignmentError != nil && !errors.Is(assignmentError, ErrCustomIconMissing) {
			t.Fatal(assignmentError)
		}
		if deleteError != nil {
			t.Fatal(deleteError)
		}
		raw, _, err := repo.GetPreference(ctx, PreferenceProviderIcons)
		if err != nil || strings.Contains(raw, "custom:"+icon.ID) {
			t.Fatalf("dangling reference after concurrent deletion: %s %v", raw, err)
		}
		if _, err := repo.GetCustomIcon(ctx, icon.ID); !errors.Is(err, ErrCustomIconMissing) {
			t.Fatalf("deleted asset remains: %v", err)
		}
	}
}

func TestCustomIconDeletionRollsBackAssignmentsOnFailure(t *testing.T) {
	ctx := context.Background()
	database, err := Open(ctx, filepath.Join(t.TempDir(), "icons.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repo := New(database)
	icon, err := repo.CreateCustomIcon(ctx, "Rollback", iconTestData())
	if err != nil {
		t.Fatal(err)
	}
	raw := `{"provider":"custom:` + icon.ID + `","unchanged":"OpenAI"}`
	if err := repo.PutPreference(ctx, PreferenceProviderIcons, raw); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SQL().ExecContext(ctx, `CREATE TRIGGER fail_icon_delete BEFORE DELETE ON custom_icons BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END`); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteCustomIcon(ctx, icon.ID); err == nil {
		t.Fatal("expected fixture failure")
	}
	stored, _, err := repo.GetPreference(ctx, PreferenceProviderIcons)
	if err != nil || stored != raw {
		t.Fatalf("partial reset escaped rollback: %s %v", stored, err)
	}
	if _, err := repo.GetCustomIcon(ctx, icon.ID); err != nil {
		t.Fatal(err)
	}
}

func TestCustomIconDeletionPreservesOtherAssetsAndPreferences(t *testing.T) {
	ctx := context.Background()
	database, err := Open(ctx, filepath.Join(t.TempDir(), "icons.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repo := New(database)
	deleted, err := repo.CreateCustomIcon(ctx, "Delete", iconTestData())
	if err != nil {
		t.Fatal(err)
	}
	retained, err := repo.CreateCustomIcon(ctx, "Retain", iconTestData())
	if err != nil {
		t.Fatal(err)
	}
	assignments := map[string]string{"provider-id": "custom:" + deleted.ID, "Legacy name": "custom:" + deleted.ID, "other-id": "custom:" + retained.ID, "builtin": "DeepSeek"}
	encoded, err := json.Marshal(assignments)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.PutPreference(ctx, PreferenceProviderIcons, string(encoded)); err != nil {
		t.Fatal(err)
	}
	if err := repo.PutPreference(ctx, "theme", `"dark"`); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteCustomIconChecked(ctx, deleted.ID, deleted.Revision); err != nil {
		t.Fatal(err)
	}
	raw, _, err := repo.GetPreference(ctx, PreferenceProviderIcons)
	if err != nil {
		t.Fatal(err)
	}
	var remaining map[string]string
	if err := json.Unmarshal([]byte(raw), &remaining); err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 2 || remaining["other-id"] != "custom:"+retained.ID || remaining["builtin"] != "DeepSeek" {
		t.Fatalf("unrelated assignments changed: %s", raw)
	}
	raw, _, err = repo.GetPreference(ctx, "theme")
	if err != nil || raw != `"dark"` {
		t.Fatalf("unrelated preference changed: %s %v", raw, err)
	}
	icons, err := repo.ListCustomIcons(ctx)
	if err != nil || len(icons) != 1 || icons[0].ID != retained.ID || icons[0].ReferenceCount != 1 {
		t.Fatalf("retained asset changed: %+v %v", icons, err)
	}
}
