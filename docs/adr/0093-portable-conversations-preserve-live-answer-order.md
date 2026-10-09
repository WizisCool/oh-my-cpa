# ADR 0093: Portable conversations preserve live answer order

- Status: Accepted
- Date: 2026-10-10
- Amends: ADR 0082's export limitation and ADR 0043's portable conversation boundary.

## Context

The live Agent places generated figures among ordered answer parts and groups adjacent
reasoning and capability calls into working timelines. The export snapshot flattened those
parts into separate text, calls and views, so portable HTML could not reconstruct that order.
The PNG path rendered a script-disabled outer document: its nested opaque canvas frames
could not contribute generated UI to the final SVG foreignObject image.

## Decision

Preserve ordered segments in a detached, redacted snapshot. Leaf `answerLayout.ts` owns
reasoning/call grouping; `callFacts.ts` owns call summaries and status/timing facts without a
runtime dependency on a page. The live framework adapts that grouping and the portable
renderer consumes the same segments. Figures keep their position and framing; failed
figures remain diagnostic rows. Permitted result details retain existing redaction rules.

For PNG, leave a slot per generated canvas, draw its frozen document in a separate opaque,
network-blocked frame at the slot's measured width, request the existing bounded SVG picture
protocol, and replace the slot with a PNG data image. The outer transcript remains
script-disabled. Live figure image downloads and conversation PNG use the same
`canvasCapture.ts` primitives. Sender identity, request identity, dimension and raster budgets
remain enforced; a failed figure keeps an explicit unavailable-image note. Every transcript
page must encode before any download starts.

HTML keeps running generated UI only in its existing opaque sandbox. Its fixed disclosure
controls operate locally. Existing bundled fonts, resolved palette tokens, privacy rules
and no-network export CSP remain unchanged.

## Consequences

Portable HTML and PNG preserve the same ordered answer, working timelines and figure
placement. PNG represents the frozen generated document rather than mutations of an
interactive frame already on screen. Long documents retain block-boundary pagination.
Additional sandbox frames exist only while capturing and are removed on success or failure.
Pure grouping/snapshot tests and real-browser script-set content, exact-color PNG pixels,
mobile layout and frame cleanup own these claims.
