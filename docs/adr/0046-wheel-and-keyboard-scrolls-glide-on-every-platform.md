# ADR 0046: Wheel and keyboard scrolls glide on every platform

- Status: Accepted
- Date: 2026-10-01

## Context

The console scrolled smoothly on macOS and in steps on Windows. The difference was in the input,
not in the console:

- A trackpad, a phone and macOS deliver a scroll as a stream of small offsets that are already
  smoothed, so any scroller glides.
- A notched mouse wheel on Windows or Linux delivers one 100px jump per notch. Whether the browser
  animates the jump is the operating system's choice. Chromium and Firefox both stop animating it
  when Windows' "Animation effects" setting is off, and many readers turn that off to make the
  desktop feel faster.
- The request list is a virtualized list (`@rc-component/virtual-list`, under antd's `Listy`). It
  clips its own overflow and applies every wheel delta itself, in one jump, so it stepped on every
  Windows desk whatever the setting was. It is the page the console is used through.

The design was tuned on the stream. With 100px steps, the request list's live-tail rules (follow at
the top, hold when reading, collapse the header on the first notch) still worked, but the page read
as a series of cuts instead of one surface.

The same Windows setting is also how Chromium reports `prefers-reduced-motion: reduce`. The console
honours that query for every animation it owns (`docs/design.md` §7). So "honour reduced motion" and
"glide for a Windows reader who turned animations off" cannot both hold if the glide counts as an
animation like the others.

## Decision

1. **A console-wide layer smooths discrete steps and nothing else**
   (`web/src/utils/scrollSmoothing.ts`, installed once by `useScrollSmoothing` in `App.tsx`). Wheel
   notches (line or page mode, or a pixel-mode event whose legacy `wheelDeltaY` is a multiple of
   120) and the scrolling keys (arrows, Page Up/Down, Space, Home, End) glide to the position they
   would have jumped to. Continuous streams (trackpads, every pixel-mode source on Apple platforms)
   and touch are never intercepted, because they already glide and smoothing them again would only
   add lag. Zoom, horizontal and modified wheels keep their native meaning. Keys are left to any
   editable control or composite widget that owns them.
2. **The glide has its own motion token, `scroll` (160ms, easeOutCubic)**, `MOTION_SCROLL` in
   `web/src/theme/themeConfig.ts`. Each notch retargets the glide from where it is, so the token
   bounds how far the glide trails the last notch, not the length of a scroll. The easing starts
   moving at once, because the console's `ease` curve starts at rest and would stall at every notch.
3. **Virtualized lists are driven through their own wheel handling.** The layer claims the notch
   with the library's nested-list flag (`_virtualHandled`) so the list does not jump, then hands the
   list each frame's step as a wheel event of its own. Writing the holder's `scrollTop` directly
   does not work: the list re-applies its offset from React state one frame later and drags every
   frame back.
4. **A component can still give a notch another meaning.** React's wheel listener is passive, so
   `preventDefault` from a React handler does not reach the layer. Such a component calls
   `consumeWheel(nativeEvent)` instead; the request list does this when the first notch collapses
   its header.
5. **The glide is on by default, including under reduced motion.** It is input following the
   reader's own hand, not motion the page starts: macOS and iOS keep inertial scrolling under Reduce
   Motion for the same reason. The Windows switch that reports reduced motion is also the switch
   that removes the browser's own glide, so following it would keep the stepping for exactly the
   readers who reported it. The `omc_scroll_smoothing` preference (`on`, `system`, `off`) on the OMC
   settings page lets a reader hand the decision back to the system's setting, or turn the glide
   off.
6. **Every other motion still honours `prefers-reduced-motion`.** That includes the request list's
   animated return to the top, which moves the page further than the reader's hand did.
   Programmatic corrections are never smoothed, and a glide stops as soon as anything else writes
   its scroller's offset, so a correction always lands.

## Consequences

- The same build scrolls the same way on macOS, Windows, Linux and phones, and the request list
  glides on Windows for the first time.
- A reader who needs reduced motion for vestibular reasons and uses a notched wheel on Windows gets a
  160ms glide by default, and has to choose `Follow system` or `Off` once. That trade-off is
  intended, and the setting sits under Appearance next to the theme mode.
- The layer depends on two details of `@rc-component/virtual-list`: the `_virtualHandled` flag and
  the fact that it accepts dispatched wheel events. The `scroll-smoothing` browser probe drives the
  real request list and fails if either changes. With the layer disabled, the probe shows the
  100px steps.
- A component that calls `stopPropagation` on a native wheel event hides it from the layer's bubble
  phase. No console component does this; one that needs to should call `consumeWheel` as well.
