package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
)

// ConfigKeyFamily names one of CPA's `{family}-api-key` credential lists.
//
// Every family shares one entry schema and one write shape (GET the list, PUT
// the whole list back), so the console treats them uniformly: the family is a
// value, not a code path. Adding a provider whose credentials CPA stores this
// way means adding a constant here and a presentation row in the API layer.
type ConfigKeyFamily string

const (
	ConfigFamilyClaude       ConfigKeyFamily = "claude"
	ConfigFamilyCodex        ConfigKeyFamily = "codex"
	ConfigFamilyGemini       ConfigKeyFamily = "gemini"
	ConfigFamilyMeta         ConfigKeyFamily = "meta"
	ConfigFamilyXAI          ConfigKeyFamily = "xai"
	ConfigFamilyVertex       ConfigKeyFamily = "vertex"
	ConfigFamilyInteractions ConfigKeyFamily = "interactions"
)

// ConfigKeyFamilies is every family, in the order readers that walk all of them
// (the model catalog, the provider list) visit them.
var ConfigKeyFamilies = []ConfigKeyFamily{
	ConfigFamilyCodex,
	ConfigFamilyClaude,
	ConfigFamilyGemini,
	ConfigFamilyMeta,
	ConfigFamilyXAI,
	ConfigFamilyVertex,
	ConfigFamilyInteractions,
}

// ConfigAPIKey is the credential entry CPA uses across every config API-key
// family.
//
// CPA declares these as separate structs (ClaudeKey, CodexKey, GeminiKey,
// VertexCompatKey, ...) that share this common core - MetaKey and XAIKey are
// aliases of CodexKey upstream, and the Interactions list reuses GeminiKey.
// Mirroring that duplication here would mean a copy of every read, write and
// merge path per family that must stay in lockstep, with no type safety gained,
// because the wire shape is the only thing that matters.
//
// The families do differ in the fields around that core (a Codex entry's
// `websockets`, a Claude entry's `cloak`, `request-retry` on most of them), and
// the console only ever writes a whole list back. Those fields are therefore
// carried through in extra rather than modelled: an edit made here must not
// silently strip a setting the operator configured in config.yaml.
type ConfigAPIKey struct {
	APIKey         string            `json:"api-key"`
	AuthIndex      string            `json:"auth-index,omitempty"`
	BaseURL        string            `json:"base-url,omitempty"`
	ProxyURL       string            `json:"proxy-url,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
	Models         []ModelAlias      `json:"models,omitempty"`
	ExcludedModels []string          `json:"excluded-models,omitempty"`
	Priority       *int              `json:"priority,omitempty"`
	Weight         *int              `json:"weight,omitempty"`
	Prefix         string            `json:"prefix,omitempty"`
	DisableCooling *bool             `json:"disable-cooling,omitempty"`

	// extra holds the entry's fields this struct does not model, verbatim, so a
	// read-modify-write round trip returns them to CPA unchanged.
	extra map[string]json.RawMessage
}

// configAPIKeyFields is ConfigAPIKey without its JSON methods, so they can use
// the default encoding for the modelled fields without recursing.
type configAPIKeyFields ConfigAPIKey

// configAPIKeyModelledFields is the set of wire names ConfigAPIKey models. It is
// derived from the struct tags so a newly modelled field can never also be
// replayed from extra.
var configAPIKeyModelledFields = func() map[string]bool {
	names := map[string]bool{}
	fieldType := reflect.TypeOf(configAPIKeyFields{})
	for i := 0; i < fieldType.NumField(); i++ {
		tag := fieldType.Field(i).Tag.Get("json")
		if name, _, _ := strings.Cut(tag, ","); name != "" && name != "-" {
			names[name] = true
		}
	}
	return names
}()

// UnmarshalJSON decodes the modelled fields and keeps every other field.
func (k *ConfigAPIKey) UnmarshalJSON(data []byte) error {
	var fields configAPIKeyFields
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for name := range raw {
		if configAPIKeyModelledFields[name] {
			delete(raw, name)
		}
	}
	*k = ConfigAPIKey(fields)
	if len(raw) > 0 {
		k.extra = raw
	} else {
		k.extra = nil
	}
	return nil
}

// MarshalJSON encodes the modelled fields and replays the unmodelled ones.
//
// A modelled field always wins: extra never holds a modelled name, so clearing
// an optional field (which omitempty then drops) cannot bring back its old value.
func (k ConfigAPIKey) MarshalJSON() ([]byte, error) {
	encoded, err := json.Marshal(configAPIKeyFields(k))
	if err != nil || len(k.extra) == 0 {
		return encoded, err
	}
	merged := map[string]json.RawMessage{}
	if err := json.Unmarshal(encoded, &merged); err != nil {
		return nil, err
	}
	for name, value := range k.extra {
		if _, isSet := merged[name]; !isSet {
			merged[name] = value
		}
	}
	return json.Marshal(merged)
}

// ConfigSection is the configuration document key this family is stored under,
// e.g. `meta-api-key`. It is what a raw `GET /config` response labels the list.
func (f ConfigKeyFamily) ConfigSection() string {
	return string(f) + "-api-key"
}

// IsMissingCapability reports whether a family read failed because CPA does not
// have that endpoint at all.
//
// The Management API is versioned independently of this console, so a release
// older than the one that introduced a family answers 404 (or 405/501 for a
// route registered with the wrong method). That is a missing capability rather
// than a broken credential list, and callers have to distinguish the two: a
// catalog that fails wholly because one provider postdates the installed CPA is
// worse than one that reports the providers CPA actually has.
func IsMissingCapability(err error) bool {
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	switch httpErr.StatusCode {
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return true
	default:
		return false
	}
}

// configKeysEndpoint is the Management API path for the family's credential list.
func (f ConfigKeyFamily) configKeysEndpoint() string {
	return "/" + string(f) + "-api-key"
}

// ConfigAPIKeys reads one family's credential list.
//
// The response wrapper is keyed by the family's own section name, so it is
// decoded through an open map rather than one struct per family.
//
// A section that is absent, null, or empty all mean "this family has no
// credentials". Only a malformed body is an error: a gateway that omits an empty
// list has said nothing about the family, and failing here would let one empty
// credential list break every caller that reads all families at once.
func (c *Client) ConfigAPIKeys(ctx context.Context, family ConfigKeyFamily) ([]ConfigAPIKey, error) {
	var response map[string]json.RawMessage
	if _, err := c.doV0JSON(ctx, http.MethodGet, family.configKeysEndpoint(), nil, &response); err != nil {
		return nil, err
	}
	entries := []ConfigAPIKey{}
	raw, present := response[family.ConfigSection()]
	if !present || len(raw) == 0 || string(raw) == "null" {
		return entries, nil
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("decode %s: %w", family.ConfigSection(), err)
	}
	if entries == nil {
		entries = []ConfigAPIKey{}
	}
	return entries, nil
}

// UpdateConfigAPIKeys replaces the whole family list. CPA accepts a bare array
// for every family, so an empty list is sent as `[]` rather than omitted: a nil
// slice would be encoded as `null`, which CPA rejects.
func (c *Client) UpdateConfigAPIKeys(ctx context.Context, family ConfigKeyFamily, entries []ConfigAPIKey) error {
	if entries == nil {
		entries = []ConfigAPIKey{}
	}
	_, err := c.doV0JSON(ctx, http.MethodPut, family.configKeysEndpoint(), entries, nil)
	return err
}
