package management

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// APIGeneration names a CPA Management API base path.
type APIGeneration string

const (
	// APIGenerationV0 is /v0/management, served by every CPA release, v8 included.
	APIGenerationV0 APIGeneration = "v0"
	// APIGenerationV8 is /v8/management, introduced by CPA v8.0.0.
	APIGenerationV8 APIGeneration = "v8"
)

// MANAGEMENT_V8_PROBE_ENDPOINT is the read the v8 capability is decided by.
//
// Support is observed, never inferred from a version string: builds, forks and
// release tags do not map reliably onto routes, while a route either answers or
// it does not. This field is always present in a v8 view of the configuration
// (GET never migrates the file, it renders it), it is a single small integer,
// and a v7 gateway answers 404 because the whole /v8 tree is unregistered.
const MANAGEMENT_V8_PROBE_ENDPOINT = "/config/config-version"

// API_SUPPORT_TTL bounds how long a probe answer is trusted. Gateways are
// upgraded and rolled back in place behind the same base URL, and a v8 route
// that answers 404 invalidates the answer immediately, so the TTL only has to
// bound how late an upgrade is noticed.
const API_SUPPORT_TTL = 5 * time.Minute

type apiSupportEntry struct {
	hasV8     bool
	expiresAt time.Time
}

// Clients are built per request, so the answer is kept per gateway: without it
// every usage-queue poll would pay a probe round trip.
var apiSupportCache = struct {
	sync.Mutex
	entries map[string]apiSupportEntry
}{entries: map[string]apiSupportEntry{}}

// SupportsManagementV8 reports whether the gateway serves /v8/management.
//
// Only a definite answer is cached: the value 8 means supported, a
// missing-capability status or any other body means not. Anything else (unreachable, 401, 5xx) is returned as an
// error and not remembered, so one bad moment cannot pin a gateway to v0.
func (c *Client) SupportsManagementV8(ctx context.Context) (bool, error) {
	if c == nil {
		return false, errors.New("CPA client is not initialized")
	}
	apiSupportCache.Lock()
	entry, found := apiSupportCache.entries[c.baseURL]
	apiSupportCache.Unlock()
	if found && time.Now().Before(entry.expiresAt) {
		return entry.hasV8, nil
	}
	request, err := c.newRequestAt(ctx, http.MethodGet, APIGenerationV8, MANAGEMENT_V8_PROBE_ENDPOINT, nil, "")
	if err != nil {
		return false, err
	}
	data, _, err := c.doBytes(request, 4*1024)
	if err != nil && !IsMissingCapability(err) {
		return false, err
	}
	// The value is checked, not just the status: a proxy or catch-all route that
	// answers 2xx to any path must not be mistaken for the v8 tree.
	var version int
	hasV8 := err == nil && json.Unmarshal(bytes.TrimSpace(data), &version) == nil && version == 8
	c.rememberManagementV8(hasV8)
	return hasV8, nil
}

// PreferredAPIGeneration is SupportsManagementV8 folded to the base path an
// operation should try first; an undecided probe prefers v0, which every
// gateway serves.
func (c *Client) PreferredAPIGeneration(ctx context.Context) APIGeneration {
	if hasV8, err := c.SupportsManagementV8(ctx); err == nil && hasV8 {
		return APIGenerationV8
	}
	return APIGenerationV0
}

func (c *Client) rememberManagementV8(hasV8 bool) {
	apiSupportCache.Lock()
	defer apiSupportCache.Unlock()
	apiSupportCache.entries[c.baseURL] = apiSupportEntry{hasV8: hasV8, expiresAt: time.Now().Add(API_SUPPORT_TTL)}
}

func (c *Client) forgetManagementV8() {
	apiSupportCache.Lock()
	defer apiSupportCache.Unlock()
	delete(apiSupportCache.entries, c.baseURL)
}

// Operation names a management operation that both API generations serve with
// the same CPA handler, and therefore the same request and response bodies.
type Operation string

const (
	OperationUsageQueue    Operation = "usage_queue"
	OperationAPIKeyUsage   Operation = "api_key_usage"
	OperationLogs          Operation = "logs"
	OperationErrorLogs     Operation = "error_logs"
	OperationRequestLog    Operation = "request_log"
	OperationAPICall       Operation = "api_call"
	OperationCooldownReset Operation = "cooldown_reset"
	OperationLatestVersion Operation = "latest_version"
)

