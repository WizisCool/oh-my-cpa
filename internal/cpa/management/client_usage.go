package management

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// APIKeyUsage returns recent request buckets grouped by provider and opaque
// composite key. The overview aggregation only exposes provider-level totals;
// composite keys never leave the Go process.
type APIKeyUsageResponse map[string]map[string]APIKeyUsageEntry

type APIKeyUsageEntry struct {
	Success        int64           `json:"success"`
	Failed         int64           `json:"failed"`
	RecentRequests []RecentRequest `json:"recent_requests"`
}

type RecentRequest struct {
	Time    string `json:"time"`
	Success int64  `json:"success"`
	Failed  int64  `json:"failed"`
}

func (c *Client) APIKeyUsage(ctx context.Context) (APIKeyUsageResponse, ResponseMeta, error) {
	var response APIKeyUsageResponse
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/api-key-usage", &response)
	if err != nil {
		return nil, meta, err
	}
	if response == nil {
		response = APIKeyUsageResponse{}
	}
	return response, meta, nil
}

// UsageQueue pops up to count usage records from CPA's redis-backed usage
// queue. Records are single-request accounting events (tokens, latency, model)
// captured when CPA's `usage-statistics-enabled` is on. The queue is
// destructive on CPA side: each successful pop removes the records.
func (c *Client) UsageQueue(ctx context.Context, count int) ([]json.RawMessage, ResponseMeta, error) {
	if count <= 0 {
		count = 1
	}
	endpoint := fmt.Sprintf("/usage-queue?count=%d", count)
	var response []json.RawMessage
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, endpoint, &response)
	if err != nil {
		return nil, meta, err
	}
	if response == nil {
		response = []json.RawMessage{}
	}
	return response, meta, nil
}
