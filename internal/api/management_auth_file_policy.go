package api

import (
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func hasCredentialScopedPolicyField(fields map[string]any) bool {
	_, hasSIWC := fields["use_siwc"]
	_, hasAliases := fields["model_aliases"]
	return hasSIWC || hasAliases
}

func requireCredentialScopedPolicyTarget(files []management.AuthFile, name, authIndex string, fields map[string]any) error {
	if !hasCredentialScopedPolicyField(fields) {
		return nil
	}
	// CPA patches by name alone, so an auth index cannot disambiguate a duplicate name.
	matches := 0
	for _, file := range files {
		if file.Name == name || file.ID == name {
			matches++
		}
	}
	if matches != 1 {
		return errAuthFileIdentityStale
	}
	file, ok := findManagementAuthFile(files, name, authIndex)
	if !ok {
		return errManagementAuthFileNotFound
	}
	if !management.CredentialPolicyFieldsApplicable(file, fields) {
		return fmt.Errorf("%w: use_siwc requires Codex and an existing binding when enabled; model alias openapi requires Vertex", errAuthFileFieldNotApplicable)
	}
	return nil
}
