package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type PluginMetadata struct {
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
	Author  string `json:"author,omitempty"`
	Logo    string `json:"logo,omitempty"`
}

type PluginItem struct {
	ID               string          `json:"id"`
	Name             string          `json:"name"`
	Path             string          `json:"path,omitempty"`
	Description      string          `json:"description,omitempty"`
	Version          string          `json:"version,omitempty"`
	Author           string          `json:"author,omitempty"`
	Enabled          bool            `json:"enabled"`
	EffectiveEnabled *bool           `json:"effective_enabled,omitempty"`
	Configured       bool            `json:"configured,omitempty"`
	Registered       bool            `json:"registered,omitempty"`
	SupportsOAuth    bool            `json:"supports_oauth,omitempty"`
	OAuthProvider    string          `json:"oauth_provider,omitempty"`
	Logo             string          `json:"logo,omitempty"`
	Permissions      []string        `json:"permissions,omitempty"`
	Config           map[string]any  `json:"config,omitempty"`
	Metadata         *PluginMetadata `json:"metadata,omitempty"`
}

type StorePluginItem struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Version     string   `json:"version,omitempty"`
	Author      string   `json:"author,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
	Installed   bool     `json:"installed"`
}

func (c *Client) Plugins(ctx context.Context) ([]PluginItem, error) {
	var raw json.RawMessage
	if err := c.DoJSON(ctx, http.MethodGet, "/plugins", &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return []PluginItem{}, nil
	}
	var list []PluginItem
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil
	}
	var obj struct {
		Plugins []PluginItem `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		return obj.Plugins, nil
	}
	return []PluginItem{}, nil
}

func (c *Client) SetPluginStatus(ctx context.Context, id string, enabled bool) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("plugin id is required")
	}
	endpoint := fmt.Sprintf("/plugins/%s/status", url.PathEscape(id))
	payload := map[string]any{"enabled": enabled}
	return c.doJSONBody(ctx, http.MethodPost, endpoint, payload, nil)
}

func (c *Client) DeletePlugin(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("plugin id is required")
	}
	endpoint := fmt.Sprintf("/plugins/%s", url.PathEscape(id))
	return c.DoJSON(ctx, http.MethodDelete, endpoint, nil)
}

func (c *Client) SetPluginConfig(ctx context.Context, id string, config map[string]any) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("plugin id is required")
	}
	endpoint := fmt.Sprintf("/plugins/%s/config", url.PathEscape(id))
	return c.doJSONBody(ctx, http.MethodPut, endpoint, config, nil)
}

func (c *Client) PluginStore(ctx context.Context) ([]StorePluginItem, error) {
	var raw json.RawMessage
	if err := c.DoJSON(ctx, http.MethodGet, "/plugin-store", &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return []StorePluginItem{}, nil
	}
	var list []StorePluginItem
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil
	}
	var obj struct {
		Plugins []StorePluginItem `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		return obj.Plugins, nil
	}
	return []StorePluginItem{}, nil
}

func (c *Client) InstallPlugin(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("plugin id is required")
	}
	endpoint := fmt.Sprintf("/plugin-store/%s/install", url.PathEscape(id))
	return c.doJSONBody(ctx, http.MethodPost, endpoint, map[string]any{}, nil)
}
