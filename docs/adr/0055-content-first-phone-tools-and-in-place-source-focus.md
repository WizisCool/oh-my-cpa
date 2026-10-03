# ADR 0055: Content-first phone tools and in-place source focus

- Status: Accepted
- Date: 2026-10-03

The console keeps one business workflow across viewports, while phones need room to read and act.
At the existing 640px phone boundary, expose primary actions and disclose secondary tools through
click-open labelled menus with selected preference state, 44px rows, focus restoration and platform
Back. `PageHeader.mobileActions` chooses this rendering explicitly rather than hiding arbitrary desktop
buttons. Keep the 900px navigation boundary, existing visual tokens and desktop action arrangement.

The configuration page uses compact non-sticky chrome, locally scrolling categories, retained group
descriptions and a dirty-only measured bottom action bar. YAML wraps by default on phones; a manual
choice survives this source session, rotation and focus changes. A focused workspace fixes the same
Monaco container inside the visible viewport instead of moving or remounting the editor: the draft,
undo stack, selection and scroll are part of the user's working state. Background siblings become
inert while modal portals stay usable, and nested overlays join the existing history contract.

This approach pays for effect-owned viewport/focus observers and careful nested overlay ordering,
but avoids two editors, duplicated save logic and state transfer between them. Keyboard/caret pan
bounds are observed with `visualViewport`; pinch zoom remains the browser's responsibility. Geometry,
focus, editing and Back are browser assertions; viewport policy is logic-tested. Real iPhone keyboard
and selection acceptance remains necessary in addition to simulated viewport tests.
