package api

import (
	"slices"
	"strings"
	"testing"
)

// An empty directory is a valid answer; a response that is not a directory at all
// must be an error, or a broken upstream reads as "this provider has no models".
func TestModelDirectoryRejectsMalformedOrUnrecognizedJSON(t *testing.T) {
	cases := []struct {
		name         string
		body         string
		shouldReject bool
		wantModels   []string
	}{
		{name: "truncated_json", body: `{"data":[`, shouldReject: true},
		{name: "unrecognized_object", body: `{}`, shouldReject: true},
		{name: "null_document", body: `null`, shouldReject: true},
		{name: "wrong_data_shape", body: `{"data":{"id":"wrong"}}`, shouldReject: true},
		{name: "empty_data_control", body: `{"data":[]}`},
		{name: "empty_models_control", body: `{"models":[]}`},
		{name: "empty_array_control", body: `[]`},
		{name: "model_control", body: `{"data":[{"id":"fixture-model"}]}`, wantModels: []string{"fixture-model"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			models, parseErr := parseModelsResponse(strings.NewReader(testCase.body))
			t.Logf("SEC-07 body=%q bytes=%d actual_models=%q actual_error=%v", testCase.body, len(testCase.body), models, parseErr)
			if testCase.shouldReject {
				if parseErr == nil {
					t.Errorf("desired invariant: malformed or unrecognized model directory must return an error, got models=%q", models)
				}
				return
			}
			if parseErr != nil || !slices.Equal(models, testCase.wantModels) {
				t.Errorf("recognized directory control: want models=%q and nil error, got models=%q error=%v", testCase.wantModels, models, parseErr)
			}
		})
	}
}

func TestModelDirectoryRejectsOversizedBody(t *testing.T) {
	const limitBytes = 2 * 1024 * 1024
	prefix := `{"data":[{"id":"fixture-model"}]}`
	cases := []struct {
		name         string
		bodyBytes    int
		shouldReject bool
	}{
		{name: "exact_limit_control", bodyBytes: limitBytes},
		{name: "one_byte_over_limit", bodyBytes: limitBytes + 1, shouldReject: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			// Legal trailing whitespace keeps truncation syntactically valid, so
			// the oversized case cannot fail merely because JSON was cut in half.
			body := prefix + strings.Repeat(" ", testCase.bodyBytes-len(prefix))
			reader := strings.NewReader(body)
			models, parseErr := parseModelsResponse(reader)
			t.Logf("SEC-07 bytes=%d limit=%d consumed=%d unread=%d actual_models=%q actual_error=%v", len(body), limitBytes, len(body)-reader.Len(), reader.Len(), models, parseErr)
			if testCase.shouldReject {
				if parseErr == nil {
					t.Errorf("desired invariant: a body larger than %d bytes must be rejected, got models=%q", limitBytes, models)
				}
				return
			}
			if parseErr != nil || !slices.Equal(models, []string{"fixture-model"}) {
				t.Errorf("exact-limit control: want fixture-model and nil error, got models=%q error=%v", models, parseErr)
			}
		})
	}
}
