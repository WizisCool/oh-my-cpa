package repository

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/oh-my-cpa/oh-my-cpa/internal/iconasset"
)

const MaxCustomIcons = 100

var ErrCustomIconMissing = errors.New("custom_icon_not_found")
var ErrCustomIconLimit = errors.New("custom_icon_limit")
var ErrCustomIconName = errors.New("custom_icon_invalid_name")

type CustomIcon struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	MIMEType       string `json:"mime_type"`
	Revision       int64  `json:"revision"`
	CreatedAtMS    int64  `json:"created_at_ms"`
	UpdatedAtMS    int64  `json:"updated_at_ms"`
	ReferenceCount int    `json:"reference_count"`
	Content        []byte `json:"-"`
}

func validateCustomIconName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > 80 {
		return "", ErrCustomIconName
	}
	return name, nil
}
func (r *Repository) ListCustomIcons(ctx context.Context) ([]CustomIcon, error) {
	rows, err := r.SQL().QueryContext(ctx, `SELECT id,name,mime_type,revision,created_at_ms,updated_at_ms FROM custom_icons ORDER BY created_at_ms DESC, id`)
	if err != nil {
		return nil, err
	}
	icons := []CustomIcon{}
	for rows.Next() {
		var icon CustomIcon
		if err := rows.Scan(&icon.ID, &icon.Name, &icon.MIMEType, &icon.Revision, &icon.CreatedAtMS, &icon.UpdatedAtMS); err != nil {
			rows.Close()
			return nil, err
		}
		icons = append(icons, icon)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	raw, _, err := r.GetPreference(ctx, PreferenceProviderIcons)
	if err != nil {
		return nil, err
	}
	references, err := customIconReferences(raw)
	if err != nil {
		return nil, err
	}
	for index := range icons {
		icons[index].ReferenceCount = references[icons[index].ID]
	}
	return icons, nil
}
func customIconReferences(raw string) (map[string]int, error) {
	references := map[string]int{}
	if raw == "" {
		return references, nil
	}
	var icons map[string]string
	if err := json.Unmarshal([]byte(raw), &icons); err != nil {
		return nil, err
	}
	for _, icon := range icons {
		if strings.HasPrefix(icon, "custom:") {
			references[strings.TrimPrefix(icon, "custom:")]++
		}
	}
	return references, nil
}
func (r *Repository) GetCustomIcon(ctx context.Context, id string) (CustomIcon, error) {
	var icon CustomIcon
	err := r.SQL().QueryRowContext(ctx, `SELECT id,name,mime_type,revision,created_at_ms,updated_at_ms,content FROM custom_icons WHERE id=?`, id).Scan(&icon.ID, &icon.Name, &icon.MIMEType, &icon.Revision, &icon.CreatedAtMS, &icon.UpdatedAtMS, &icon.Content)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrCustomIconMissing
	}
	return icon, err
}
func (r *Repository) CreateCustomIcon(ctx context.Context, name, imageData string) (CustomIcon, error) {
	name, err := validateCustomIconName(name)
	if err != nil {
		return CustomIcon{}, err
	}
	artwork, err := iconasset.ValidateImage(imageData)
	if err != nil {
		return CustomIcon{}, err
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return CustomIcon{}, err
	}
	now := time.Now().UnixMilli()
	icon := CustomIcon{ID: hex.EncodeToString(random), Name: name, MIMEType: artwork.MIME, Content: artwork.Content, Revision: 1, CreatedAtMS: now, UpdatedAtMS: now}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return CustomIcon{}, err
	}
	defer tx.Rollback()
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM custom_icons`).Scan(&count); err != nil {
		return CustomIcon{}, err
	}
	if count >= MaxCustomIcons {
		return CustomIcon{}, ErrCustomIconLimit
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO custom_icons(id,name,mime_type,content,revision,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)`, icon.ID, icon.Name, icon.MIMEType, icon.Content, icon.Revision, now, now); err != nil {
		return CustomIcon{}, err
	}
	return icon, tx.Commit()
}
func (r *Repository) UpdateCustomIcon(ctx context.Context, id string, name *string, imageData *string) (CustomIcon, error) {
	if name == nil && imageData == nil {
		return CustomIcon{}, ErrCustomIconName
	}
	var cleanName string
	var artwork iconasset.Image
	var err error
	if name != nil {
		cleanName, err = validateCustomIconName(*name)
		if err != nil {
			return CustomIcon{}, err
		}
	}
	if imageData != nil {
		artwork, err = iconasset.ValidateImage(*imageData)
		if err != nil {
			return CustomIcon{}, err
		}
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return CustomIcon{}, err
	}
	defer tx.Rollback()
	var icon CustomIcon
	err = tx.QueryRowContext(ctx, `SELECT id,name,mime_type,content,revision,created_at_ms,updated_at_ms FROM custom_icons WHERE id=?`, id).Scan(&icon.ID, &icon.Name, &icon.MIMEType, &icon.Content, &icon.Revision, &icon.CreatedAtMS, &icon.UpdatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return CustomIcon{}, ErrCustomIconMissing
	}
	if err != nil {
		return CustomIcon{}, err
	}
	if name != nil {
		icon.Name = cleanName
	}
	if imageData != nil {
		icon.MIMEType = artwork.MIME
		icon.Content = artwork.Content
	}
	icon.Revision++
	icon.UpdatedAtMS = time.Now().UnixMilli()
	_, err = tx.ExecContext(ctx, `UPDATE custom_icons SET name=?,mime_type=?,content=?,revision=?,updated_at_ms=? WHERE id=?`, icon.Name, icon.MIMEType, icon.Content, icon.Revision, icon.UpdatedAtMS, id)
	if err != nil {
		return CustomIcon{}, err
	}
	var raw string
	err = tx.QueryRowContext(ctx, `SELECT pref_value FROM ui_preferences WHERE pref_key=?`, PreferenceProviderIcons).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return CustomIcon{}, err
	}
	references, err := customIconReferences(raw)
	if err != nil {
		return CustomIcon{}, err
	}
	icon.ReferenceCount = references[id]
	return icon, tx.Commit()
}
func (r *Repository) DeleteCustomIcon(ctx context.Context, id string) error {
	return r.DeleteCustomIconChecked(ctx, id, 0)
}
func (r *Repository) DeleteCustomIconChecked(ctx context.Context, id string, expectedRevision int64) error {
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if expectedRevision != 0 {
		var revision int64
		err := tx.QueryRowContext(ctx, `SELECT revision FROM custom_icons WHERE id=?`, id).Scan(&revision)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrCustomIconMissing
		}
		if err != nil {
			return err
		}
		if revision != expectedRevision {
			return errors.New("resource_conflict")
		}
	}
	var raw string
	err = tx.QueryRowContext(ctx, `SELECT pref_value FROM ui_preferences WHERE pref_key=?`, PreferenceProviderIcons).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var assignments map[string]string
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &assignments); err != nil {
			return err
		}
	}
	hasRemovedReferences := false
	for providerKey, reference := range assignments {
		if reference == "custom:"+id {
			delete(assignments, providerKey)
			hasRemovedReferences = true
		}
	}
	if hasRemovedReferences {
		encoded, err := json.Marshal(assignments)
		if err != nil {
			return err
		}
		// Removing overrides preserves each surface's own default and plugin authority.
		// The asset delete shares this transaction so failures cannot leave a partial reset.
		if _, err := tx.ExecContext(ctx, `UPDATE ui_preferences SET pref_value=?,updated_at_ms=? WHERE pref_key=?`, string(encoded), time.Now().UnixMilli(), PreferenceProviderIcons); err != nil {
			return err
		}
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM custom_icons WHERE id=?`, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrCustomIconMissing
	}
	return tx.Commit()
}
func validateCustomIconReferences(ctx context.Context, tx *sql.Tx, raw string) error {
	references, err := customIconReferences(raw)
	if err != nil {
		return ErrCustomIconName
	}
	for id := range references {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM custom_icons WHERE id=?`, id).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			return ErrCustomIconMissing
		}
	}
	return nil
}
