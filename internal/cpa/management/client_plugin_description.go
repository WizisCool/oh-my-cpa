package management

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (c *Client) PluginDescription(ctx context.Context, id string) ([]byte, error) {
	if id == "" || strings.ContainsAny(id, "/\\") {
		return nil, ErrPluginHostPath
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := c.requireManagementV8(ctx); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+PluginResourcePrefix+url.PathEscape(id)+"/omc.json", nil)
	if err != nil {
		return nil, err
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("runtime plugin description unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 64*1024 {
		return nil, errors.New("runtime plugin description too large")
	}
	return data, nil
}
