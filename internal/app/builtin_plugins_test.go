package app

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestBuiltinPolicyDefaultsOnAndKeepsExplicitSwitchAcrossBootstrap(t *testing.T) {
	ctx := context.Background()
	cipher, err := appcrypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	db, err := repository.Open(ctx, fmt.Sprintf("file:bootstrap_builtin_%d?mode=memory&cache=shared", time.Now().UnixNano()), repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)
	cfg := config.Config{CPA: config.CPAConfig{BaseURL: "http://cpa.example.test", ManagementKey: "synthetic-bootstrap-only"}}
	if err := bootstrapDefaultInstance(ctx, cfg, repo, cipher); err != nil {
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
	if !policy.Enabled || policy.Revision != 1 {
		t.Fatalf("fresh gateway did not default builtins on: %+v", policy)
	}

	policy.Enabled = false
	if err := repo.SaveBuiltinPolicy(ctx, instance, policy, policy.Revision, "", nil); err != nil {
		t.Fatal(err)
	}

	// Rotating the gateway credential must not reset the operator's choice.
	cfg.CPA.ManagementKey = "synthetic-rotated-key"
	if err := bootstrapDefaultInstance(ctx, cfg, repo, cipher); err != nil {
		t.Fatal(err)
	}
	rotated, err := repo.GetInstance(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	after, err := repo.BuiltinPolicy(ctx, rotated)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.BindingGeneration != instance.BindingGeneration || after.Enabled || after.Revision != 2 {
		t.Fatalf("key rotation changed builtin policy: instance=%+v policy=%+v", rotated, after)
	}

	// A different CPA is a different automation scope and starts on by default.
	cfg.CPA.BaseURL = "http://second-cpa.example.test"
	if err := bootstrapDefaultInstance(ctx, cfg, repo, cipher); err != nil {
		t.Fatal(err)
	}
	rebound, err := repo.GetInstance(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	newScope, err := repo.BuiltinPolicy(ctx, rebound)
	if err != nil {
		t.Fatal(err)
	}
	if rebound.BindingGeneration != 2 || !newScope.Enabled || newScope.Revision != 1 {
		t.Fatalf("second gateway did not start from the default-on policy: instance=%+v policy=%+v", rebound, newScope)
	}
}
