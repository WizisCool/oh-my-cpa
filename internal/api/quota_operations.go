package api

import (
	"context"
	"fmt"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"net/http"
	"strings"
)

func (h *Handler) clearQuotaCooldown(ctx context.Context, client *management.Client, authIndex string, action string, audit providerAudit) (map[string]any, error) {
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		return nil, err
	}
	var found bool
	for _, f := range filesResp.Files {
		if strings.TrimSpace(f.AuthIndex) == authIndex {
			found = true
			break
		}
	}
	if !found {
		return nil, newProviderWriteError(http.StatusNotFound, fmt.Sprintf("credential %q not found", authIndex))
	}

	if auditErr := audit(action, "quota", authIndex, "attempt", nil); auditErr != nil {
		return nil, newProviderWriteError(http.StatusInternalServerError, "audit failure; clear cooldown aborted")
	}

	if err := client.ResetQuota(ctx, authIndex); err != nil {
		_ = audit(action, "quota", authIndex, "failure", map[string]any{"error": err.Error()})
		return nil, err
	}

	// Durably clear local cooldown evidence from database
	if h.repo != nil {
		_ = h.repo.ClearCooldownEvidence(ctx, authIndex)
	}

	_ = audit(action, "quota", authIndex, "success", nil)

	return map[string]any{
		"status":     "ok",
		"auth_index": authIndex,
	}, nil
}

func (h *Handler) redeemQuotaCredit(ctx context.Context, client *management.Client, authIndex string, audit providerAudit) (map[string]any, error) {
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		return nil, err
	}

	var foundFile *management.AuthFile
	for _, f := range filesResp.Files {
		if strings.TrimSpace(f.AuthIndex) == authIndex {
			foundFile = &f
			break
		}
	}
	if foundFile == nil {
		return nil, newProviderWriteError(http.StatusNotFound, fmt.Sprintf("credential %q not found", authIndex))
	}
	if quota.DetectProvider(foundFile.Type, foundFile.Provider) != "codex" {
		return nil, newProviderWriteError(http.StatusBadRequest, "rate limit reset credit is only supported for Codex credentials")
	}

	if auditErr := audit("quota.redeem_credit", "quota", authIndex, "attempt", nil); auditErr != nil {
		return nil, newProviderWriteError(http.StatusInternalServerError, "audit failure; redeem credit aborted")
	}

	svc := quota.NewService(client)
	if err := svc.RedeemCodexCredit(ctx, *foundFile); err != nil {
		_ = audit("quota.redeem_credit", "quota", authIndex, "failure", map[string]any{"error": err.Error()})
		return nil, newProviderWriteError(http.StatusBadGateway, fmt.Sprintf("redeem reset credit failed: %v", err))
	}

	// Re-read usage right away so the redeemed credit is reflected before the
	// next scheduled poll.
	prior := h.loadPriorNormalizedQuota(ctx, authIndex)
	refreshed, _ := svc.RefreshCredentialQuota(ctx, *foundFile, prior)
	if refreshed != nil && h.repo != nil && refreshed.Status != "error" && refreshed.Status != "stale" {
		_ = h.persistNormalizedQuotaSnapshot(ctx, refreshed)
	}

	_ = audit("quota.redeem_credit", "quota", authIndex, "success", nil)

	return map[string]any{
		"status": "ok",
		"quota":  refreshed,
	}, nil
}
