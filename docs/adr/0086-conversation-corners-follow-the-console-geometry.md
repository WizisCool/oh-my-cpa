# ADR 0086: Conversation corners follow the console geometry

- Status: Accepted
- Date: 2026-10-08
- Amends: ADR 0081's radius values. Its fill, framing, typography and motion rules remain unchanged.

## Context

Agent and Playground share a conversation workspace, while the surrounding console uses
4px controls and cards. The conversation's larger corners make the two surfaces read as
different visual systems. Conversation objects still need a small shape hierarchy without
letting geometry outweigh their content.

## Decision

1. Printed output and pressed controls use 4px corners, matching the console.
2. Field panels and floating lists use 6px corners. Composers, operator bubbles,
   approval cards, question panels and suggestions use 8px corners.
3. Keep the existing semantic token names and foreground grouping fills. `THREAD_RADII`
   in `web/src/theme/palette.ts` owns the values; the theme projection and HTML
   conversation exports read it. `web/src/index.css` mirrors the first-frame defaults.
4. Apply the scale to both conversation workspaces and shared approval cards. Other
   console components retain their existing geometry.

## Consequences

Conversation controls and document frames blend with the console, while larger conversation
objects retain a modest distinction. Existing CSS consumers need no per-element overrides.
Palette projection tests pin the values and their pre-hydration defaults.
