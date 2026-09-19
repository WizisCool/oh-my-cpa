# ADR 0017: A request record names the provider key that answered it, resolved at read time

- Status: Accepted
- Date: 2026-09-20

## Context

Two surfaces disagreed with what an operator needs to know about an upstream
credential.

**The provider list printed one key per provider.** The name cell showed
`security.MaskSecret` of `record.api_key`, which is CPA's first key entry for that
provider. A provider configured with several keys therefore showed one of them,
unlabelled, beside the provider's name - a fact that is wrong for every request the
other keys served, and that invited the reader to believe that provider had one
credential. ADR 0015 decision 4 had already reduced that cell to a mask (the tooltip
repeated the mask rather than the value), so the remaining exposure was not a secret
but a false claim.

**A request record could not name the key that answered.** The list shows the
provider, and for an OAuth record the account and file it used, but an API-key
record showed only the provider name. When a provider holds several keys, an
operator diagnosing a failure or a bill could not tell which one was used.

The obstacle is that the fact does not exist in the record. CPA's usage payload
carries the credential's runtime `auth_index`, which `usage_events` stores, and no
key material. The keys exist only in CPA's configuration, which the console reads
through the management API. Two shapes were available:

1. **Resolve at read time.** Read CPA's credential lists, index them by auth index,
   and attach a display mask to each record as the list is served.
2. **Capture at ingestion.** Resolve the index while a record is being stored and
   persist the mask on `usage_events`.

## Decision

1. **A request record names the provider key that answered it, resolved at read
   time.** The usage list and the single-record view return an optional
   `provider_key_mask` resolved from the credential lists CPA currently reports -
   the four config API-key families and the `openai-compatibility` providers. The
   browser renders it beneath the provider name and holds no credential to do so.
2. **Resolution is current-config, never a snapshot.** The response states which
   configured credential claims the record's index *now*. A credential that has
   since been rotated, deleted or disabled claims no index, so the row prints
   nothing. The console never reconstructs a key it cannot read, and a mask is never
   inferred from a provider name, a position, or the caller key.
3. **Nothing is guessed when identification is ambiguous.** An unclaimed index, a
   key CPA reports without an index, an index two entries claim (even when their
   masks are alike), and a record with no index resolve to nothing. Only an API-key
   record is a candidate at all: an OAuth record's index identifies an auth file,
   not a provider key.
4. **The mask is the only thing that leaves the process.** Resolution uses CPA's
   configured values and `security.MaskSecret`; the plaintext reaches no cache entry
   that outlives the read, no response, and no browser. ADR 0015 stands unchanged for
   every other surface: the provider editor remains the one page that asks for the
   values.
5. **The provider list no longer prints a key at all.** The provider's own key
   count stays visible in the models/headers column, and the editor drawer lists
   every entry, masked, behind its own reveal. ADR 0015 decision 4's premise - that
   the cell showed one key's mask - no longer holds, because the cell shows none.
6. **The read is bounded and best effort.** Each credential list is read at most
   once per TTL, concurrent pages share one read, failures are negatively cached, and
   the enrichment has its own deadline inside the request. A gateway that cannot be
   read leaves the masks empty and returns the request list unchanged.

## Consequences

### Positive

- The provider list stops asserting something untrue about multi-key providers,
  while the key count and the editor keep the information that is true.
- A request record answers "which key answered this" for the case where it matters
  most - several keys behind one provider - without the operator opening anything.
- The resolution is expressed in the data the console already reads, so no schema
  change, no migration, and no dependency on discovery being enabled is needed, and
  historical records are covered from the first read.
- Rotation and deletion degrade to silence rather than to a stale claim, which is
  the failure direction a display label should have.

### Trade-offs

- **The mask is not a historical fact.** Re-serving an old page after a key rotation
  can show a different mask, or none, for the same record. The alternative -
  persisting the mask at ingestion - would freeze a fact and pay for it with a
  migration, an ingest-time dependency on CPA's configuration being readable, and a
  permanently blank column for every record stored before it landed.
- **The request list now reads CPA's credential lists.** That is a new outbound
  dependency on the read path, bounded by a TTL, a shared read, a negative cache and
  its own deadline, and it can only ever remove a label - never fail the page.
- **A resolved mask is a claim about the current configuration, not proof about the
  past.** An operator who renamed or re-keyed a credential since the request sees the
  credential that claims the index today. This is the honest reading of an index that
  CPA itself treats as the credential's runtime identity.
- **Two keys can share a mask**, because a mask keeps only a short head and tail.
  Distinguishing them is what the editor's reveal is for; the row's job is to say
  which of a provider's keys served the request, not to prove it cryptographically.

## Alternatives considered

- **Persist the mask on each record at ingestion.** Rejected: it buys a frozen fact
  at the cost of a migration, a permanently empty column for existing history, and an
  ingest-time read of CPA configuration - so a gateway that is momentarily unreadable
  would blank the label for traffic it can otherwise attribute. It also duplicates
  what the console already reads live for every other provider fact.
- **Resolve in the browser from the provider list it already fetches.** Rejected as
  the contract, though it needs the same information: the usage page would have to be
  handed per-entry masks on the sanitized provider response - widening what a surface
  that displays no key receives - and the resolution rule would then live in two
  places, once per client. Keeping it server-side holds one implementation and one
  DTO, and lets the detail view and the list share it.
- **Match provider identity as well as the auth index.** Rejected: CPA's provider
  label for a compatibility record follows the name the operator gave it, so a rename
  would orphan every request recorded before it even though the credential - and
  CPA's index for it - is unchanged. The index is the credential's own runtime
  identity, and it is what the match uses within the list the record's provider
  belongs to.
- **Fall back to the provider's only key when the index does not match.** Rejected:
  "there is one configured key, so it must be the one" is an inference, and it becomes
  wrong the moment a key is added or replaced - printing one key's mask on another
  key's request. Omission is the answer the user chose, and it is the one that stays
  true as the configuration changes.
- **Keep the mask on the provider list and add it to the request list.** Rejected:
  the provider list's line is the one that is structurally misleading, because it
  cannot speak for the provider's other keys. Two surfaces printing the same mask
  would not fix which of them is wrong.
