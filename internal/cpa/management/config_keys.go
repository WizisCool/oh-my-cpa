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
	// RequestRetry overrides the global retry count. CPA reads nil or a negative
	// value as "use the global setting" and 0 as "no additional retry rounds".
	RequestRetry        *int                     `json:"request-retry,omitempty"`
	RequestScopedErrors []RequestScopedErrorRule `json:"request-scoped-errors,omitempty"`
	// The three settings below exist on some families only, and CPA decodes each
	// family strictly: one of them written to a family that lacks it makes CPA
	// refuse the whole configuration. Callers set them per family.
	AlphaSearch bool `json:"alpha-search,omitempty"`
	// DisableCodexCloaking overrides the global Codex cloaking switch; nil
	// inherits it.
	DisableCodexCloaking    *bool `json:"disable-codex-cloaking,omitempty"`
	RebuildMidSystemMessage bool  `json:"rebuild-mid-system-message,omitempty"`

	extra wireExtras
	// origin is the v8 group this entry was read from, set only by
	// EditableConfigAPIKeys, so a write can return it to the group it came from.
	origin *keyGroupOrigin
	// runtimeBaseURL is the base URL the runtime list reported for this key,
	// which is what the console's edit form shows.
	runtimeBaseURL string
}

// SubmittedBaseURL is the base URL an edit stores when the form submitted
// submitted. The runtime fills in a family's default endpoint where the file
// has none, and the form shows that value; sending it back unchanged must not
// write the default into the file and move the key out of its group.
func (k ConfigAPIKey) SubmittedBaseURL(submitted string) string {
	if k.origin != nil && strings.TrimSpace(k.BaseURL) == "" && strings.TrimSpace(submitted) == strings.TrimSpace(k.runtimeBaseURL) {
		return ""
	}
	return submitted
}

// configAPIKeyFields is ConfigAPIKey without its JSON methods, so they can use
// the default encoding for the modelled fields without recursing.
type configAPIKeyFields ConfigAPIKey

var configAPIKeyModelledFields = modelledWireFields(reflect.TypeOf(configAPIKeyFields{}))

// UnmarshalJSON decodes the modelled fields and keeps every other field.
func (k *ConfigAPIKey) UnmarshalJSON(data []byte) error {
	var fields configAPIKeyFields
	extra, err := decodeWithExtras(data, &fields, configAPIKeyModelledFields)
	if err != nil {
		return err
	}
	*k = ConfigAPIKey(fields)
	k.extra = extra
	return nil
}

// MarshalJSON encodes the modelled fields and replays the unmodelled ones.
func (k ConfigAPIKey) MarshalJSON() ([]byte, error) {
	return encodeWithExtras(configAPIKeyFields(k), k.extra)
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
	if _, err := c.getV0JSON(ctx, family.configKeysEndpoint(), &response); err != nil {
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
