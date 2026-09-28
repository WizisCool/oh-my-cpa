// Package gateway exposes only the two inference operations used by the playground.
package gateway

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"regexp"
	"strings"

	_ "golang.org/x/image/webp"
)

const (
	// DefaultUserAgent is the fallback product token when a deployment supplies no
	// version of its own. It names the product and a version in the `Product/Version`
	// form clients conventionally parse.
	DefaultUserAgent    = "Oh-My-CPA/0.1.0"
	MaxUserAgentBytes   = 512
	MaxRequestBytes     = 32 << 20
	MaxImageBytes       = 5 << 20
	MaxImagesPerMessage = 4
	MaxResponseBytes    = 8 << 20
)

// UserAgentForVersion builds the default User-Agent for a deployment.
//
// The version comes from the running build rather than a constant here, so the header a
// gateway sees names the build that actually sent it, and a `v0.1.0-dev` or `-demo`
// suffix is preserved rather than rewritten into a release number the build is not.
//
// The result must be a valid product token, not merely printable text: a User-Agent is
// parsed as `product/version` pairs, so a version carrying a space or a separator would
// produce a header a client cannot read back. A version that is not a token falls back to
// the product default instead of being silently mangled into one, because a rewritten
// version would name a build that does not exist.
func UserAgentForVersion(version string) string {
	// A leading `v` is a tag spelling, not part of the version token clients parse.
	token := strings.TrimPrefix(strings.TrimSpace(version), "v")
	if !versionTokenPattern.MatchString(token) {
		return DefaultUserAgent
	}
	return "Oh-My-CPA/" + token
}

