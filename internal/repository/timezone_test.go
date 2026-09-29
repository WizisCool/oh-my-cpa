package repository

import (
	"context"
	"errors"
	"github.com/oh-my-cpa/oh-my-cpa/internal/timezone"
	"testing"
)

func TestTimezonePersistenceValidationAndReset(t *testing.T) {
	t.Setenv("TZ", "Asia/Shanghai")
	repo, _ := testRepository(t)
	ctx := context.Background()
	if err := repo.PutPreference(ctx, PreferenceTimezone, `"America/New_York"`); err != nil {
		t.Fatal(err)
	}
	info, err := repo.ReadTimezone(ctx)
	if err != nil || info.EffectiveTimezone != "America/New_York" || info.ServerTimezone != "Asia/Shanghai" {
		t.Fatalf("%+v %v", info, err)
	}
	restarted := New(repo.db)
	if err := restarted.LoadTimezone(ctx); err != nil || restarted.Timezone().Location().String() != "America/New_York" {
		t.Fatal("restart lost zone", err)
	}
	for _, raw := range []string{`null`, ` null `, `{}`, `42`, `"Local"`, `"Invalid/Zone"`} {
		if err := repo.PutPreference(ctx, PreferenceTimezone, raw); !errors.Is(err, timezone.ErrInvalid) {
			t.Fatalf("accepted %s: %v", raw, err)
		}
	}
	if err := repo.PutPreferences(ctx, map[string]string{PreferenceTimezone: `"UTC"`, "invalid key": `true`}); err == nil {
		t.Fatal("accepted invalid transaction")
	}
	if repo.Timezone().Location().String() != "America/New_York" {
		t.Fatal("failed transaction changed runtime zone")
	}
	if err := repo.PutPreference(ctx, PreferenceTimezone, `""`); err != nil {
		t.Fatal(err)
	}
	info, err = repo.ReadTimezone(ctx)
	if err != nil || info.Timezone != "" || info.EffectiveTimezone != "Asia/Shanghai" {
		t.Fatalf("%+v %v", info, err)
	}
}
