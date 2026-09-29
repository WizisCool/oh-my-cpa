package management

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"
)

// APIGeneration names a CPA Management API base path.
type APIGeneration string

const (
	// APIGenerationV8 is /v8/management, the API Oh My CPA is built on.
	APIGenerationV8 APIGeneration = "v8"
	// APIGenerationV0 is /v0/management. It is addressed only for the reads and
	// configuration writes the console has not moved to the v8 tree (see
	// client_v0.go); nothing else may use it.
	APIGenerationV0 APIGeneration = "v0"
)

// ErrManagementV8Required is returned, before any request is sent, by every
// operation against a gateway that has answered that it does not serve the v8
// Management API. A CPA older than v8 would otherwise answer 404 to every path,
// which reads as a scattering of "unsupported operation" errors rather than the
// one fact the operator has to act on.
var ErrManagementV8Required = errors.New("CPA does not serve the v8 Management API; Oh My CPA requires CPA v8.0.0 or later")

// ErrManagementDisabled is returned, before any request is sent, while the
// gateway serves no Management API at all. CPA answers 404 on every management
// path, v0 and v8 alike, until management.secret-key (or MANAGEMENT_PASSWORD) is
// set, so the missing v8 tree alone would misread a current gateway as one that
// needs an upgrade.
var ErrManagementDisabled = errors.New("CPA does not serve its Management API; set management.secret-key in the CPA configuration")

// ManagementAPIStatus is the gate's answer as the console shows it.
type ManagementAPIStatus string

const (
	ManagementAPIV8          ManagementAPIStatus = "v8"
	ManagementAPIUnsupported ManagementAPIStatus = "unsupported"
	// ManagementAPIDisabled means neither management tree answers: the gateway
	// has no management secret configured, so its version cannot be observed.
	ManagementAPIDisabled ManagementAPIStatus = "disabled"
	// ManagementAPIUnknown means the probe got no answer (unreachable, 401, 5xx).
	ManagementAPIUnknown ManagementAPIStatus = "unknown"
)

// MANAGEMENT_V8_PROBE_ENDPOINT is the read the gate is decided by.
//
// Support is observed, never inferred from a version string: builds, forks and
// release tags do not map reliably onto routes, while a route either answers or
// it does not. This field is always present in a v8 view of the configuration
// (GET never migrates the file, it renders it), it is a single small integer,
// and a gateway older than v8 answers 404 because the whole /v8 tree is
// unregistered.
const MANAGEMENT_V8_PROBE_ENDPOINT = "/config/config-version"

// MANAGEMENT_V0_PROBE_ENDPOINT tells the two reasons for a missing v8 tree apart.
// Every CPA generation registers it, so a 404 here means the gateway serves no
// management routes at all rather than an older route set.
const MANAGEMENT_V0_PROBE_ENDPOINT = "/debug"

// API_SUPPORT_TTL bounds how long a v8 answer is trusted. Gateways are replaced
// in place behind the same base URL, and a v8 route that answers "missing"
// invalidates the answer immediately, so the TTL only has to bound how late a
// rollback is noticed.
const API_SUPPORT_TTL = 5 * time.Minute

// API_UNSUPPORTED_TTL is shorter: a "not v8" answer blocks the whole console, and
// an operator who has just upgraded CPA should not wait minutes to see it lift.
// The console's health poll re-asks on this cadence.
const API_UNSUPPORTED_TTL = 15 * time.Second

// API_UNDECIDED_TTL is how long the gate stops re-probing after a probe got no
// answer. Requests are let through while undecided anyway, so probing each one
// would only double its latency against an unreachable gateway; the health
// poll, which does not consult this window, keeps re-asking on its own cadence.
const API_UNDECIDED_TTL = 15 * time.Second

type apiSupportEntry struct {
	status    ManagementAPIStatus
	expiresAt time.Time
}

// Clients are built per request, so the answer is kept per gateway: without it
// every usage-queue poll would pay a probe round trip.
var apiSupportCache = struct {
	sync.Mutex
	entries        map[string]apiSupportEntry
	undecidedUntil map[string]time.Time
}{entries: map[string]apiSupportEntry{}, undecidedUntil: map[string]time.Time{}}

// SupportsManagementV8 reports whether the gateway serves /v8/management.
func (c *Client) SupportsManagementV8(ctx context.Context) (bool, error) {
	status, err := c.managementStatus(ctx)
	return status == ManagementAPIV8, err
}

