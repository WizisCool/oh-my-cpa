package usage

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/testkit"
)

// decodeCase is the body of a decode golden case.
type decodeCase struct {
	// Record is the message as CPA queued it. A JSON string is handed over as its
	// text, so a case can carry a record that is not valid JSON.
	Record json.RawMessage `json:"record"`
	// IsFingerprinted decodes with a keyed fingerprinter, as the ingest runner does.
	IsFingerprinted bool `json:"fingerprinted"`
	// Secrets must not appear anywhere in the decoded output.
	Secrets []string `json:"secrets"`
}

// TestDecodeGolden decodes every record under testdata/golden/<kind>/ at the case's
// now_ms, the pop time that backfills a missing timestamp, and compares the stored
// row with the golden file.
func TestDecodeGolden(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	for kind, decode := range map[string]func(raw string, observedAt time.Time, input decodeCase) (any, error){
		"event": func(raw string, observedAt time.Time, input decodeCase) (any, error) {
			if input.IsFingerprinted {
				return DecodeEventWithFingerprinter(raw, "default", observedAt, cipher)
			}
			return DecodeEvent(raw, "default", observedAt)
		},
		"error": func(raw string, observedAt time.Time, input decodeCase) (any, error) {
			if input.IsFingerprinted {
				return DecodeErrorEventWithFingerprinter(raw, "default", observedAt, cipher)
			}
			return DecodeErrorEvent(raw, "default", observedAt)
		},
	} {
		testkit.Cases(t, "testdata/golden/"+kind, func(t *testing.T, input testkit.Case) any {
			var body decodeCase
			if err := json.Unmarshal(input.Body, &body); err != nil {
				t.Fatalf("decode case body: %v", err)
			}
			raw := string(body.Record)
			var text string
			if json.Unmarshal(body.Record, &text) == nil {
				raw = text
			}
			decoded, err := decode(raw, time.UnixMilli(input.NowMS).UTC(), body)
			if err != nil {
				return map[string]string{"error": err.Error()}
			}
			row := nonZeroFields(decoded)
			if kind == "event" {
				if headers := DecodeResponseHeaders(decoded.(Event).ResponseHeaders); headers != nil {
					row["ResponseHeaders"] = headers
				}
			}
			encoded, err := json.Marshal(row)
			if err != nil {
				t.Fatal(err)
			}
			for _, secret := range body.Secrets {
				if strings.Contains(string(encoded), secret) {
					t.Errorf("decoded row keeps %q: %s", secret, encoded)
				}
			}
			return row
		})
	}
}

// nonZeroFields renders a decoded row without its zero fields, so a golden file shows
// what a record set and a field it leaves unset reads as absent. A pointer field is
// kept whenever it is set, since a stored false or zero differs from unknown.
func nonZeroFields(value any) map[string]any {
	row := reflect.ValueOf(value)
	fields := map[string]any{}
	for index := 0; index < row.NumField(); index++ {
		if field := row.Field(index); !field.IsZero() {
			fields[row.Type().Field(index).Name] = field.Interface()
		}
	}
	return fields
}
