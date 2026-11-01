package operations

import (
	"context"
	"errors"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func sameOAuthProvider(left, right string) bool {
	normalize := func(value string) string {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "anthropic" {
			return "claude"
		}
		return value
	}
	return normalize(left) == normalize(right)
}

// Recovery requires a uniquely resolved identity before CPA pins the account.
// Neither a stale pair nor an ambiguous name may become an untargeted sign-in.
func (s *Service) recoveryAuthFile(ctx context.Context, target CredentialTarget) (management.AuthFile, error) {
	if target.Name == "" && target.AuthIndex == "" {
		return management.AuthFile{}, management.ErrInvalidOAuthTarget
	}
	client, err := s.Client(ctx)
	if err != nil {
		return management.AuthFile{}, err
	}
	files, err := client.AuthFiles(ctx)
	if err != nil {
		return management.AuthFile{}, err
	}
	var found management.AuthFile
	matches := 0
	for _, file := range files.Files {
		if target.Name != "" && file.Name != target.Name {
			continue
		}
		if target.AuthIndex != "" && file.AuthIndex != target.AuthIndex {
			continue
		}
		found, matches = file, matches+1
	}
	if matches != 1 {
		return management.AuthFile{}, errors.New("resource_conflict")
	}
	if found.RuntimeOnly {
		return management.AuthFile{}, management.ErrInvalidOAuthTarget
	}
	return found, nil
}

// VerifyCredential is deliberately separate from quota reads and token refresh.
// CPA alone chooses the isolated inference session and pins the selected account.
func (s *Service) VerifyCredential(ctx context.Context, target CredentialTarget, model, revision string) (bool, error) {
	release, err := s.lock(ctx)
	if err != nil {
		return false, err
	}
	defer release()
	file, err := s.recoveryAuthFile(ctx, target)
	if err != nil {
		return false, err
	}
	if revision != "" {
		if err := s.checkRevision(file, revision); err != nil {
			return false, err
		}
	}
	client, err := s.Client(ctx)
	if err != nil {
		return false, err
	}
	verified, err := client.VerifyAuthFile(ctx, file.Name, file.AuthIndex, model)
	if err == nil && s.Notify != nil {
		s.Notify()
	}
	return verified, err
}
