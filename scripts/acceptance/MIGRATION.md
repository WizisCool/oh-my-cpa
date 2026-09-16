# Browser acceptance migration ledger

Every assertion in the browser acceptance suite is classified once, and every
assertion that leaves the browser names the test that replaced it. The point of
the ledger is that no claim is dropped without a replacement: an assertion may
move, but it may not disappear.

## The probe files that were removed

Beyond the acceptance suite, six standalone probe entry points were deleted:
`browser-usage-events.mjs`, `browser-refresh-sync.mjs`, `browser-icon-picker.mjs`,
`browser-dashboard-charts.mjs`, `browser-column-alignment.mjs` and
`browser-performance.mjs`. Every claim worth keeping now lives in
`scripts/browser-probes.mjs`, which runs them as scenarios against one shared dev
server and one browser:

| Former file | Where its claims live now |
| --- | --- |
| `browser-column-alignment.mjs` | the `column alignment` scenario, unchanged in strength |
| `browser-icon-picker.mjs` | the `icon picker stacking` scenario, unchanged in strength |
| `browser-dashboard-charts.mjs` | the `dashboard chart marks` scenario, unchanged in strength |
| `browser-refresh-sync.mjs` | the `refresh sequencing` scenario, including the held-response ordering proof |
| `browser-usage-events.mjs` | the `request list interactions` scenario for the virtualization bound, the column resize and its persistence, keyboard access to the detail drawer, and the request-log download gate |
| `browser-performance.mjs` | nothing - see below |

Claims that are deliberately not restored, listed so the loss is a decision rather
than an oversight:

- **The collapse gesture choreography** (`first wheel down collapses the header`,
  `row 1 remains visible after entering full-screen mode`, the wheel-up bounce, and
  the scroll-to-last-record tour) from `browser-usage-events.mjs`. The probe keeps
  the bounded-window claim, which is the part that makes a long list usable. The
  scroll *schedule* is unit-tested in `scripts/test-scroll-intent.ts`; what no test
  now catches is the header failing to collapse on a wheel gesture.
- **The forced-minimum-width token measurement** (`token column reached its 130px
  minimum`, `token cell holds the largest real numbers at its minimum width`).
  `column alignment` covers track geometry, truncation and the responsive override;
  this was a second measurement of the same layout at one specific width.
- **The 320px interactive sweep.** Redundant with the 390px and 768px overflow and
  drawer checks in the acceptance suite. 320px itself is still a supported width -
  the settings picker and the auth-files viewport check both assert it - so what was
  dropped is the sweep, not the viewport.
- **`browser-performance.mjs` in full.** It asserted page-load timings against a dev
  server, which measures the mock and the machine rather than the product. It ran in
  no gate and its numbers were never a budget. The one timing claim that is a real
  budget - the pricing page opening under 3s - lives in the acceptance suite.

## Classes

| Class | Meaning |
| --- | --- |
| `PURE` | A decision about the operator's own input. Provable by calling the module the page calls. |
| `COMPONENT` | Needs a rendered React tree, but not a real browser engine. |
| `BROWSER` | Needs real Chromium: geometry, stacking, hit-testing, paint, virtualization, focus, lifecycle. |
| `CROSS-STACK` | Needs the whole stack — SPA + Go binary + SQLite fixture + fake CPA. |

## Migrated out of the browser

Granular policy logic and state permutations below had their primary, exhaustive
verification migrated from timing-sensitive browser steps into deterministic
Node-based logic tests (such as `scripts/test-usage-events-view-policy.ts`). High-level
end-to-end user workflows that integrate these capabilities in live browser sessions
continue to be exercised by `scripts/browser-acceptance.mjs` and its focused
domain modules under `scripts/acceptance/`.