// OperationRoute is one operation's path under each API generation.
type OperationRoute struct {
	V0 string
	V8 string
}

// OPERATION_ROUTES maps each operation to its grouped v8 route and its v0 route.
//
// Only operations whose v8 route is registered on the very same CPA handler as
// the v0 one belong here (CPA v8.0.2 internal/api/server_management_v8.go), so
// switching generations can never change a payload. Configuration writes are
// deliberately absent: a v8 configuration write migrates and rewrites the whole
// file, which OMC never does on the operator's behalf.
var OPERATION_ROUTES = map[Operation]OperationRoute{
	OperationUsageQueue:    {V0: "/usage-queue", V8: "/observability/usage/queue"},
	OperationAPIKeyUsage:   {V0: "/api-key-usage", V8: "/observability/usage/api-keys"},
	OperationLogs:          {V0: "/logs", V8: "/observability/logs"},
	OperationErrorLogs:     {V0: "/request-error-logs", V8: "/observability/logs/errors"},
	OperationRequestLog:    {V0: "/request-log-by-id", V8: "/observability/logs/requests"},
	OperationAPICall:       {V0: "/api-call", V8: "/requests/api-call"},
	OperationCooldownReset: {V0: "/reset-quota", V8: "/routing/cooldown/reset"},
	OperationLatestVersion: {V0: "/latest-version", V8: "/server/latest-version"},
}

// operationCall is one operation request, rebuilt for each generation it tries.
type operationCall struct {
	operation   Operation
	method      string
	suffix      string // appended to the route: "/<id>" or "?query"
	body        []byte
	contentType string
}

// doOperation sends the call to the preferred generation and falls back to v0
// when the v8 route is missing.
//
// A retry is safe because a missing route never reaches a handler, so nothing
// was consumed or reset. A handler's own 404 (an unknown request id) is retried
// too and answers the same way on v0; that costs a request, not a wrong answer.
func (c *Client) doOperation(ctx context.Context, call operationCall, output any) (ResponseMeta, error) {
	var meta ResponseMeta
	err := c.eachOperationAttempt(ctx, call, func(request *http.Request) error {
		var errDo error
		meta, errDo = c.do(request, output)
		return errDo
	})
	return meta, err
}

// doOperationJSON is doOperation with a JSON request body.
func (c *Client) doOperationJSON(ctx context.Context, operation Operation, method string, payload any, output any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode CPA request: %w", err)
	}
	_, err = c.doOperation(ctx, operationCall{operation: operation, method: method, body: data, contentType: "application/json"}, output)
	return err
}

// doOperationBytes is doOperation for downloads.
func (c *Client) doOperationBytes(ctx context.Context, call operationCall, maxBytes int64) ([]byte, ResponseMeta, error) {
	var (
		data []byte
		meta ResponseMeta
	)
	err := c.eachOperationAttempt(ctx, call, func(request *http.Request) error {
		var errDo error
		data, meta, errDo = c.doBytes(request, maxBytes)
		return errDo
	})
	return data, meta, err
}

func (c *Client) eachOperationAttempt(ctx context.Context, call operationCall, send func(*http.Request) error) error {
	route, found := OPERATION_ROUTES[call.operation]
	if !found {
		return errors.New("unknown management operation")
	}
	generations := []APIGeneration{APIGenerationV0}
	if c.PreferredAPIGeneration(ctx) == APIGenerationV8 {
		generations = []APIGeneration{APIGenerationV8, APIGenerationV0}
	}
	var err error
	for _, generation := range generations {
		endpoint := route.V0
		if generation == APIGenerationV8 {
			endpoint = route.V8
		}
		var body io.Reader
		if call.body != nil {
			body = bytes.NewReader(call.body)
		}
		request, errRequest := c.newRequestAt(ctx, call.method, generation, endpoint+call.suffix, body, call.contentType)
		if errRequest != nil {
			return errRequest
		}
		err = send(request)
		if err == nil || generation != APIGenerationV8 || !IsMissingCapability(err) {
			return err
		}
		// Re-probe on the next call: the gateway may have been replaced by one
		// without the v8 routes, and the probe is what decides that.
		c.forgetManagementV8()
	}
	return err
}
