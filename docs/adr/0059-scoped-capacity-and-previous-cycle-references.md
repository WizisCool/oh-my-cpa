# ADR 0059: Scoped capacity and previous-cycle references

- Status: Accepted
- Extends ADR 0058's read-time estimation; supersedes its global-only scope and
  absence of previous-cycle references.

## Decision

Keep capacity estimates as read-time joins from locked request costs, and extend
that join to model-metered windows. Prefer the upstream-served model recorded by
CPA; otherwise accept recognizable canonical requested identities. Claude's
Sonnet, Opus and Fable windows meter families, while an explicit model window
meters that model release (including dated snapshots). Antigravity group names
are mapped by an exact reviewed allowlist, never by substring guesses. Every
recorded identity must be classifiable; an unresolved alias, unknown group or
unknown period withholds the entire scoped numerator, not just its dollar value.

When a fresh, valid current cycle has too little consumption, no recorded traffic
or no used-share reading, expose the final retained estimate of the immediately
preceding scheduled cycle as a **Previous-Cycle Capacity Reference**. It is not the
previous cycle's total actual usage. Its `basis`, observation time, start and reset
instant travel with the estimate, while `usage` and `capacity_unavailable` continue
to describe the current cycle. The console labels the reference and its observation
time; Agent/MCP consumers receive the same provenance. Never skip a cycle, cross
changed model scopes or periods, or reuse an early-reset cycle to find a number.
Adjacent boundaries may differ by at most one second to tolerate derived-clock
rounding.

Detect a reset anywhere in the retained sequence, even after consumption recovers.
A used-share drop greater than one percentage point or a premature boundary
replacement greater than one second is reset evidence. Persist only its sticky
`has_mid_cycle_reset` observation flag in the existing window JSON, until the cycle
ends. This preserves detected resets after the 50-snapshot retention evicts their
original readings, without lifecycle tables or a migration. Failed and disabled
refreshes never become new observations; quota status alone is not freshness
provenance, because cooldown can override an error status.
A failed history read does not block fresh observations: save them with a sticky
`has_incomplete_history` marker for that cycle, withhold estimates/references and log
the evidence failure. This is distinct from an observed upstream reset.

## Consequences

- Missing, corrupt or unreadable history and unreadable usage fail closed. A missing
  preceding snapshot yields no reference; it is not a reason to invent one.
- The evidence is bounded by retained observations. A reset that was never observed
  cannot be detected; a migrated installation has no sticky evidence for evicted
  history. A real persisted lifecycle could provide stronger historical guarantees,
  at the cost of schema and maintenance work.
- A new Antigravity group needs an explicit reviewed mapping. Opaque aliases need a
  served model identity; current alias configuration cannot reconstruct historical
  routing, so the estimate does not depend on live CPA alias/model reads.
- Late-arriving events inside an observation's range are included on the next read.
  The estimate can change on backfill; it is not a frozen balance or routing input.
- The error allowance covers half-point percentage rounding only. It is an
  approximate relative uncertainty, not a statistical confidence interval; external
  traffic, incomplete price coverage and model mix remain separate limitations.
