package updater

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// DEFAULT_LISTEN_ADDR is where the control interface listens inside the sidecar.
const DEFAULT_LISTEN_ADDR = ":8090"

// MAX_REQUEST_BYTES bounds an update request; a manifest and its signature are a few
// hundred bytes.
const MAX_REQUEST_BYTES = 64 << 10

// StatusResponse is the control interface's view of the deployment.
type StatusResponse struct {
	UpdaterVersion string   `json:"updater_version"`
	Products       []Target `json:"products"`
	Job            *Job     `json:"job"`
}

// UpdateRequest asks for one product to be replaced. It deliberately has no field for
// a container or an image: the updater decides both, so a caller holding the token can
// only ever move this deployment's own containers to images their publisher released.
type UpdateRequest struct {
	Product   string `json:"product"`
	Manifest  string `json:"manifest"`
	Signature string `json:"signature"`
}

// Handler serves the control interface.
func (s *Service) Handler(version string) http.Handler {
	mux := http.NewServeMux()
	// Unauthenticated on purpose: the container health check has no token, and the
	// answer says nothing about the deployment.
	mux.HandleFunc("GET /v1/healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("GET /v1/status", s.authenticated(func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(writer, http.StatusOK, StatusResponse{
			UpdaterVersion: version,
			Products:       s.Targets(request.Context()),
			Job:            s.LastJob(),
		})
	}))
	mux.Handle("POST /v1/update", s.authenticated(func(writer http.ResponseWriter, request *http.Request) {
		var body UpdateRequest
		if err := json.NewDecoder(io.LimitReader(request.Body, MAX_REQUEST_BYTES)).Decode(&body); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request", "the request body is not valid JSON")
			return
		}
		job, err := s.Start(request.Context(), body.Product, []byte(body.Manifest), body.Signature)
		var unavailable *UnavailableError
		switch {
		case err == nil:
			writeJSON(writer, http.StatusAccepted, job)
		case errors.Is(err, ErrBusy):
			writeError(writer, http.StatusConflict, "busy", err.Error())
		case errors.As(err, &unavailable):
			writeError(writer, http.StatusConflict, unavailable.Reason, err.Error())
		case errors.Is(err, ErrSignature):
			writeError(writer, http.StatusForbidden, "invalid_signature", err.Error())
		default:
			writeError(writer, http.StatusUnprocessableEntity, "refused", err.Error())
		}
	}))
	return mux
}

// authenticated admits a request carrying the token derived from the console's master
// key. The key is read from the console container on each request, so recreating the
// console with a new key takes effect without restarting the updater.
func (s *Service) authenticated(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		masterKey, err := s.MasterKey(request.Context())
		expected := ControlToken(masterKey)
		if err != nil || expected == "" {
			writeError(writer, http.StatusServiceUnavailable, "console_not_found", "the console container could not be identified")
			return
		}
		provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			writeError(writer, http.StatusUnauthorized, "unauthorized", "missing or invalid token")
			return
		}
		next(writer, request)
	})
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

func writeError(writer http.ResponseWriter, status int, code, message string) {
	writeJSON(writer, status, map[string]string{"code": code, "message": message})
}
