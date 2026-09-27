package repository

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestAgentStoreRevisionAndEnvelope(t *testing.T) {
	repo, cipher := testRepository(t)
	store := AgentStore{repo, cipher}
	ctx := context.Background()
	expiry := time.Now().Add(time.Hour)
	if _, err := store.Save(ctx, "session", "missing", 3, expiry, "secret"); !errors.Is(err, ErrAgentConflict) {
		t.Fatalf("nonzero insert: %v", err)
	}
	revision, err := store.Save(ctx, "session", "latest", 0, expiry, "secret")
	if err != nil || revision != 1 {
		t.Fatalf("insert: %d %v", revision, err)
	}
	if _, err = store.Save(ctx, "session", "latest", 0, expiry, "overwrite"); !errors.Is(err, ErrAgentConflict) {
		t.Fatalf("duplicate insert: %v", err)
	}
	if _, err = store.Save(ctx, "session", "latest", 2, expiry, "overwrite"); !errors.Is(err, ErrAgentConflict) {
		t.Fatalf("stale update: %v", err)
	}
	revision, err = store.Save(ctx, "session", "latest", 1, expiry, "updated")
	if err != nil || revision != 2 {
		t.Fatalf("update: %d %v", revision, err)
	}
	var value string
	if _, err = store.Load(ctx, "session", "latest", &value); err != nil || value != "updated" {
		t.Fatalf("load: %s %v", value, err)
	}
	if _, err = repo.SQL().ExecContext(ctx, "UPDATE agent_documents SET id='swapped' WHERE id='latest'"); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Load(ctx, "session", "swapped", &value); err == nil {
		t.Fatal("accepted swapped ciphertext")
	}
}
