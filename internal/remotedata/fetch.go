// Package remotedata bounds downloads of public reference data. Domain packages
// own decoding and publication; no caller credentials travel with these requests.
package remotedata

import (
	"context"
	"fmt"
	"io"
	"net/http"
)

func Fetch(ctx context.Context, client *http.Client, endpoint, userAgent string, maxBytes int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", userAgent)
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download reference data: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("reference data HTTP status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read reference data: %w", err)
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("reference data exceeds size limit")
	}
	return body, nil
}
