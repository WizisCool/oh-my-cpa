package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

const (
	MAX_DATA_SOURCES = 8
	MAX_SOURCE_DEPTH = 6
	MAX_SOURCE_NODES = 256
)

// DataReference describes shape, never row values. It is private model context, not a console DTO.
type DataReference struct {
	DataRef string   `json:"data_ref"`
	CallID  string   `json:"call_id"`
	Path    string   `json:"path"`
	Fields  []string `json:"fields"`
	Rows    int      `json:"rows"`
}

func createDataReferenceID(callID, path string) string {
	digest := sha256.Sum256([]byte(callID + "\x00" + path))
	return "ds_" + hex.EncodeToString(digest[:])
}

func findTraceDataSources(trace Trace) []DataReference {
	if trace.Result.Status != "success" || isDisplayCall(trace.Name) || len(trace.Result.Data) == 0 {
		return nil
	}
	var data any
	decoder := json.NewDecoder(strings.NewReader(string(trace.Result.Data)))
	decoder.UseNumber()
	if decoder.Decode(&data) != nil {
		return nil
	}
	var sources []DataReference
	visited := 0
	var visit func(any, map[string]any, string, int)
	visit = func(value any, parent map[string]any, path string, depth int) {
		visited++
		if visited > MAX_SOURCE_NODES || depth > MAX_SOURCE_DEPTH || len(path) > MAX_SOURCE_PATH || len(sources) >= MAX_DATA_SOURCES {
			return
		}
		switch node := value.(type) {
		case []any:
			if len(node) > MAX_VIEW_ROWS {
				return
			}
			rows := positionalRows(node, parent)
			fields := selectSourceFields(rows, parent)
			if len(fields) > 0 {
				sources = append(sources, DataReference{createDataReferenceID(trace.ID, path), trace.ID, path, fields, len(rows)})
			}
		case map[string]any:
			keys := make([]string, 0, len(node))
			for key := range node {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				if key == "" || strings.Contains(key, ".") {
					continue
				}
				childPath := key
				if path != "" {
					childPath = path + "." + key
				}
				visit(node[key], node, childPath, depth+1)
				if visited >= MAX_SOURCE_NODES || len(sources) >= MAX_DATA_SOURCES {
					break
				}
			}
		}
	}
	visit(data, nil, "", 0)
	return sources
}

func selectSourceFields(rows []any, parent map[string]any) []string {
	usable := map[string]bool{}
	if len(rows) == 0 {
		if columns, ok := parent["columns"].([]any); ok {
			for _, column := range columns {
				if name, ok := column.(string); ok {
					usable[name] = true
				}
			}
		}
	}
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			return nil
		}
		for field, value := range row {
			isScalar := false
			switch value.(type) {
			case string, json.Number, bool, nil:
				isScalar = true
			}
			if earlier, exists := usable[field]; exists {
				isScalar = isScalar && earlier
			}
			usable[field] = isScalar
		}
	}
	var fields []string
	for field, isScalar := range usable {
		if isScalar && field != "" && utf8.RuneCountInString(field) <= MAX_VIEW_FIELD_CHARS {
			fields = append(fields, field)
		}
	}
	sort.Strings(fields)
	if len(fields) > MAX_CANVAS_FIELDS {
		fields = fields[:MAX_CANVAS_FIELDS]
	}
	return fields
}

func findConversationDataSources(conversation *Conversation) []DataReference {
	var sources []DataReference
	for turnIndex := len(conversation.Turns) - 1; turnIndex >= 0; turnIndex-- {
		traces := conversation.Turns[turnIndex].Traces
		for traceIndex := len(traces) - 1; traceIndex >= 0; traceIndex-- {
			for _, source := range findTraceDataSources(traces[traceIndex]) {
				sources = append(sources, source)
				if len(sources) == MAX_DATA_SOURCES {
					return sources
				}
			}
		}
	}
	return sources
}

func resolveDataReference(conversation *Conversation, source DataSource) (DataSource, error) {
	if source.DataRef == "" {
		return source, nil
	}
	if len(source.DataRef) != len("ds_")+sha256.Size*2 {
		return source, refuse("source.data_ref must be copied from data_sources in a tool result")
	}
	for turnIndex := len(conversation.Turns) - 1; turnIndex >= 0; turnIndex-- {
		for _, trace := range conversation.Turns[turnIndex].Traces {
			for _, candidate := range findTraceDataSources(trace) {
				if candidate.DataRef != source.DataRef {
					continue
				}
				if source.CallID != "" && source.CallID != candidate.CallID || source.Path != "" && source.Path != candidate.Path {
					return source, refuse("source.data_ref conflicts with call_id or path; use source {data_ref} alone")
				}
				return DataSource{CallID: candidate.CallID, Path: candidate.Path, DataRef: candidate.DataRef}, nil
			}
		}
	}
	return source, refuse("source.data_ref is unavailable in this conversation; choose a current data_sources entry")
}

