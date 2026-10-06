package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"regexp"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// VertexImportDTO reports a stored Vertex service account. It names the file and the
// identity it was stored under and nothing of the key itself.
type VertexImportDTO struct {
	Status    string `json:"status"`
	Name      string `json:"name"`
	ProjectID string `json:"project_id"`
	Email     string `json:"email,omitempty"`
	Location  string `json:"location"`
}

// vertexLocationPattern covers Google Cloud's region names ("us-central1",
// "europe-west4") and "global"; the value becomes part of an upstream hostname.
var vertexLocationPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)

// validateVertexServiceAccount refuses what CPA would refuse, before the key leaves
// this process, so the common mistake - choosing an OAuth client file or a token
// file - is answered with a reason instead of CPA's bare "invalid service account".
func validateVertexServiceAccount(data []byte) (projectID string, err error) {
	var key struct {
		ProjectID  string `json:"project_id"`
		PrivateKey string `json:"private_key"`
	}
	if jsonErr := json.Unmarshal(data, &key); jsonErr != nil {
		return "", errors.New("the file is not a JSON object")
	}
	if strings.TrimSpace(key.PrivateKey) == "" {
		return "", errors.New("the file is not a service account key: it has no private_key")
	}
	if strings.TrimSpace(key.ProjectID) == "" {
		return "", errors.New("the service account key has no project_id")
	}
	return strings.TrimSpace(key.ProjectID), nil
}

func (h *Handler) importVertexServiceAccount(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, managementAuthFileUploadLimit)
	location := strings.TrimSpace(request.URL.Query().Get("location"))
	if location != "" && !vertexLocationPattern.MatchString(location) {
		writeError(writer, http.StatusBadRequest, "location must be a Google Cloud region such as us-central1")
		return
	}
	data, err := io.ReadAll(request.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(writer, http.StatusRequestEntityTooLarge, "upload is too large")
			return
		}
		writeError(writer, http.StatusBadRequest, "cannot read upload")
		return
	}
	projectID, validationErr := validateVertexServiceAccount(data)
	if validationErr != nil {
		writeError(writer, http.StatusBadRequest, validationErr.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if err := h.recordAudit(request, "auth_file.vertex_import", "auth_file", projectID, "attempt", nil); err != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; import aborted")
		return
	}
	result, err := client.ImportVertexCredential(request.Context(), data, location)
	if err != nil {
		detail := map[string]any{"error": "import failed"}
		var httpErr *management.HTTPError
		if errors.As(err, &httpErr) {
			detail["cpa_status"] = httpErr.StatusCode
		}
		_ = h.recordAudit(request, "auth_file.vertex_import", "auth_file", projectID, "failure", detail)
		writeCPAFacadeError(writer, err)
		return
	}
	// CPA answers with the path on its own disk; only the file name is this
	// console's business, and it is what the credential list shows.
	name := path.Base(strings.ReplaceAll(result.AuthFile, `\`, "/"))
	if name == "." || name == "/" {
		name = ""
	}
	// The upstream mutation has landed; an outcome-audit failure must not invite
	// a retry that renews or replaces the credential again.
	_ = h.recordAudit(request, "auth_file.vertex_import", "auth_file", projectID, "success", map[string]any{"name": name, "location": result.Location})
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	writeJSON(writer, http.StatusOK, VertexImportDTO{
		Status:    "ok",
		Name:      name,
		ProjectID: firstNonEmpty(result.ProjectID, projectID),
		Email:     result.Email,
		Location:  result.Location,
	})
}
