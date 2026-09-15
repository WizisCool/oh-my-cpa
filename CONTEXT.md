# Oh My CPA domain context

Oh My CPA adds a user-owned identity and organization layer above CLIProxyAPI (CPA). CPA remains the execution and protocol-adaptation backend; Oh My CPA stores the business meaning users give to CPA resources.

## Terms

- **Source**: The service origin a user recognizes, such as OpenAI, OpenCode Go, Command Code GOAT, DeepSeek, or a relay station. It is not the same as CPA's technical provider field.
- **Subscription**: A purchased plan or entitlement associated with a Source. One subscription may have multiple accounts or credentials.
- **Account**: A user or upstream identity associated with a Source or Subscription. A local account ID is stable even if an upstream email or identifier changes.
- **Credential**: Authentication material that CPA can use, such as an OAuth auth file, API key, service account, or runtime-only credential. Oh My CPA references and describes credentials; it does not expose secrets in normal resource responses.
- **Endpoint**: A network destination, represented by a base URL and related connection details. An Endpoint is where traffic goes, not necessarily who provides the service.
- **Connection**: A user-facing usable line formed from a Source, optional Subscription and Account, Credential, Endpoint, and Protocol Driver. It is the primary resource users organize and name.
- **Protocol Driver**: The technical protocol adapter used by CPA, such as Codex/Responses, OpenAI-compatible Chat Completions, Anthropic Messages, or Gemini. It is implementation metadata, not the user-facing Source.
- **CPA Binding**: The link between a Connection and a concrete resource on one CPA instance, including the CPA resource type and runtime auth index.
- **Unclaimed Resource**: A CPA resource discovered by Oh My CPA that has no confirmed local user identity or override yet. Discovery, the claim status column, and `PATCH /resources/{id}/override` all still exist, but the console no longer routes a triage page: since navigation aligned with gateway surfaces, CPA runtime resources are managed directly through Providers and OAuth management pages instead. The discovery engine persists rows into `discovered_resources` and `cpa_bindings` (queried via `/resources`), so the domain model remains load-bearing even without a dedicated triage screen.
- **Model Price**: The current CPA model catalog is the maintenance scope. Each catalog identity has one current price projection (four per-1M-token rates plus a multiplier); models.dev syncs automatically and manual rows win over sync.
- **Price Version**: An immutable, time-effective price snapshot. A price change creates a new version; deleting a current price creates a tombstone so future requests stay unpriced while existing snapshots remain valid.
- **Request Cost Snapshot**: The price version and USD nanos amount selected in the same transaction as a usage event, using the request timestamp. It is never recalculated from the current price projection.
- **Unpriced Usage**: A request for which no valid price version existed at request time. It remains usage-only, is excluded from cost totals, and is never backfilled when a price is added later. Historical rows without a stored snapshot are `legacy_unpriced`.
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

## Naming rule

User-facing names, icons, colors, ownership, and subscription metadata belong to Oh My CPA. CPA driver names, auth indexes, base URLs, and raw provider fields remain technical details and are shown secondarily.

## Provider disable rule

A provider toggle must change the gateway, not the console. `openai-compatibility`
entries carry CPA's native `disabled` field; claude/codex/gemini API-key entries
have none, so OMC applies CPA's own mechanism instead: the excluded-all marker
`*` in `excluded-models` (`management.SetExcludedAll`). Writing a local
preference only used to repaint the UI while fallback kept routing into the
"disabled" credential.

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
sign-in answers 503 until `OMCPA_CPA_MANAGEMENT_KEY` is set. Authenticated
secret-management surfaces (such as raw YAML source viewing or client-key
reveals) explicitly return credentials to authorized administrators and log
audits.

## i18n

Native zh/en bilingual UI. Dictionary lives in `web/src/i18n/index.tsx` as
`[zh, en]` pairs accessed through `t(key, vars)`; language persists in
`localStorage('omc-lang')` and the antd locale follows. Rule: both languages
fully localize — a Chinese UI must not show untranslated English captions next
to Chinese ones (proper nouns and industry terms excepted).

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
spacing, and the antd token mapping. `web/src/theme/themeConfig.ts` mirrors its
palette in code; never hardcode colors in components.

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
  `en-compact` whenever the reading language is not Chinese, and the option is
  shown disabled there. The stored value itself is never rewritten, so returning
  the console to Chinese restores the operator's own choice. `full` is
  language-neutral and reads the same in both.
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
