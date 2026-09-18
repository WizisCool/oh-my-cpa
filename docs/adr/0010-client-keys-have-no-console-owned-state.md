# ADR 0010: The console owns no client-key state — CPA's `api-keys` is the only model

- Status: Accepted
- Date: 2026-09-18

## Context

CPA authenticates inbound caller requests against its `api-keys:` list and nothing else. A client
key therefore has exactly two states there: present (accepted) or absent (rejected with
`401 Unauthorized`). The console had nonetheless grown a third state of its own — "temporarily
disabled" keys were removed from the `api-keys` draft and remembered in the `ui_preferences` key
`omc_disabled_client_keys`.

That state could not be persisted. `omc_disabled_client_keys` was never added to `knownPreferences`
in `internal/api/management_preferences.go`, which is the whole public surface of the preferences
API: the write was answered with `400 unsupported preference key`, `listPreferences` filtered the
key out of every read, and the optimistic value in the shared query cache was rolled back. So the
reachable behaviour was the opposite of the intended one — disabling a key removed it from the
configuration document, the console recorded no trace of it, and the toast reported that the key was
parked and reversible.

The mistaken model was cheap to describe and expensive to keep: a state Oh My CPA stores but CPA does
not honour is not a control, it is a claim. Had the flag persisted, CPA would still have accepted the
key while the console displayed "disabled" — the failure mode of a security-looking label with no
enforcement behind it.

## Decision

1. **A client key has no disabled state.** The console models a key as present or absent. Stopping a
   key means removing it from `api-keys`, through the same revision-guarded draft transaction as
   every other configuration write.

2. **Removal is irreversible for the secret, and the console says so.** Oh My CPA stores no copy of
   a key value, so the delete confirmation states that the value cannot be recovered and that it must
   be copied first if it is wanted. An alias and the key's historical traffic outlive the removal,
   because `client_key_aliases` and `usage_events` are keyed by the usage fingerprint rather than by
   the key text.

3. **The configuration panel points instead of editing.** The `grp_apikeys` group renders a pointer
   panel — the configured key count plus a jump to the dedicated page — in place of a second editor
   of the same field. This supersedes the earlier handling that hid the group entirely, which left
   the panel silent about a field it owns. Two editors of one document were deliberately never
   introduced, and this ADR keeps it that way: no surface writes keys outside the key page's own
   draft flow.

4. **No preference key is registered for key state.** The removal required no migration, because the
   write had never once succeeded.

5. **One display mask shape, computed independently of the secret's length.** The key list renders
   the same constant-shape mask as the request list (`security.MaskSecret`: a short head, a fixed
   bullet run, a short tail), so the same key reads the same way on both surfaces, and the mask never
   reveals how long the secret is.

## Consequences

### Positive

- The console stops reporting a state CPA does not have. "Disabled" no longer appears anywhere the
  gateway would in fact keep accepting calls.
- The destructive path is the explicit one. Removing a key is visibly destructive at the moment it is
  confirmed, instead of arriving as a state that silently dropped the key from the document.
- One document, one writer. Keys are edited on the key-management page only, so each surface holds at
  most one draft of `config.yaml` and the revision guard has nothing ambiguous to arbitrate.
- The configuration panel is no longer silent about `api-keys`: an operator who looks there is told
  where the field lives and how many keys exist.
- The key list lost the state concept with it — an unlabelled status pip, an enable/disable filter and
  a status column existed only to serve the state that is now gone.

### Trade-offs

- **There is no way to park a key.** An operator who wants to stop traffic without losing the secret
  must copy the value out first. That is a real capability loss, and it is the honest limit of CPA's
  model rather than a console choice.
- **Discoverability now depends on a pointer.** A panel showing a count and a button is one click
  further from the field than the field itself would have been.
- **The removed state is not covered by an automated test**, because it was never reachable through
  the accepted write path; there is no behaviour to assert against. The guarantee is the absence of
  the code, and the two names that would reintroduce it (`omc_disabled_client_keys`, a key-status
  preference) are specific enough to grep for.

## Alternatives considered

- **Register the preference and persist the parked keys.** Rejected on three counts: it contradicts
  the model, since CPA would still accept the key; it turns the preferences table into a secret store
  for gateway keys, against the boundary that keeps caller secrets out of console storage; and it
  would have made the console's "disabled" label a false security claim rather than a bug.
- **Keep a console-side flag that hides the key without touching `api-keys`.** Rejected: a hidden row
  still authenticates. This is the specific failure of the removed feature in a form that would
  finally persist, which is strictly worse than the version that failed loudly.
- **Enforce disablement at CPA's protocol level, the way provider disablement works
  (`excluded-models: ['*']`).** Rejected: an inbound caller key is not a credential that routes
  upstream, so there is no upstream exclusion to set.
- **Keep the group hidden in the configuration panel.** Rejected: a field the panel owns but never
  mentions is the discoverability defect the pointer panel fixes, and it is what left a dead
  `api-keys` entry in the visual workbench.
