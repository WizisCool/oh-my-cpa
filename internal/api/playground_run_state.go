package api

import (
	"encoding/json"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Recovery snapshots carry display state, not inference authority. Redact every image copy,
// including the request history, before keeping one beyond the upstream call.
func redactPlaygroundRun(raw json.RawMessage) json.RawMessage {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	var redact func(any) any
	redact = func(value any) any {
		switch typed := value.(type) {
		case string:
			if strings.HasPrefix(typed, "data:image/") && len(typed) > 16384 {
				return "<image omitted>"
			}
		case []any:
			for i, child := range typed {
				typed[i] = redact(child)
			}
		case map[string]any:
			for key, child := range typed {
				typed[key] = redact(child)
			}
		}
		return value
	}
	encoded, _ := json.Marshal(redact(value))
	if len(encoded) > repository.MaxPreferenceValueBytes {
		return nil
	}
	return encoded
}

func playgroundRecoveryTurn(body []byte, id string, startedAt int64) json.RawMessage {
	var input playgroundRequest
	if json.Unmarshal(body, &input) != nil || len(input.Messages) == 0 {
		return nil
	}
	var supplied struct {
		KeyLabel   string `json:"keyLabel"`
		ReplacesID string `json:"replaces_id"`
	}
	_ = json.Unmarshal(input.RecoveryTurn, &supplied)
	if len(supplied.KeyLabel) > 256 {
		supplied.KeyLabel = ""
	}
	if !BROWSER_RUN_ID.MatchString(supplied.ReplacesID) {
		supplied.ReplacesID = ""
	}
	input.RecoveryTurn = nil
	turn := map[string]any{"id": id, "replaces_id": supplied.ReplacesID, "request": input, "keyLabel": supplied.KeyLabel, "user": input.Messages[len(input.Messages)-1], "reply": "", "status": "running", "startedAt": startedAt, "events": []any{}, "eventBytes": 0, "isTruncated": false}
	raw, _ := json.Marshal(turn)
	return redactPlaygroundRun(raw)
}
