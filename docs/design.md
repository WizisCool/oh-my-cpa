# Interface design

OMC is a dense operator console: quiet structure, readable data and clear actions.
This guide explains design intent. Theme values and component APIs live in code.

## Sources of truth

| Need | Read |
| --- | --- |
| Palette definition and derivation | [`palette.ts`](../web/src/theme/palette.ts) |
| Component theme projection | [`themeConfig.ts`](../web/src/theme/themeConfig.ts) |
| Global CSS, type/radius scales and initial render | [`index.css`](../web/src/index.css) |
| Typeface selection and assets | [`web/src/theme`](../web/src/theme) |
| Shared interaction primitives | [`web/src/components/common`](../web/src/components/common) |
| Event and state feedback | [`web/src/components/feedback`](../web/src/components/feedback) |
| Copy and translation | [i18n README](../web/src/i18n/README.md), [style](../web/src/i18n/STYLE.md), [glossary](../web/src/i18n/GLOSSARY.md) |

Change a token in its implementation, not in a second table of color values. Use
resolved tokens/CSS variables in components; derive relationships once in the theme.
The pre-hydration appearance must agree with the chosen theme after mounting.

## Visual language

The navigation sits on a canvas; the working page is one inset rounded panel.
Static cards and tables use fill and hairlines. Menus, popovers, toasts, dialogs and
sheets lift with the shared floating/overlay shadows. Group related content through
enclosure rather than a stack of headings and dividers.

Use the UI font role for interface prose, the mono role for code and aligned values,
and tabular numerals for changing measurements. The default bundled typeface is
Sarasa Mono SC; operator-selected fonts must preserve readability and stay local.
Don't introduce externally hosted fonts, icons or artwork.

Keep chrome muted. Semantic status colors convey actual health/state; categorical
chart colors identify series and must remain distinguishable in both modes. Do not
encode success, failure or selection in color alone. An unavailable reading is not
zero, and an unpriced request is not free.

## Brand marks

Connection branding, credential-provider identity and model manufacturer identity answer
separate questions. A connection renamed or assigned custom artwork must not relabel the
protocol it uses or the maker of a model it serves. Use the semantic provider/credential
entry points in [`LobeIcon.tsx`](../web/src/components/LobeIcon.tsx) and `ModelMark`, not
page-local combinations of preferences, plugin logos and catalog guesses.

[`brandMark.ts`](../web/src/types/brandMark.ts) owns the shared identity and ordered artwork
resolution; [`useProviderBranding`](../web/src/hooks/useProviderBranding.ts) resolves
collection-level sources through shared queries and revalidates the sanitized provider
catalog on mount. The DOM renderer and request-image painter consume the same artwork
candidates. Plugin ownership remains authoritative even when its logo is
missing or a registry read fails. Render plugin SVGs only as isolated images, never as
host markup or direct remote asset requests. Operations/status glyphs remain in the
static icon module, separate from brand identity.

A protocol family is not a provider identity. Only an OAuth channel's family names the
provider a connection belongs to, so only that family may resolve a plugin's artwork or
prove plugin ownership; an API-key family such as `codex` is a dialect several unrelated
connections speak, and lending it one plugin's mark would overwrite the operator's own
choice. A name resolved from the provider catalog is likewise provisional until that read
succeeds: a surface may show the withheld rows, but anything durable — an export above
all — has to say the name is unconfirmed instead of saving it.

## Composition and shared controls

Use the shared page, panel, toolbar, field, empty-state, drawer and confirmation
primitives before creating another page-local version. Keep semantic HTML, labels,
focus management and accessible names when adapting a library component.

Put the primary action where the task finishes. Destructive actions need an explicit
confirmation that names the affected resource. Preserve edits during background
refreshes; distinguish Apply/Save from Cancel and from viewing current server state.
A disabled or pending action should not move surrounding controls.

A table is one dataset with one set of column semantics. On phones, use the shared
labelled-row representation, not a separately maintained mobile dataset. Preserve
ordering, values, action reachability and empty/loading states in either presentation.

## Feedback and loading

- Toasts describe events: a completed save, a failed operation, a copied value.
- Inline notices describe persistent state: unavailable data or required configuration.
- Field validation belongs beside the field. Do not repeat the same failure in a toast,
  banner and dialog.
- Initial absence can use a skeleton. Refreshing existing data should retain the data
  and its geometry, with a local activity indicator.
- A route names the body its loading frame draws (`loadingAs` in `App.tsx`; the bodies
  are in `PageLoading.tsx`). A page's first read keeps its real head and draws that same
  body, so the download frame, the first-read frame and the content land in one place.
- A progress estimate is not elapsed-time truth. Do not invent a time remaining or an
  exact accessibility percentage for work whose total cannot be measured.

Prefer concise, actionable copy. Secondary text explains what the user can do or what
a value means, not internal version history or defensive disclaimers.

## Motion and lifecycle

Motion explains a state transition; it must not delay the action it describes. Keep
transitions short and interruptible, preserving semantic values and focus while visual
readouts settle. Do not animate every item on a large mount or duplicate scroll ownership.

Honor reduced motion and visibility changes. Timers, observers, animation frames,
subscriptions and native listeners belong to a disposable lifetime. Background or
unmounted views must not continue doing presentation work. Test behavior in the lowest
credible layer; browser timing is useful only where the browser engine is the subject.

## Small screens, keyboard and touch

Design for content first, including a 390px-wide phone, dynamic viewport height and
safe-area insets. Avoid page-level horizontal overflow. Dialogs and drawers must keep
the current action and focused field reachable when the keyboard appears. Opening a
list must not raise the keyboard over it: a select the reader can type into uses
[`SearchSelect`](../web/src/components/common/SearchSelect.tsx), which becomes a
bottom sheet on narrow screens.

Use visible labels, keyboard navigation, clear focus indicators and appropriate hit
areas. Do not make hover the only route to information or an action. On coarse pointers,
keep editable text large enough to avoid browser focus zoom. A phone layout must retain
the same information and capabilities as the desktop layout.

## Finishing a UI change

Inspect light and dark modes, a narrow viewport, keyboard flow, loading/error/empty
states and reduced motion where affected. Use [Testing](testing.md) to choose checks.
If a pictured user-facing page changed, refresh the relevant README screenshots with
`pnpm build && pnpm readme:screenshots`; screenshots are presentation assets, not a test
of exact pixels. Do not duplicate this guide in component comments or feature documents.
