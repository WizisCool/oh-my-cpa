package updater

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DEFAULT_URL is where the console looks for its updater: the name both the installed
// sidecar and the Compose service answer to.
const DEFAULT_URL = "http://" + SIDECAR_NAME + DEFAULT_LISTEN_ADDR

// ErrUnreachable means no updater answered: none is installed, or it is stopped.
var ErrUnreachable = errors.New("the updater is not reachable")

// RefusedError is an answer the updater gave instead of doing what was asked.
type RefusedError struct {
	Status  int
	Code    string
	Message string
}

func (e *RefusedError) Error() string { return "the updater refused: " + e.Message }

// Status is read while the System Information page waits, so an absent updater must
// read as absent rather than as a slow page. Admitting an update resolves the deployment
// from the daemon several times before it answers, and a job keeps running if the
// console stops waiting, so a short limit there would report an admitted job as failed.
const (
	statusTimeout = 5 * time.Second
	updateTimeout = 60 * time.Second
)

// Client is the console's side of the control interface.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

// NewClient builds a client for the updater at baseURL, authenticated with the token
// derived from the console's master key.
func NewClient(baseURL, masterKey string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:      ControlToken(masterKey),
		httpClient: &http.Client{},
	}
}

func (c *Client) call(parent context.Context, timeout time.Duration, method, path string, body, into any) error {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		// The caller's own cancellation is reported as such; running out of this call's
		// time means the updater did not answer.
		if parent.Err() != nil {
			return parent.Err()
		}
		return fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	if response.StatusCode >= 400 {
		refusal := &RefusedError{Status: response.StatusCode}
		var decoded struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &decoded)
		refusal.Code, refusal.Message = decoded.Code, decoded.Message
		if refusal.Message == "" {
			refusal.Message = fmt.Sprintf("status %d", response.StatusCode)
		}
		return refusal
	}
	return json.Unmarshal(raw, into)
}

// Status reads the updater's view of the deployment and its most recent job.
func (c *Client) Status(ctx context.Context) (StatusResponse, error) {
	var status StatusResponse
	err := c.call(ctx, statusTimeout, http.MethodGet, "/v1/status", nil, &status)
	return status, err
}

// Update asks for one product to be replaced and returns the admitted job.
func (c *Client) Update(ctx context.Context, request UpdateRequest) (Job, error) {
	var job Job
	err := c.call(ctx, updateTimeout, http.MethodPost, "/v1/update", request, &job)
	return job, err
}
