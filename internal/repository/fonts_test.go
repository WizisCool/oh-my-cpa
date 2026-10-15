package repository

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/fontasset"
)

func TestFontLibraryStoresFacesAndKeepsRoleReferencesResolvable(t *testing.T) {
	ctx := context.Background()
	database, err := Open(ctx, filepath.Join(t.TempDir(), "fonts.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	repo := New(database)
	font, err := repo.CreateFont(ctx, " Inter ", FontSourceGoogle, []fontasset.Face{
		{WeightMin: 400, WeightMax: 700, UnicodeRange: "U+0-FF", Format: fontasset.FormatWOFF2, Content: []byte("wOF2-latin")},
		{WeightMin: 400, WeightMax: 400, Italic: true, Format: fontasset.FormatWOFF2, Content: []byte("wOF2-italic")},
	})
	if err != nil {
		t.Fatal(err)
	}
	fonts, err := repo.ListFonts(ctx)
	if err != nil || len(fonts) != 1 || fonts[0].Family != "Inter" || len(fonts[0].Faces) != 2 || fonts[0].ByteSize != int64(len("wOF2-latin")+len("wOF2-italic")) {
		t.Fatalf("%+v %v", fonts, err)
	}
	if fonts[0].Faces[1].Style != "italic" || fonts[0].Faces[0].WeightMax != 700 {
		t.Fatalf("face order or descriptors lost: %+v", fonts[0].Faces)
	}
	face, err := repo.GetFontFace(ctx, font.ID, font.Faces[0].ID)
	if err != nil || string(face.Content) != "wOF2-latin" {
		t.Fatalf("%q %v", face.Content, err)
	}
	if _, err := repo.GetFontFace(ctx, "0123456789abcdef0123456789abcdef", font.Faces[0].ID); !errors.Is(err, ErrFontMissing) {
		t.Fatalf("a face was served under another family: %v", err)
	}

	for _, refused := range []string{`{"ui":"font:0123456789abcdef0123456789abcdef"}`, `{"body":"builtin:system-sans"}`, `{"ui":"https://example.com/x.woff2"}`, `[]`} {
		if err := repo.PutPreference(ctx, PreferenceFonts, refused); err == nil {
			t.Fatalf("%s was stored", refused)
		}
	}
	if err := repo.PutPreference(ctx, PreferenceFonts, `{"ui":"font:`+font.ID+`","mono":"builtin:sarasa-mono"}`); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteFont(ctx, font.ID); err != nil {
		t.Fatal(err)
	}
	raw, _, err := repo.GetPreference(ctx, PreferenceFonts)
	if err != nil || raw != `{"mono":"builtin:sarasa-mono"}` {
		t.Fatalf("deleting a family left its role behind: %s %v", raw, err)
	}
	var faces int
	if err := repo.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM font_faces`).Scan(&faces); err != nil || faces != 0 {
		t.Fatalf("faces outlived their family: %d %v", faces, err)
	}
	if err := repo.DeleteFont(ctx, font.ID); !errors.Is(err, ErrFontMissing) {
		t.Fatalf("second delete: %v", err)
	}
}