| Original claim | Class | Replacement |
| --- | --- | --- |
| A filter edit commits the dimension it names to the URL | `PURE` | `scripts/test-usage-events-view-policy.ts` — *a filter edit replaces the dimension it names and leaves the window alone* |
| Removing a chip clears the filter from the URL | `PURE` | *a filter edit can remove a dimension, which a merge could not express*; *setting, widening and clearing one dimension…* |
| Clear-all removes every filter but keeps the window and page size | `PURE` | *clear-all removes every filter and the verdict but keeps window and page size* |
| Clear-all keeps an explicitly chosen window | `PURE` | *clear-all leaves an explicitly chosen absolute window in place* |
| A cleared filter stays cleared after a reload | `PURE` | *the saved view is derived from the navigated URL, not merged from the previous query* — the derivation this replaced is the bug that resurrected it |
| The saved view restores window and page size on the bare route | `PURE` | *an absolute window is saved as bounds…*; *the saved view carries the layout choices it was given* |
| A cost filter travels as exactly one parameter | `PURE` | *cost is stored once, as its own field, and never inside the filter map*; `filterParamsToUrl` round trips are already pinned in `test-usage-event-view.ts` |
| The time menu sets an explicit window | `PURE` | *a preset replaces an absolute range instead of stacking beside it*; *an absolute range replaces a preset…* |
| A filter and a window coexist in the URL | `PURE` | *a filter edit replaces the dimension it names and leaves the window alone* |
| A reversed range is explained inline and blocks Apply | `PURE` | *a reversed or equal range is refused*; *the validation outcome maps to the message key* |
| A range past now is refused | `PURE` | *a range reaching past now is refused* |
| Every preset appears exactly once, whichever is selected | `PURE` | *every configured preset appears exactly once, whichever one is selected*; *the quick group and the rest partition the presets* |
| A typed alias marks the draft as changed | `PURE` | `isDraftDirty` in `test-usage-event-view.ts` |
| A queued search debounce cannot revive a cleared filter | `PURE` | *an invalidation reached through the controller suppresses a queued commit*; *an invalidation suppresses a callback that already fired but has not run* |
| History navigation discards a pending keystroke | `PURE` | *adopting an external committed value cancels the queued keystroke* |
| The search box follows the navigated term across two saved views | `PURE` | *a keystroke after an external navigation commits against the new view* |
| A parameter that cannot be applied is reported, not dropped | `PURE` | `rejectedEventParams` — already pinned in `test-usage-event-view.ts` with 13 references |
| An over-long or invalid filter value is refused | `PURE` | `readEventQuery` / `parseUsageRangeBound` in `test-usage-event-view.ts` |
| A poll does not re-read the facets | `PURE` | *every reason to skip a tick is honoured* + `staleTime` policy in `staleTime`/`pollingPolicy` |
| Auto-refresh starts off and the label states no cadence | `PURE` | *the cadence is not a round-trip afterthought*. The switch's rendered state stays a browser claim. |
| The result verdict is a filter with no URL parameter of its own | `PURE` | *a result verdict is committed, and "all" removes it rather than storing it* |
| A filter change drops the pagination cursor | `PURE` | *a filter edit never touches the pagination cursor it is about to invalidate* — the drop is the page's separate decision, pinned by the same test |
| A refresh that could not drain CPA is reported as incomplete | `PURE` | *a pull that could not drain CPA is reported as incomplete rather than successful* |
| A disabled collector is information, not an error | `PURE` | *a disabled collector is information, not a failure* |
| The refresh re-reads list, facets and pipeline status | `PURE` | *a completed refresh re-reads every surface the pull could have changed* |
| A caller chip shows the alias rather than the fingerprint | `PURE` | *a caller chip prefers the alias, then the mask, then the raw fingerprint* |
| A credential chip shows the file name | `PURE` | *a credential chip shows the file name rather than the stored fingerprint* |
| Row ordering is by request time, newest first | — | Already a Go regression: `TestListUsageEventsOrdersByRequestTime` in `internal/repository`. The browser copy cannot fail for the reason its name gives. |
## Renamed or merged

These claims still exist under a name that no longer matches the original, because a
loop became a single case or two checks about one transition were merged. They are
listed so a reader diffing the two revisions can account for every line rather than
trusting that a name change was a deletion.

