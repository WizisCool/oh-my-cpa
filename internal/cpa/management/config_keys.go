package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// ConfigKeyFamily names one of CPA's `{family}-api-key` credential lists.
//
// Every family shares one entry schema and one write shape (GET the list, PUT
// the whole list back), so the console treats them uniformly: the family is a
// value, not a code path. Adding a provider whose credentials CPA stores this
// way means adding a constant here and a presentation row in the API layer.
type ConfigKeyFamily string

const (
	ConfigFamilyClaude ConfigKeyFamily = "claude"
	ConfigFamilyCodex  ConfigKeyFamily = "codex"
	ConfigFamilyGemini ConfigKeyFamily = "gemini"
	ConfigFamilyMeta   ConfigKeyFamily = "meta"
)

// ConfigAPIKey is the credential entry CPA uses across every config API-key
// family.
//
// CPA declares these as separate structs (ClaudeKey, CodexKey, GeminiKey,
// MetaKey) that are field-for-field identical - MetaKey is in fact an alias of
// CodexKey upstream. Mirroring that duplication here would mean four copies of
// every read, write and merge path that must stay in lockstep, with no type
// safety gained, because the wire shape is the only thing that matters.
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
	if err := c.DoJSON(ctx, http.MethodGet, family.configKeysEndpoint(), &response); err != nil {
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
	return c.doJSONBody(ctx, http.MethodPut, family.configKeysEndpoint(), entries, nil)
}
