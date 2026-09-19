# ADR 0015: A credential leaves the server only for the surface that edits it, and only when it asks

- Status: Accepted
- Date: 2026-09-19

## Context

Two management responses carried credential material that nothing needed in the clear:

1. **The caller-key list returned the stored keys verbatim.** `ClientAPIKeyItemDTO.Key` was CPA's
   `api-keys` entry as-is, and the create response echoed the key it had just been sent. Both the
   dashboard's key picker and the key page read that field.
2. **The providers table put the provider key in a `title` attribute.** The cell showed
   `maskKeyText(record.api_key)` while the element's `title` was the value itself, so the full secret
   sat in the document — readable from a DOM snapshot, on hover, or by any extension — with no reveal
   action in between. The page does hold the values deliberately (`getManagementProviders(true)`),
   because the provider editor edits them.

ADR 0002 decision 2 says plaintext API keys "must never enter primary keys, database foreign keys,
regular logs, or standard browser responses". The one sanctioned exception is
`internal/cpa/configyaml/configyaml.go`, whose `SanitizeSafeYAML` states that upstream/downstream API
keys are intentionally returned in plaintext: the visual configuration mode is the surface that edits
them, so it has to see them.

That exception does not reach either surface above. It also cannot simply be extended to the key list
in masked form, because the key page needs the value for a job the mask cannot do: it joins the alias
and usage overlay in this list against the key text of the configuration document it is editing.
CONTEXT.md already rules out both substitutes — "never a configuration array index and never the
display mask", because an index moves when CPA's `api-keys` list is edited and a mask keeps only a
short head and tail, so two keys can share one. A join on either would print one key's
operator-assigned name on another key's row, and the rename that reads back from that row writes the
alias against a usage fingerprint, so the wrong name would be stored on the wrong key.

## Decision

1. **A management response carries a credential only for the surface that owns editing it, and only
   on an explicit request.** `include_keys=true` — already used by the provider list — is what makes
   `/management/api-keys` return the stored values. Without it, `ClientAPIKeyItemDTO.Key` is
   `security.MaskSecret` of the value. `Length`, `fingerprint` and `usage_fingerprint` are computed
   from the value in both cases, so identity and the alias overlay are unaffected by what is sent.
2. **Each reader declares which contract it reads, in its own cache entry.** The key page asks for the
   values (`['management-client-keys', 'with-keys']`) because it joins them; the dashboard's key picker
   reads the masked list at the bare `['management-client-keys']` and keeps using `maskKeyText` on
   whatever it is given. One entry cannot answer both contracts, because whichever page fetched first
   would decide what the other one sees — and a mask reaching the key page would not merely display
   wrong, it would empty every alias and usage column without an error.
3. **A response never echoes a secret the requester just sent.** The key-creation response returns the
   row index and the mask, not the key.
4. **A surface that only displays a key never carries the value.** The providers table's tooltip
   repeats the cell's mask, so the value reaches the browser only through the editor that edits it.
5. **The mask stays the one shape ADR 0010 decision 5 fixed, and stays idempotent.** Masking a mask
   returns it unchanged, which is what lets a reader that masks whatever it receives render both
   response forms identically; `scripts/test-mask-key.ts` pins that property over every branch.

## Consequences

### Positive

- ADR 0002 decision 2 holds again on these two responses: the default answers carry a display mask, so
  a devtools panel, a DOM snapshot, a screenshot of a hover or a browser extension reads no credential
  from the surfaces that do not edit one.
- The exposure that remains is deliberate, named, and requested by the page whose job is editing that
  credential — the same posture the provider list already had, now stated once for both.
- The dashboard stops receiving key values it never used, which is the change with no trade-off in it.
- The key page's exact join is preserved. Names, traffic columns and the "view requests" action keep
  working off the key text, with no new identity invented for a mask that cannot carry one.

### Trade-offs

- **The key list has two contracts.** A caller that reads it without the flag and expects values gets
  masks instead. The failure is visible rather than silent — aliases and usage columns come back empty
  — but it is a second thing for a future reader of the list to get right, and it is why the flag and
  its reason are stated on the DTO field and in `getClientAPIKeys`.
- **The masked response is not a boundary against the browser session.** The same session can read the
  values through the configuration document (the sanctioned exception) and through the opt-in request;
  this decision removes the copy that had no purpose, it does not hide the keys from the page that
  edits them.
- **Reveal-by-default is gone from the provider row.** The tooltip now repeats the mask, so an operator
  who wants to compare a provider key by eye opens the editor for it. That is one click further than a
  hover, and it is what an explicit reveal is for.

## Alternatives considered

- **Mask the list always and rejoin the overlay in the page, by mask or by index.** Rejected: a mask is
  not unique (two keys with the same head and tail share one, and every short key shares the
  all-filler mask), so an ambiguous lookup either mislabels a row or has to drop the metadata for the
  colliding keys; and an index is not stable across the edits this page makes. CONTEXT.md already
  forbids both as identity, and a mislabelled row feeds a rename that is stored against a fingerprint.
- **Return the list in CPA's order and let the page match positionally.** Rejected: the key list and
  the configuration document are two live reads, so a concurrent edit — or the page's own unsaved draft
  — makes position disagree with identity. Today's join is exact because both sides match the key text;
  this would trade an exact join for an approximate one to avoid a flag.
- **Leave the list in plaintext and document why.** Rejected: the dashboard reads the same response and
  has no use for the values, so the reason would only hold for one of its two readers, and ADR 0002
  decision 2 would keep a standing exception for a response that does not need one.
- **Drop the providers tooltip rather than mask it.** Rejected: the cell truncates at 220px, so the
  tooltip is still the thing that shows the whole mask on a long key. Removing it would remove the
  affordance along with the secret.
