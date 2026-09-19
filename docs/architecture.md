# Oh My CPA architecture

Module map, data flows, and the invariants that hold them together. Domain
vocabulary lives in `CONTEXT.md`; visual rules live in `docs/design.md`; the
decisions behind the shape below are recorded in `docs/adr/`.

## 1. Runtime shape

```text
browser ──▶ reverse proxy or Vite ──▶ Go process (one binary)
                                        ├─ chi router under the base path
                                        ├─ embedded React SPA (internal/web/dist)
                                        ├─ SQLite (WAL, one connection)
                                        ├─ usage collector  ──▶ CPA
                                        └─ pricing sync loop ──▶ models.dev

Go process ──▶ CPA management API (/v0/management) ──▶ upstream providers
Go process ──▶ CPA RESP usage channel
```

One process, one SQLite file, one Oh My CPA replica. The Go process owns the
base path contract: the SPA is served at `<base>/`, the API at `<base>/api/v1`,
media at `<base>/media`. The embedded bundle's hashed assets are served from
`<base>/assets/` and provider SVGs from `<base>/lobe-icons/`; unknown non-API
paths fall back to the SPA shell. The proxy must preserve the prefix rather than
strip it (ADR 0001).

The React bundle is built into `internal/web/dist` and embedded with
`go:embed`, so a deployment has no CDN or static-file dependency. Everything the
browser can reach is a handwritten JSON endpoint; there is no generic pass
through to CPA.

### Demo mode is the same process with the gateway replaced

`OMCPA_DEMO_MODE=true` runs this binary against its own fixture; see §12. The shape
above still describes it, with two edges replaced and one added:

```text
browser ──▶ Go process (one binary, demo mode)
              ├─ chi router + the demo policy (internal/api/demo_policy.go)
              ├─ embedded React SPA
              ├─ SQLite (temporary, rebuilt on every boot)
              ├─ CPA management API ──▶ internal/demo's in-process fixture (loopback)
              └─ usage collector: not started; pricing sync: not started
```

There is no arrow to models.dev and none to a provider, because the demo starts
neither the pricing sync nor any capture loop, and the fixture answers the quota
reads from its own catalogue instead of forwarding them. It does listen: the console
is served on the port the platform routes to. What it never does is connect anywhere
but its own fixture.

## 2. Go package map

Dependency direction is acyclic at package level. `internal/usage` (payload
decoding) and `internal/usage/ingest` (the capture loop) are separate packages,
so `repository → usage` and `usage/ingest → repository` do not form an import
cycle even though the `internal/usage` directory appears in both directions.

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `internal/config` | Environment parsing and defaults; `.env` loading | — |
| `internal/domain` | Durable entities (`CPAInstance`, resources) | — |
| `internal/crypto` | AES-GCM envelope for secrets at rest | — |
| `internal/security` | Redaction, keyed-HMAC fingerprints, display masks | — |
| `internal/auth` | Admin session cookie: sign, verify, rotate | — |
| `internal/usage` | Decode CPA usage/error payloads into typed events | `security` |
| `internal/usage/resp` | Minimal RESP client for CPA's subscribe/LPOP subset | — |
| `internal/pricing` | Catalog snapshot, model matching, sync service, money math | — |
| `internal/cpa/management` | Typed CPA `/v0/management` client and RESP stream wrapper | `internal/usage/resp` |
| `internal/cpa/discovery` | Normalize CPA resources into the local identity model | `management`, `crypto`, `domain`, `security` |
| `internal/cpa/configyaml` | YAML document editing that preserves comments and unknown keys | — |
| `internal/repository` | SQLite schema, migrations, queries, transactional invariants | `crypto`, `domain`, `pricing`, `security`, `usage` |
| `internal/usage/ingest` | Collector loop, decode processor, rollup and retention maintenance | `repository`, `management`, `security`, `usage` |
| `internal/quota` | Per-provider quota probes and normalization | `management` |
| `internal/demo` | The publication fixture: an in-process CPA stand-in, the seeded history, and the capture state the console renders | `domain`, `pricing`, `quota`, `repository`, `security`, `usage`, `usage/ingest` |
| `internal/api` | Routes, DTO allowlists, audited sensitive reveals, audit writes, the demo policy | all of the above, `internal/web` |
| `internal/web` | `go:embed` of the built SPA | — |
| `internal/app` | Wiring, background loops, graceful shutdown | all of the above |

Two rules keep the boundary meaningful:

- `internal/repository` owns transaction boundaries. Anything that must be
  atomic with a write (cost locking, inbox→event promotion, rollup checkpoints)
  is a repository method, not a sequence of calls from a service.
- `internal/api` owns the allowlist. A new response field is a deliberate DTO
  change; the allowlist tests fail otherwise. Every management surface declares its own
  response shape (`ProviderItemDTO`, `QuotaItemDTO`, `PluginItemDTO`,
  `managementAuthFileResponse`, …) instead of forwarding the facade model it decoded CPA
  into, so a field added there for decoding cannot reach a caller without a decision at
  this boundary. The plugin projection is also where manifest text is bounded
  (`management_plugin_projection.go`), because that text arrives from an installed plugin.

### Known coverage gaps

- The browser suite had a history of timing-sensitive flakes in the usage-events
  filter section, unrelated to the provider write path: `the list is back to the
  unfiltered page` and `the queued search still lands` each failed once in repeated
  runs before the request-view policies were lifted out of the page. They were fixed
  rather than tolerated - see §11.3 - and the diagnosis was confirmed by reproducing
  them on the unmodified baseline commit, two runs in three, under a 2-CPU
  constraint. The suite now passes eight consecutive trials in the configuration the
  baseline failed, including with the probes running concurrently.
- The lost-update regression is the Go test, not the browser check. The interleaving
  that loses a write depends on two requests overlapping at CPA, and a browser run
  cannot force that: removing the gate still produced a green browser run, because
  the first write happened to land before the second read. The browser check
  therefore asserts only the operator-visible outcome, and
  `TestConcurrentProviderTogglesDoNotLoseAWrite` (which controls the ordering at
  the fake gateway) is the check that fails when the gate is removed.
- The stale-list-read guard (a read issued before a confirmation is discarded
  rather than published over it) is reasoned and implemented but has no automated
  check: the console's list read and a toggle's internal read are the same CPA
  endpoint, so a fixture cannot delay one without delaying the other, and the
  ordering cannot be produced deterministically yet. The browser suite therefore
  covers the concurrent-toggle and rapid-burst paths, not this one.
- The `503 write_busy` refusal is covered where it is decided (the gate test in
  `internal/api`, and the retry-classification test for the controller), but not
  end to end: producing it in the browser needs the gate held open from outside
  the page, which the fixture cannot express. Its user-visible message is checked
  by `pnpm check-i18n` and type-checking only.
- `isRetryableWriteFailure` in `web/src/api/client.ts` is the classifier the
  toggle's retries depend on, and it is not directly unit-tested: the module
  imports the application's whole type graph (one of its type-only imports is
  unresolvable under the test runner's loader), so the harness cannot import it.
  Its behaviour is exercised only through the controller tests' own predicate,
  which mirrors it. Moving it to a module with no application imports would make
  it testable.

### Effect-scoped resources must survive a StrictMode remount

React runs mount, unmount, and mount again for every component under `React.StrictMode`
in a **development** build. `web/src/main.tsx` enables StrictMode, so any resource a
hook owns has to be created where the effect that owns it is created, and its
cleanup has to release the resource rather than leave a disposed one installed.

A resource created during render and disposed in an effect cleanup is disposed by
the simulated unmount and then reinstated by the remount, so consumers hold a dead
object. That failure is silent and one-sided: operations on it become no-ops, so a
control still animates while nothing is sent, and every production-bundle check
passes because StrictMode's checks do not run in a production build. It reached a
user as "the provider switch no longer toggles" on the development server while the
deterministic browser suite was green.

`web/src/hooks/disposableSlot.ts` implements the rule (setup builds and installs,
teardown disposes and releases, a replacing setup disposes what it replaces) and
`scripts/test-provider-toggle-queue.ts` exercises the mount/unmount/remount sequence
directly. When adding a hook that owns a disposable resource, use the slot rather
than a ref that is disposed in place.

### Provider configuration write gate

`internal/api` serialises every whole-list provider configuration write through
one process-wide gate (`management_provider_writes.go`): the status toggle, the
provider create/update/delete paths, and the configuration-source writer, which
replaces the same document.

This is a correctness invariant rather than a performance choice. CPA exposes no
per-entry write for a provider family, so a change means reading that family's
list, editing it, and writing the whole list back. Two such writes that overlap
read the same baseline and the later one discards the earlier, which loses a
change that both requests reported as successful. The per-provider last-intent
queue in the browser cannot close that window: it deliberately runs writes for
different providers concurrently, and those are exactly the writes that collide
over one family's list. The revision check on the configuration-source path
detects a change that already landed but not one landing between its read and its
write, which is why that path takes the same gate.

Properties to preserve when changing this code:

- The read happens inside the gate, together with the write. Acquiring only
  around the write keeps a stale snapshot and reproduces the lost update.
- The permit is a single slot, so the helper that performs the read-modify-write
  must not be called while already holding it; re-entry deadlocks against the
  caller's own acquisition and surfaces as a busy refusal.
- Acquisition is bounded and cancellable. A caller that cannot enter is answered
  `503` with `code: write_busy` and no gateway write has started, which is what
  makes the refusal safe for the client to repeat.
- The permit is released on every exit path, including a panic in the callbacks.
- The gate is process-local. It orders this console's own writes; it cannot order
  writes made to CPA by another client, and it does not make click order
  authoritative across clients.
- A provider is addressed by its position in the family, so a write carries the
  identity the operator saw (`expected_auth_index`, or `expected_name` for the
  family without an auth index) and the handler refuses the write when the entry
  at that position is no longer it. A retry repeats the position, and positions
  shift when a provider is deleted; without this check a retry would toggle a
  different provider and report success. The precondition is optional, so a
  caller with no identity to send still works, and a mismatch answers `409`
  rather than writing.
