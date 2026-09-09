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
- **Unclaimed Resource**: A CPA resource discovered by Oh My CPA that has no confirmed local user identity or override yet. It is presented in the triage queue for naming and organization.
- **Model Price**: One editable USD price row per model (four per-1M-token rates plus a multiplier). models.dev syncs automatically; manual rows win over sync.
- **Estimated Cost**: A float64 USD estimate per request from the model price; unpriced models report no cost instead of zero.

## Naming rule

User-facing names, icons, colors, ownership, and subscription metadata belong to Oh My CPA. CPA driver names, auth indexes, base URLs, and raw provider fields remain technical details and are shown secondarily.

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
  storage. The dashboard's chosen window and the log page's view filters are
  preferences; the values are JSON documents under a small set of named keys.
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
repeated poll, server-issued cursor, client-side splice — but key on the
`usage_events` row `id`, which is monotonic, rather than on a timestamp, which
a sliding window keeps invalidating.

