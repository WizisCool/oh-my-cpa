package management

import (
	"context"
	"errors"
	"net/http"
)

// StaticModelDefinitions is fixed to CPA's own catalog channels. It never turns
// a channel or a model label supplied by a reader into an arbitrary upstream URL.
func (c *Client) StaticModelDefinitions(ctx context.Context, channel string) ([]AuthModel, error) {
	switch channel {
	case "codex", "claude", "gemini", "xai", "meta", "vertex", "interactions":
	default:
		return nil, errors.New("unsupported model definition channel")
	}
	var response struct {
		Models []AuthModel `json:"models"`
	}
	if err := c.DoJSON(ctx, http.MethodGet, "/routing/model-definitions/"+channel, &response); err != nil {
		return nil, err
	}
	if response.Models == nil {
		response.Models = []AuthModel{}
	}
	return response.Models, nil
}