- The operator's name, website and icon for a provider are stored under the
  same positional id (`provider_names`, `provider_websites`, `provider_icons`).
  A delete therefore re-keys every later entry of that family
  (`shiftPositionalProviderIDs`), because otherwise the name given to one
  credential would relabel whichever credential took the freed index, and the
  deleted row's own brand mark would reappear on it. The icon overlay is written
  by the console through the preferences API rather than by a provider save, so
  the server both re-keys the stored document and the console replays the same
  shift into its local cache - a cache that kept the deleted key would write it
  back on the next icon change. The name and website overlays of an update are
  written only after the gateway accepted the write, while the icon overlay is
  written by the console through the preferences API and so is never part of a
  provider save: the row, the request list's provider label and the name resolver
  read these maps, so an entry recorded ahead of a refused write would leave the
  console naming a credential CPA never accepted.

### Provider families are data, not code paths

CPA stores `claude`, `codex`, `gemini` and `meta` credentials as four lists with
one shared entry schema and one shared write shape. The console mirrors that:
`internal/cpa/management/config_keys.go` owns the family values, the endpoints
and the decoding, and `internal/api/management_providers.go` holds one
declaration per family (`providerConfigFamilies`) that supplies the presentation
constants, with the list projection it feeds beside it. The writes live in
`internal/api/management_provider_crud.go`, the enable/disable toggle in
`management_provider_status.go` and the model-list pull in
`management_provider_models.go`, and all of them are written once against that
table.

Adding such a family is a constant plus a row, and the pieces that must stay in
step are the same three in both stacks: the family's credential list in CPA, its
row in that table, and its label in `PROVIDER_FAMILIES`
(`web/src/types/providerFamilies.ts`). A family that reaches the API but not the
frontend table renders as a row without a protocol label, so both the contract
test in `internal/cpa/management/config_keys_test.go` and the browser acceptance
check on the rendered provider table assert the label rather than the module.

A family an installed CPA does not have answers `404`; that is a missing
capability rather than an empty or broken list (`IsMissingCapability`), so a
console release that knows a newer family still works against an older gateway.

Two callers fetch an address the process did not construct: a model-list pull, whose
URL the operator typed for a provider they run, and a plugin logo, whose URL an
installed plugin's manifest declares. `internal/api/outbound_fetch.go` owns the
redirect rule both obey - a redirect that changes scheme or host is refused before
the next request leaves the process, so neither the provider key nor custom
provider headers can reach a target the operator did not enter - and the two
destination policies sit in their own callers, because the authority behind the URL
is not the same. A model pull accepts HTTP for localhost, loopback and private
literals, since a self-hosted relay on the operator's LAN is the normal case;
invalid URL policy answers `400 invalid_model_pull_url` and a refused redirect
answers `502 model_pull_redirect_refused`. A plugin logo is allowed only over
public HTTPS, or HTTP to the machine itself, and the resolved address is checked in
the dialer against everything that is not public internet space - the operator's
network, the shared-address range an overlay network hands out (`100.64.0.0/10`), the
reserved IANA blocks and a cloud metadata endpoint - so a hostname that resolves into
any of them is refused where the connection would actually be made rather than trusted
because the name looked public. A plugin is not trusted to choose what this process
connects to, which is also why this fetch connects directly instead of through an
environment proxy: through one, the dialer would be asked about the proxy's address and
the target would be unverifiable.

A plugin's logo is fetched for a different reason than a model list: not to reach
the plugin's host from the browser, but to keep the browser away from it.
`internal/api/management_plugin_logos.go` fetches the URL a plugin publishes,
requires an image media type from a bound allowlist, caps the response - for a logo
published inline as well as for one fetched - and reports it as an inline `data:`
URL on both `logo` and `metadata.logo`. The whole plugin list shares one fetch
deadline, because what has to stay bounded is the endpoint the console polls and not
each request; the result is cached, failures included, so a plugin list that names an
unreachable host does not refetch it on every poll. An exhausted budget is the one
outcome that is not cached, since running out of time is not an answer about the
logo. A logo that cannot be inlined is reported as absent rather than as a URL, which
is what makes every provider surface fall back to the vendored catalog mark; see §3.

### OAuth providers are one registry

`internal/cpa/management/oauth_providers.go` is the single declaration of which
authorizations exist, the shape of each (`redirect` or `device`), and whether CPA
should open its loopback callback forwarder for it (`UsesLoopbackCallback`, sent
as `is_webui`). The facade's provider list and the client's request are both
projections of it, and the browser's card registry
(`web/src/pages/oauthProviderLogic.ts`) carries the matching presentation plus the
rules for judging a pasted redirect.

The registry is deliberately not an allowlist: CPA plugins register their own
`{provider}-auth-url` routes at runtime, the console discovers them from the
plugin list, and an id the registry does not know is forwarded unchanged with no
per-provider flags. The two registries are held together by an id, so a provider
is added in both or in neither.

A provider the console's own registry names also needs a brand mark, because a
surface that cannot draw one falls back to a neutral placeholder - which reads as
"this provider has no identity" even though its artwork ships in the bundle. The
catalog marks are declared in `web/src/components/common/providerMetadata.ts` and
`web/src/types/providerIconIds.ts`; a plugin-registered provider instead brings
the logo it publishes (§3).

## 3. Frontend shape

`web/src` is a single-page app on React + TypeScript + Ant Design, with TanStack
Query for server state.

