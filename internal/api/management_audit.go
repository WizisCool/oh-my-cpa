package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

const (
	// auditListPageMax bounds one page of the console's timeline. The export takes
	// repository.AuditPageMax instead: it is a file, not something scrolled.
	auditListPageMax = 200
	// auditSearchMaxRunes bounds the substring filter; it matches identifiers, so a
	// longer needle can only be a mistake or an attempt to make the scan expensive.
	auditSearchMaxRunes = 128
	// auditCategoriesMax bounds the category filter's OR list.
	auditCategoriesMax = 24
)

// auditCategoryPattern is the shape of an action's first segment (`api_key`,
// `system`). The filter accepts nothing else, so it cannot smuggle a wildcard.
var auditCategoryPattern = regexp.MustCompile(`^[a-z][a-z_]{0,39}$`)

// auditEventDTO is the wire shape of one trail row. It is spelled out rather than
// serialising repository.AuditEvent directly so a column added to the table does
// not reach the console until someone decides it should.
type auditEventDTO struct {
	ID            int64          `json:"id"`
	OccurredAtMS  int64          `json:"occurred_at_ms"`
	Action        string         `json:"action"`
	TargetType    string         `json:"target_type"`
	TargetID      string         `json:"target_id"`
	Result        string         `json:"result"`
	RequestID     string         `json:"request_id"`
	SourceSummary string         `json:"source_summary"`
	Details       map[string]any `json:"details,omitempty"`
}

func auditEventDTOs(events []repository.AuditEvent) []auditEventDTO {
	out := make([]auditEventDTO, 0, len(events))
	for _, event := range events {
		out = append(out, auditEventDTO(event))
	}
	return out
}

// parseAuditQuery reads the trail filters shared by the list and the export.
// `fold` defaults to the caller's choice: the timeline reads one entry per
// operation, while the export is the complete record unless asked otherwise.
func parseAuditQuery(request *http.Request, maxLimit int, defaultFold bool) (repository.AuditQuery, error) {
	values := request.URL.Query()
	query := repository.AuditQuery{Limit: 50, FoldAttempts: defaultFold}
	if raw := values.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit <= 0 {
			return query, errors.New("limit must be a positive integer")
		}
		query.Limit = min(limit, maxLimit)
	}
	if raw := values.Get("before"); raw != "" {
		cursor, err := parseAuditCursor(raw)
		if err != nil {
			return query, err
		}
		query.Before = cursor
	}
	if raw := values.Get("since_ms"); raw != "" {
		since, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || since < 0 {
			return query, errors.New("since_ms must be a non-negative integer")
		}
		query.SinceMS = since
	}
	for _, raw := range values["category"] {
		for _, category := range strings.Split(raw, ",") {
			category = strings.TrimSpace(category)
			if category == "" {
				continue
			}
			if !auditCategoryPattern.MatchString(category) {
				return query, fmt.Errorf("unknown audit category %q", category)
			}
			query.Categories = append(query.Categories, category)
		}
	}
	if len(query.Categories) > auditCategoriesMax {
		return query, errors.New("too many audit categories")
	}
	switch outcome := values.Get("outcome"); outcome {
	case "", "all":
	case repository.AuditOutcomeFailed, repository.AuditOutcomeSucceeded:
		query.Outcome = outcome
	default:
		return query, fmt.Errorf("unknown audit outcome %q", outcome)
	}
	search := strings.TrimSpace(values.Get("q"))
	if len([]rune(search)) > auditSearchMaxRunes {
		return query, errors.New("search is too long")
	}
	query.Search = search
	switch values.Get("fold") {
	case "":
	case "1", "true":
		query.FoldAttempts = true
	case "0", "false":
		query.FoldAttempts = false
	default:
		return query, errors.New("fold must be a boolean")
	}
	return query, nil
}

// The cursor is `<occurred_at_ms>_<id>`: opaque to the console, which only ever
// hands back what the previous page gave it.
func formatAuditCursor(cursor *repository.AuditCursor) string {
	if cursor == nil {
		return ""
	}
	return strconv.FormatInt(cursor.OccurredAtMS, 10) + "_" + strconv.FormatInt(cursor.ID, 10)
}

func parseAuditCursor(raw string) (repository.AuditCursor, error) {
	timePart, idPart, ok := strings.Cut(raw, "_")
	if !ok {
		return repository.AuditCursor{}, errors.New("invalid audit cursor")
	}
	occurredAt, errTime := strconv.ParseInt(timePart, 10, 64)
	id, errID := strconv.ParseInt(idPart, 10, 64)
	if errTime != nil || errID != nil || occurredAt < 0 || id <= 0 {
		return repository.AuditCursor{}, errors.New("invalid audit cursor")
	}
	return repository.AuditCursor{OccurredAtMS: occurredAt, ID: id}, nil
}

func (h *Handler) listAuditEvents(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is not initialized")
		return
	}
	query, err := parseAuditQuery(request, auditListPageMax, true)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	page, err := h.repo.QueryAuditEvents(request.Context(), query)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"events":      auditEventDTOs(page.Events),
		"next_cursor": formatAuditCursor(page.Next),
	})
}

// exportAuditEvents downloads the filtered trail, up to repository.AuditPageMax
// rows. Reading the trail out of the console is itself recorded, and the file is
// withheld when that record cannot be written.
func (h *Handler) exportAuditEvents(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")

	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is not initialized")
		return
	}
	query, err := parseAuditQuery(request, repository.AuditPageMax, false)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if request.URL.Query().Get("limit") == "" {
		query.Limit = repository.AuditPageMax
	}
	page, err := h.repo.QueryAuditEvents(request.Context(), query)
	if err != nil {
		writeInternalError(writer, err)
		return
	}

	exportPayload := map[string]any{
		"exported_at": time.Now().UTC().Format(time.RFC3339),
		"count":       len(page.Events),
		"truncated":   page.Next != nil,
		"events":      auditEventDTOs(page.Events),
	}
	body, err := json.Marshal(exportPayload)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	if auditErr := h.recordAudit(request, "audit.export", "audit_events", "export", "success", map[string]any{"count": len(page.Events)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; export aborted")
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="omc-audit-%d.json"`, time.Now().Unix()))
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(body)
}
