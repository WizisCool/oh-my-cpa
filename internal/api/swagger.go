package api

// @title Oh My CPA API
// @version 1.0
// @description Self-hosted control plane, management, and usage observability API for CLIProxyAPI (CPA).
// @BasePath /api
// @schemes http https
// @produce json
// @consumes json
//
// @securityDefinitions.apikey CookieAuth
// @in header
// @name Cookie
// @description Console session cookie issued by POST /api/auth/login (plus same-origin check on state-changing requests).
//
// @securityDefinitions.apikey BearerAuth
// @in header
// @name Authorization
// @description Bearer CPA management key (`Authorization: Bearer <key>`) accepted by capability, MCP, and management endpoints.

// ErrorResponseDTO represents a standard machine-readable API error payload.
type ErrorResponseDTO struct {
	Error   string   `json:"error"`
	Code    string   `json:"code,omitempty"`
	Details []string `json:"details,omitempty"`
}

// StatusOKResponseDTO represents a simple acknowledgement payload.
type StatusOKResponseDTO struct {
	OK     bool   `json:"ok,omitempty"`
	Status string `json:"status,omitempty"`
}
