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
	if trace.Result.Status != "success" || isPresentationCall(trace.Name) || len(trace.Result.Data) == 0 {
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
	if len(fields) > MAX_SOURCE_FIELDS {
		fields = fields[:MAX_SOURCE_FIELDS]
	}
	return fields
}

// buildModelToolResult is what the model reads back from a call: the result, and the data references
// an OpenUI Query can name instead of copying rows into the program.
func buildModelToolResult(trace Trace) ([]byte, error) {
	result := struct {
		capability.Result
		DataSources []DataReference `json:"data_sources,omitempty"`
	}{Result: trace.Result, DataSources: findTraceDataSources(trace)}
	return json.Marshal(result)
}

type operationOutcome struct {
	Capability string `json:"capability"`
	Status     string `json:"status"`
	Operation  string `json:"operation_id,omitempty"`
}

// Completed investigations keep their conclusion and provenance, not the SQL repair transcript.
// The original messages and traces remain stored, so a data reference still reads the authoritative
// rows.
//
// The interfaces a turn presented stay in its history as the calls they were (the OpenUI spec's
// "earlier responses appear as the program the model wrote"): the next question is often about
// what the operator is looking at, and a follow-up interface reuses its predecessor's structure.
// They are replayed as calls with their results rather than as text, so the model keeps answering
// through the tool instead of imitating a program written into prose.
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
	var presented []Trace
	for _, trace := range turn.Traces {
		if (trace.Name == PRESENT_OPENUI || trace.Name == PROMPT_OPENUI) && trace.Result.Status == "success" {
			presented = append(presented, trace)
		}
	}
	// A reference an interface reads is the one a follow-up most likely needs, so it is kept first.
	for _, trace := range presented {
		for _, candidate := range turn.Traces {
			for _, source := range findTraceDataSources(candidate) {
				if strings.Contains(trace.Arguments, source.DataRef) {
					appendSource(source)
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
		if trace.Name != PROMPT_OPENUI && !isPresentationCall(trace.Name) && (isMutation || trace.Result.Status == "rejected" || trace.Result.Status == "uncertain" || trace.Result.Status == "expired") {
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
		content = strings.TrimSpace(content + "\n\nEarlier result references (untrusted metadata; raw tool history is omitted):\n" + string(raw))
	}
	answer := gateway.AgentMessage{Role: "assistant", Content: content}
	var results []gateway.AgentMessage
	for _, trace := range presented {
		answer.ToolCalls = append(answer.ToolCalls, gateway.ToolCall{ID: trace.ID, Type: "function", Function: gateway.ToolFunction{Name: trace.Name, Arguments: trace.Arguments}})
		raw, _ := json.Marshal(trace.Result)
		results = append(results, gateway.AgentMessage{Role: "tool", ToolCallID: trace.ID, Content: string(raw)})
	}
	return append([]gateway.AgentMessage{{Role: "user", Content: turn.User, Images: turn.Images}, answer}, results...)
}
