# ADR 0023: The playground remembers its selected target

- Status: Superseded by ADR 0024
- Date: 2026-09-27

## Context

ADR 0022 deliberately kept playground conversations, request snapshots and images in the mounted
page. Operators repeatedly choose the same key and call point when debugging a model, so losing that
selection on every reload or service restart makes the page unnecessarily repetitive. The selection
is small identity metadata, but it must not become a place to retain prompts, answers, images or
credentials.

## Decision

Oh My CPA stores one additional UI preference, `playground_selection`, containing only the selected
client-key usage fingerprint and the CPA call point. It is written through the existing preferences
API and the closed `knownPreferences` allowlist. It never contains the client key text, a mask,
provider credentials, prompt, answer, image, request snapshot or response diagnostics.

On load, the page validates the remembered fingerprint against the current CPA client-key list and
the remembered call point against the live `/v1/models` directory. A deleted or changed target is
not used: the selector falls back to a currently available target where possible and otherwise
waits for the operator to choose one. The public demonstration does not claim durable preference
storage; its Worker continues to refuse non-read API calls, so the page keeps the selection local
for that session.

This decision supersedes only ADR 0022's statement that the selected target is page-memory state.
The conversation and image privacy boundary, the server-side key resolution and the refusal to store
credentials remain unchanged.

## Consequences

The operator returns to the same debugging target after a reload, service restart or container
rebuild. The stored value remains useful metadata rather than a secret store, and deleting a key
cannot leave a stale selection that silently calls with the wrong identity. The preference is
ordinary UI state and adds no database table or migration.
