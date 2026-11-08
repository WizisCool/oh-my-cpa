package warmup

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// VerifyFunc executes a credential-pinned inference request through CPA's /v8/management/credentials/verify endpoint.
type VerifyFunc func(ctx context.Context, name, authIndex, model string) (bool, error)

// Send triggers a minimal credential-pinned warmup request by delegating directly to CPA.
// The model goes out as the task names it: CPA strips the credential's own prefix and resolves an
// OAuth alias itself, and an alias may contain a slash.
func Send(ctx context.Context, verify VerifyFunc, file management.AuthFile, model string) Outcome {
	model = strings.TrimSpace(model)
	if verify == nil || (strings.TrimSpace(file.Name) == "" && strings.TrimSpace(file.AuthIndex) == "") {
		return Outcome{Status: "failed", Reason: "invalid_parameters"}
	}
	verified, err := verify(ctx, strings.TrimSpace(file.Name), strings.TrimSpace(file.AuthIndex), model)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return Outcome{Status: "unknown", Reason: "timeout"}
		}
		// CPA may have run the request without its answer arriving, so repeating it could consume twice.
		if errors.Is(err, management.ErrCredentialOutcomeUnknown) {
			return Outcome{Status: "unknown", Reason: "no_answer"}
		}
		var httpErr *management.HTTPError
		if errors.As(err, &httpErr) && httpErr.StatusCode > 0 {
			if httpErr.StatusCode == 504 {
				return Outcome{Status: "unknown", Reason: "timeout"}
			}
			return Outcome{Status: "failed", Reason: fmt.Sprintf("HTTP %d", httpErr.StatusCode)}
		}
		return Outcome{Status: "failed", Reason: sanitizeReason(err.Error())}
	}
	if !verified {
		return Outcome{Status: "failed", Reason: "verification_failed"}
	}
	return Outcome{Status: "ok"}
}

func sanitizeReason(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 200 {
		return s[:200]
	}
	return s
}
