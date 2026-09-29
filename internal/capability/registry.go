// Package capability is the transport-independent, explicitly opted-in tool boundary.
package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"

	"github.com/google/jsonschema-go/jsonschema"
)

const MAX_PAYLOAD_BYTES = 32 << 10

type Principal struct {
	ID      string
	Adapter string
	IsAdmin bool
	Allowed map[string]bool
}

func (p Principal) Allows(name string) bool { return p.IsAdmin || p.Allowed[name] }

type Metadata struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Version     int      `json:"version"`
	Permission  string   `json:"permission"`
	Risk        string   `json:"risk"`
	Adapters    []string `json:"adapters"`
	Invalidates []string `json:"invalidates,omitempty"`
	HumanInput  string   `json:"human_input,omitempty"`
}

// Preview is what the operator decides on: one target at one revision, and the change proposed
// for it. Approval is a single allow-or-deny decision (ADR 0035); the revision, not a typed
// confirmation, is what stops an approval from applying to a target that has since changed.
type Preview struct {
	Target   string `json:"target"`
	Revision string `json:"revision"`
	Changes  any    `json:"changes"`
}
type Definition struct {
	Metadata
	InputSchema  *jsonschema.Schema `json:"input_schema"`
	OutputSchema *jsonschema.Schema `json:"output_schema"`
	input        *jsonschema.Resolved
	output       *jsonschema.Resolved
	Prepare      func(context.Context, json.RawMessage) (Preview, error)             `json:"-"`
	Execute      func(context.Context, json.RawMessage, string, string) (any, error) `json:"-"`
}
type Registry struct{ definitions map[string]*Definition }

func NewRegistry() *Registry { return &Registry{definitions: map[string]*Definition{}} }

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

func Register[I, O any](registry *Registry, metadata Metadata, prepare func(context.Context, I) (Preview, error), execute func(context.Context, I, string, string) (O, error)) error {
	if metadata.Name == "omc_operation_status" {
		return errors.New("reserved_capability_name")
	}
	if !namePattern.MatchString(metadata.Name) || metadata.Description == "" || metadata.Version < 1 || len(metadata.Adapters) == 0 || execute == nil {
		return errors.New("invalid_capability_definition")
	}
	if metadata.Permission != "read" && metadata.Permission != "write" && metadata.Permission != "destructive" {
		return errors.New("invalid_permission")
	}
	if metadata.Risk != "low" && metadata.Risk != "high" {
		return errors.New("invalid_risk")
	}
	if metadata.Permission == "destructive" && metadata.Risk != "high" {
		return errors.New("destructive_requires_confirmation")
	}
	// A secret or an OAuth flow completes a change, so it rides on a confirmed write. An answer is
	// the operator replying to the agent: it changes nothing, so it is only allowed on a read.
	switch metadata.HumanInput {
	case "":
	case "secret", "oauth":
		if metadata.Risk != "high" {
			return errors.New("invalid_human_input")
		}
	case "answer":
		if metadata.Permission != "read" || prepare == nil {
			return errors.New("invalid_human_input")
		}
	default:
		return errors.New("invalid_human_input")
	}
	for _, adapter := range metadata.Adapters {
		if adapter != "agent" && adapter != "mcp" {
			return errors.New("invalid_adapter")
		}
	}
	if metadata.Risk == "high" && prepare == nil {
		return errors.New("confirmation_requires_preview")
	}
	if _, exists := registry.definitions[metadata.Name]; exists {
		return fmt.Errorf("duplicate_capability: %s", metadata.Name)
	}
	input, err := jsonschema.For[I](nil)
	if err != nil {
		return err
	}
	output, err := jsonschema.For[O](nil)
	if err != nil {
		return err
	}
	inputResolved, err := input.Resolve(nil)
	if err != nil {
		return err
	}
	outputResolved, err := output.Resolve(nil)
	if err != nil {
		return err
	}
	definition := &Definition{Metadata: metadata, InputSchema: input, OutputSchema: output, input: inputResolved, output: outputResolved}
	if prepare != nil {
		definition.Prepare = func(ctx context.Context, raw json.RawMessage) (Preview, error) {
			var value I
			if err := json.Unmarshal(raw, &value); err != nil {
				return Preview{}, err
			}
			return prepare(ctx, value)
		}
	}
	definition.Execute = func(ctx context.Context, raw json.RawMessage, revision, secret string) (any, error) {
		var value I
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		return execute(ctx, value, revision, secret)
	}
	registry.definitions[metadata.Name] = definition
	return nil
}
func (r *Registry) Lookup(name string, p Principal) (*Definition, error) {
	definition := r.definitions[name]
	if definition == nil || !p.Allows(name) {
		return nil, errors.New("capability_forbidden")
	}
	for _, adapter := range definition.Adapters {
		if adapter == p.Adapter {
			return definition, nil
		}
	}
	return nil, errors.New("capability_forbidden")
}
func (r *Registry) List(p Principal) []*Definition {
	result := []*Definition{}
	for name := range r.definitions {
		if definition, err := r.Lookup(name, p); err == nil {
			result = append(result, definition)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}
func (d *Definition) Validate(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) > MAX_PAYLOAD_BYTES {
		return nil, errors.New("tool_input_too_large")
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if decoder.Decode(&value) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("invalid_tool_arguments")
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, errors.New("invalid_tool_arguments")
	}
	if err := d.input.Validate(value); err != nil {
		return nil, errors.New("invalid_tool_arguments")
	}
	canonical, err := json.Marshal(value)
	return canonical, err
}
func (d *Definition) ValidateOutput(value any) (json.RawMessage, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("invalid_tool_result")
	}
	if len(raw) > MAX_PAYLOAD_BYTES {
		return nil, errors.New("tool_result_too_large")
	}
	var decoded any
	if json.Unmarshal(raw, &decoded) != nil || d.output.Validate(decoded) != nil {
		return nil, errors.New("invalid_tool_result")
	}
	return raw, nil
}

// ResultSchema describes the executor envelope while retaining the definition's typed data contract.
func (d *Definition) ResultSchema() map[string]any {
	return map[string]any{"type": "object", "required": []string{"status"}, "additionalProperties": false, "properties": map[string]any{
		"status": map[string]any{"type": "string"}, "data": d.OutputSchema, "code": map[string]any{"type": "string"}, "detail": map[string]any{"type": "string"}, "operation_id": map[string]any{"type": "string"}, "invalidates": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
	}}
}
