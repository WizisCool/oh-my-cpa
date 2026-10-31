package pluginregistry

import (
	"encoding/json"
	"errors"
)

const MaxDescriptionBytes = 64 * 1024

type DescriptionDocument struct {
	SchemaVersion int    `json:"schema_version"`
	PluginID      string `json:"plugin_id"`
	PluginVersion string `json:"plugin_version"`
	I18n          struct {
		Description Descriptions `json:"description"`
	} `json:"i18n"`
}

func ParseDescription(raw []byte, id, version string) (Descriptions, error) {
	if len(raw) > MaxDescriptionBytes {
		return nil, errors.New("plugin description is too large")
	}
	var document DescriptionDocument
	if err := decodeStrict(raw, &document); err != nil {
		return nil, err
	}
	if document.SchemaVersion != 1 || document.PluginID != id || document.PluginVersion != version || !idPattern.MatchString(id) || !versionPattern.MatchString(version) || len(document.I18n.Description) == 0 {
		return nil, errors.New("plugin description identity mismatch")
	}
	if err := ValidateDescriptions(document.I18n.Description); err != nil {
		return nil, err
	}
	// Return an independent map, including only the protocol's public text fields.
	raw, _ = json.Marshal(document.I18n.Description)
	var result Descriptions
	_ = json.Unmarshal(raw, &result)
	return result, nil
}