// versionTokenPattern is the permissive-but-token-safe shape a version may take: an
// alphanumeric first character, then alphanumerics and the separators versions actually use.
// It deliberately excludes whitespace, control characters, `/` (which would forge a second
// product pair) and every other character a User-Agent parser treats specially.
var versionTokenPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]*$`)

func isPrintableASCII(value string) bool {
	for _, char := range value {
		if char < 32 || char > 126 {
			return false
		}
	}
	return true
}

type ImageURL struct {
	URL string `json:"url"`
}
type Content struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *ImageURL `json:"image_url,omitempty"`
}
type Message struct {
	Role    string    `json:"role"`
	Content []Content `json:"content"`
}
type ChatRequest struct {
	Model           string          `json:"model"`
	Messages        []Message       `json:"messages"`
	Temperature     *float64        `json:"temperature,omitempty"`
	TopP            *float64        `json:"top_p,omitempty"`
	MaxTokens       *int            `json:"max_tokens,omitempty"`
	ReasoningEffort *string         `json:"reasoning_effort,omitempty"`
	UserAgent       string          `json:"user_agent,omitempty"`
	CustomBody      json.RawMessage `json:"custom_body,omitempty"`
	Stream          bool            `json:"stream"`
	StreamOptions   struct {
		IncludeUsage bool `json:"include_usage"`
	} `json:"stream_options"`
}
type Model struct {
	// ID is the OpenAI-compatible identifier. CPA advertises client-visible
	// call points under this field, so CallPoint is an explicit alias for the
	// surface that must select by call point rather than by an upstream name.
	ID        string `json:"id"`
	CallPoint string `json:"call_point"`
	Vision    string `json:"vision"`
}
type Usage struct {
	PromptTokens     *int64 `json:"prompt_tokens,omitempty"`
	CompletionTokens *int64 `json:"completion_tokens,omitempty"`
	TotalTokens      *int64 `json:"total_tokens,omitempty"`
}
type Event struct {
	FirstContentMS *int64 `json:"first_content_ms,omitempty"`
	DurationMS     *int64 `json:"duration_ms,omitempty"`
	Type           string `json:"-"`
	Content        string `json:"content,omitempty"`
	Usage          *Usage `json:"usage,omitempty"`
	FinishReason   string `json:"finish_reason,omitempty"`
	Code           string `json:"code,omitempty"`
	UpstreamStatus int    `json:"upstream_status,omitempty"`
	Parameter      string `json:"parameter,omitempty"`
	RequestID      string `json:"request_id,omitempty"`
}
type Error struct {
	Code      string
	Status    int
	Parameter string
	// RequestID is CPA's id for a rejected request, when it got far enough to be given one.
	RequestID string
}

func (failure *Error) Error() string { return failure.Code }

// BuildPayload composes the exact JSON body sent upstream: this console's own fields
// first, then `custom_body` last so an operator's override wins every collision.
//
// The result is a map rather than a typed struct because `custom_body` exists precisely
// to carry upstream parameters this console does not model, and decoding it into
// ChatRequest would silently drop them.
func BuildPayload(request ChatRequest) (map[string]any, error) {
	payload := map[string]any{
		"model":          request.Model,
		"messages":       request.Messages,
		"stream":         true,
		"stream_options": map[string]any{"include_usage": true},
	}
	if request.Temperature != nil {
		payload["temperature"] = *request.Temperature
	}
	if request.TopP != nil {
		payload["top_p"] = *request.TopP
	}
	if request.MaxTokens != nil {
		payload["max_tokens"] = *request.MaxTokens
	}
	if request.ReasoningEffort != nil {
		payload["reasoning_effort"] = *request.ReasoningEffort
	}
	if len(request.CustomBody) > 0 && string(request.CustomBody) != "null" {
		var custom map[string]any
		if err := json.Unmarshal(request.CustomBody, &custom); err != nil {
			return nil, &Error{Code: "invalid_parameters"}
		}
		for key, value := range custom {
			payload[key] = value
		}
	}
	return payload, nil
}

// ValidatePayload validates the body that will actually be sent, plus the resolved
// User-Agent header that travels beside it, and not the typed request they were composed
// from.
//
// The distinction is the whole point: `custom_body` is merged last and can replace
// `messages`, so validating only ChatRequest would let an override carry content that
// never passed the image checks - and those checks are the reason an inline data URL is
// the only accepted image form. The same merge that lets an override win therefore has to
// be validated after it wins.
//
// The User-Agent is a parameter rather than a payload field because it is not one: it is
// a transport header, so it cannot be read back out of the body and has to be handed in.
//
// Message content is normalised to the array form for validation only. Both forms are
// valid upstream, and only the array form can carry an image, so a string-content message
// has nothing for the image checks to examine and must not be rejected as malformed.
func ValidatePayload(payload map[string]any, userAgent string) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return errors.New("invalid_request")
	}
	var shape struct {
		Model           string            `json:"model"`
		Messages        []json.RawMessage `json:"messages"`
		Temperature     *float64          `json:"temperature"`
		TopP            *float64          `json:"top_p"`
		MaxTokens       *int              `json:"max_tokens"`
		ReasoningEffort *string           `json:"reasoning_effort"`
		Stream          *bool             `json:"stream"`
	}
	if err := json.Unmarshal(encoded, &shape); err != nil {
		return errors.New("invalid_request")
	}
	// This route answers in SSE and projects allowlisted events, so it cannot serve a
	// non-streamed body. Rejected by name rather than left to fail later as an
	// unreadable upstream response.
	if shape.Stream != nil && !*shape.Stream {
		return &Error{Code: "unsupported_parameter", Parameter: "stream"}
	}
	request := ChatRequest{
		Model:           shape.Model,
		Temperature:     shape.Temperature,
		TopP:            shape.TopP,
		MaxTokens:       shape.MaxTokens,
		ReasoningEffort: shape.ReasoningEffort,
		UserAgent:       userAgent,
	}
	for _, raw := range shape.Messages {
		message, err := normalizeMessage(raw)
		if err != nil {
			return err
		}
		request.Messages = append(request.Messages, message)
	}
	return Validate(request)
}

// normalizeMessage accepts both content forms the upstream schema defines and returns the
// array form the console's own validation is written against.
func normalizeMessage(raw json.RawMessage) (Message, error) {
	var envelope struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return Message{}, errors.New("invalid_request")
	}
	var text string
	if json.Unmarshal(envelope.Content, &text) == nil {
		return Message{Role: envelope.Role, Content: []Content{{Type: "text", Text: text}}}, nil
	}
	var parts []Content
	if err := json.Unmarshal(envelope.Content, &parts); err != nil {
		return Message{}, errors.New("invalid_request")
	}
	return Message{Role: envelope.Role, Content: parts}, nil
}

// Validation precedes credential resolution and any paid request. Images are checked
// without decoding pixels, so a small compressed file cannot allocate a giant bitmap.
func Validate(request ChatRequest) error {
	if strings.TrimSpace(request.Model) == "" || len(request.Model) > 512 || len(request.Messages) == 0 || len(request.Messages) > 256 {
		return errors.New("invalid_request")
	}
	if request.Temperature != nil && (!isFinite(*request.Temperature) || *request.Temperature < 0 || *request.Temperature > 2) {
		return errors.New("invalid_parameters")
	}
	if request.TopP != nil && (!isFinite(*request.TopP) || *request.TopP < 0 || *request.TopP > 1) {
		return errors.New("invalid_parameters")
	}
	if request.MaxTokens != nil && (*request.MaxTokens < 1 || *request.MaxTokens > 2147483647) {
		return errors.New("invalid_parameters")
	}
	if request.ReasoningEffort != nil {
		trimmed := strings.TrimSpace(*request.ReasoningEffort)
		if trimmed == "" || len(trimmed) > 64 {
			return errors.New("invalid_parameters")
		}
		if !isPrintableASCII(trimmed) {
			return errors.New("invalid_parameters")
		}
	}
	// A User-Agent is a header value, so a CR or LF in it is a request-splitting
	// attempt. net/http refuses such a value and the send fails, but that surfaced as
	// `gateway_unavailable`, which reads like an outage rather than a bad parameter.
	if userAgent := strings.TrimSpace(request.UserAgent); userAgent != "" {
		if len(userAgent) > MaxUserAgentBytes || !isPrintableASCII(userAgent) {
			return &Error{Code: "invalid_parameters", Parameter: "user_agent"}
		}
	}
	if len(request.CustomBody) > 0 && string(request.CustomBody) != "null" {
		var customPayload map[string]any
		if err := json.Unmarshal(request.CustomBody, &customPayload); err != nil {
			return errors.New("invalid_parameters")
		}
	}
	for position, message := range request.Messages {
		if message.Role != "user" && message.Role != "assistant" && !(position == 0 && message.Role == "system") {
			return errors.New("invalid_request")
		}
		if len(message.Content) == 0 || len(message.Content) > 64 {
			return errors.New("invalid_request")
		}
		imageCount := 0
		for _, part := range message.Content {
			switch part.Type {
			case "text":
				if part.ImageURL != nil || strings.TrimSpace(part.Text) == "" {
					return errors.New("invalid_request")
				}
			case "image_url":
				imageCount++
				if message.Role != "user" || imageCount > MaxImagesPerMessage || part.ImageURL == nil || part.Text != "" {
					return errors.New("invalid_image")
				}
				if err := validateImage(part.ImageURL.URL); err != nil {
					return err
				}
			default:
				return errors.New("invalid_request")
			}
		}
	}
	if request.Messages[len(request.Messages)-1].Role != "user" {
		return errors.New("invalid_request")
	}
	return nil
}
func isFinite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
func validateImage(value string) error {
	header, encoded, found := strings.Cut(value, ",")
	expected := map[string]string{"data:image/png;base64": "png", "data:image/jpeg;base64": "jpeg", "data:image/webp;base64": "webp"}[header]
	if !found || expected == "" || len(encoded) > base64.StdEncoding.EncodedLen(MaxImageBytes) {
		return errors.New("invalid_image")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > MaxImageBytes {
		return errors.New("invalid_image")
	}
	dimensions, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != expected || dimensions.Width < 1 || dimensions.Height < 1 || int64(dimensions.Width)*int64(dimensions.Height) > 40_000_000 {
		return errors.New("invalid_image")
	}
	return nil
}
