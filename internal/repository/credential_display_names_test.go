package repository

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// A name is written against the file it names, guarded by the version the
// writer read, and clearing it leaves no row behind.
func TestCredentialDisplayNameLifecycle(t *testing.T) {
	repo := fingerprintTestRepository(t)
	ctx := context.Background()
	const file = "codex-1a2b-ops@example.com-plus.json"

	stored, err := repo.SetCredentialDisplayName(ctx, "default", file, "  Team seat  ", 0)
	if err != nil {
		t.Fatalf("set: %v", err)
	}
	if stored.DisplayName != "Team seat" || stored.Version != 1 {
		t.Fatalf("stored = %+v, want trimmed name at version 1", stored)
	}

	// A second session that read the credential unnamed must not overwrite it.
	if _, err := repo.SetCredentialDisplayName(ctx, "default", file, "Other", 0); !errors.Is(err, ErrCredentialDisplayNameVersionConflict) {
		t.Fatalf("stale write err = %v, want version conflict", err)
	}
	renamed, err := repo.SetCredentialDisplayName(ctx, "default", file, "Overflow seat", stored.Version)
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if renamed.Version != 2 || renamed.CreatedAtMS != stored.CreatedAtMS {
		t.Fatalf("renamed = %+v, want version 2 keeping its creation time", renamed)
	}

	listed, err := repo.ListCredentialDisplayNames(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[file].DisplayName != "Overflow seat" {
		t.Fatalf("listed = %+v", listed)
	}

	if _, err := repo.SetCredentialDisplayName(ctx, "default", file, "", renamed.Version); err != nil {
		t.Fatalf("clear: %v", err)
	}
	listed, _ = repo.ListCredentialDisplayNames(ctx, "default")
	if len(listed) != 0 {
		t.Fatalf("cleared name left a row: %+v", listed)
	}

	for _, invalid := range []string{strings.Repeat("名", MaxCredentialDisplayNameLength+1), "line\nbreak", "seat‮evil"} {
		if _, err := repo.SetCredentialDisplayName(ctx, "default", file, invalid, 0); !errors.Is(err, ErrCredentialDisplayNameInvalid) {
			t.Fatalf("name %q err = %v, want invalid", invalid, err)
		}
	}
}
