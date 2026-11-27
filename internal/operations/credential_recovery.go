package operations

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
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

// CredentialVerifyResult carries the verification outcome alongside the resolved
// auth file so the caller can refresh related projections without re-resolving.
type CredentialVerifyResult struct {
	Verified bool
	AuthFile management.AuthFile
}

// VerifyCredential is deliberately separate from quota reads and token refresh.
// CPA alone chooses the isolated inference session and pins the selected account.
// When CPA confirms verification (verified=true) and its post-verify auth-file
// projection affirmatively reports that no credential-level cooldown remains
// (as on CPA v8.1.8+ after scoped credential_quota release), OMC clears matching
// local credential cooldown evidence captured before verification started while
// preserving independent per-model cooldowns, force cooldowns, and any newer
// cooldown ingested after verification began.
func (s *Service) VerifyCredential(ctx context.Context, target CredentialTarget, model, revision string) (CredentialVerifyResult, error) {
	release, err := s.lock(ctx)
	if err != nil {
		return CredentialVerifyResult{}, err
	}
	defer release()
	file, err := s.recoveryAuthFile(ctx, target)
	if err != nil {
		return CredentialVerifyResult{}, err
	}
	if revision != "" {
		if err := s.checkRevision(file, revision); err != nil {
			return CredentialVerifyResult{}, err
		}
	}
	client, err := s.Client(ctx)
	if err != nil {
		return CredentialVerifyResult{}, err
	}
	// Capture the local evidence watermark before invoking CPA verify so a new
	// cooldown ingested during or after verify can never be cleared retroactively.
	var preVerifyMaxEventID int64
	hasWatermark := false
	if s.Repo != nil {
		if maxID, wmErr := s.Repo.LatestErrorEventID(ctx); wmErr == nil {
			preVerifyMaxEventID, hasWatermark = maxID, true
		}
	}
	verified, err := client.VerifyAuthFile(ctx, file.Name, file.AuthIndex, model)
	if err != nil {
		return CredentialVerifyResult{AuthFile: file}, err
	}
	if verified && strings.TrimSpace(file.AuthIndex) != "" {
		// Re-read CPA's live auth-file projection instead of inferring cooldown
		// release from verified=true alone: older pre-v8.1.8 gateways can return
		// verified=true while leaving a credential_quota block active, and a
		// force_cooldown stays active across verify. Require unique auth_index
		// ownership and matching identity before clearing local evidence or
		// passing AuthFile to post-verify quota refresh. Any read or local
		// storage failure here is non-fatal because upstream verify completed.
		postFile, confirmed, postErr := s.verifyReadbackAuthFile(ctx, client, file)
		if postErr != nil || !confirmed {
			if s.Notify != nil {
				s.Notify()
			}
			return CredentialVerifyResult{Verified: verified}, nil
		}
		file = postFile
		if s.Repo != nil && hasWatermark && preVerifyMaxEventID > 0 && postFile.HasClearedCredentialCooldown(s.now()) {
			_ = s.Repo.ClearCredentialCooldownEvidenceUpTo(ctx, file.AuthIndex, preVerifyMaxEventID)
		}
	}
	if s.Notify != nil {
		s.Notify()
	}
	return CredentialVerifyResult{Verified: verified, AuthFile: file}, nil
}

// verifyReadbackAuthFile re-reads CPA's live credential list and confirms that
// target.AuthIndex is uniquely owned by the same credential that was verified.
// When another credential shares the same auth_index or CPA swapped runtime IDs,
// returning confirmed=false prevents clearing sibling evidence or refreshing a
// replacement credential's quota under the old index.
func (s *Service) verifyReadbackAuthFile(ctx context.Context, client *management.Client, target management.AuthFile) (management.AuthFile, bool, error) {
	files, err := client.AuthFiles(ctx)
	if err != nil {
		return management.AuthFile{}, false, err
	}
	targetIndex := strings.TrimSpace(target.AuthIndex)
	var matched management.AuthFile
	indexMatches := 0
	for _, file := range files.Files {
		if strings.TrimSpace(file.AuthIndex) != targetIndex {
			continue
		}
		matched, indexMatches = file, indexMatches+1
	}
	if indexMatches != 1 {
		return management.AuthFile{}, false, nil
	}
	if matched.RuntimeOnly || matched.Name != target.Name {
		return management.AuthFile{}, false, nil
	}
	if target.ID != "" && matched.ID != "" && target.ID != matched.ID {
		return management.AuthFile{}, false, nil
	}
	return matched, true, nil
}

