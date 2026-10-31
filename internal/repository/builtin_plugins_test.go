package repository

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
)

func TestBuiltinReconcileCompletionInitializesPolicyWithoutChangingChoices(t *testing.T) {
	repo, _ := testRepository(t)
	ctx := context.Background()
	instance := domain.CPAInstance{ID: "default", BaseURL: "http://cpa.example", ManagementKeyCiphertext: []byte("fixture"), ManagementKeyNonce: []byte("fixture"), CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := repo.UpsertInstance(ctx, instance); err != nil {
		t.Fatal(err)
	}
	instance, err := repo.GetInstance(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.MarkBuiltinReconciled(ctx, instance); err != nil {
		t.Fatal(err)
	}
	policy, err := repo.BuiltinPolicy(ctx, instance)
	if err != nil || policy.LastReconcileAt == "" || !policy.Enabled || policy.Revision != 1 {
		t.Fatalf("first reconciliation did not record its outcome: policy=%+v err=%v", policy, err)
	}
	first := policy.LastReconcileAt
	policy.Enabled = false
	if err := repo.SaveBuiltinPolicy(ctx, instance, policy, policy.Revision, "", nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.MarkBuiltinReconciled(ctx, instance); err != nil {
		t.Fatal(err)
	}
	after, err := repo.BuiltinPolicy(ctx, instance)
	if err != nil || after.Enabled || after.Revision != 2 || after.LastReconcileAt == first {
		t.Fatalf("completion changed the policy or did not advance its stamp: %+v %v", after, err)
	}
	rebound := instance
	rebound.BaseURL = "http://other-cpa.example"
	if err := repo.UpsertInstance(ctx, rebound); err != nil {
		t.Fatal(err)
	}
	if err := repo.MarkBuiltinReconciled(ctx, instance); !errors.Is(err, ErrBuiltinBindingChanged) {
		t.Fatalf("stale binding was marked complete: %v", err)
	}
}

func TestBuiltinPolicyBindsToGatewayAndSurvivesKeyRotation(t *testing.T) {
	repo, _ := testRepository(t)
	ctx := context.Background()
	now := time.Now()
	instance := domain.CPAInstance{ID: "default", ManagementKeyCiphertext: []byte("fixture"), ManagementKeyNonce: []byte("fixture"), BaseURL: "HTTP://EXAMPLE.com:80/", CreatedAt: now, UpdatedAt: now}
	if err := repo.UpsertInstance(ctx, instance); err != nil {
		t.Fatal(err)
	}
	instance, err := repo.GetInstance(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if instance.BaseURL != "http://example.com" || instance.BindingGeneration != 1 {
		t.Fatalf("binding = %+v", instance)
	}
	policy, err := repo.BuiltinPolicy(ctx, instance)
	if err != nil {
		t.Fatal(err)
	}
	if !policy.Enabled || policy.Revision != 1 || len(policy.Overrides) != 0 {
		t.Fatalf("default policy = %+v", policy)
	}
	policy.Enabled = false
	disabled := BuiltinPluginPolicy{State: "disabled"}
	if err := repo.SaveBuiltinPolicy(ctx, instance, policy, policy.Revision, "omc-zcode-oauth", &disabled); err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveBuiltinPolicy(ctx, instance, policy, policy.Revision, "", nil); !errors.Is(err, ErrBuiltinPolicyConflict) {
		t.Fatalf("stale policy write = %v", err)
	}
	// Ordinary key rotation must retain the operator's global and per-plugin switches.
	instance.ManagementKeyCiphertext = []byte("rotated ciphertext")
	if err := repo.UpsertInstance(ctx, instance); err != nil {
		t.Fatal(err)
	}
	rotated, err := repo.GetInstance(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	restored, err := repo.BuiltinPolicy(ctx, rotated)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Enabled || restored.Revision != 2 || restored.Overrides["omc-zcode-oauth"].State != "disabled" {
		t.Fatalf("policy lost on key rotation: %+v", restored)
	}
	rotated.BaseURL = "http://second.example"
	if err := repo.UpsertInstance(ctx, rotated); err != nil {
		t.Fatal(err)
	}
	rebound, err := repo.GetInstance(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if rebound.BindingGeneration != 2 {
		t.Fatalf("generation = %d", rebound.BindingGeneration)
	}
	if err := repo.CheckBuiltinBinding(ctx, instance); !errors.Is(err, ErrBuiltinBindingChanged) {
		t.Fatalf("old task binding = %v", err)
	}
	changed, err := repo.BuiltinPolicy(ctx, rebound)
	if err != nil {
		t.Fatal(err)
	}
	if !changed.Enabled || changed.Revision != 1 || len(changed.Overrides) != 0 {
		t.Fatalf("new gateway did not start from the default-on policy: %+v", changed)
	}
	if err := repo.SaveBuiltinOperation(ctx, instance, "omc-zcode-oauth", BuiltinOperation{State: "pending"}); !errors.Is(err, ErrBuiltinBindingChanged) {
		t.Fatalf("stale operation accepted: %v", err)
	}
	rebound.BaseURL = instance.BaseURL
	if err := repo.UpsertInstance(ctx, rebound); err != nil {
		t.Fatal(err)
	}
	returned, err := repo.GetInstance(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	again, err := repo.BuiltinPolicy(ctx, returned)
	if err != nil {
		t.Fatal(err)
	}
	if returned.BindingGeneration != 3 || !again.Enabled || again.Revision != 1 {
		t.Fatalf("returning to an old address resurrected stale policy: instance=%+v policy=%+v", returned, again)
	}
}

func TestBuiltinDefaultOnMigrationPreservesOnlyCurrentOverrides(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseAtMigration(t, 53)
	repo := New(db)
	if err := repo.PutPreference(ctx, PreferenceOMCPluginSource, "false"); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	explicit := domain.CPAInstance{ID: "explicit", BaseURL: "https://explicit.example", ManagementKeyCiphertext: []byte("fixture"), ManagementKeyNonce: []byte("fixture"), CreatedAt: now, UpdatedAt: now}
	if err := repo.UpsertInstance(ctx, explicit); err != nil {
		t.Fatal(err)
	}
	explicit, err := repo.GetInstance(ctx, explicit.ID)
	if err != nil {
		t.Fatal(err)
	}
	missing := domain.CPAInstance{ID: "missing", BaseURL: "https://missing.example", ManagementKeyCiphertext: []byte("fixture"), ManagementKeyNonce: []byte("fixture"), CreatedAt: now, UpdatedAt: now}
	if err := repo.UpsertInstance(ctx, missing); err != nil {
		t.Fatal(err)
	}
	missing, err = repo.GetInstance(ctx, missing.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO builtin_policies(instance_id,generation,gateway_id,enabled,consent,revision) VALUES(?,?,?,0,0,7)`, explicit.ID, explicit.BindingGeneration, BuiltinGatewayID(explicit)); err != nil {
		t.Fatal(err)
	}
	for pluginID, state := range map[string]string{
		"removed-plugin":  "removed",
		"pinned-plugin":   "pinned",
		"disabled-plugin": "disabled",
	} {
		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO builtin_plugin_policies(instance_id,generation,plugin_id,state,pinned_version) VALUES(?,?,?,?,?)`, explicit.ID, explicit.BindingGeneration, pluginID, state, "0.1.4"); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	explicit, err = repo.GetInstance(ctx, explicit.ID)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := repo.BuiltinPolicy(ctx, explicit)
	if err != nil {
		t.Fatal(err)
	}
	if !policy.Enabled || policy.Revision != 7 {
		t.Fatalf("default-on migration changed explicit identity: %+v", policy)
	}
	if policy.Overrides["removed-plugin"].State != "default" || policy.Overrides["pinned-plugin"].State != "default" || policy.Overrides["disabled-plugin"].State != "disabled" {
		t.Fatalf("default-on migration did not normalize obsolete overrides: %+v", policy.Overrides)
	}
	var pinned string
	if err := db.SQL.QueryRowContext(ctx, `SELECT pinned_version FROM builtin_plugin_policies WHERE instance_id=? AND plugin_id='disabled-plugin'`, explicit.ID).Scan(&pinned); err != nil || pinned != "" {
		t.Fatalf("pinned version survived migration: %q %v", pinned, err)
	}
	missing, err = repo.GetInstance(ctx, missing.ID)
	if err != nil {
		t.Fatal(err)
	}
	defaulted, err := repo.BuiltinPolicy(ctx, missing)
	if err != nil {
		t.Fatal(err)
	}
	if !defaulted.Enabled || defaulted.Revision != 1 {
		t.Fatalf("gateway without a row did not default on: %+v", defaulted)
	}

	// The migration is a one-time normalization. A switch turned off after it
	// must survive every later startup.
	defaulted.Enabled = false
	if err := repo.SaveBuiltinPolicy(ctx, missing, defaulted, defaulted.Revision, "", nil); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	missing, err = repo.GetInstance(ctx, missing.ID)
	if err != nil {
		t.Fatal(err)
	}
	after, err := repo.BuiltinPolicy(ctx, missing)
	if err != nil {
		t.Fatal(err)
	}
	if after.Enabled {
		t.Fatalf("migration reran and overwrote the operator switch: %+v", after)
	}
}

func TestOMCCommunityPreferenceCannotChangeBuiltinPolicy(t *testing.T) {
	for _, legacy := range []string{"", "false", "true"} {
		for _, disabled := range []bool{false, true} {
			t.Run(legacy+"/disabled="+map[bool]string{false: "false", true: "true"}[disabled], func(t *testing.T) {
				repo, _ := testRepository(t)
				ctx := context.Background()
				if legacy != "" {
					if err := repo.PutPreference(ctx, PreferenceOMCPluginSource, legacy); err != nil {
						t.Fatal(err)
					}
				}
				instance := domain.CPAInstance{ID: "default", BaseURL: "http://example.test", ManagementKeyCiphertext: []byte("fixture"), ManagementKeyNonce: []byte("fixture"), CreatedAt: time.Now(), UpdatedAt: time.Now()}
				if err := repo.UpsertInstance(ctx, instance); err != nil {
					t.Fatal(err)
				}
				instance, err := repo.GetInstance(ctx, "default")
				if err != nil {
					t.Fatal(err)
				}
				before, err := repo.BuiltinPolicy(ctx, instance)
				if err != nil {
					t.Fatal(err)
				}
				if !before.Enabled {
					t.Fatal("a new gateway inherited the community source switch")
				}
				if disabled {
					before.Enabled = false
					override := BuiltinPluginPolicy{State: "disabled"}
					if err := repo.SaveBuiltinPolicy(ctx, instance, before, before.Revision, "omc-zcode-oauth", &override); err != nil {
						t.Fatal(err)
					}
					before, err = repo.BuiltinPolicy(ctx, instance)
					if err != nil {
						t.Fatal(err)
					}
				}
				if err := repo.SaveBuiltinOperation(ctx, instance, "omc-zcode-oauth", BuiltinOperation{Version: "0.1.4", State: "pending"}); err != nil {
					t.Fatal(err)
				}
				before, err = repo.BuiltinPolicy(ctx, instance)
				if err != nil {
					t.Fatal(err)
				}
				for _, value := range []string{"false", "true", "false"} {
					if err := repo.PutPreference(ctx, PreferenceOMCPluginSource, value); err != nil {
						t.Fatal(err)
					}
					after, err := repo.BuiltinPolicy(ctx, instance)
					if err != nil {
						t.Fatal(err)
					}
					current, err := repo.GetInstance(ctx, "default")
					if err != nil {
						t.Fatal(err)
					}
					if current.BindingGeneration != instance.BindingGeneration {
						t.Fatal("community preference changed the gateway generation")
					}
					if !reflect.DeepEqual(before, after) {
						t.Fatalf("community=%s changed builtin policy: before=%+v after=%+v", value, before, after)
					}
				}
			})
		}
	}
}

func TestBuiltinDefaultOnMigrationRunsFromPreBuiltinSchema(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseAtMigration(t, 52)
	repo := New(db)
	if err := repo.PutPreference(ctx, PreferenceOMCPluginSource, "false"); err != nil {
		t.Fatal(err)
	}
	instance := domain.CPAInstance{ID: "default", BaseURL: "https://old.example", ManagementKeyCiphertext: []byte("fixture"), ManagementKeyNonce: []byte("fixture"), CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := repo.UpsertInstance(ctx, instance); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	instance, err := repo.GetInstance(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	policy, err := repo.BuiltinPolicy(ctx, instance)
	if err != nil {
		t.Fatal(err)
	}
	if !policy.Enabled || policy.Revision != 1 || instance.BindingGeneration != 1 {
		t.Fatalf("pre-builtin upgrade policy=%+v instance=%+v", policy, instance)
	}
}
