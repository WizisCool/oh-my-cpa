package repository

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/fontasset"
)

// MaxFonts bounds the font library. Each family can hold tens of megabytes of slices,
// so the ceiling is about the database file rather than about the list.
const MaxFonts = 32

var (
	ErrFontMissing    = errors.New("font_not_found")
	ErrFontLimit      = errors.New("font_limit")
	ErrFontReference  = errors.New("font_invalid_reference")
	ErrFontNoFaces    = errors.New("font_invalid_file")
	fontReferenceForm = regexp.MustCompile(`^(builtin:[a-z0-9-]{1,32}|font:[0-9a-f]{32})$`)
)

// FontSource names where a stored family came from.
type FontSource string

const (
	FontSourceGoogle FontSource = "google"
	FontSourceUpload FontSource = "upload"
)

// Font is one installed family and the faces it is drawn from.
type Font struct {
	ID          string     `json:"id"`
	Family      string     `json:"family"`
	Source      FontSource `json:"source"`
	CreatedAtMS int64      `json:"created_at_ms"`
	ByteSize    int64      `json:"byte_size"`
	Faces       []FontFace `json:"faces"`
}

// FontFace is one `@font-face` rule of an installed family. Its content is served on
// its own route; the list carries only what a browser needs to declare the face.
type FontFace struct {
	ID           string           `json:"id"`
	WeightMin    int              `json:"weight_min"`
	WeightMax    int              `json:"weight_max"`
	Style        string           `json:"style"`
	UnicodeRange string           `json:"unicode_range,omitempty"`
	Format       fontasset.Format `json:"format"`
	Content      []byte           `json:"-"`
}

func newFontID() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return hex.EncodeToString(random), nil
}

// ListFonts returns every installed family with its face declarations.
func (r *Repository) ListFonts(ctx context.Context) ([]Font, error) {
	rows, err := r.SQL().QueryContext(ctx, `SELECT id,family,source,created_at_ms FROM fonts ORDER BY created_at_ms DESC, id`)
	if err != nil {
		return nil, err
	}
	fonts := []Font{}
	index := map[string]int{}
	for rows.Next() {
		var font Font
		if err := rows.Scan(&font.ID, &font.Family, &font.Source, &font.CreatedAtMS); err != nil {
			rows.Close()
			return nil, err
		}
		font.Faces = []FontFace{}
		index[font.ID] = len(fonts)
		fonts = append(fonts, font)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	faceRows, err := r.SQL().QueryContext(ctx, `SELECT id,font_id,weight_min,weight_max,style,unicode_range,format,length(content) FROM font_faces ORDER BY font_id, position`)
	if err != nil {
		return nil, err
	}
	defer faceRows.Close()
	for faceRows.Next() {
		var face FontFace
		var fontID string
		var size int64
		if err := faceRows.Scan(&face.ID, &fontID, &face.WeightMin, &face.WeightMax, &face.Style, &face.UnicodeRange, &face.Format, &size); err != nil {
			return nil, err
		}
		if position, ok := index[fontID]; ok {
			fonts[position].Faces = append(fonts[position].Faces, face)
			fonts[position].ByteSize += size
		}
	}
	return fonts, faceRows.Err()
}

// CreateFont stores a family and its faces in one transaction, so a failed install
// never leaves a family that draws only some of its characters.
func (r *Repository) CreateFont(ctx context.Context, family string, source FontSource, faces []fontasset.Face) (Font, error) {
	family, err := fontasset.CleanFamily(family)
	if err != nil {
		return Font{}, err
	}
	if len(faces) == 0 {
		return Font{}, ErrFontNoFaces
	}
	id, err := newFontID()
	if err != nil {
		return Font{}, err
	}
	font := Font{ID: id, Family: family, Source: source, CreatedAtMS: time.Now().UnixMilli(), Faces: make([]FontFace, 0, len(faces))}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return Font{}, err
	}
	defer tx.Rollback()
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM fonts`).Scan(&count); err != nil {
		return Font{}, err
	}
	if count >= MaxFonts {
		return Font{}, ErrFontLimit
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO fonts(id,family,source,created_at_ms) VALUES(?,?,?,?)`, font.ID, font.Family, string(source), font.CreatedAtMS); err != nil {
		return Font{}, err
	}
	for position, face := range faces {
		faceID, err := newFontID()
		if err != nil {
			return Font{}, err
		}
		style := "normal"
		if face.Italic {
			style = "italic"
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO font_faces(id,font_id,weight_min,weight_max,style,unicode_range,format,content,position) VALUES(?,?,?,?,?,?,?,?,?)`,
			faceID, font.ID, face.WeightMin, face.WeightMax, style, face.UnicodeRange, string(face.Format), face.Content, position); err != nil {
			return Font{}, err
		}
		font.ByteSize += int64(len(face.Content))
		font.Faces = append(font.Faces, FontFace{ID: faceID, WeightMin: face.WeightMin, WeightMax: face.WeightMax, Style: style, UnicodeRange: face.UnicodeRange, Format: face.Format})
	}
	return font, tx.Commit()
}

// GetFontFace returns one face with its file.
func (r *Repository) GetFontFace(ctx context.Context, fontID, faceID string) (FontFace, error) {
	var face FontFace
	err := r.SQL().QueryRowContext(ctx, `SELECT id,weight_min,weight_max,style,unicode_range,format,content FROM font_faces WHERE id=? AND font_id=?`, faceID, fontID).
		Scan(&face.ID, &face.WeightMin, &face.WeightMax, &face.Style, &face.UnicodeRange, &face.Format, &face.Content)
	if errors.Is(err, sql.ErrNoRows) {
		return FontFace{}, ErrFontMissing
	}
	return face, err
}

// DeleteFont removes a family and, in the same transaction, every role that used it,
// so the console falls back to its default typeface rather than to a family that no
// longer exists.
func (r *Repository) DeleteFont(ctx context.Context, id string) error {
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var raw string
	err = tx.QueryRowContext(ctx, `SELECT pref_value FROM ui_preferences WHERE pref_key=?`, PreferenceFonts).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if raw != "" {
		var roles map[string]string
		if json.Unmarshal([]byte(raw), &roles) == nil {
			hasChanged := false
			for role, reference := range roles {
				if reference == "font:"+id {
					delete(roles, role)
					hasChanged = true
				}
			}
			if hasChanged {
				encoded, err := json.Marshal(roles)
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `UPDATE ui_preferences SET pref_value=?,updated_at_ms=? WHERE pref_key=?`, string(encoded), time.Now().UnixMilli(), PreferenceFonts); err != nil {
					return err
				}
			}
		}
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM fonts WHERE id=?`, id)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil {
		return err
	} else if count == 0 {
		return ErrFontMissing
	}
	return tx.Commit()
}

// validateFontReferences keeps the font preference a map of role to a reference the
// console can resolve: a built-in typeface or an installed family.
func validateFontReferences(ctx context.Context, tx *sql.Tx, raw string) error {
	var roles map[string]string
	if err := json.Unmarshal([]byte(raw), &roles); err != nil {
		return ErrFontReference
	}
	for role, reference := range roles {
		if role != "ui" && role != "mono" {
			return ErrFontReference
		}
		if !fontReferenceForm.MatchString(reference) {
			return ErrFontReference
		}
		id, isInstalled := strings.CutPrefix(reference, "font:")
		if !isInstalled {
			continue
		}
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM fonts WHERE id=?`, id).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			return ErrFontMissing
		}
	}
	return nil
}
