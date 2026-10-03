# ADR 0054: Loading progress and waiting activity are separate

- Status: Accepted
- Date: 2026-10-03
- Amends: ADR 0052's loading-bar presentation, accessible value and completion lifecycle.
  Task accounting, the 200ms delay, first-load placeholders and refresh data retention remain.

## Context

Queries and lazy imports reveal their start and settlement, but not their total duration. Capped
pending credit is an estimate: a single pending task approaches 85%, and adding tasks can lower
the target while a never-backwards fill waits for it to catch up. In a replay of the existing
policy, one task added at two seconds held the fill for approximately 1.3 seconds. A stationary
fill can look stalled even when the client is still waiting. Announcing this estimate as an
accessible percentage implies a precision the source cannot supply.

## Decision

Keep the task-driven rough fill and separate waiting activity from completed work. The shared
2px bar uses its existing 18% accent-tinted track, an accent fill at 65% opacity, and a solid
accent marker inside the fill's frontier. The clipped window is at most 64px and 16% of track
width; the marker is at most 16px and 25% of the window. Its 1200ms linear CSS transform/opacity
cycle fades at the wrap and continues independently when the fill holds. It indicates pending
client work, not an upstream heartbeat, a remaining-time prediction or additional completed work.

Keep the localized `progressbar` name and omit `aria-valuenow`. Actual pending tasks own
`aria-busy`. Final settlement stops activity and closes the fill within one resolved base-motion
beat, followed by the existing one-beat hold and one-beat fade. Content does not wait for the
animation; failures and cancellations are settlements rather than success verdicts.

Inject the lifecycle clock and scheduler in `web/src/utils/progressController.ts`. Source
notifications must not reset the drawing clock or activity animation. Reduced motion removes
activity and pending estimates, performs task-event-only updates and retires completed work
immediately. Live changes preserve the batch and never shrink its fill. Hidden documents suspend
frames, show timers and activity; unfinished work resumes from its state, while completed work
is not replayed. React does not rerender per animation frame and frames perform no layout reads.

## Consequences

The fill remains approximate, but a held estimate no longer carries the entire burden of
expressing waiting. The activity cycle is a narrow, documented motion-budget exception with
mandatory reduced-motion coverage. Lifecycle decisions are tested with injected time; browser
probes own real animation, clipping, color, geometry and transition cancellation. Palette
values and theme token mappings remain unchanged.