func clearedCooldownAuthIndexes(files []management.AuthFile, now time.Time) map[string]bool {
	cleared := make(map[string]bool, len(files))
	seen := make(map[string]bool, len(files))
	for _, file := range files {
		authIndex := strings.TrimSpace(file.AuthIndex)
		if authIndex == "" {
			continue
		}
		isCleared := file.HasClearedCredentialCooldown(now)
		if !seen[authIndex] {
			seen[authIndex] = true
			cleared[authIndex] = isCleared
		} else {
			cleared[authIndex] = cleared[authIndex] && isCleared
		}
	}
	return cleared
}

// ReconcileCPACredentialCooldowns treats CPA's live auth-file projection as authoritative
// when it disagrees with locally observed credential-scoped cooldown evidence captured on or
// before snapshotMaxEventID. After bounded clears succeed, affected indexes are re-read so
// any newer active cooldown ingested after BatchCorrelatedCooldowns remains in the response.
func (s *Service) ReconcileCPACredentialCooldowns(
	ctx context.Context,
	files []management.AuthFile,
	activeCooldowns map[string]repository.ActiveCooldownRecord,
	now time.Time,
	snapshotMaxEventID int64,
) error {
	if s == nil || s.Repo == nil || len(activeCooldowns) == 0 || len(files) == 0 || snapshotMaxEventID <= 0 {
		return nil
	}
	cleared := clearedCooldownAuthIndexes(files, now)
	var errs []error
	clearedPrior := make(map[string]repository.ActiveCooldownRecord)
	clearedIndexes := make([]string, 0)
	for authIndex, cooldown := range activeCooldowns {
		if !cooldown.IsActive || !cleared[authIndex] {
			continue
		}
		// Reject stale CPA observations: if the active cooldown was inserted after we
		// began fetching AuthFiles, CPA may have entered cooldown after the snapshot.
		if cooldown.EventID > snapshotMaxEventID {
			continue
		}
		if _, err := s.Repo.ClearAuthoritativeCredentialCooldownEvidenceUpTo(ctx, authIndex, snapshotMaxEventID); err != nil {
			errs = append(errs, err)
			continue
		}
		clearedPrior[authIndex] = cooldown
		clearedIndexes = append(clearedIndexes, authIndex)
		delete(activeCooldowns, authIndex)
	}
	if len(clearedIndexes) > 0 {
		surviving, err := s.Repo.BatchCorrelatedCooldowns(ctx, clearedIndexes, now.UnixMilli())
		if err != nil {
			errs = append(errs, err)
			for _, authIndex := range clearedIndexes {
				activeCooldowns[authIndex] = clearedPrior[authIndex]
			}
		} else {
			for _, authIndex := range clearedIndexes {
				if rec, ok := surviving[authIndex]; ok && rec.IsActive {
					activeCooldowns[authIndex] = rec
				}
			}
		}
	}
	return errors.Join(errs...)
}

// ReconcileExpiredCPACredentialCooldowns releases expired local credential cooldown
// evidence up to snapshotMaxEventID when CPA's live auth-file projection affirmatively
// shows no credential-level cooldown remains.
//
// reconcileCandidates covers all expired credential-scoped rows (including credentials
// that still have an independent model cooldown, because local reconciliation preserves
// independent model cooldowns). resetCandidates is the narrower map used to dispatch
// credential-wide CPA resets; whenever CPA already reports an auth_index clear, that
// index is removed from resetCandidates regardless of rows cleared or errors so this
// round never falls through to an unbounded credential-wide CPA reset (leaving any
// post-watermark or failed rows in storage for the next round's fresh watermark).
func (s *Service) ReconcileExpiredCPACredentialCooldowns(
	ctx context.Context,
	files []management.AuthFile,
	reconcileCandidates map[string]int64,
	resetCandidates map[string]int64,
	now time.Time,
	snapshotMaxEventID int64,
) (int, int, error) {
	if s == nil || s.Repo == nil || len(files) == 0 || snapshotMaxEventID <= 0 {
		return 0, 0, nil
	}
	cleared := clearedCooldownAuthIndexes(files, now)
	var errs []error
	clearedCount := 0
	failedCount := 0
	for authIndex := range resetCandidates {
		if cleared[authIndex] {
			delete(resetCandidates, authIndex)
		}
	}
	for authIndex := range reconcileCandidates {
		if !cleared[authIndex] {
			continue
		}
		rows, err := s.Repo.ClearAuthoritativeCredentialCooldownEvidenceUpTo(ctx, authIndex, snapshotMaxEventID)
		if err != nil {
			errs = append(errs, err)
			failedCount++
			continue
		}
		if rows > 0 {
			clearedCount++
		}
	}
	return clearedCount, failedCount, errors.Join(errs...)
}