| Before | After |
| --- | --- |
| the list is ordered by request time, newest first | the rendered time column is monotonic, newest first |
| the saved window is restored on the bare route, the saved page size is restored on the bare route | the saved window survives a reload |
| the cleared filters stay cleared on the bare route | the cleared filters stay cleared after a reload |
| clear-all keeps the window and the page size | folded into the two reload checks above |
| a typed alias reaches the URL, the alias is reported as a chip | a typed alias reaches the URL and is reported as a chip |
| the search box shows the navigated term (alpha-search, beta-search) | the search box shows the navigated term |
| the navigated term survives the debounce window (alpha-search, beta-search) | the navigated term survives the debounce window |
| with {selected} selected, {preset} appears exactly once - 14 checks over two loop iterations | the window menu lists every preset and not just the unselected ones, the preset menu is rendered from the same policy the tests assert |
| the single fixture provider renders exactly one enable switch | every provider in the fixture renders exactly one enable switch |
| clear-all removes the filter | clear-all removes every filter |
| a cost filter travels as exactly one parameter | no cost parameter is duplicated in the restored URL; the serializer half is pure |

## Retained in the browser

| Claim | Class | Why it must stay |
| --- | --- | --- |
| `/omc` redirects, sign-in rejects a wrong key, a valid key creates a session | `CROSS-STACK` | The auth boundary. Cookie attributes, redirect status and the `Secure` derivation are browser/HTTP facts. |
| Every route renders with no document overflow | `BROWSER` | Layout, not presence. A route can render and still overflow. |
| The filter drawer is on screen at 768px and 390px, including mid-slide | `BROWSER` | Geometry. The failure mode is an off-screen panel, invisible to any DOM assertion. |
| The custom time dialog stays on screen at both widths | `BROWSER` | Same, for a second surface that only exists while open. |
| Request rows ellipsize instead of expanding their column | `BROWSER` | `scrollWidth > clientWidth` is a paint fact. |
| Header and body column tracks line up | `BROWSER` | Two independent grids agreeing is geometry. |
| The numeric columns are right-aligned and stay right-aligned | `BROWSER` | …and the responsive override actually wins. A specificity slip is invisible to CSS text. |
| The provider cell keeps its icon and label vertically centred | `BROWSER` | Cross-axis alignment of rendered boxes. |
| The icon picker stacks above the open drawer | `BROWSER` | `z-index` + `elementFromPoint()`. Portals are antd's, so only the engine can say. |
| The virtualized list holds a bounded DOM at the top, middle and bottom | `BROWSER` | Virtualization is a rendering behaviour. |
| A poll does not scroll the reader or reorder the rows under the cursor | `BROWSER` | Rendered row identity across a real interval, with the reader's scroll offset as the invariant. |
| The back-to-top pill reports the arrivals and returns to the top | `BROWSER` | Scroll geometry plus a server-counted value. |
| A rapid burst settles on the last click and coalesces | `CROSS-STACK` | The rendered switch, the gateway's stored value and the write count must agree. |
| Two overlapping toggles leave both changes on the gateway | `CROSS-STACK` | The operator-visible outcome of a real interleaving. The lost-write regression is the Go test; this is the end-to-end outcome. |
| The brand mark follows the console's theme, with rendered ink | `BROWSER` | Pixels, and the console theme rather than the OS scheme. |
| The collapsed rail centres its mark | `BROWSER` | Geometry after a width animation. |
| The theme persists across a reload and applies during hydration | `BROWSER` | `localStorage` plus a browser lifecycle. |
| Lighthouse-free dashboard sparkline marks are fill-only | `BROWSER` | A canvas/SVG paint fact. |
| Quota progress bars have a positive rendered fill | `BROWSER` | Computed width after a live refresh. |
| Console, page and request errors are empty | `BROWSER` | Runtime health. |
| Secret material never reaches the DOM, storage or a response body | `CROSS-STACK` | A security predicate over the real stack. |
| The session expires when the cookie is cleared | `BROWSER` | Cookie lifecycle. |