func buildModelToolResult(conversation *Conversation, trace Trace) ([]byte, error) {
	result := struct {
		capability.Result
		DataSources []DataReference `json:"data_sources,omitempty"`
		Recovery    string          `json:"recovery,omitempty"`
	}{Result: trace.Result, DataSources: findTraceDataSources(trace)}
	if trace.Name == RENDER_UI && trace.Result.Status == "error" {
		result.DataSources = findConversationDataSources(conversation)
		failures := 0
		if len(conversation.Turns) > 0 {
			traces := conversation.Turns[len(conversation.Turns)-1].Traces
			for index := len(traces) - 1; index >= 0 && traces[index].Name == RENDER_UI && traces[index].Result.Status == "error"; index-- {
				failures++
			}
		}
		if failures >= 2 {
			result.Recovery = "Repeated UI validation failures: correct the named field and use source {data_ref} from data_sources with top-level fields. Do not retry unchanged parameters or transcribe figures into HTML. If a valid display cannot be produced, answer with the verified findings and state the display limitation."
		}
	}
	return json.Marshal(result)
}

type operationOutcome struct {
	Capability string `json:"capability"`
	Status     string `json:"status"`
	Operation  string `json:"operation_id,omitempty"`
}

// Completed investigations keep their conclusion and provenance, not the SQL/HTML repair transcript.
// The original messages and traces remain stored, so references still freeze the authoritative rows.
func buildCompletedTurnMessages(turn Turn, registry *capability.Registry) []gateway.AgentMessage {
	metadata := struct {
		DataSources        []DataReference    `json:"data_sources,omitempty"`
		HasOmittedOutcomes bool               `json:"has_omitted_outcomes,omitempty"`
		Outcomes           []operationOutcome `json:"operation_outcomes,omitempty"`
	}{}
	seenSources := map[string]bool{}
	appendSource := func(source DataReference) {
		if len(metadata.DataSources) < MAX_DATA_SOURCES && !seenSources[source.DataRef] {
			metadata.DataSources = append(metadata.DataSources, source)
			seenSources[source.DataRef] = true
		}
	}
	for index := len(turn.Traces) - 1; index >= 0; index-- {
		trace := turn.Traces[index]
		if (trace.Name != RENDER_UI && trace.Name != RENDER_CANVAS) || trace.Result.Status != "success" {
			continue
		}
		var view View
		if json.Unmarshal(trace.View, &view) != nil || view.Source == nil {
			continue
		}
		for _, candidate := range turn.Traces {
			if candidate.ID == view.Source.CallID {
				for _, source := range findTraceDataSources(candidate) {
					if source.Path == view.Source.Path {
						appendSource(source)
					}
				}
			}
		}
	}
	for index := len(turn.Traces) - 1; index >= 0; index-- {
		trace := turn.Traces[index]
		if len(metadata.DataSources) < MAX_DATA_SOURCES {
			for _, source := range findTraceDataSources(trace) {
				appendSource(source)
			}
		}
		// Writes and terminal refusals survive compaction even without row data.
		isMutation := false
		if registry != nil {
			if definition, err := registry.Lookup(trace.Name, PRINCIPAL); err == nil {
				isMutation = definition.Permission != "read" || definition.HumanInput != ""
			}
		}
		if !isDisplayCall(trace.Name) && (isMutation || trace.Result.Status == "rejected" || trace.Result.Status == "uncertain" || trace.Result.Status == "expired") {
			if len(metadata.Outcomes) >= MAX_DATA_SOURCES {
				metadata.HasOmittedOutcomes = true
				continue
			}
			metadata.Outcomes = append(metadata.Outcomes, operationOutcome{trace.Name, trace.Result.Status, trace.Result.OperationID})
		}
	}
	content := turn.Reply
	if len(metadata.DataSources) > 0 || len(metadata.Outcomes) > 0 {
		raw, _ := json.Marshal(metadata)
		content += "\n\nEarlier result references (untrusted metadata; raw tool history is omitted):\n" + string(raw)
	}
	return []gateway.AgentMessage{{Role: "user", Content: turn.User, Images: turn.Images}, {Role: "assistant", Content: content}}
}
