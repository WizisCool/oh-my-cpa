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
- **Unclaimed Resource**: A CPA resource discovered by Oh My CPA that has no confirmed local user identity or override yet. Discovery, the claim status column, and `PATCH /resources/{id}/override` all still exist, but the console no longer routes a triage page: since the navigation was aligned with the gateway surfaces, CPA resources are reached through Providers and OAuth management instead. The discovered/claimed model is what those pages render from, so the term stays load-bearing even without a dedicated queue screen.
- **Model Price**: The current CPA model catalog is the maintenance scope. Each catalog identity has one current price projection (four per-1M-token rates plus a multiplier); models.dev syncs automatically and manual rows win over sync.
- **Price Version**: An immutable, time-effective price snapshot. A price change creates a new version; deleting a current price creates a tombstone so future requests stay unpriced while existing snapshots remain valid.
- **Request Cost Snapshot**: The price version and USD nanos amount selected in the same transaction as a usage event, using the request timestamp. It is never recalculated from the current price projection.
- **Unpriced Usage**: A request for which no valid price version existed at request time. It remains usage-only, is excluded from cost totals, and is never backfilled when a price is added later. Historical rows without a stored snapshot are `legacy_unpriced`.
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
last-intent queue (`web/src/hooks/useLastIntentQueue.ts`): one write in flight per
provider, a click during that window replaces the remembered value instead of
racing it or being dropped, and the switch renders the remembered intent until the
gateway confirms it. The queue re-reads the list once per drained queue, so two
overlapping refetches of the list cannot let a stale response win. A failure drops
the intent and re-reads, so the switch shows what the gateway holds rather than
what was attempted.

## Auth model

There is exactly one credential in the whole system: the CPA management key
(`remote-management.secret-key`). Oh My CPA has no separate admin password —
the login form takes the management key, verifies it server-side, and derives
the session signature from it (HMAC-SHA256 over a fixed label). Rotating the
CPA key invalidates every existing session. The key never reaches the browser;
sessions are HttpOnly SameSite=Strict cookies. No key configured means the app
boots but sign-in answers 503 until `OMCPA_CPA_MANAGEMENT_KEY` is set.

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

- **Range Preset**: A relative window — 实时 (last 15m), 1h, 6h, 24h, 7d, 30d,
  90d. It slides with the current time, so its totals move on every poll even
  when no request arrived: the left edge keeps dropping old events. That is why
  a relative window cannot answer "nothing changed".
- **实时 (Live)**: The shortest preset, fifteen minutes at one bucket per minute.
  It is a preset, not a mode: it slides and is polled like the rest, at the
  cadence its own bucket width implies (five seconds). Five minutes was too
  narrow to read as a trend and an hour too coarse to feel live.
- **Custom Range**: An absolute window picked from the calendar, at day
  granularity. It comes in two kinds. A **closed range** is frozen — the console
  shows exactly what was asked for and stops polling, and a picked end means
  through that day. An **open-ended range** ("至今", expressed by leaving the end
  empty) keeps its start fixed while its end tracks the current time, so it is
  polled like a preset and grows as it runs.
- **Preference**: Console state stored server-side rather than in the browser,
  because a reload, a service restart and a container rebuild all drop browser
  storage. Values are JSON documents under a closed set of named keys
  (`repository.Preference*`); the API rejects any key not on that list, so the
  preference endpoint cannot become a general blob store reachable through the
  session. The keys in use are the dashboard window, the log page's filters,
  the provider icon, display-name and website overrides, and the usage-event
  view and column layout.
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
