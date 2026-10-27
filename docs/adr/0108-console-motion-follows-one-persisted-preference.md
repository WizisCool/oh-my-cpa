# ADR 0108: Console motion follows one persisted preference

- Status: Accepted
- Date: 2026-10-27

## Context

The console's smooth-scrolling setting controlled only wheel and keyboard glide. Most other
animations followed the system query independently, while the live routing map always animated
under ADR 0102. An operator could neither reduce all motion nor consistently allow it on a machine
whose system preference disables it.

## Decision

Replace that setting with **Reduce motion**, persisted as `omc_reduced_motion`: `on` reduces motion,
`system` follows the live system query and is the default, and `off` allows full motion. This replaces
the input-glide preference policy in ADR 0046 and the routing-map exception in ADR 0102; their input
classification, animation budgets, concurrency bounds and hidden-page cleanup still apply.

A shared leaf module resolves the policy for React, imperative effects and the document-root CSS
attribute. Chart and number libraries defer to it rather than consulting the system independently.
Reduced motion stops routing trips, geometry animation and scroll glide while retaining static
readings. A permanently mounted library motion provider completes dialog, notification and popup
lifecycles directly, preserving focus and unmounting closed surfaces without waiting for CSS events.

A forward-only migration converts explicitly stored scroll preferences (`on` to `off`, `off` to
`on`, `system` unchanged), keeps a previously stored reduced-motion choice, and removes the old
preference. An installation without an explicit choice follows the system. The facade allowlist
exposes only the new key.

## Consequences

Future effects have one integration point and explicit overrides work in both directions. Existing
scrolling choices survive the upgrade, but now apply to the whole console. Reduced motion omits the
routing trip's temporal encoding; its diagram and counts continue updating. The system listener and
effect cleanup are shared, so changing a preference needs no reload and does not replay missed trips.
