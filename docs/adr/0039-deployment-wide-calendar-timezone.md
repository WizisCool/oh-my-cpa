# ADR 0039: Deployment-wide calendar timezone

- Status: Accepted
- Date: 2026-09-29
- Supersedes: The browser-owned timezone source in ADR 0005; its exact calendar bounds and DOM-grid decisions remain unchanged.

## Context

Browser-local timestamps, browser-supplied heatmap days and server log timestamps could describe different calendars for the same deployment. Operators need one shared timezone while preserving the identity of historical requests and the interpretability of upstream evidence.

## Decision

Persist an optional IANA timezone in OMC preferences. Its default is the deployment's timezone, including `TZ` for containers. Apply it to console timestamp presentation, natural-day grouping, picker interpretation and OMC service-log timestamps. Send the resolved zone to calendar APIs; API requests without an explicit zone use the same server-side setting. Embed IANA data for offline named-zone loading.

Keep stored epoch timestamps, durations, rolling windows and protocol instants unchanged. Preserve raw upstream logs; interpret CPA's offset-free log timestamps using the shared deployment timezone. The supplied full Compose stack passes the same `TZ` to both products. Pricing tiers retain their explicitly defined UTC time-of-day contract: a presentation preference must not silently change request billing.

## Consequences

Different browsers see the same calendar. DST and fractional offsets require instant-specific conversion, not a single fixed offset. Successful preference commits publish an atomic location for running log handlers without mutating process-global time state. Native deployments must have an identifiable local timezone; container operators should set an IANA `TZ`. UI components and capabilities share one validated preference rather than acquiring independent timezone defaults.
