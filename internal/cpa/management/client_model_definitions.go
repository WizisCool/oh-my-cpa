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

// OAuthChannelModelDefinitions reads the catalog CPA serves an OAuth channel
// from, for editors that pick model IDs. The channel is checked against the
// ones CPA's registry answers before it reaches the path; anything else, and a
// gateway that does not know the channel, reads as "no catalog" rather than as
// a failure, because rules for such a provider are still typed by hand.
func (c *Client) OAuthChannelModelDefinitions(ctx context.Context, channel string) ([]AuthModel, bool, error) {
	switch channel {
	case "claude", "gemini", "vertex", "aistudio", "codex", "kimi", "antigravity", "xai", "devin", "meta":
	default:
		return []AuthModel{}, false, nil
	}
	var response struct {
		Models []AuthModel `json:"models"`
	}
	if err := c.DoJSON(ctx, http.MethodGet, "/routing/model-definitions/"+channel, &response); err != nil {
		var httpErr *HTTPError
		if errors.As(err, &httpErr) && (httpErr.StatusCode == http.StatusBadRequest || httpErr.StatusCode == http.StatusNotFound) {
			return []AuthModel{}, false, nil
		}
		return nil, false, err
	}
	if response.Models == nil {
		response.Models = []AuthModel{}
	}
	return response.Models, true, nil
}
