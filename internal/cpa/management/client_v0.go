package management

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
)

// The /v0/management routes below are the ones this client still addresses on a
// v8 gateway, which serves the whole v0 tree unchanged. Everything else uses
// /v8/management, and a gateway without it is refused by the gate before any
// request is sent, v0 ones included. Every one of them is a read, for one of
// two reasons:
//
//   - Applied runtime configuration, fingerprinted to observe asynchronous hot reloads.
//   - Runtime fields v8 does not offer. Only the v0 per-family credential lists
//     (`/<family>-api-key`, `/openai-compatibility`) carry each upstream key's
//     `auth-index`, the identifier usage attribution, quota and key disablement
//     are keyed by; the v8 configuration view is the stored document and has no
//     runtime fields.
//   - The stored configuration file itself. `/v8/management/config.yaml` is a
//     v8 rendering of it; only `/v0/management/config.yaml` returns the file as
//     stored, which is what is kept before the first v8 write rewrites it.

// getV0JSON reads one gated JSON document from /v0/management.
func (c *Client) getV0JSON(ctx context.Context, endpoint string, output any) (ResponseMeta, error) {
	request, err := c.newRequestAt(ctx, http.MethodGet, APIGenerationV0, endpoint, nil, "")
	if err != nil {
		return ResponseMeta{}, err
	}
	return c.do(request, output)
}

// doV0Bytes reads a raw body (a YAML document) from /v0/management.
func (c *Client) doV0Bytes(ctx context.Context, method, endpoint string, maxBytes int64) ([]byte, error) {
	request, err := c.newRequestAt(ctx, method, APIGenerationV0, endpoint, nil, "")
	if err != nil {
		return nil, err
	}
	data, _, err := c.doBytes(request, maxBytes)
	return data, err
}

// StoredConfigYAML returns the configuration file exactly as CPA stores it.
func (c *Client) StoredConfigYAML(ctx context.Context) (string, error) {
	if c == nil {
		return "", errors.New("CPA client is not initialized")
	}
	data, err := c.doV0Bytes(ctx, http.MethodGet, "/config.yaml", CONFIG_YAML_LIMIT)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// RuntimeConfigRevision fingerprints CPA's applied configuration independently
// from its persisted YAML. File saves can precede the asynchronous hot reload.
// Only the digest escapes this method; the secret-bearing payload is not cached.
func (c *Client) RuntimeConfigRevision(ctx context.Context) (string, error) {
	if c == nil {
		return "", errors.New("CPA client is not initialized")
	}
	data, err := c.doV0Bytes(ctx, http.MethodGet, "/config", CONFIG_YAML_LIMIT)
	if err != nil {
		if IsMissingCapability(err) {
			return "", nil
		}
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return "", errors.New("decode CPA runtime configuration")
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return "", errors.New("fingerprint CPA runtime configuration")
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}
