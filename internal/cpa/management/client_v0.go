package management

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
)

// The /v0/management routes below are the ones this client still addresses on a
// v8 gateway, which serves the whole v0 tree unchanged. Everything else uses
// /v8/management, and a gateway without it is refused by the gate before any
// request is sent, v0 ones included.
//
// Two groups remain, for different reasons:
//
//   - Reads v8 does not offer. Only the v0 per-family credential lists
//     (`/<family>-api-key`, `/openai-compatibility`) carry each upstream key's
//     `auth-index`, the identifier usage attribution, quota and key disablement
//     are keyed by; the v8 configuration view is the stored document and has no
//     runtime fields.
//   - Configuration reads and writes the console has not moved to the v8
//     configuration tree yet (the editor, client keys, provider credentials,
//     OAuth model aliases and exclusions, per-plugin settings). A v8
//     configuration write migrates the stored file, so each moves together with
//     the editor that owns it.

// doV0JSON sends one gated request to /v0/management. A nil payload sends no
// body; a nil output discards the answer.
func (c *Client) doV0JSON(ctx context.Context, method, endpoint string, payload any, output any) (ResponseMeta, error) {
	var body io.Reader
	contentType := ""
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return ResponseMeta{}, fmt.Errorf("encode CPA request: %w", err)
		}
		body = bytes.NewReader(data)
		contentType = "application/json"
	}
	request, err := c.newRequestAt(ctx, method, APIGenerationV0, endpoint, body, contentType)
	if err != nil {
		return ResponseMeta{}, err
	}
	return c.do(request, output)
}

// doV0Body sends a raw body (a YAML document) to /v0/management.
func (c *Client) doV0Body(ctx context.Context, method, endpoint string, data []byte, contentType string) error {
	request, err := c.newRequestAt(ctx, method, APIGenerationV0, endpoint, bytes.NewReader(data), contentType)
	if err != nil {
		return err
	}
	_, err = c.do(request, nil)
	return err
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