// managementStatus probes the gateway, or returns the cached answer.
//
// Only a definite answer is cached: the value 8 means v8, and a missing v8 tree
// means either an older gateway or, when the v0 tree is missing too, a disabled
// Management API. Anything else (unreachable, 401, 5xx) is returned as an error
// and not remembered as an answer, so one bad moment cannot block the console.
func (c *Client) managementStatus(ctx context.Context) (ManagementAPIStatus, error) {
	if c == nil {
		return ManagementAPIUnknown, errors.New("CPA client is not initialized")
	}
	if status, found := c.cachedManagementStatus(); found {
		return status, nil
	}
	status, err := c.probeManagementStatus(ctx)
	apiSupportCache.Lock()
	defer apiSupportCache.Unlock()
	if err != nil {
		apiSupportCache.undecidedUntil[c.baseURL] = time.Now().Add(API_UNDECIDED_TTL)
		return ManagementAPIUnknown, err
	}
	delete(apiSupportCache.undecidedUntil, c.baseURL)
	ttl := API_SUPPORT_TTL
	if status != ManagementAPIV8 {
		ttl = API_UNSUPPORTED_TTL
	}
	apiSupportCache.entries[c.baseURL] = apiSupportEntry{status: status, expiresAt: time.Now().Add(ttl)}
	return status, nil
}

func (c *Client) cachedManagementStatus() (ManagementAPIStatus, bool) {
	apiSupportCache.Lock()
	defer apiSupportCache.Unlock()
	entry, found := apiSupportCache.entries[c.baseURL]
	if !found || !time.Now().Before(entry.expiresAt) {
		return ManagementAPIUnknown, false
	}
	return entry.status, true
}

// probeManagementStatus sends the probes, which are the only requests that
// bypass the gate they decide.
func (c *Client) probeManagementStatus(ctx context.Context) (ManagementAPIStatus, error) {
	request, err := c.newRequestAt(ctx, http.MethodGet, APIGenerationV8, MANAGEMENT_V8_PROBE_ENDPOINT, nil, "")
	if err != nil {
		return ManagementAPIUnknown, err
	}
	data, _, err := c.sendBytes(request, 4*1024)
	if err == nil {
		// The value is checked, not just the status: a proxy or catch-all route that
		// answers 2xx to any path must not be mistaken for the v8 tree.
		var version int
		if json.Unmarshal(bytes.TrimSpace(data), &version) == nil && version == 8 {
			return ManagementAPIV8, nil
		}
		return ManagementAPIUnsupported, nil
	}
	if !IsMissingCapability(err) {
		return ManagementAPIUnknown, err
	}
	request, err = c.newRequestAt(ctx, http.MethodGet, APIGenerationV0, MANAGEMENT_V0_PROBE_ENDPOINT, nil, "")
	if err != nil {
		return ManagementAPIUnknown, err
	}
	// Any HTTP answer, a refusal included, proves the v0 tree is registered; only
	// the status matters, so the body is left unread.
	response, _, err := c.send(request)
	switch {
	case err == nil:
		response.Body.Close()
		return ManagementAPIUnsupported, nil
	case IsMissingCapability(err):
		return ManagementAPIDisabled, nil
	case errors.As(err, new(*HTTPError)):
		return ManagementAPIUnsupported, nil
	default:
		return ManagementAPIUnknown, err
	}
}

// ManagementAPI folds the gate's answer into the status the console renders.
func (c *Client) ManagementAPI(ctx context.Context) ManagementAPIStatus {
	status, err := c.managementStatus(ctx)
	if err != nil {
		return ManagementAPIUnknown
	}
	return status
}

// requireManagementV8 is the gate every management request passes. An undecided
// probe lets the request through: it will fail on its own with the error that
// actually describes the problem (unreachable, wrong key), which is more useful
// than a guess about the version. Within API_UNDECIDED_TTL of such a probe the
// gate does not probe again.
func (c *Client) requireManagementV8(ctx context.Context) error {
	if c.isManagementUndecided() {
		return nil
	}
	status, err := c.managementStatus(ctx)
	if err != nil {
		return nil
	}
	switch status {
	case ManagementAPIUnsupported:
		return ErrManagementV8Required
	case ManagementAPIDisabled:
		return ErrManagementDisabled
	default:
		return nil
	}
}

func (c *Client) isManagementUndecided() bool {
	apiSupportCache.Lock()
	defer apiSupportCache.Unlock()
	if entry, found := apiSupportCache.entries[c.baseURL]; found && time.Now().Before(entry.expiresAt) {
		return false
	}
	until, found := apiSupportCache.undecidedUntil[c.baseURL]
	return found && time.Now().Before(until)
}

// forgetManagementV8 drops the cached answer after a v8 route answered
// "missing", so a gateway rolled back behind the same URL is re-probed on the
// next call instead of producing unsupported-operation errors until the TTL.
func (c *Client) forgetManagementV8() {
	apiSupportCache.Lock()
	defer apiSupportCache.Unlock()
	delete(apiSupportCache.entries, c.baseURL)
	delete(apiSupportCache.undecidedUntil, c.baseURL)
}
