# ADR 0040: Provider traffic is credited by the key that served it

- Status: Accepted
- Date: 2026-09-29

## Context

The dashboard's provider panel and the provider list both report traffic per provider,
and both were reporting it to the wrong one.

**CPA's provider label cannot identify a configured provider.** For a request served by
an API key, CPA writes the *family* into the usage record's `provider` field — `codex`
for every Codex key, `claude` for every Claude key — and it writes the same word for a
request served by that family's OAuth credential. One label therefore covers several
distinct things at once: every configured key family of that name, and the OAuth
channel beside them. The label answers "which upstream family", which is not the
question a provider list asks.

**Two consequences followed from matching on it.** A provider the operator had just
created, with no traffic of its own, claimed the family's OAuth traffic and displayed
it as its own — announcing requests nobody had sent to it. And because the first row to
claim a label consumed it, a second provider of the same family showed "no requests"
while the first showed all of them, even when both were serving traffic.

**Rows were also merged by name.** The aggregation skipped a configured provider whose
display name, id or upstream name an earlier row had already claimed. Two providers left
at CPA's default name ("Codex / Responses") therefore collapsed into one: the dashboard's
provider panel listed the first and dropped the second, and the provider page - which
draws a row per configured provider and joins traffic onto it by id - showed the second
as a dash, the same mark it uses for a window it could not read. A provider that was
serving traffic read as one whose traffic could not be determined.

**Family ids double as channel ids.** The console's OAuth channel table is keyed by the
same short ids (`codex`, `claude`, `xai`, `meta`) that name CPA's API-key families, and a
configured API-key provider was being classified as an OAuth channel through that
overlap. It then took the channel's credential count — the number of OAuth files — and
the channel's traffic, so an API-key provider reported credentials it does not hold.

**The fact that does identify the key already exists in the record.** Each usage record
carries the credential's runtime `auth_index` when an API key served it, and CPA reports
the same index on each configured key of a provider through the management API. The
label is unusable; the index is an identity.

## Decision

1. **A configured API-key provider's traffic is what its own keys served.** The window's
   totals are split server-side: records with `auth_type = 'apikey'` are grouped by their
   runtime auth index and returned as `credentials[]`; every other record is grouped by
   its provider label as before. A provider's traffic is the sum of the indexes its own
   keys report, joined exactly, one index claimed by one provider.
2. **An OpenAI-compatible provider also counts the label CPA reserves for it.** CPA
   labels a compatibility provider's requests `openai-compatible-<name>`, lowercasing the
   provider's own name, and those records carry no key index. That exact label is added
   to the provider's own keys' traffic, for the provider whose `upstream_name` produces
   it.
3. **Nothing is credited by family, by display name, or by substring.** Family labels
   belong to the OAuth channel that shares the name; a family match credits a provider
   with another surface's traffic. A configured provider of one of CPA's API-key families
   is an API-key provider by construction, and takes the channel's identity only when it
   is an OpenAI-compatible provider relaying under a channel's name.
4. **Every configured provider is its own row.** Two providers left with CPA's default
   name, and two keys of one family, are distinct providers with distinct traffic and
   distinct credentials; neither is merged into the other, and neither is skipped.
5. **A provider's credential count is its own.** The count comes from the number of key
   entries the provider holds, not from the gateway's tally of auth files for a type that
   happens to share an id.
6. **`auth_indexes` is not a secret and travels in the sanitized projection.** The runtime
   index is an opaque identifier CPA assigns to a credential at runtime; it is not key
   material, and ADR 0017 already returns it per request record. The provider DTO carries
   the indexes of the provider's keys so the browser can join without reading any key.
7. **A record that names no index is credited to nobody.** A record stored before the index
   was captured has none, and one whose credential CPA no longer holds keeps the index it was
   served under while no configured provider publishes it — it stays in `credentials[]` under
   that index and is credited to no row. Neither can be claimed by inference: a provider that
   has one key is not evidence that it served a record with no index.
8. **An index two configured providers both publish is credited to neither.** CPA derives a
   credential's runtime index from the credential itself, so one key entered twice under one
   name resolves to one index. Crediting whichever row comes first would make the number
   depend on the order of the provider list.

## Consequences

### Positive

- A provider created a minute ago reports zero requests instead of another surface's
  traffic, and two providers of the same family each report their own.
- An OAuth channel's traffic stops including the requests API keys served, so the
  dashboard's channel numbers and the request records agree.
- Colliding display names no longer hide a provider: every configured provider has a row
  and an accurate count.
- The join is exact and testable without a database: it is a map lookup on an identifier
  CPA already publishes on both sides, with no heuristics to tune.

### Trade-offs

- **History without an index is not attributable.** Records written before the index was
  captured, and records whose credential has been removed from CPA, count toward no
  configured provider. They stay visible in totals and in the request list. The
  alternative — guessing from the family label, the display name, or a provider's only
  key — is systematically wrong in the two cases this decision exists to fix, and a
  number that is confidently wrong is worse than a zero that is honestly narrow.
- **The panel's first paint is unpartitioned.** While the windowed read is absent — the frame
  before it arrives, or a partial failure — rows fall back to the overview's label totals, which
  are not split by serving key, and a channel row then carries its family's mixed total. The
  windowed read replaces them on arrival; the alternative would be to withhold the only figures
  available in that state.
- **The dashboard response grew a second list.** `credentials[]` is one entry per key
  that served traffic in the window rather than per provider, so the payload scales with
  both providers and their keys. Each entry is three small fields.
- **The console now depends on a per-key fact, not a per-provider one.** A key that CPA
  reports without an index cannot be credited, and the provider shows only its other
  keys' traffic — the same honest omission as above, at a smaller scale.

## Alternatives considered

- **Match on the family label and split by position.** Rejected: a label that covers both
  the OAuth channel and every key of a family has no position to split by, and the
  ordering CPA reports keys in is not a claim about which one served a past request.
- **Credit each family's traffic to the provider that holds the most keys, or the first
  one.** Rejected: it invents a distribution rather than reading one, and the invented
  number is displayed as measured traffic.
- **Keep the first row's claim on a label and show the rest as zero.** Rejected: this is
  the defect being fixed. Two providers of one family serving traffic with only one of
  them reporting it is a wrong answer to the panel's only question.
- **Attribute the OpenAPI-compatible label by substring.** Rejected: `deepseek` matching
  `deepseek-pro` would credit one provider with another's requests. Only the exact label
  CPA derives from the provider's own `upstream_name` counts.
- **Resolve the join in the browser from the raw label list.** Rejected: the index-based
  split has to happen where the records are read, because the label alone cannot be split
  into keys and channels. Shipping both halves to the browser and joining there would put
  the same rule in a second place with less information.

## References

- ADR 0017: a request record names the provider key that answered it, resolved at read
  time. This ADR applies the same identity (`auth_index`) to aggregate traffic.