| Area | Contents |
| --- | --- |
| `App.tsx` | Router, lazily loaded pages, theme and locale providers; the theme provider sits above `ConfigProvider` (Ant Design's tokens are a projection of the resolved palette) while `ThemeServerSync` sits inside `App`, because a refused save is reported through Ant Design's message API |
| `api/client.ts` | The one typed HTTP client; every endpoint is declared here |
| `types/` | Wire types, including the request-record view model split by responsibility (`usageEventQuery.ts` for the URL and filter contract, `usageEventViewPreference.ts` for the stored view, `usageEventIdentity.ts` for the credential and provider behind a row, `usageEventGrouping.ts` for how records bucket, `usageEventLabels.ts` for what a row prints, `usageEventMetrics.ts` for its numbers and `usageEventCadence.ts` for the page's timing constants), `usageEventViewActions.ts` (the view's URL and persistence rewrites), `pluginOAuthProviders.ts` (which logo an installed plugin publishes for the OAuth provider it registers, and whether a URL may be rendered as an image at all), `tokenDisplay.ts` (the one layer every user-facing token number is formatted through) and `rollingNumber.ts` (the animated shape of a reading) |
| `hooks/` | `usePreference`, `useLastIntentQueue` (React binding) over `lastIntentQueue` (the framework-free controller) and `disposableSlot` (effect-scoped resource lifetime), `useLogTail`, `useVisibleNow`, `useIsNarrowViewport` (900px, the shell), `useIsPhoneViewport` (640px, lists and control sizes), `useOverlayHistory` (React binding) over `overlayHistory` (the framework-free overlay/history policy: one sentinel per open Drawer or Modal, so the platform's Back dismisses the topmost one), `usePluginOAuthLogos` (the plugin list read once, projected to provider-key logos), `usePrefersReducedMotion` (the app-owned reduced-motion switch the canvas marks need, since neither `@antv/g2` nor `@ant-design/plots` reads the preference) |
| `i18n/` | `index.tsx` owns the base `[zh, en]` dictionary and the `t()` context; `language.ts` is the reading-language registry and locale helpers; `locales/zh-Hant.ts` and `locales/ms.ts` are the complete additional catalogs |
| `theme/` | `palette.ts` (the nine authored tokens, the seventeen-token derivation, the registered palettes and the resolution of a mode plus a selection into a palette), `themePreference.ts` (the stored preference document, its parse and its migration from the earlier bare palette id), `ThemeContext.tsx` (the preference, the system follow, the in-progress edit, and the server sync), `themeConfig.ts` (antd tokens and CSS-variable projection), `colorMath.ts` (OKLCH mixing, luminance and contrast - the one authority for every ratio in the console), `cacheScale.ts` and `heatmapRamp.ts` (the two sequential ramps' stops) |
| `utils/` | `maskKey.ts` (the console's one caller-key mask shape, kept branch for branch with the server's `security.MaskSecret`), `externalUrl.ts` (the http/https link rule), `modelOptions.ts` (model-input filtering), `smoothScroll.ts` (the gesture/correction scroll schedule), `clipboard.ts` (the one copy path, below) |
| `components/common/` | What more than one page renders: the shell (`AppLayout`, `HeaderNav`, `AuthGate`, `PreferenceMenus`), and the phone row a list becomes below 640px - `PhoneRow.tsx` (headline, summary, labelled fields, controls) over `phoneRowFields.ts` (derives a row's fields, and one column's rendered cell, from the *table's own* column array, so a list has one description of a record at both widths and a column cannot silently disappear on a phone; see ADR 0012) |
| `components/`, `pages/` | Feature UI; one page per route, no page owns another. A page composes its surface rather than carrying it: `pages/UsageEventsPage.tsx` renders `components/usage/`'s toolbar, header and rows and takes its state from that directory's hooks, `pages/ProvidersPage.tsx` renders `components/providers/`'s table and editor, and `pages/ConfigPage.tsx` renders `components/config/`'s renderers. The framework-free policies of a surface stay beside it: `components/usage/` carries `searchDebounce.ts`, `pollingPolicy.ts`, `timeRangePolicy.ts`, `syncPresentation.ts` and `chipDisplay.ts`, and `components/config/` carries `payloadRules.ts` and `configDirty.ts` |

Every copy control goes through `utils/clipboard.ts` rather than calling the
Clipboard API itself. That API exists only in a secure context, and a plain-HTTP
origin is a supported deployment of this console (`deploy/nginx.conf` listens on
:80 without TLS, and the dev server is reachable from a LAN or Tailscale device),
where `navigator.clipboard` is `undefined` outright. The helper therefore falls
back to the selection path and returns whether the text actually reached the
clipboard, and no control may announce a copy it did not make.

That fallback carries two constraints a control inside a dialog depends on. A dialog -
antd's Drawer and Modal both - pulls focus back into its own subtree, so the scratch
element the selection path types through has to join that subtree rather than
`document.body`: attached outside it, the element never keeps the focus its selection
needs and the selection stays empty. And `execCommand('copy')` answers `true` for an
empty selection, so the helper checks that the scratch element holds focus and its own
selection before believing the result.

All page routes are `React.lazy` import boundaries so the entry chunk stays
small; the shell (`AppLayout`, `AuthGate`) is loaded eagerly because every
route needs it. Brand/provider marks are copied from the pinned
`@lobehub/icons-static-svg` package into `web/public/lobe-icons` and referenced
as SVG URLs. The small catalog used for lookup and grouping is vendored in
`web/src/generated/lobeIconCatalog.json`; the React icon package is not a
dependency, because importing it would pull hundreds of components into the
eager bundle; the OMC Settings page is lazy for the same reason, because the palette editor it carries
pulls in Ant Design's colour picker. Dashboard KPI cards use `@ant-design/charts` in a dedicated
`vendor-charts` chunk, lazily loaded so the entry bundle stays small. Their
numbers animate through `@number-flow/react`, which the dashboard page imports
directly instead of through a vendor chunk: only that route uses it, and being on
a lazy route boundary it never enters the entry's static module graph. The marks
themselves morph between revisions on the same motion token, gated by the
reduced-motion hook above. `docs/design.md`
§7 rules 5 and 8 own the motion they are allowed to run, and ADRs 0007 and 0008 own the
trade-offs.

**A plugin's published logo outranks the catalog mark for the provider it
registers.** A plugin that declares `supports_oauth` may publish its own logo, and
when it publishes usable artwork that mark is the one drawn: the plugin is the only
authority on what its own provider looks like, and the vendored catalog cannot be
updated by installing a plugin, so guessing a brand from the provider key would
label the operator's own credential with somebody else's mark.
It is not loaded from the plugin's host, though - the deployment must not
depend on a CDN, and the console's CSP allows images only from itself or inline -
so the Go process inlines it (§2) and `types/pluginOAuthProviders.ts` resolves the
plugin list into provider-key logos (including a plugin whose auths are typed by
its own id rather than by `oauth_provider`). `LobeIcon.tsx`'s `ProviderBrandIcon`
renders it - one component for the provider tabs, the quota and credential cards,
the request records, the provider table and the dashboard's provider rows, so
those surfaces cannot disagree about the same provider. Only inline artwork is
rendered: a provider no plugin owns, a logo that could not be inlined, and a value
at a scheme the browser may not load all fall back to the catalog mark, and a
plugin-owned row shows the plugin's mark even when an operator icon override is
stored for that key, and it does not depend on the plugin being enabled — the mark
identifies the provider behind a credential or a past request, which does not stop being
true when the plugin is switched off (ADR 0014). ADR 0013 owns the trade-offs behind the
other choices here, including why a plugin-declared logo URL is held to a stricter
destination policy than an operator-typed one.
`components/resources/` and `components/icons/PresetIcon.tsx`
are retained from the retired triage console and are currently unreferenced; the
backend discovery/binding model they rendered is still live behind Providers and
OAuth management.

CSS class names are kebab-case everywhere, including `*.module.css` exports,
which are consumed as `styles['kebab-case']`. That is not cosmetic: `tsc` types a
CSS module as `Record<string, string>`, so a stale class reference compiles and
fails silently at runtime. `pnpm check-css-modules` is the guard that closes
that hole.

The motion budget is enforced the same way. `pnpm check:motion` reads the
stylesheets and the inline `transition:` strings in components, and fails on a
duration that is not a `--motion-*` token, a transition on a layout property (or
on `all`), a keyframe animation with no `prefers-reduced-motion` counterpart, and
a hover transitioning colour outside the fast token; the disclosures that need a
layout animation are listed in its `EXCEPTIONS` table with a reason each, and a
stale entry is itself a failure. The budget it enforces is stated in
`docs/design.md` §7, and the reasoning behind the hover bound is ADR 0009.

## 4. Request and session flow

1. `POST <base>/api/auth/login` with the CPA management key. The handler
   compares it against `OMCPA_CPA_MANAGEMENT_KEY`; there is no second password.
2. On success the session manager derives an HMAC key from the management key
   and issues an HttpOnly, SameSite=Strict cookie (`Secure` when
   `OMCPA_PUBLIC_URL` is HTTPS) with a 12-hour expiry.
3. `requireAuthentication` wraps every `/api/v1` route and rejects an absent or
   stale cookie with 401.
4. Rotating the CPA management key changes the derived signing key, so every
   existing session fails verification without any server-side session store.
5. Sensitive exports (raw auth file, request logs) write an `audit_events` row,
   and audit-write failure blocks the export (fail closed).

   **Raw config YAML is deliberately not behind a second credential.** It used to
   require a short-lived reveal grant obtained by re-entering the CPA management
   key, while `PUT /config/source` - which writes the same file - required only
   the session. Since the management key is the console's only credential, the
   grant re-checked exactly the authority the session already carried, so it added
   a step without adding a boundary. Reading the raw source still sits behind
   `requireAuthentication`, is served `no-store`, and keeps the fail-closed audit
   write. This is a deliberate removal of step-up authentication, not a
   frontend-only prompt change: the grant endpoint and its state are gone.

The key itself is encrypted with `OMCPA_MASTER_KEY` and stored on the
`cpa_instances` row, where `bootstrapDefaultInstance` refreshes it at every
startup so a rotation needs no SQLite surgery.

## 5. Discovery and identity flow

```text
POST /api/v1/instances/default/discover
  → internal/cpa/management reads auth-files, the claude/codex/gemini/meta API-key
    lists, and openai-compatibility entries
  → cpa/discovery derives a stable resource key and binding fingerprint
  → repository upserts discovered_resources + cpa_bindings (served via /api/v1/resources)
```

The resource key resolution order and the ban on array position are fixed by
ADR 0002: immutable upstream id, then family-scoped `auth_index`, then a
versioned keyed HMAC of the credential material, then a fingerprint of
non-sensitive metadata, and finally an explicit `identity_collision` marker
rather than a silent merge. Secrets never enter a key or a stored fingerprint
input, and a response DTO carries one only for the surface that edits it and only
when it asks for it (`?include_keys=true`, ADR 0015); every other response carries
a display mask. (The Providers and OAuth management pages inspect
and manage CPA runtime entries directly through `/api/v1/management/providers`
and `/api/v1/management/auth-files`, layering local preference metadata on read.)
Auth-file edits use CPA's field patch but do not treat its `200` as proof:
the facade reads the runtime entry and a server-side projection of the
downloaded JSON back before returning success. The projection exposes only
prefix, proxy URL, expiry, disable-cooling, WebSockets, using-API, note, priority,
weight and excluded models; tokens and other credential material stay inside
the Go process. Global OAuth model aliases are managed separately through
`/api/v1/management/auth-files/model-aliases`: the facade replaces one provider
at a time, reads CPA back before reporting success, and audit logs the write.
These writes and safe reads are audit logged.

`cpa_bindings` carries `missing_at_ms` and `ON DELETE SET NULL` so upstream
removal marks a binding missing without cascading into history.

## 6. Usage flow

```text
CPA queue / subscription
  → ingest.Runner        pop or receive, persist immediately
  → usage_inboxes        raw payload, status pending, durable before decoding
  → ingest.Processor     decode via internal/usage, one event per inbox row
  → usage_events         typed row + request-time price snapshot (one tx)
  → ingest.Maintenance   incremental rollup into hourly/daily stats,
                         retention purge
  → /management/dashboard, /management/dashboard/tail,
    /management/dashboard/token-heatmap, /management/dashboard/models,
    /management/dashboard/providers, /usage/events
```

The pipeline exists because CPA's queue is destructive and short-lived: the only
safe ordering is "persist the raw payload first, interpret it later". A failed
local write records an `ingest_gaps` row so coverage loss is visible instead of
silent, and `usage_inboxes.status` (`pending → processed | failed | discarded`)
makes a decode failure retryable without losing telemetry.

`usage_inboxes` is the only place a payload can be replayed from, so the decode
step is serialised: `ClaimUsageInboxBatch` merely selects pending rows and
`usage_events.event_key` is intentionally not unique (CPA reports retries under
one `request_id`), so two concurrent decoders would each commit their own copy of
the same payload. `ingest.Processor.drain` is that gate, which is why both the
background loop and a manual sync go through it; it is a channel rather than a
mutex so a manual sync waiting for the background loop still returns on its own
deadline.

`internal/usage/ingest.Runner` picks its transport in `auto` mode by probing
`AUTH` only — never by popping, because a probe that consumed a record would
destroy it. Subscription is preferred; repeated `SUBSCRIBE` failures degrade to
RESP `LPOP`, and an unreachable RESP endpoint degrades to HTTP
`/v0/management/usage-queue`. Empty pulls back off through `pullPacer` (1s → 2s →
4s → 8s → 10s, then capped) while a full batch drains with no delay. A wrong
management key triggers a long cooldown instead of retrying, because CPA bans a
client IP after repeated failures.

### Manual sync versus background collection

The request list reads Oh My CPA's own database, so a manual refresh that only
re-read it could never show a request CPA accepted a moment ago. `POST
/usage/ingest/refresh` therefore drains CPA first: `ingest.Pipeline.RefreshNow`
hands a request to the collector goroutine (a second consumer would divert
records from a live subscription and race the poll loop on the same destructive
queue), waits for the pass, then runs a decode barrier until the inbox rows that
pass could have produced are no longer `pending`.

Five properties are deliberate:

- The manual pass is served by the collector's goroutine, never by the HTTP
  handler, and it persists under the collector's context while only *asking* CPA
  under the caller's: payloads already popped cannot be put back, so a caller that
  stops waiting must not abort the write, but a caller that stopped waiting also
  stops asking for more.
- A manual failure is returned to `Run` rather than swallowed, so the backoff and
  the wrong-key cooldown still govern it. An operator who clicks refresh five
  times must not spend CPA's five-strike ban budget.
- In `subscribe` mode the pass moves whatever the reader has already buffered
  into the batch, then drains the reconnect-gap residue through the same bounded
  multi-batch loop the poll path uses. A live subscription suppresses CPA's
  enqueue, so a pop alone would report "nothing new" while freshly pushed records
  waited for the next flush tick; and a single pop would report a clean sync with
  an older backlog still queued.
- The decode barrier is scoped by a watermark (`MAX(usage_inboxes.id)` taken after
  the pass). Waiting for `pending == 0` instead would only finish during a lull,
  because records keep arriving while the refresh runs.
- `synced` requires that nothing captured at or below the watermark was parked as
  undecodable. A poison payload leaves no event, so a barrier that ignored
  discards would promise records the list can never show.

The endpoint answers with `synced` plus the reason it could not sync, and an
already-running sync gets a 409 rather than queueing a second identical drain.
Its deadline is capped below the server's write timeout, so a slow sync cannot
outlive the connection carrying its answer.

Timestamps in the usage tables are epoch **milliseconds**; the older identity
tables use `unixepoch()` seconds. Rollups are gated by
`usage_aggregation_checkpoints` so aggregation is incremental rather than a
full rescan.

**A window may only be served from a rollup whose grain is no finer than the
requested bucket.** The rollups are hourly and daily; the dashboard's short presets
ask for buckets well under an hour (15m and 1h resolve to one and two minutes, 6h to
ten, 24h to thirty). An hourly row cannot be split across that grid: every rollup
timestamp is already a multiple of any bucket dividing an hour, so re-aligning maps
the whole hour onto its first bucket and reports the rest as zero. That failure is
quiet — the window total stays correct, so sum-based assertions pass while the chart
shows one spike per hour and nothing where the traffic actually was. `QueryUsageAnalytics`
therefore reads the detail rows whenever `bucketMS < grainMS`, and keeps the rollup
for hourly and coarser grids, where slicing is honest and the rollup earns its keep.
The detail path is bounded by the retention window, so it cannot grow without limit.

### Why the model breakdown reads one source, not the rollup split

The dashboard's two model panels - the per-model token trend and the model-usage ring - are served by
their own endpoint, `GET /management/dashboard/models`, with its own query, its own refresh cadence and
its own failure mode. Three properties make it the wrong thing to attach to the KPI response, and each
is the same reasoning ADR 0005 recorded for the token grid.

**It is the page's most expensive read.** `QueryUsageModelBuckets` aggregates the *detail* table by
model and bucket. `QueryUsageAnalytics` deliberately splits its window at the aggregation checkpoint
and reads the two halves from different tables - but that split is not reusable here, and reusing it
would be wrong rather than merely slower. Its boundary is a *timestamp*, while the rollup's unit of read
is a whole row whose start may precede that boundary: an event timestamped inside an already-folded
hour that arrived late (CPA event times can arrive out of order) sits on the detail side of the boundary
while its own hour is already inside the rollup, so both halves count it. In a windowed total that
artefact is a quiet double count; in a per-model *ranking* it also reorders models, which is the kind of
wrong that still looks plausible on screen. One source has no boundary to get wrong.

**It moves on its own cadence.** The KPI tiles poll through `/management/dashboard/tail` as often as
every five seconds; that poll recomputes the window's aggregates, and for grids at or above the rollup's
grain it reads them from the rollup rather than from individual events. Attaching a detail-table scan to
it would multiply the page's heaviest query by twelve to redraw a ranking that changes when a caller
switches models, which is not a second-by-second event. The panels poll on a one-minute interval for a
sliding window and not at all for a closed one.

A closed range has fixed **bounds**, not immutable contents: records are still arriving, and retention
can prune the far end. Its panels are simply not re-read on a timer, so they show what the range held
when it was last fetched - which is why the page's refresh button reaches them.

**It is allowed to fail alone.** An unavailable read leaves the six tiles and the activity grid beside
it readable, which is the same reasoning that put `partial_errors` on the overview and gave the heatmap
its own endpoint.

**The grouping is the request's, not the panel's.** The endpoint takes `group_by=call|model` (default
`model`, and an unknown value is a 400 rather than a silent fall-back, so a typo cannot quietly change
what the numbers mean). The call view partitions rows by call point - the model alias a client
requested, falling back to the upstream model name when no alias was set - so one call point served by
several upstream variants reads as one line, the way the deployment's own vocabulary names it; the
model view partitions by the upstream model name exactly as CPA recorded it. The choice rides in the
query because ranking and folding are the server's single answer for exactly one grouping - a
client-side regroup of one ranking could not also re-rank, re-fold, and re-assign colours without
duplicating the fold logic and letting it drift from the server's. The response also carries each
group's priced spend (`cost_usd`, null when nothing in the group was priced) and `priced_requests`,
summed only over rows priced at request time, so an unpriced-heavy window cannot present a partial
spend as the whole.

Two details of the fold are load-bearing. The remainder group carries a `folded` boolean rather than a
reserved display name, because the label is the frontend's to translate and a deployment may
legitimately serve a model whose name collides with whatever that label is; a name-based test would
merge real traffic into the remainder or split it in two. And the ranking is tie-broken by model name,
because equal volumes are ordinary (two aliases of one model, or a window where one request hit each)
and without a total order the order would come from map iteration, reshuffling the legend under the
operator on every poll.

`BenchmarkUsageModelBuckets` pins the cost: roughly 0.23 s over 100 000 in-window detail rows and 2.6 s
over 1 000 000 on one development machine, against a 15-second handler deadline. Retention bounds a
row's *age* rather than how many exist, so those are the numbers to re-measure if the horizon or the
traffic profile changes.

### Why the daily token grid folds its own days

The dashboard's windowed read and the year-long token grid look like the same question at
two zoom levels, and they are not - which is why
`/management/dashboard/token-heatmap` is a separate endpoint with its own query.

Three properties of the windowed read make it the wrong tool for a calendar. Its window
slides, so the same series is a different span every time it is asked. Its grid is a
*bucket* grid (`dashboardBucketWidth`), chosen so a sparkline stays near 48 points, and
`QueryUsageAnalytics` reads its hourly or daily rollup whenever the requested bucket is
*at least as coarse as* that rollup's grain, and falls back to the detail rows when the grid
is finer - a rollup row cannot be split across a finer grid, so re-aligning one would report
the whole hour in its first bucket and the rest of it as zero. And the rollup is keyed on a UTC bucket start.

A day is not a bucket. Grouping hourly rows by an offset-shifted key cannot split a UTC
hour that straddles a local midnight at a fractional offset: India is `+05:30`, so local
midnight falls at 18:30 UTC - inside the 18:00 row. The same arithmetic is wrong for
every day on the far side of a daylight-saving transition, not merely the two transition
days, because a single offset cannot describe a span that crosses one.

`Repository.QueryDailyTokenTotals` therefore takes the days as exact instant ranges,
built by the handler from the viewer's IANA zone with `time.Date`/`AddDate`, and reads the
detail table only. It does not reuse the rollup-plus-tail split either: that split is
correct for a bucket grid because the two halves partition by *time* against the same
grid, but a day boundary and an hour checkpoint do not line up, and CPA event times can
arrive out of order - a request timestamped inside an already-folded hour lands on the
detail side of the boundary while its own hour is already in the rollup, so a hybrid read
counts it twice. One source has no boundary to get wrong.

The cost is a scan of the detail table over the span, aggregated inside SQLite so at most one row
per day crosses into Go. The window is a rolling year of weeks, and the default retention horizon
(`OMCPA_USAGE_RETENTION_DAYS`) is 400 days so the whole window stays readable — the two are one
decision, since a shorter horizon would show the window's own beginning as carrying nothing. A day
with no stored record (pruned, or later this week than today) is reported as carrying nothing and
drawn as *unrecorded*, rather than as a measured zero that would claim the gateway was idle.
The panel calls it on a five-minute interval and on an explicit page refresh, not on the tail
poll's cadence. The final day's window stops at the read instant rather than at the following
midnight, so a record timestamped in the future cannot inflate today's total.

### Why the request list is ordered by `timestamp_ms`

The list's order is the column the reader sorts by eye, so the two must agree.
`ListUsageEvents` orders by `timestamp_ms DESC, id DESC`: the newest request time
first, with the row id as a tiebreaker.

`timestamp_ms` is when the request *started*, which is what the time column
prints, and that is exactly why the visible column has to be the sort key. An
agent request can run for minutes, so ordering by anything else puts a
long-running request above requests that began after it: the reader sees
`14:53:34`, then `14:52:57`, then `14:53:36` and concludes the sort is broken.
Measured against a real instance, ordering by row id inverted **1329 of 5464**
adjacent rows — about a quarter of the list.

The `id` tiebreaker is not optional. Several records can share a start time (a
client fanning out, or a second-granularity source), and without a total order the
keyset boundary would skip or repeat rows as the reader pages. The cursor is
therefore a composite `(timestamp_ms, id)` position applied as the row comparison
`(e.timestamp_ms, e.id) < (?, ?)`, not a single-column predicate. Cursors written
before this order existed carry only an `id`; `resolveEventCursor` looks the row's
timestamp up to convert them, and a cursor naming a row that no longer exists is
rejected with `ErrUsageCursorStale` (HTTP 409) so the console restarts at page one
instead of silently serving a page from the wrong place.

This order is served by `idx_usage_events_instance_time` (migration 018),
`(instance_id, timestamp_ms DESC, id DESC)`: the keyset predicate and the
instance/time window both read from it, and the plan is a covering index seek with
no temp B-tree. Migration 021's `idx_usage_events_instance_id` no longer serves the
list order; it remains the index for `id`-keyed lookups such as the ingestion
watermark behind the console's "N records arrived" pill.

That pill is the one place the two orderings still have to be told apart, because
"new records" means newly *recorded*, not newest request time. A request that
started an hour ago and finished just now is genuinely new while sorting far below
the first page, so the console counts arrivals against an ingestion id
(`?since=<row id>`) rather than diffing the rows it has loaded — which would report
"nothing new" while records were flowing in. On a real instance **5415 of 5515**
records sort below page one, so that distinction is the normal case, not an edge
case. The arrival count is resolved before the list scan, and the list result set
is closed before the function returns. With one SQLite connection, issuing the
count after the list could otherwise keep both statements on the same WAL
snapshot, so a record committed between polls would remain invisible until a
later transaction happened to replace it. The acceptance fixture covers the same
refreshing-window path without a second process writing after the app opens the
database: it seeds one future-dated row before startup, and a later poll admits
that row once the sliding window reaches it.

Request *time* is also the windowing key (`timestamp_ms >= from AND <= to`) and the
axis of every rollup and chart, so the list, the window and the charts all agree on
what the numbers mean.

### Client key aliases: one identity, two purposes

Operator-assigned names for gateway client keys live in `client_key_aliases`
(migration 022), keyed by `(instance_id, key_fingerprint)`.

The fingerprint is `usage_events.api_group_key`, which is `security.Fingerprint`
under the purpose **`usage-api-key`** (`repository.UsageClientKeyPurpose`). The
purpose is part of the HMAC input, so the same key hashed under a different
purpose is an unrelated value - and that is exactly what the key list used to do:
it fingerprinted under `client-key`, producing an identity that matched **no**
request record. An alias written against that value could never label anything.
`ClientAPIKeyItemDTO` therefore carries both: `fingerprint` (the legacy page value,
kept for compatibility) and `usage_fingerprint` (the joinable identity).

Three consequences shape the implementation:

- **Identity is the fingerprint, never an array index or a mask.** Reordering CPA's
  `api-keys` list moves an index, and a mask keeps only a short head and tail, so
  two keys can share one. Either would put one key's name on another key's records.
- **Aliases are never pruned.** Requests keep their `api_group_key` forever, so a
  deleted key's history still needs its name; an alias belongs to the identity, not
  to the current configuration. Renaming is read-time resolution, so it changes how
  historical rows read without rewriting a single usage record.
- **Alias writes never touch CPA's configuration.** Naming a key is Oh My CPA
  metadata with its own endpoint, because routing it through `PUT /config.yaml`
  would rotate the revision for every other editor and rewrite a secret the
  operator did not touch.

Resolution is a single batched `IN` lookup per page (deduplicated, chunked at 500
parameters), not one query per row, and it is best-effort: a failure leaves
`api_key_alias` empty and the console falls back to the mask rather than failing
the list. The fingerprint remains the filter identity, so a rename cannot change
what a saved filter or a drill-down link selects.

Because neither a mask nor an index can stand in for the value, the key list is
the one reader that asks the management API for it: `/management/api-keys` sends
`ClientAPIKeyItemDTO.Key` as a display mask unless the caller opts in with
`?include_keys=true`, which is the flag the provider list already uses. The key
page opts in, joins the overlay by that value, and keeps its own query cache entry
so the dashboard's key picker — which only needs the mask — cannot be served the
values, and the key page cannot be served the masks (ADR 0015).

### Provider key masks: which upstream key answered

A request record names its provider, and an operator reading it needs one more
fact — which of that provider's keys the request actually went through. CPA does
not put that key in the usage payload: it publishes the credential's runtime
`auth_index` and nothing else. The keys exist only in CPA's configuration, so the
mask is resolved on the server while the request list is read, and returned on each
record as `provider_key_mask`.

`internal/api/usage_provider_key_masks.go` owns that resolution. It reads the
credential lists CPA currently reports — the four config API-key families and the
`openai-compatibility` providers — and indexes each one by auth index.

**The record's own provider label chooses the list, and an unrecognized label is not
a candidate at all.** CPA labels a config API-key credential with the family name
(`codex`, `claude`, `gemini`, `meta`) and a compatibility credential with
`openai-compatible-<upstream name>`
(`management.OpenAICompatibilityLabelPrefix`, the same constant the dashboard's
provider grouping uses). Those two shapes are what an attributable request looks
like; anything else — an OAuth-only provider, a family the console does not manage —
reads nothing, so an index that happens to collide across lists can never be answered
by the wrong one. Within each list the match is by index alone, deliberately:
renaming a compatibility provider in CPA changes the label on later records while the
credential, and CPA's index for it, stay the same, so a name-scoped match would
orphan history that is still perfectly identifiable.

Four properties are load-bearing:

- **It resolves against the configuration as it is read, not as it was at request
  time.** A credential that has been rotated or deleted since the request stops
  being offered as that index's owner, so that record prints nothing once the cached
  read of its list expires — at once if the operator removed it through this console,
  and within the TTL if it was changed outside it. The console cannot reconstruct a
  key it can no longer read, and a plausible-looking mask would be a fabrication
  rather than a display label.

  A provider that has merely been **switched off** is deliberately not treated as a
  removal. CPA reports no auth index for a disabled compatibility provider, so such
  an entry claims nothing anyway, while filtering on the flag would additionally hide
  the key of a request served *before* the provider was switched off — the provider's
  current state is not part of the credential's identity, and that label is a true
  fact about the request rather than a wrong one. An index claimed by both a disabled
  and a live entry resolves to nothing, so the protection that matters is kept.
- **Nothing is guessed.** An index no entry claims, a key CPA reports without an
  index (the compatibility list's legacy `api-keys` array), an index two entries
  claim, a record with no index at all, and a provider that has exactly one key but
  does not claim the record's index are all left empty. The duplicate case is resolved
  to nothing even when the two masks are identical, because neither an index nor a
  mask is an identity — the same rule the resource join follows.
- **Only an API-key credential has one.** An OAuth record names the account it used
  instead, and its index lives in the same column, so an auth-type check stands in
  front of the lookup. The mask is display only, is stored on no row, is never a
  filter value, and the property is absent rather than empty when nothing was
  resolved; only `security.MaskSecret` output ever leaves the process, and a failed
  read is reported through the same public classifier every other gateway failure
  uses, because a management error body can echo the credential it rejected.
- **It is best effort and bounded.** The lists are read at most once per TTL, one
  read is shared by concurrent pages, failures are negatively cached, and the whole
  enrichment has its own short deadline. A gateway that is down, slow or missing a
  family leaves the masks empty and returns the request list unchanged, because a
  display label must not be able to fail the page whose job is to show request
  history. A write through this console drops the cached read, so an edit is
  reflected immediately; a read that was already in flight when that write landed is
  withheld as well as not stored, since the list it saw is the one being replaced.

### Streaming status and throughput (TPS) derivation

CPA usage payloads include a boolean `stream` field indicating whether the request
was executed in streaming mode. Oh My CPA records this in `usage_events.stream`
(migration 023) as a nullable integer: `1` for streaming, `0` for non-streaming,
and `NULL` for historical rows where the flag was not captured.

The flag is operational metadata, not a sufficient classifier for TTFT validity.
An upstream executor can capture a real first-token event even when the client
requested `stream: false`, while an apparently streaming request can still receive
its whole payload in one chunk. Throughput therefore keys on the observed residual
window rather than the recorded mode:

- When `latency_ms - ttft_ms >= MIN_STREAMING_GENERATION_WINDOW_MS` (50 ms,
  defined in `web/src/types/usageEventMetrics.ts`), `ttft_ms` is treated as a genuine
  generation boundary and TPS is `output_tokens * 1000 / (latency_ms - ttft_ms)`.
- When TTFT is missing or the residual window is collapsed, the response was not
  observed progressively enough to isolate generation. TPS falls back to
  `output_tokens * 1000 / latency_ms`, and presentation omits TTFT and uses a
  single total-duration bar in the drawer waterfall. This prevents timer artifacts
  such as 768,588 t/s on a 13k-token response.

The request list and detail drawer show a non-stream badge when an explicit
`stream: false` record has no measurable TTFT or when the observed residual window
collapsed. Historical records (`stream IS NULL`) use the same residual-window
heuristic, preserving genuine legacy generation rates without inferring a
first-token boundary from a completion-only measurement.

### 6.1 The request-record filter vocabulary

`UsageEventFilter` in `internal/repository/usage_events.go` is the single filter
vocabulary for the whole request-record feature set. Dimensions combine as AND;
values inside one dimension combine as OR, so an empty list means "do not narrow
this dimension" and a cleared multi-select is indistinguishable from one that was
never set.

The console sends a multi-select as a **repeated query parameter**
(`?model=a&model=b`), never as a delimited list. A comma is a legal character in
a model name, a source label and a caller mask, so splitting on one would corrupt
the exact values being filtered on. A single occurrence still parses, which keeps
drill-down links written before multi-select existed working unchanged.

| Dimension | Wire parameter | Match |
| --- | --- | --- |
| Model / alias / provider / caller key / auth index / source / auth type / executor / reasoning effort / service tier | same name, repeatable | exact, OR within the dimension |
| Identity search | `q` | literal substring across the columns in `usageEventSearchColumns` |
| Endpoint, user agent | `endpoint`, `ua` | literal substring |
| Request id | `request_id` | exact |
| Latency / tokens | `latency_min`…`tokens_max` | inclusive integer bounds |
| Cost | `cost_min`, `cost_max` | inclusive bounds in decimal USD, at most nine fractional digits |
| Price availability | `cost` | `priced` (`cost_nanos IS NOT NULL`) or `unpriced` |
| Result | `result` | `all`, `success`, `failed` |

Three properties are load-bearing rather than incidental:

- **The search is literal.** `%` and `_` are escaped with an explicit
  `ESCAPE '\'`, because SQLite's `LIKE` has no default escape character:
  untreated, searching for `50%` would match every row and `gpt_5` would also
  match `gpt-5`. The disjunction across columns is parenthesised, or its loose
  `OR`s would bind more weakly than the surrounding `AND`s and silently drop
  every other filter.
- **Bounds are pointers.** `0` is a meaningful bound (`max_cost=0` selects the
  records priced at nothing), so it cannot double as "unset". `cost_nanos` is
  compared directly, which means an unpriced row satisfies neither a lower nor an
  upper bound — it is reachable only by asking for `cost=unpriced`. Cost bounds
  arrive as decimal USD and are scaled to integer nanos in string form, so a
  bound of `0.1` cannot land below the value it was meant to include. Precision
  is **refused rather than rounded**: a bound of `0.0000000001` exceeds what the
  column stores, and rounding it to zero would answer a real constraint with "no
  cost at all". The console therefore carries cost bounds as decimal strings end
  to end — field, URL and preference document — because a nano-dollar amount does
  not survive a round trip through a double.
- **Diagnostic values are protected, not list fields.** `client_ip` and
  `x_forwarded_for` are preserved as the exact peer address and complete valid
  proxy chain for the single-record detail view, while list payloads and the
  shared search box omit both. `endpoint` is likewise available only on detail.
  `source` and `api_group_key` are fingerprinted at the persistence boundary, so
  a filter matches the stored fingerprint the facet offered, never the plaintext.
  Historical rows written under the earlier `/24` and `/64` policy remain masked;
  they are not guessed or backfilled.
- **Address projection is shape-tolerant and explicit.** `NormalizeClientIP`
  accepts IPv4, IPv6 and valid host:port forms and removes the transport port;
  `NormalizeForwardedFor` keeps every valid hop in order. An endpoint arrives as
  the request line CPA handled (`POST /v1/chat/completions`), not as a bare path,
  so `PublicEndpoint` keeps the method while stripping query, fragment and
  authority credentials. Round-trip tests run a raw payload through decode *and*
  insert, proving the protected detail value survives both boundaries without
  widening the list contract.

### 6.2 Facets

`GetUsageFacets` enumerates the values actually present in a window so a dropdown
never offers a choice that returns nothing. Each dimension costs one grouped scan
of the window, and it is the *count* of those scans — not the size of any one —
that makes facets the expensive part of opening the page; `BenchmarkUsageFacets`
pins the budget. Endpoint and user agent are deliberately **not** facets: both are
long, high-cardinality values where a typed substring beats a capped 200-row list,
and the endpoint must never be handed to the browser at all.

Facets are read on their own window revision rather than on the list's poll
counter, and are cached with a five-minute `staleTime`. They describe which values
exist in a window, so they change only when the window is redefined (a new preset
or absolute range) or the operator refreshes explicitly — not on each list poll.
That manual refresh is the same sync described in §6: the page waits for the pull
and the decode barrier, then re-reads the list, the facets and the pipeline status.
The revision is part of the facet query key, not only of the window it computes,
because an absolute range resolves to the same two timestamps on every render and
a naive revision would leave the cached entry inside its `staleTime`.
`scripts/browser-probes.mjs` asserts this directly: a manual refresh issues
a `POST` to `/usage/ingest/refresh` *and the list and facet reads wait for it*.
Request counts alone cannot establish that ordering — a page that fired all three
in parallel would still issue all three — so the probe holds the pull's response
open and requires that no list or facet read happens while it is held. Because the
response is capped at 200 values per dimension, a value that is selected but absent
from it is merged back into the options, so a filter that is still applied never
renders as a blank control.

### 6.3 Grouping the request list

The list offers three modes: chronological (`time`, the default), `source`, and
`ua`. `source` merges what used to be two separate modes, "by provider" and "by
credential": they were the same axis at two zoom levels, so one mode buckets on
provider-plus-credential and decides per provider whether the credential half is
worth printing. That decision is a property of the *page*, not of one bucket —
`providersWithMultipleAuthSources` answers it for every provider in the loaded
window — so a line served by a single credential reads as the provider alone
while a line split across two names both.

Grouping keys and labels are computed in `web/src/types/usageEventGrouping.ts` and
`web/src/types/usageEventLabels.ts`, which is what the logic test harness loads,
and are pinned there rather than by reading the DOM. Two properties matter beyond
the labels:

- **The stored preference migrates.** `parseUsageEventsView` maps the retired
  `provider` and `credential` values onto `source`, so an operator returning to a
  saved view keeps it instead of being silently moved to chronological order. An
  unreadable value falls back to `time`, which is the mode that never hides a
  record.
- **Unknown is a bucket, not a drop.** A record with no provider, no credential or
  no user agent is grouped under `unknown` and keeps its own header, because
  "nothing was recorded" is a fact about the record worth seeing.

The UA mode uses the stored `user_agent` verbatim: the value was already reduced
to a short product label on the persistence path, so grouping must not re-parse a
raw header or widen what was deliberately minimised.

## 7. Pricing flow

The catalog, the editable current price, and the immutable version history are
three separate things (ADR 0003):

```text
CPA catalog read ──▶ pricing_model_catalog   (last complete snapshot)
                          │
models.dev api.json ──▶ pricing.Service ──▶ model_prices      (current projection)
                          │                      │ triggers
                          │                      ▼
                          │              model_price_versions (immutable, time-effective)
                          ▼
                    manual rows win; a delete writes an unavailable tombstone
```

`usage_events` stores the price version id and integer USD nanos chosen in the
event's own insert transaction, using the request timestamp. Historical totals
never join the mutable `model_prices` table, so a later edit cannot rewrite an
invoice. A request with no effective version is stored with pricing status
`unpriced` (`legacy_unpriced` for rows that predate migration 019), cost absent,
and is never backfilled.

Matching (`internal/pricing/match.go`) ranks catalog candidates with a fixed
tie-break chain instead of refusing ambiguous ones; an entry without explicit
input/output rates is never selected, because a missing rate must not become
zero.

## 8. Quota flow

`internal/quota` calls CPA's `/api-call` with the credential under observation to
reach the provider's own usage endpoint. Targets are restricted to
`AllowedURLPrefixes` — a compile-time allowlist of official HTTPS endpoints — and
the resulting snapshot is normalized and stored in `quota_snapshots`. This is the
only place Oh My CPA uses CPA as a request proxy, and it is server-initiated:
there is no user-supplied URL or generic `/api-call` surface.

A provider is observed only once `internal/quota` both recognizes it
(`DetectProvider`) and implements its probe; a credential whose provider has no
probe is reported with `refresh_supported: false` rather than as a failed fetch.

## 9. Storage

| Table group | Tables | Notes |
| --- | --- | --- |
| Instances & identity | `cpa_instances`, `discovered_resources`, `resource_overrides`, `connections`, `cpa_bindings` | Encrypted management key; bindings survive upstream removal. `connections` is provisioned by migration 006 for the Connection entity but no code reads or writes it yet — treat it as reserved, not as a live table |
| Usage | `usage_inboxes`, `usage_events`, `error_events`, `ingest_gaps`, `usage_overview_hourly_stats`, `usage_overview_daily_stats`, `usage_aggregation_checkpoints` | Milliseconds; raw payloads encrypted |
| Pricing | `model_prices`, `model_price_versions`, `pricing_sync_state`, `pricing_model_catalog`, `pricing_catalog_state` | Versions are append-only via triggers |
| Operations | `audit_events`, `ui_preferences`, `quota_snapshots`, `schema_migrations` | Audit has no update or delete path — only `RecordAuditEvent` writes and read queries exist, and export itself is audited; the schema carries no enforcement trigger, so the guarantee lives in the repository API |

Migrations are embedded from `migrations/` and applied in filename order inside
one transaction each. A migration against an existing on-disk database first
writes an AES-GCM backup plus SHA-256 sidecar, restores it as a smoke test, and
keeps the newest five. Migration 004 additionally runs a Go governance hook
inside its transaction to sanitize historical rows. Rollback is forward-only:
fix a defect with a new migration, never by editing `schema_migrations`
(`docs/ops/sqlite-operations.md`).

## 10. Background loops

| Loop | Owner | Failure behaviour |
| --- | --- | --- |
| HTTP server | `app.Run` | Fatal; shutdown drains 10s |
| Usage pipeline | `app.Run` → `ingest.Pipeline` | Fatal; a stopped collector must not serve silently stale numbers |
| Pricing sync | `app.Run` → `pricing.Service` | Best effort; prices go stale, capture continues |
| Rollup + retention | `ingest.Maintenance` inside the pipeline | Retried on its own interval; errors surface in ingest status |

A demo deployment starts only the HTTP server: its history is the fixture, so there
is no collector to lose and no sync loop to let prices go stale. §12 and
`internal/demo` explain what replaces them.

## 11. Test layering

The suite is split by what each layer can actually prove, not by which runner is
fashionable. The rule is **Browser Everything → Browser Only Where Browser
Matters**: an assertion moves down a layer when a lower layer can make the same
claim, and it stays in Chromium only when the claim is about the engine.

| Layer | Command | What it proves |
| --- | --- | --- |
| Pure logic | `pnpm test:logic` | Decisions about the operator's own input: URL rewrites, saved-view derivation, debounce invalidation, the poll decision, range validation, chip display mapping, refresh presentation. Runs under Node with no bundler, no HTTP server, no Go binary and no browser. |
| Mechanical repository gates | `pnpm test:docs`, `pnpm test:i18n`, `pnpm test:css-modules`, `pnpm test:dev-target`, `pnpm test:affected-checks`, `pnpm test:sync-web-dist`, `pnpm test:install-chromium`, `pnpm test:check-ui-plan` | Path references, translation keys, CSS class references, the dev proxy target, the embedded-distribution sync, the Chromium installer's decision, the fast-path planner and the UI scenario planner. |
| **UI fast path** (development only) | `pnpm check:ui` | The subset of browser claims a change can affect, against the **dev server** with mocked routes. No `pnpm build`, no Go binary, no fake CPA. This is the only layer where `React.StrictMode`'s double-invoke happens, so it is the only place a hook that disposes what it should re-create can be observed. |
| Cross-stack smoke | `pnpm verify:browser:smoke` | The thin path a pull request needs: `/omc` redirect, sign-in rejection and success, the dashboard and request list rendering their seeded rows, no console or page error. |
| Cross-stack P0 gates | `pnpm verify:browser:p0` | Pull-request release gates over the request-record/live-tail suite and the auth-file/OAuth scheduling-field suite, using the same built binary and deterministic fixture. |
| Cross-stack acceptance | `pnpm verify:browser` | The whole stack against the fake CPA: auth, every route's render and secret boundary, key aliases, provider enable/disable and its concurrent path, live-tail polling, quota, OAuth. |
| Browser-only probes | `pnpm verify:probes` | The same claims as the UI fast path, but against the built SPA for release. Drawer/modal stacking and hit-testing, column geometry and truncation, the responsive alignment override, dashboard trend mark paint, refresh sequencing under a held response, the platform's Back dismissing each overlay class, the phone rendering of each list surface against its table, and the touch rules on a deliberately coarse-and-hoverless context. |
| Demo smoke | `pnpm verify:demo` | The demonstration as a deployment: the binary in demo mode with no gateway anywhere in its environment, every console page rendering its own fixture data with no failed request and no script error, the refusals reached with `fetch` rather than through the page, and one permitted edit reporting that it is not durable. `verify:browser` cannot cover this, because it drives the self-hosted path against a fake gateway. |

Pull requests run smoke followed by the P0 gates. Master retains the full
`verify:browser:release` orchestration, which runs cross-stack acceptance and the
browser-only probes concurrently.

### 11.0 The fast path is not a cheaper gate

`check:ui` and `verify:probes` run the **same scenarios** from
`scripts/acceptance/scenarios.mjs`, which orders the implementations under
`scripts/acceptance/probes/` (one module per product surface); the difference is
what they run them against, and
that difference is not a cost trade - it is a coverage difference in both directions.

`check:ui` cannot replace `verify:probes`, because the dev server and a mocked API
cannot show path resolution, minification or chunk boundaries, which is exactly the
class of bug a release artefact exposes. `verify:probes` cannot replace `check:ui`,
because a production build does not double-invoke effects, so a hook that creates a
disposable resource during render and disposes it in the first cleanup looks correct
there and is broken in development. The `search-dev-server` scenario exists because
that is not hypothetical: the debounce controller was refactored into exactly that
shape, the whole production-bundle suite stayed green, and the search box silently
stopped committing on the dev server. It was found by running the scenario against
the dev server, and it is guarded there now.

### 11.0.1 Three verification moments

Verification is organised by *when it runs*, because what a developer pays is
waiting, and a gate that costs minutes gets routed around:

| Moment | Runs | Cost |
| --- | --- | --- |
| Development iteration | `pnpm test:fast`, plus `pnpm check:ui` when the change touches interaction, layout or a browser lifecycle | 1-13s, plus 3-19s |
| One logical feature complete | `pnpm verify` | ~22s |
| Before declaring done or pushing | `pnpm verify:full`; skipped when the stage's own run already covered unchanged code and artefact | ~95s |

The rule that keeps this honest is that a *narrow* plan must never be **silent**.
`scripts/affected-checks.mjs` and `scripts/acceptance/check-ui-plan.mjs` both widen
rather than guess: the shared layer selects everything, an unrecognised frontend path
selects everything, and a change to either planner's own framework selects
everything. Both are pinned by tests that were checked against negative controls.

Two properties of this split are load bearing.

**A browser assertion is never removed without a replacement.**
`scripts/acceptance/MIGRATION.md` classifies every assertion in
`scripts/browser-acceptance.mjs` once - `PURE`, `COMPONENT`, `BROWSER` or
`CROSS-STACK` - and every assertion that left the browser names the test that
replaced it. An assertion may move; it may not disappear silently.
`scripts/browser-acceptance.mjs` is now the lifecycle/orchestration entrypoint.
Release domains live in focused modules under `scripts/acceptance/`: auth files,
key management, usage events and live-tail behavior, providers, observability,
configuration and plugins, theme and brand artwork, and OAuth flows. Each module
receives the shared browser harness it needs and owns one product surface rather
than becoming another catch-all script.

**`pnpm test:fast` never pays for the browser.** No ordinary change may build the
SPA, build a Go binary, start Vite, start Chromium or start the fake CPA. The
selection lives in `scripts/affected-checks.mjs` so it can be asserted directly,
including that negative property, and a file the rules cannot place selects the
broad gates rather than nothing.

### 11.1 Why some claims live where they do

- **Request ordering belongs to Go.** `TestListUsageEventsOrdersByRequestTime` in
  `internal/repository` inserts a request that was recorded last but started
  earliest, so a regression to recording order inverts the assertion. A JavaScript
  re-check would read whatever the server already ordered and could not fail for
  the reason its name gives.
- **Pagination and scroll stay in the browser.** A virtualized list holding a
  bounded DOM, a poll leaving the reader's scroll offset and row identity untouched,
  and a back-to-top gesture landing exactly on the top are rendering behaviours.
  The scroll *schedule* is a pure function and is tested as one
  (`scripts/test-scroll-intent.ts`); its effect on a real list is not.
- **Some browser waits are irreducible, and one was investigated rather than
  assumed.** The live-tail block waits out the app's ten-second auto-refresh
  cadence. Driving it with `page.clock` works - the interval fires early, 11s of app
  time in about 900ms - but the same mock covers `requestAnimationFrame` and
  `performance.now`, which is what `smoothScroll`'s gesture schedule is built from:
  with the clock installed the back-to-top gesture landed at 37px instead of the
  top, with no page error, breaking the assertion the block exists for. Isolating
  the interval from the frame clock is not expressible through that API, so the
  wait stays and the rationale is recorded at the call site.
- **The debounce is split rather than moved.** `createSearchDebounce` carries the
  policy and is tested directly. The one claim that stays in the browser is that a
  real pending timer survives a real clear-all, because it depends on a React state
  update and a URL write happening between the two.
- **Refresh sequencing cannot be replaced by a poll-decision test.** A
  `shouldPoll()` unit test says nothing about whether the page serialises the pull
  before the reads, so the probe holds the response and observes the ordering.
- **The copy path is split between a unit test and the browser.** Which route a copy
  takes - the async Clipboard API, or the selection path a plain-HTTP origin needs -
  is a decision over stubbed globals (`scripts/test-clipboard.ts`), including where a
  dialog's focus trap requires the scratch element to be attached. Whether that
  selection path puts the text on the clipboard is not: it needs a real document, so
  the acceptance pastes the value back out of the browser's own paste pipeline from
  inside a dialog and from a drawer, which are the containers that trap focus. That
  context is granted no clipboard permission on purpose - granting it would stop the
  acceptance from exercising the fallback at all.

### 11.2 Where the wall clock actually goes

Assertion count was not the cost, and reducing it did not by itself make the
browser suite faster. Measured per line, the acceptance run's time sits in
navigations, `waitFor` round trips and one ten-second cadence wait - which is why
the useful levers were structural rather than subtractive:

| Lever | Effect |
| --- | --- |
| Fold four standalone Chromium probes into one shared server and browser, each scenario in its own context | Four dev servers and four browsers become one each |
| Move the focused probes into `verify:full` | They were in no gate at all; a guarded invariant nobody runs is not guarded |
| Fix the suite's CPU-sensitive reads, then run the two browser phases concurrently | About 12s on a 2-CPU runner, about 14s on four cores |
| Remove the deletion window from the embedded-distribution sync | Not a speed fix: it removes a race between `pnpm build` and the Go gates, which is what made overlapping them safe to keep |

Two levers were measured and rejected.

**Clock-driven polling.** `page.clock` does make the ten-second interval fire early
(11s of app time in about 900ms), but the same mock covers `requestAnimationFrame`
and `performance.now`, which is what `smoothScroll`'s gesture schedule is built
from: with the clock installed the back-to-top gesture landed at 37px instead of
the top, with no page error, breaking the assertion the block exists for. Isolating
the interval from the frame clock is not expressible through that API, so the wait
stays.

**`tsc --incremental`.** It needs a cache that stays correct across a changing
`include` set, which is the fragile dependency graph `test:fast` exists to avoid.

### 11.3 The flakes were real, and they were in the assertions

The suite carried a recorded history of intermittent failures in the filter
section. Running the same suite under a 2-CPU constraint on the **unmodified
baseline commit** reproduced them two runs in three, which settled the question of
whether they were caused by the refactor: they were not.

The shared shape is a read taken immediately after a state change, with no wait for
the event that makes the read meaningful:

- **A footer read racing the refetch.** `the list is back to the unfiltered page`
  read the pagination footer immediately after a URL write. A filterless URL and a
  list that has re-issued its request are different states, and the read could see
  the previous filter's page size.
- **A poll wait with three intervals of headroom.** The live-tail block waited 30s
  for a 10s cadence. That is not three intervals of margin under contention; it is
  three intervals before giving up, and it expired on a page that was merely slow.
  It is now derived from `EVENT_AUTO_REFRESH_MS` with six intervals, and a longer
  bound costs nothing on a healthy machine because the wait returns as soon as the
  pill appears.
- **A row count read before the rows could arrive.** `the list still runs on the
  usable filters` read the row count one render after the notice.

A negative claim still cannot be waited on: `a clean URL shows no notice` stays a
plain `check`, because waiting for the absence of a notice would pass on the first
poll whether or not the page had rendered. What makes it meaningful is the await
before it - the rows being visible is the evidence that the page rendered, and it
rendered without a notice.

After the fixes, the suite passes eight consecutive trials under the strictest
configuration available here (2 CPUs, with the probes running concurrently), which
is the configuration the baseline failed.

### 11.4 The CI critical path is Chromium's OS dependencies

The `browser` job's preparation step was about 99s, bound by
`playwright-core install --with-deps chromium`: almost all of it apt installing the
shared libraries Chromium links against. The SPA build (29.5s) and the Go binaries
(1.3s) run concurrently with that work and are entirely hidden behind it, which is
why overlapping more with the step cannot shorten it.

The apt cost is real but it is not always necessary. `scripts/install-chromium.mjs`
downloads the browser without `--with-deps`, probes a real launch, and installs the
dependencies only when that launch fails. A runner image that already carries the
libraries therefore skips the ~100s, and one that does not gets exactly the command
the workflow used to run unconditionally, so the worst case is the previous cost
rather than a new failure mode. A second launch failure is reported instead of
ignored, because the alternative is a browser job with no browser, which surfaces
as a test failure rather than an environment one.

The probe, not the download's exit status, is what decides. A download that reports
success while the binary cannot start is precisely the state `--with-deps` exists to
repair, so trusting the exit status would reintroduce the bug the flag prevents.
`scripts/install-chromium.test.mjs` asserts both halves.

Removing the apt cost then exposed what it had been hiding: the Go build is now the
floor of that step, about 60s locally with a cold build cache against 92s on the
runner. Two ideas for it were measured and rejected rather than left looking open:
warming the non-embedding packages concurrently with the SPA build is *slower*
(48s against 46s), because the warm-up competes for the same cores the build is
using; and starting the seeder beside the SPA build is also slower (34s for two
concurrent `go build` calls against 23s plus about 5s serially), because both share
one module and build cache and contend on its lock.

Two constraints keep the preparation step's shape:

- **The application binary must be compiled after the SPA build**, because it embeds
  `internal/web/dist`. Building it alongside `pnpm build` can embed a half-written
  bundle, so the sequencing is a correctness requirement rather than a preference.
  Only the seeder, which embeds nothing, runs in parallel.
- **A cache hit on `~/.cache/ms-playwright` proves the browser files are present and
  says nothing about the shared libraries.** That is why the OS dependencies are
  still guaranteed on every run, just by probe rather than unconditionally.

## 12. Demo mode

A public demonstration has to show the product without a gateway behind it, without
any credential, and without becoming a second frontend to maintain. Demo mode is
that, expressed as a thin layer over the ordinary process: `OMCPA_DEMO_MODE=true`
changes where the data comes from and refuses what must not happen, and nothing
declares itself a demo at compile time.

It is off unless it is asked for, and everything it changes is scoped to it, so the
self-hosted path is byte-for-byte the same code (ADR 0016 records the decision and
the alternatives).

| Concern | Self-hosted | Demo |
| --- | --- | --- |
| Upstream | The configured CPA instance | `internal/demo`'s fixture, over a loopback socket, with a key minted per process |
| Management key | `OMCPA_CPA_MANAGEMENT_KEY` | The fixture's own key; an inherited one is discarded, never encrypted into the instance row |
| Database | `oh-my-cpa.db` under `OMCPA_DATA_DIR` | `oh-my-cpa-demo.db`, deleted and rebuilt on every boot |
| Capture and sync | Collector and pricing loop run | Neither starts; the fixture is the history and the price list |
| Sign-in | The CPA management key | A session on first sight, so a link can be opened by anyone |
| Dangerous routes | Served | Refused by `internal/api/demo_policy.go` |

### Why the upstream is a fixture rather than a separate adapter

The console reads the gateway through `internal/cpa/management` in about twenty
handlers. The cheapest way to keep all of them working - including the DTO
allowlists, the credential projection and the model catalog resolution - is to keep
the client and replace what is on the other end of it, so `internal/demo` serves the
management API on a loopback port and the application is pointed at it exactly as it
would be pointed at a real gateway. An adapter at the handler layer would have had
to reproduce every response shape from Go structs and would have grown a branch in
every handler that reads one.

The fixture never dials the URL it is handed: it resolves the requested provider
endpoint against its own catalogue and refuses anything else, which is what makes
"the demonstration performs no outbound request" a property of the code rather than
a promise about the environment. The URLs it answers are pinned to
`internal/quota`'s allowlist by a test, so the duplication cannot drift into
answering a request the console would never make.

### The boundary is a classification, not a list of disabled buttons

The server classifies every route it serves. `internal/api/demo_policy.go` holds one
table of `method + chi pattern + verdict`, first match wins, and the test suite walks
the **real** routing table asserting that every registered route is classified: an
endpoint added without a verdict fails the suite rather than inheriting one. At
runtime an unclassified route is refused, so the failure mode of a gap is a blocked
feature.

The table is ordered from the specific to the general, and the trailing wildcard
that serves the SPA comes last. That ordering is load-bearing: while the wildcard
sat first, it classified every `GET` in the application as public - including the
credential download and the request log - and both were allowed.

Last is not enough on its own, though. A wildcard that resolves before the refusal
for an unclassified API path makes the coverage test unfalsifiable for reads: an
unlisted `GET` matches the wildcard and looks classified. The fallback and the
console are therefore separate lists, and the coverage test refuses a fallback match
as a verdict - so a read endpoint added without one fails the suite, and is refused
at runtime while it does.

Refusals answer `403` with `{"error": ..., "code": "demo_operation_refused"}` - the
code the facade's other failures already carry - plus `X-OMCPA-Demo-Blocked` for a
caller that never parses a body. Reads are marked with `X-OMCPA-Demo: active`, and a
write carries `X-OMCPA-Demo-Persistence: none`, which is how a response can say its
result is not durable without the page having to know.

The classification resolves in three passes - the endpoint verdicts, then the
fallbacks, then the console itself - and the third exists because a trailing wildcard
matches every path below it. That ordering is what keeps the SPA fallback from
answering for an API path: `/api/v1/...` is refused by the fallback, while `/api-keys`
is a page and stays public. Writing the coverage test against that arrangement found
two reads - the gateway key list and the error-log file list - that had been matching
the SPA wildcard, which is to say they were being served without anyone having decided
they should be.

What the demo refuses is whatever moves credential material, starts a real sign-in,
executes a plugin, writes the gateway configuration, spends a quota entitlement,
hands back a raw request or error log, or would leave the process - provider model
reads, the pricing catalogue sync, the diagnostic bundle. What it performs instead
are writes that stay inside this instance: credential metadata and the enabled state
in the fixture, and client-key names, preferences, price rows, resource overrides and
a discovery sweep in the database. A credential status edit and a preference edit are
therefore stored in different places, and both are gone when the instance is replaced.

### The fixture is seeded through the real write path

`internal/demo` builds the history a deployment would have accumulated - about
fourteen thousand requests over 371 days, rising towards the present, across fourteen
traffic models and eight providers, with cached and reasoning tokens, latency and
TTFT, a failure share, named caller keys and a price list - and writes it through
`repository.InsertUsageEvents`, the same call the capture path uses. That is what keeps the fixture subject to the request-time price
lock, the display-mask rules and the schema instead of drifting from them.

The consequence is that the fabricated history needs the price version it is
pretending existed: the price lock resolves a version by the request's own
timestamp, and the trigger that shadows every price write stamps the moment of the
write. `Repository.SeedModelPriceHistoryBackfill` is the one caller that writes a
version at an explicit time, and it exists so the fixture can stay under the real
lock rather than writing a cost column directly.

The price list is seeded with the catalogue the pricing page resolves against,
because a real deployment fills that catalogue from the gateway's own model list
during a sync and the demo deliberately runs none. Without it the page would
intersect its stored prices with an empty catalogue and render nothing.

Seeding is also why the demo database is rebuilt on every boot. A platform that
scales to zero brings the process back hours later; a database left behind would end
its history hours ago, and the fifteen-minute and one-hour windows - the panels that
make the console look alive - would be empty.

### The capture state is reported, not faked

The request list prints the capture state in its own header, and a demo has no
collector to report on. Rather than render "capture disabled" over a page full of
requests, the demo answers with the deployment its fixture describes - a
subscribe-mode collector that last captured seconds ago - while every number that
describes stored data is read from the database. A manual sync is answered the same
way: it reports a pass that found an empty queue, which is what a real deployment
answers when nothing arrived in between.

### On the platform it is deployed to

Vercel builds and routes to `Dockerfile.vercel` (declared in `vercel.json` as a
container service behind a catch-all rewrite), which runs the same binary with the
demo environment baked in: the console at the site root, data under `/tmp`, and the
listening address following the platform's `PORT` at start-up. The only adaptation
the platform needs is that entry point; everything else is the application's own.

The session is issued on any unauthenticated request rather than only on the
sign-in endpoint. That is not a boundary decision - the route policy is the
boundary, and it refuses the same operations either way - but the platform runs
several container instances behind one address, each with its own fixture key, so a
cookie minted by one is invalid at the next. Refusing those reads would turn a
working page into a sign-in card, because the console issues its first queries in
parallel with the session check.

`docs/ops/vercel-demo.md` is the deployment runbook: what the repository provides,
the account-level steps no command can perform, and the failure modes that look like
something else.

## 13. Where to look next

- Domain wording: `CONTEXT.md`
- Deployment and its trade-offs: `docs/adr/0001-go-react-sqlite-modular-monolith.md`
- Identity keys and rebinding: `docs/adr/0002-cpa-binding-and-identity-hierarchy.md`
- Cost immutability: `docs/adr/0003-request-time-price-snapshots.md`
- Visual system: `docs/design.md`
- Backup, restore, and migration gates: `docs/ops/sqlite-operations.md`
- Feature parity status against CPAMC: `docs/cpamc-parity.md`
