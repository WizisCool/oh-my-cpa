# ADR 0071: Quota readings report what upstream published

- Status: Accepted
- Date: 2026-10-08

## Context

Three defects reached operators with one shape: a reading was inferred from the
request this deployment sent rather than from the document the provider answered
with.

- Grok's SuperGrok credentials showed a plan name and no usage at all. The quota
  service read only `https://cli-chat-proxy.grok.com/v1/billing`, the metered
  ledger, which a subscription account leaves empty, while the percentage lives in
  the CLI's credits document (`?format=credits`). The plan label still arrived from
  the subscription endpoints, which is what made an empty reading look like a
  missing one. `XaiBillingWeeklyURL` had been declared beside the ledger's URL
  since the parser was written and was never requested.
- Kimi credentials on plans without a weekly limit showed no usage. The parser
  decoded `usage` and `limits`, and such a plan publishes its windows as ratio
  pools under `usages`.
- A Codex free account's monthly limit was labelled "5-Hour". The primary window's
  identity was hard-coded to the five-hour slot, and the period the payload states
  (`limit_window_seconds`) overrode it only for the weekly and five-hour cases, so
  a 30-day limit kept a five-hour name, label and id while its own reset reported
  otherwise.

All three shared a second, quieter defect: every window parser but Devin's returns
zero windows with a nil error, which the status machine renders as `idle` — the
reading a credential nobody has read carries. A provider that answers with nothing
therefore looked exactly like a provider nobody had asked, and the console invited
the operator to repeat the read that had just come back empty.

Reference implementations agree on what these documents are. CPAMC reads both xAI
billing URLs and prefers the credits period, decodes Kimi's
`usages.limit_month_total`, and derives an xAI window's length from
`currentPeriod.start`/`end`; CodexBar documents the same credits endpoint, the same
ratio pools and the same period derivation. Neither was matched, and the fixtures
had encoded the opposite of reality — the credits content served at the ledger's
URL, and the ratio pools absent — so the tests agreed with the defect.

## Decision

**A window's identity follows the duration its own payload states.** A Codex
standard-scope window takes its id, label and kind from `limit_window_seconds` for
every period the console localizes (five-hour, daily, weekly, monthly); the slot a
limit arrived in names it only when the payload states no duration, which is the
rule the model-scoped and code-review windows already followed. A Kimi ratio pool's
period comes from its own key, and the keys are read as a set rather than as named
fields, because the family is open-ended and a plan publishes only the durations it
meters. Capacity eligibility follows the same kinds, so a monthly standard window is
estimated on the terms the five-hour and weekly windows are.

**A reading is taken from the document that carries it.** xAI reads both billing
documents, and the period stays atomic: a window and its reset come from one
document, while the ledger's monthly figures arrive beside it as extra usage rather
than merging into a window whose clock they do not share. Either document may be
absent or unreadable without failing the read. Kimi decodes its ratio pools, and a
counted limit that already describes a period wins that period, because it carries
the absolute usage a ratio cannot.

**An empty reading is an observation.** A read that succeeds without publishing a
window is recorded as `unpublished` and preserved through the stored status, which
the read paths seed back into evaluation. The status machine keeps it while there is
no window, no error, no cooldown and no disabled credential; every other branch
recomputes as before. The console labels it, and its empty-state copy, separately
from the idle reading, so the two stop being one message. The triage filter keeps
its existing `unobserved` bucket for both, because an operator looking for a
credential without a usable reading wants both.

Upstream billing instants are read with both the strict and the fractional-second
layout. The CLI writes fractional seconds with an explicit offset, and a rejected
instant silently costs a window its reset.

## Consequences

- The xAI credits read adds no authority: `IsAllowedQuotaURL` already admits a
  query on the ledger's allowlisted path, and the target stays server-owned. The
  added work is one GET with CPA's credential marker.
- `unpublished` is a new stored status value; existing snapshots keep the values
  they hold. The marker is consulted only in the branch that grades a credential
  with no window, so no other status becomes sticky, and a later window replaces it
  normally.
- A window id can change once for a credential whose period was misfiled (a Codex
  free plan's primary window moves from `five_hour` to `monthly`). Cycle-keyed
  calculations read the id, so history and detected reset evidence filed under the
  old id no longer apply to that window: the credential loses its previous-cycle
  reference and its reset evidence once, and reports on the correct period from
  then on. That is the price of the id following the period, and the reason it has
  to: a monthly window filed under a five-hour id was already being read by
  five-hour cycle arithmetic.
- A provider that reshapes a document now degrades to an explicit empty reading
  rather than a silent one. That is the point — the failure is visible in the card
  instead of being reported as a credential nobody read.
- Kimi's ratio windows carry the share alone. No counts are invented for them, so a
  reading that needs absolute usage finds none rather than a fabricated pair.

## Verification

`internal/quota` tests pin the pair that yields a subscription's window while
keeping the ledger's figures beside it, a single usable document still reading, a
pair without a config failing, a document without a period keeping the weekly
assumption, Kimi's ratio pools and the period each key names, the counted limit
winning its own period, an unknown key keeping its name, either ratio scale,
Codex's monthly primary window taking the monthly identity while the five-hour
shape is unchanged, a monthly standard window remaining estimable, and the empty
reading surviving evaluation and a reload while a later window replaces it. The
subscription test serves each xAI document from its own URL with
fractional-second instants. The demo fixture answers both xAI documents separately,
which `internal/demo/demo_test.go` requires of every URL the service may call.
