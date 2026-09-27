# ADR 0025: Console icons come from Lucide through an Ant Design-shaped layer

- Status: Accepted
- Date: 2026-09-27

## Context

Every surface of the console drew its icons from `@ant-design/icons`, so that package was a direct
dependency of `web/`. Two facts made replacing it worth the churn:

- The console could not choose its own icon set; the vocabulary was whatever that package shipped.
- `.anticon` is load-bearing beyond that package. antd's own components still emit the class, and
  first-party CSS still selects on it (`.req-back-to-top-btn .anticon`,
  `.request-source-chain > .anticon`), so the class names have to survive whatever draws the icons.

The package also injects its stylesheet (the `.anticon` box model and `.anticon-spin`) at runtime when
one of its components mounts. Those declarations were therefore not ours, and our icons depended on
another library mounting something on the same page.

## Decision

`web/src/components/icons/index.tsx` is the console's icon layer. It wraps Lucide components in
forwarders that keep the Ant Design names (`<ApiOutlined />`, `<SyncOutlined spin />`) and the
`anticon`/`anticon-<name>` classes, so all 52 consumers import the layer rather than an icon library.

`web/src/index.css` owns the two declarations the console relies on:

- the base box model (`display`, `align-items`, `color`, `line-height`, `vertical-align`);
- the spin keyframes.

The base rule is a subset of what the removed package injected, property for property identical to
it, so antd's own icons render unchanged. The spin animation is 900ms per rotation, matching the
indeterminate progress bars, and it is registered as a `duration` exception in
`scripts/check-motion.mjs`: a rotation is a loop whose period is not a state transition, so §7 freezes
it under reduced motion rather than shortening it. An exception that stops matching fails the check.

`web/package.json` lists `lucide-react` and no longer lists `@ant-design/icons`. antd still depends on
that package internally; this ADR covers what *our* code imports, and the console does not reach into
antd's copy. `export * from 'lucide-react'` re-exports the full set for callers that want an unwrapped
icon, and is tree-shaken: the built chunk contains the icons the layer wraps and none it does not.

## Consequences

- The console owns its icon vocabulary; changing or extending it is a one-file edit.
- Icon alignment and spinning no longer depend on another package's runtime injection.
- `vertical-align: -0.125em` and `line-height: 0` are ours to keep correct. Without the base
  rule a Lucide glyph falls back to `vertical-align: baseline` and the box model the console's
  CSS and antd's components expect; the declarations were taken from what the removed package
  injected rather than tuned by eye.
- A Lucide glyph and the Ant Design glyph it replaces are similar, not identical, so a change to the
  layer's mapping still needs a visual review.
