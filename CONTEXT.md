# Oh My CPA domain context

Oh My CPA adds a user-owned identity and organization layer above CLIProxyAPI (CPA). CPA remains the execution and protocol-adaptation backend; Oh My CPA stores the business meaning users give to CPA resources.

## Terms

- **Source**: The service origin a user recognizes, such as OpenAI, OpenCode Go, Command Code GOAT, DeepSeek, or a relay station. It is not the same as CPA's technical provider field.
- **Subscription**: A purchased plan or entitlement associated with a Source. One subscription may have multiple accounts or credentials.
- **Account**: A user or upstream identity associated with a Source or Subscription. A local account ID is stable even if an upstream email or identifier changes.
- **Credential**: Authentication material that CPA can use, such as an OAuth auth file, API key, service account, or runtime-only credential. Oh My CPA references and describes credentials; it does not expose secrets in normal resource responses. Auth-file routing fields may be read and written through an explicit safe projection, and a write is only reported as successful once CPA's runtime entry agrees with it: the fields that live in the downloaded JSON are additionally verified against a server-side projection of it, and the update response carries that projection only when it was read back.
- **OAuth Model Alias**: A CPA-owned, provider-scoped mapping from an upstream OAuth/file-backed model ID to a client-visible model ID. It is global to the provider rather than to one credential; Oh My CPA replaces one provider's mapping through an allowlisted facade and verifies CPA's readback before reporting success.
- **Authorization Flow Shape**: How an OAuth sign-in is completed, and the distinction the sign-in page renders. A **redirect flow** ends at a callback URL carrying the authorization code, which an operator on a remote browser may have to paste back (Devin's callback is a loopback address on the CPA host, so pasting is the normal path there rather than a fallback); a **device flow** asks the operator to confirm a short code on the vendor's own page while the console polls (Kimi, Meta Muse). The shape is declared once per provider rather than inferred from its name, and CPA reports it when a flow starts so the console renders the box that actually applies.
- **Endpoint**: A network destination, represented by a base URL and related connection details. An Endpoint is where traffic goes, not necessarily who provides the service.
- **Provider Model Pull**: The console's server-side model-list request to an
  operator-supplied provider endpoint using the provider credential. Model pulls
  require HTTPS; plain HTTP is limited to localhost, loopback, and private IP
  literals. A redirect is followed only when both its scheme and host stay
  unchanged, so credentials and custom headers are never forwarded to a target
  the operator did not enter.
- **Connection**: A user-facing usable line formed from a Source, optional Subscription and Account, Credential, Endpoint, and Protocol Driver. It is the primary resource users organize and name.
- **Protocol Driver**: The technical protocol adapter used by CPA, such as Codex/Responses, OpenAI-compatible Chat Completions, Anthropic Messages, or Gemini. It is implementation metadata, not the user-facing Source.
- **CPA Binding**: The link between a Connection and a concrete resource on one CPA instance, including the CPA resource type and runtime auth index.
- **Unclaimed Resource**: A CPA resource discovered by Oh My CPA that has no confirmed local user identity or override yet. Discovery, the claim status column, and `PATCH /resources/{id}/override` all still exist, but the console no longer routes a triage page: since navigation aligned with gateway surfaces, CPA runtime resources are managed directly through Providers and OAuth management pages instead. The discovery engine persists rows into `discovered_resources` and `cpa_bindings` (queried via `/resources`), so the domain model remains load-bearing even without a dedicated triage screen.
- **Model Price**: The current CPA model catalog is the maintenance scope. Each catalog identity has one current price projection (four per-1M-token rates plus a multiplier); models.dev syncs automatically and manual rows win over sync.
- **Price Version**: An immutable, time-effective price snapshot. A price change creates a new version; deleting a current price creates a tombstone so future requests stay unpriced while existing snapshots remain valid.
- **Request Cost Snapshot**: The price version and USD nanos amount selected in the same transaction as a usage event, using the request timestamp. It is never recalculated from the current price projection.
- **Diagnostic Client Address**: The exact connection peer and the ordered
  `X-Forwarded-For` chain associated with one request record. They are preserved
  for the protected single-record detail, never exposed by the request list,
  search, or authorization logic. Historical records written before this
  contract may still contain the earlier `/24` or `/64` network mask; that data
  cannot be recovered and is never synthetically expanded.
- **Unpriced Usage**: A request for which no valid price version existed at request time. It remains usage-only, is excluded from cost totals, and is never backfilled when a price is added later. Historical rows without a stored snapshot are `legacy_unpriced`.
- **Update State**: The System Information page's answer about one product, and one of
  four values rather than a boolean: `update_available`, `up_to_date`, `update_ahead`
  (the build is newer than any release - ahead of publication, not an update to
  install), or `indeterminate`. Only comparable release versions are compared, so a
  suffixed build version such as `v0.1.0-dev` or `v0.1.0-demo` yields `indeterminate`
  and carries a **reason**: a development build, nothing published, or a release tag
  that is not a version. Reporting such a build as "up to date" would assert something
  the compared data does not support.
- **Release Record**: One published version of a product - its tag, name, publication
  time, and whether it was published as a prerelease. Records are the index the console
  stores. They are replaced as a unit per product each time a feed is read, so a
  withdrawn release stops being claimed.
- **Release Notes**: A release's own Markdown description, held only in the running
  process's memory. They are untrusted remote text: the console never executes HTML
  from them and never loads an image they reference, so opening the page makes no
  request to a third party. Because they are not stored, an index without notes is a
  normal state after a restart - the page then names the versions and links to the
  source rather than rendering an empty change log, which would read as "nothing
  changed".
- **Merged Change Log**: The stable releases in the interval between the running
  version and the newest published one, grouped by version, opened as an overlay over
  the page rather than expanding inside a card. The interval is exclusive at the
  bottom, because the running version's own notes describe a version already in use.
  Prereleases are excluded: a stable operator never received them. When the running
  version is not comparable no interval is claimed at all, and the newest release is
  shown alone. The log states that the interval is **not fully known** only when a
  truncated release walk can actually affect it: a walk that stopped at its page limit
  kept the *newest* releases and dropped older ones, so the interval is still complete
  whenever the running version is at or above the oldest release that was read. The
  alarm is real only when the running version is older than that, because the dropped
  releases then sit inside the interval the reader asked about.
- **Database Footprint**: The measured sizes of the SQLite database's main file and,
  when present, its `-wal` and `-shm` files, reported separately. A file that does not
  exist is absent rather than zero-sized: a cleanly closed database has no WAL file,
  which is a different measurement from an empty one.
- **Free Pages**: Pages inside the database file that later writes reuse, reported
  through `page_count`, `page_size` and `freelist_count`. They are never presented as
  reclaimable or wasted disk space: the file does not shrink until it is rebuilt, and
  the rebuild needs comparably free space while it runs.
- **Maintenance Action**: One of the two operator-issued database operations the console
  can run - a WAL-truncating checkpoint, or a rebuild (`VACUUM`). It runs as a
  background job against the database file and is refused while another is in flight. A
  checkpoint whose own result row says it was blocked is reported as **incomplete**
  rather than successful, because SQLite reports that outcome in the statement's result
  rather than as an error.
- **Write Gate**: The rule that no ordinary write may overlap a Maintenance Action.
  Writers wait for the gate rather than failing, because a failed write stops the usage
  collector and with it the process; a queued writer may abandon the wait when its own
  context ends. It is what makes offering the maintenance actions safe at all.
- **Model Usage**: The dashboard's two model-level panels - a **Token Trend** and a **Model Usage**
  ring - between the six KPI tiles and the Token Activity Grid. Unlike the grid, whose span is
  fixed, both follow the Range Preset, so they answer "which models is this window spending on, and
  when" where the tiles answer "how much, in total". They are ranked by token volume and keep at most
  five named models plus a folded remainder, because a deployment's model list is open-ended
  (aliases, dated revisions, per-provider variants) while both a line chart and a legend stop being
  readable at roughly six series. The remainder is marked with a `folded` flag rather than a reserved
  name: the label is translated in the frontend, so the API cannot know which name would have to be
  reserved, and a model whose name collides with it must not be merged into the remainder. Both panels
  read one response, so a model's colour in the trend cannot disagree with its colour in the ring - see
  `docs/design.md` §2 for the categorical palette this needs and ADR 0006 for why it is a scoped
  exception to the semantic-colour rule. Both panels rank by one of two groupings, chosen per
  **Call Point** or per upstream model and persisted as a Preference; the ranked list also carries each
  group's priced spend at request-time prices, with the priced share shown when it is partial. The list
  reads name, spend, volume, share, and its three numeric columns are tracks declared once on the list
  rather than per row, so a group's spend, volume and share start on the same edge as every other
  group's regardless of how wide any single amount happens to be.
- **Filter Dimension**: One axis of the request-record filter, such as model, provider or credential. Dimensions combine with AND and the values inside one dimension combine with OR, so adding a value widens a dimension while adding a dimension narrows the result. An absent dimension does not narrow at all — a cleared filter must be indistinguishable from one that was never set, which is why absence rather than an empty value is how "not filtering" is expressed everywhere the filter is stored or serialized.
- **Auto Refresh**: A boolean on the request-record view, not an interval. The cadence is fixed at 10 seconds, because the operator only ever wants one of two answers — keep this list current, or stop moving it. Polling is a wall-clock cadence and skips a tick rather than queueing one, so a slow query cannot build a backlog that fires the moment it resolves.
- **Client Key Alias**: The operator-assigned name for one gateway client key, stored in `client_key_aliases` and keyed by `(instance_id, usage fingerprint)`. It is Oh My CPA metadata, not CPA configuration: the secret stays in CPA's document and naming a key never writes that document. The identity is the keyed fingerprint that `usage_events.api_group_key` carries (HMAC purpose `usage-api-key`), never a configuration array index and never the display mask — an index moves when CPA reorders its `api-keys` list, and a mask is not unique because it preserves only a short head and tail. Aliases are deliberately never pruned: historical requests keep their fingerprint forever, so a deleted key's records still need their name, and a rename is read-time resolution rather than a rewrite of stored usage. Duplicate names are allowed, because a name is a label rather than an identity. Where no name exists, every surface falls back to the mask.
- **Streaming Usage Record**: Whether CPA executed a request in streaming mode, captured from CPA's `stream` field into `usage_events.stream` (`1` for streaming, `0` for non-streaming, `NULL` for historical rows where the flag was not recorded). The flag is operator-facing metadata, not the sole classifier for TTFT validity: an upstream executor can capture a genuine first-token boundary even when the client requested `stream: false`. Derived metrics therefore use the residual window `latency_ms - ttft_ms`: **TPS** uses the generation-phase rate `output / (latency - ttft)` when the window is at least `MIN_STREAMING_GENERATION_WINDOW_MS` (50 ms), and otherwise falls back to the end-to-end average `output / latency`; the recorded `stream` flag does not override that decision. A collapsed window means the proxy observed the response at completion rather than a progressive stream, so subtracting it would create timer artifacts such as 768,588 t/s. Presentation shows TTFT only when the window is measurable and shows the non-stream badge when an explicit `stream: false` record has no measurable TTFT or when the residual window collapsed. Historical records (`stream IS NULL`) use the same residual-window heuristic.

## Demo mode

- **Demo mode**: A deployment of the same binary that serves the console from a fixture and refuses the operations a public deployment must not perform, switched on by `OMCPA_DEMO_MODE` and off unless it is. It is not a second product and not a second frontend: every page, DTO and read path is the operator's own. What it changes is where the gateway's answers come from, which credential the session is derived from, where the database lives, and which routes answer at all - see `docs/architecture.md` §13 and ADR 0016.
- **Demo fixture**: The in-process stand-in for CLIProxyAPI that answers the management API the console reads, on a loopback socket, with a key minted per process. It never contacts the URL it is handed: a provider quota read is resolved against its own catalogue and anything else is refused, so a demo performs no outbound request. It stands in for the *gateway*, not for the console: pages that read Oh My CPA's own stored data read the real database.
- **Demo refusal**: A `403` from the route classification, marked with its own header and naming the reason. It is what a route the demonstration must not serve answers, and it is the boundary - a control the console hides or disables is a courtesy to the reader, never the protection.
- **Not-persisted notice**: The statement the console makes after a write the demonstration permits. Such a write lands either in the fixture (a credential's enabled state or its metadata) or in the instance's own temporary database (a caller-key name, a preference, a price row, a resource override), and in both cases it is gone when the platform replaces the instance. Sign-in is excluded: it is not a write, and the notice beside a successful sign-in would say the opposite of what happened. It is shown because "the button worked" and "the change is durable" are different claims, and only the first is true here.

## Naming rule

User-facing names, icons, colors, ownership, and subscription metadata belong to Oh My CPA. CPA driver names, auth indexes, base URLs, and raw provider fields remain technical details and are shown secondarily.

One exception, and only for the icon: a provider a CPA plugin registers carries the logo that plugin publishes, because the plugin is the only authority on it and the console's own catalog cannot be updated by installing a plugin. The logo is fetched by the OMC process and inlined rather than loaded from the plugin's host, and the console's catalog mark is the fallback when the plugin publishes nothing usable — so an operator icon override does not apply to a plugin-owned provider. See `docs/architecture.md` §3.

## Provider disable rule

A provider toggle must change the gateway, not the console. `openai-compatibility`
entries carry CPA's native `disabled` field; a `{family}-api-key` credential
(claude, codex, gemini, meta) has none, so OMC applies CPA's own mechanism
instead: the excluded-all marker `*` in `excluded-models`
(`management.SetExcludedAll`). Writing a local preference only used to repaint
the UI while fallback kept routing into the "disabled" credential.

Because a toggle is a gateway write followed by a re-read, the operator's second
click lands in that gap. The console serialises toggles **per provider** through a
last-intent queue (`web/src/hooks/useLastIntentQueue.ts`, policy in
`web/src/hooks/lastIntentQueue.ts`): one write in flight per provider, a click
during that window replaces the remembered value instead of racing it or being
dropped, and the switch renders the remembered intent until the gateway confirms
it.

That per-provider queue is not sufficient on its own, and the difference is the
reason the gateway side is also serialised. CPA has no per-entry write, so a
toggle reads the family's whole list and writes the whole list back. Two toggles
of **different** providers in one family run concurrently by design, and if both
read before either writes, they submit the same baseline and the later write
discards the earlier one — a switch silently reverts while both requests report
success. Whole-list provider writes are therefore serialised console-side, and
**last-intent** is a property of the per-provider queue, not of that
serialisation: the gateway writer orders writes but does not merge them.

A confirmed write settles from its own response rather than a second list read,
and a list read that a confirmation overtook is discarded instead of published,
so a confirmed value is never replaced by an older one. A transient failure is
retried a bounded number of times, re-reading the newest intent before each
attempt; the whole burst carries one deadline measured from its first click,
which neither a retry nor a later click extends. Passing that deadline abandons
the burst, and because an aborted request does not prove the gateway did not
commit, the row is reconciled against a fresh read and reports an unknown outcome
rather than the value it asked for.

Retrying is safe because a toggle names the provider it meant, not only its
position: the write carries the identity the operator saw, and the gateway-side
handler refuses it when that position now holds a different provider. Without
that check the retry itself would be a defect — a deletion during the retry delay
shifts the positions, and repeating the old position would toggle a provider the
operator never clicked.

Disablement is also what a surface reads back, and reading it is not the toggle's
own field alone: a provider counts as disabled when its own toggle is off **or**
when the gateway holds no enabled credential for its type — the per-type
`disabled` tally `/management/overview` returns beside each type's credential
count. The dashboard's provider fleet orders on that answer before any traffic
number (`web/src/components/dashboard/dashboardProvidersLogic.ts`): every enabled
channel precedes every disabled one, and request volume only orders the rows
inside each group, because a disabled channel's requests are history rather than
capacity in play. That claim is matched on the exact normalized type key and never
by containment, and only against the credential types the row owns — the
`{family}-api-key` family a configured provider belongs to, or the channel a
plugin-driven row names — since CPA's tally covers every auth-file type, and
calling a channel off on another channel's files would assert something false
about who can still serve.

## Auth model

There is exactly one administrator login credential in the whole system: the
CPA management key (`remote-management.secret-key`), passed as
`OMCPA_CPA_MANAGEMENT_KEY`. This is distinct from `OMCPA_MASTER_KEY` (which is a
system encryption secret used for AES-GCM at rest). Oh My CPA has no separate
admin password: the login form takes the management key, submits it to the
server, and derives the session signature from it (HMAC-SHA256 over a fixed
label). The key is never persisted in browser storage and is omitted from normal
API responses; sessions are HttpOnly SameSite=Strict cookies. Rotating the CPA
key invalidates existing sessions once Oh My CPA reloads the new key (e.g. upon
restart or configuration reload). No key configured means the app boots but
sign-in answers 503 until `OMCPA_CPA_MANAGEMENT_KEY` is set. Demo mode is the one
exception, and it is not a relaxation of this rule: there the session is derived
from the fixture's own per-process key and issued on first sight, because a public
demonstration has no administrator whose identity it could be establishing.
Authenticated secret-management surfaces (such as raw YAML source viewing or
explicit caller-key and provider-key reveals) explicitly return credentials to
authorized administrators. Each reveal writes its audit record before the
response is emitted; if that write fails, the read is refused rather than served
unaudited.

## i18n

Native Simplified Chinese, Traditional Chinese, English and Malay UI. The base
dictionary lives in `web/src/i18n/index.tsx` as `[zh, en]` pairs, while
`web/src/i18n/locales/zh-Hant.ts` and `web/src/i18n/locales/ms.ts` carry the
additional catalogs. All four are accessed through `t(key, vars)`; language
persists in `localStorage('omc-lang')` and the antd locale follows. Rule: every
registered language fully localizes — a localized UI must not show untranslated
captions from another language beside its own copy (proper nouns and industry
terms excepted).

The supported languages are listed once in `web/src/i18n/language.ts`, and every
switcher reads that registry. A row carries the language's **endonym** — its own
name in its own script — its stable id, two-glyph code and BCP 47 locale. `id`,
`name` and `code` are stable in every reading, and the endonym is the one part of
the interface the dictionary does not translate: a switcher that renamed 简体中文
to "Simplified Chinese" could not be used by the reader who needs it most, since
someone who cannot read the console's current language cannot recognize their own
behind a translation of it and would have no way back.

The two additional catalogs are separate chunks, fetched when the language is
selected, so the stored preference is a **choice** rather than a guarantee: a tab
older than the deployment serving it asks for a chunk name that no longer exists.
A catalog that cannot be fetched leaves the console reading in its default language
while `omc-lang` keeps the operator's choice, and a switch that cannot fetch one
leaves the reading where it was — never a blank page, and never a leaked rejection.
A browser does not re-fetch a module whose import has already failed in a document,
so the language arrives on the next load rather than on a second click.

One deliberate exception is in the code rather than the dictionary: quota
window labels, plan labels, recommendation reasons, and the discovery fallback
source name are composed by the Go normalizers and rendered verbatim, so an
English console shows those strings as the backend wrote them. The same is true
of transport-level error text: a failed `fetch`, an unreadable error body, or an
upstream `last_error` arrives as a technical English sentence and is injected
into an otherwise translated message (for example `dash.error_title — message`).
Localizing any of these means returning stable identifiers instead of display
text — the frontend already has `apiErrorCode()` for the cases where that
matters, and the rest are deliberately shown as payload.

## Visual system

`docs/design.md` is the single source of truth for brand color, typography,
spacing, and the antd token mapping. `web/src/theme/palette.ts` is the single
source of truth for the palettes: a **palette** is nine **authored tokens**
(`bg`, `surface`, `elevated`, `fg`, `fg2`, `muted`, `meta`, `border`, `accent`)
and seventeen **derived tokens** computed from them, so the six **registered
palettes** and an operator's own are the same kind of object. `themeConfig.ts`
projects a resolved palette onto Ant Design and onto the stylesheet's custom
properties; every other surface - charts, the heatmap, the Monaco editor, the
brand artwork - reads that same resolved palette. Never hardcode colors in
components.

The console has two **theme modes**, light and dark, plus **follow the system**.
Each mode holds one **palette** of its own, so choosing a palette for the mode
that is not in force records it without moving the console. A **custom palette**
is a palette the operator authored; it is labelled 自定义/自訂/Custom/Tersuai
rather than named, and it carries the registered palette it started from, which
is what its reset returns to. See ADR 0011 for the derivation, its constants,
and the places it deliberately differs from the hand-tuned values it replaced.

## Time windows

- **Range Preset**: A relative window — Live (last 15m), 1h, 6h, 24h, 7d, 30d,
  90d. It slides with the current time, so its totals move on every poll even
  when no request arrived: the left edge keeps dropping old events. That is why
  a relative window cannot answer "nothing changed".
- **Live (15m)**: The shortest preset, fifteen minutes at one bucket per minute.
  It is a preset, not a mode: it slides and is polled like the rest, at the
  cadence its own bucket width implies (five seconds). Five minutes was too
  narrow to read as a trend and an hour too coarse to feel live.
- **Custom Range**: An absolute window picked from the calendar, at day
  granularity. It comes in two kinds. A **closed range** is frozen — the console
  shows exactly what was asked for and stops polling, and a picked end means
  through that day. An **open-ended range** (expressed by leaving the end empty)
  keeps its start fixed while its end tracks the current time, so it is polled
  like a preset and grows as it runs.
- **Preference**: Console state stored server-side rather than in the browser,
  so it follows the deployment across devices, browsers, incognito windows, and
  cleared browser storage rather than binding to a single client instance.
  Values are JSON documents under a closed set of named keys
  (`repository.Preference*`); the API rejects any key not on that list, so the
  preference endpoint cannot become a general blob store reachable through the
  session. The keys in use are the dashboard window, the log page's filters,
  the provider icon, display-name and website overrides, the usage-event view
  and column layout, and the console's own display settings — the token unit
  style (`omc_token_style`) and the model panels' grouping view
  (`omc_models_view`).
- **Token Unit Style**: How the console abbreviates token counts — `en-compact`
  (300K, 300M, 1.2B), `zh` (30万, 300万, 12亿) or `full` (300,000,000) — stored as
  the `omc_token_style` preference and applied by one shared frontend layer
  (`web/src/types/tokenDisplay.ts`) so every token readout on the dashboard,
  the request records and the detail drawer changes together. The abbreviation is
  a reading, never a loss: every surface that prints a rounded token number keeps
  the exact count reachable beside it — as the value's own `title`, or in the
  accessible name where the value is decorative — because a rounded value scanned
  in a chart is fine while the same rounding presented as the only number on offer
  is a wrong number. The Chinese scale is a *word*, not just a notation,
  so it belongs only to a Chinese console: a stored `zh` resolves to
  `en-compact` whenever the reading language is neither Simplified nor Traditional
  Chinese, and the option is shown disabled there. The stored value itself is
  never rewritten, so returning the console to Chinese restores the operator's own
  choice. `full` is language-neutral and reads the same in every language.
- **Call Point**: The client-facing identity of a model request: the model alias
  a client requested, or the upstream model name when no alias was set. It is a
  *grouping key*, not a display rewrite — in the model panels' call view one
  call point served by several upstream model variants (the gateway's routing
  detail) reads as one line, because the split between them is not a difference
  the caller chose. The model view keeps the upstream variants distinct, which
  is what the gateway actually routed to. Call view is the default; the choice
  is stored as the `omc_models_view` preference.
- **Source Grouping**: One mode of the request-record list that groups by the
  source a record came from — the provider plus the credential underneath it — so
  the provider context and the auth source are the same axis read at one zoom
  level. The credential half is printed only for a provider the page served
  through more than one credential; a line served by a single credential would
  otherwise repeat the same file name on every header. Records with no provider
  or no credential land in an `unknown` bucket rather than being dropped or
  folded into a named source.
- **Provider Key Mask**: The display mask of the upstream credential that answered one request, shown beneath the provider name on a request record. CPA's usage payload does not carry the key: it carries the credential's runtime `auth_index`, and the keys live only in CPA's configuration. The mask is therefore resolved on the server as the request list is read, by matching that index — inside the one credential list the record's own provider label names, and only for the two label shapes CPA writes for a key-backed provider — against the credential lists CPA currently reports: the four config API-key families and the `openai-compatibility` providers. It is **current-config resolution, not a snapshot taken with the request**: a credential that has since been rotated or deleted stops claiming its index, so the row prints nothing — from the moment the operator changes it here, or within the cached read's short TTL when it is changed outside the console. A provider that has only been switched off is not a removal: it reports no index to claim, and the key that served an earlier request stays named. Nothing is ever reconstructed or guessed, and the resolved value is absent rather than empty when there is none. An index claimed by more than one credential resolves to nothing as well, even when the masks are alike, because neither an index nor a mask is an identity (the same rule the resource join follows). Only API-key records have one — an OAuth record names the account it used instead — and the mask is display only: it exists on no stored row and is never a filter value.
- **Provider Website**: A provider's own homepage, stored as Oh My CPA management
  metadata. CPA has no field for it, so it is never written into CPA's config;
  only an absolute http/https URL is accepted, because the provider list renders
  the provider's name as a link to it.
- **Token Activity Grid (Heatmap)**: The dashboard's day-by-day token field below the six
  KPI tiles — a contribution-graph shape of seven weekday rows (Monday first) by one column
  per week, fifty-three whole weeks ending today. Its span is fixed rather than derived from
  the Range Preset: it answers "how has this year gone" where the tiles answer "how is this
  window going". It carries no caption and no readout saying so - the panel's title names it and
  the cells' tooltips carry the numbers - which is why the two ranges are told apart by the shape
  of the field rather than by a sentence. Seven rows are what make a weekly rhythm a row and a
  trend a direction, which is why the grid is not a single-row timeline. Each day is the **viewer's** local calendar day,
  resolved server-side from the IANA zone the browser sends; a day is 23, 24 or 25 hours as
  the zone requires, and the exact interval a cell aggregated is the same interval its click
  opens in the request list.
- **Heatmap Cell State**: One of `measured` (carried traffic), `empty` (stored, no traffic), or
  `unrecorded` (nothing stored for that day — whether the records were pruned or the day is later
  this week than today). There is no separate `pending` state: the panel distinguishes "there is
  stored data" from "there is not", and a reader comparing days cannot act on the difference between
  a day that has not happened and one whose records were pruned. The days after today in the final
  column are drawn as ordinary unrecorded cells so the current week stays a complete column.
  `empty` and `unrecorded` are **solid fills ordered against the card**, not outlines: the window is
  a rolling year and the default retention horizon is 400 days, so the two agree — but the window
  still ends on today, and outlining the zero cells turned the field into a wire mesh regardless of
  how many there were. Their order carries the meaning — unrecorded is closest to the card (no
  information), empty is a step further (a measured zero), and only a measured day is clearly louder.
  **Every cell is interactive**, including one with nothing stored: its tooltip says so rather than
  refusing the question, and omits the two counts instead of printing zeros that would assert a
  measurement the panel cannot make. That is also why the panel carries no caption and no readout —
  the counts live in the cells' own tooltips and accessible names.
- **Heatmap Tooltip**: The panel's only readout, opened by **clicking** any cell — not by
  hovering, because on a field this dense a hover tooltip fires continuously and competes with
  the hover ring. It shows the date, the request count and the token volume, and carries the
  drill-down to that day's request records as an anchor inside it, opening the exact interval the
  cell aggregated. Its token volume prints in the console's **Token Unit Style** like every other token
  readout, keeping the exact count on the value for the reason that style states; the request count is a
  count rather than a token volume, so it keeps grouped digits whatever the token style is.
  The cell itself never navigates: the day's list is a place, so it is a link that
  can be opened in a new tab and copied, and a stray click cannot throw the operator out of the
  dashboard.
- **Recorded Cell**: A cell whose day has a stored record at or after the first stored request. A
  day before that marker is drawn *unrecorded* — a solid fill one step quieter than an empty day, not
  a hairline — and the copy says "nothing stored" rather than claiming the gateway was idle.
- **Ramp Position**: A cell's place on the Token Activity Grid's **continuous** colour ramp, from the
  cell's own empty fill (no traffic) to the accent (the window's busiest day). A continuous scale
  rather than fixed steps, because a stepped one paints every day between two steps identically —
  which is the day-to-day difference the panel exists to show. The mapping is the square root of the
  day's volume against the window's busiest day: volume spans several orders of magnitude in one
  window, so a linear ramp collapses the middle of the range into one invisible shade and a logarithm
  over-amplifies the bottom. The scale is relative to the window, so the same shape of traffic paints
  the same field whatever the absolute volume.

- **Bucket**: One point of the sparkline. Width is chosen per window so the
  series stays near 48 points on a human step. The newest bucket is always
  partial, and the grid is aligned to bucket multiples so a sliding window does
  not redraw every past point.
- **Tail**: `/management/dashboard/tail` — the whole window's totals and
  metrics, plus the last four buckets. The browser splices it onto the grid it
  already holds; when the two do not line up it refetches the window rather than
  draw a hole in the line. Coverage is deliberately absent: it describes the
  collector, not the window.

A future per-request live feed should follow the same convention — cheap
repeated poll, server-issued cursor, client-side splice — and key on the
`usage_events` row `id`, which is monotonic, rather than on a timestamp, which
a sliding window keeps invalidating. The request list itself already does this:
it is ordered and paged by request time (`timestamp_ms`), while "what has
arrived since" is a separate count anchored on the row `id`.

## Pre-existing CPA adoption and co-existence invariants

A deployment may connect Oh My CPA to a CLIProxyAPI (CPA) instance that was already configured, deployed, and serving traffic independently before Oh My CPA was introduced. Architecture decisions and surface designs must maintain these backward-compatibility and non-destructive adoption invariants:

1. **Zero-destructive configuration adoption**:
   Oh My CPA must never wipe, overwrite, or mutate pre-existing CPA configuration entries that it does not own. Comments, unknown YAML keys, custom routing rules, and unrelated provider definitions in `config.yaml` must survive round trips byte-for-byte. Configuration writes are revision-guarded and modify only the targeted field subtree via AST manipulation (`components/config/configDirty.ts`).

2. **Immediate discovery without configuration modification**:
   When connecting to an existing CPA instance:
   - Pre-configured client keys (`api-keys:` in `config.yaml`) are immediately discovered and rendered in the Key Management console (`/api-keys`).
   - Discovered keys start with no alias and fall back to displaying their masked key, but their HMAC usage fingerprints (`api_group_key` with purpose `usage-api-key`) immediately join with any historical request traffic captured in `usage_events`.
   - Adding, renaming, or clearing a custom name (alias) is stored as Oh My CPA presentation metadata in the SQLite table `client_key_aliases`, keyed by `(instance_id, key_fingerprint)`. It **never** mutates CPA's `config.yaml`, never rotates CPA configuration revisions, and never disrupts running proxy traffic.
   - When adding new keys, operators can optionally supply a custom name immediately; leaving it blank keeps the key unnamed.

3. **Client key removal boundary**:
   CPA authenticates inbound caller requests strictly against its active `api-keys:` list, and that list is the only state a client key has: present (accepted) or absent (rejected with 401 Unauthorized). Oh My CPA deliberately models no suspended or disabled state of its own, because a flag stored here could not stop CPA from accepting the key and would therefore read as a security control it is not. Stopping a key means removing it from `api-keys`, through the same revision-guarded draft transaction as every other configuration write (see ADR 0010).
   - Removal is irreversible for the secret: Oh My CPA stores no copy of a key value, so the console's delete confirmation states that the value cannot be recovered and must be copied first if it is wanted.
   - A custom name and the key's historical traffic outlive its removal, because `client_key_aliases` and `usage_events` are keyed by the usage fingerprint rather than by the key text.
   - The list on the Key Management console (`/api-keys`) carries no status filter, because there is no status to filter: it is exactly what CPA will accept.

4. **Multi-dimensional observability and filtering**:
   - Both the Request Records console (`/usage/events`) and the Dashboard (`/dashboard`) support filtering metrics, throughput, token volume, model ranking, and drill-down links by specific client key fingerprint (`api_key`).
   - Pre-existing traffic with or without custom names remains fully filterable via the stable HMAC fingerprint.
