# Oh My CPA domain context

Oh My CPA adds a user-owned identity and organization layer above CLIProxyAPI (CPA). CPA remains the execution and protocol-adaptation backend; Oh My CPA stores the business meaning users give to CPA resources.

## Terms

- **Release version**: The stable `vMAJOR.MINOR.PATCH` identity shared by an official OMC build, its published container and its GitHub Release. The running release version is a claim about the shipped build, not a user-selected upgrade target. Development and fork suffixes are intentionally incomparable with the stable release line; failed or absent observations never imply that a deployment is current.

- **Playground**: An ephemeral text-and-image debugging workspace for models already callable through CPA. The operator chooses an existing Client Key Alias (or its mask) and a client-visible Call Point returned by CPA's live `/v1/models` directory. CPA retains normal routing and protocol adaptation; choosing a model does not pin a provider or Credential. Each explicit send or retry can spend provider entitlement.
- **Playground Turn**: One immutable request snapshot and its streamed answer, measured timings, reported usage and bounded diagnostic events. Failed or stopped partial answers remain visible but do not enter later context as completed assistant messages. A Turn carries CPA's `request_id` once CPA has picked a credential for it, and that id (within the Turn's own time window, since CPA's ids restart with CPA) is how the Turn opens its one request record; a Turn without an id has no request link. Retrying the last turn reuses its original snapshot; edited settings apply to the next new turn. The single latest session (selected key fingerprint, Call Point, parameters, custom request body, and active conversation turns with large image payloads redacted) is persisted server-side as the `playground_session` Preference, allowing operators to resume debugging across devices. Starting a new conversation discards stored turns. No key secrets are stored, and an inline image past the storage limit (16 KiB of data URL) is replaced by a placeholder in every retained copy of the turn - the message it was attached to and the request snapshot, which also carries earlier turns' images as history. A restored conversation replays without those placeholders rather than sending a URL the gateway would reject. This does not change CPA or upstream logging policies.
- **Effective request body**: The body actually sent upstream for a Playground Turn, composed once as: the console's own `model`/`messages`/`stream` defaults, then the Turn's parameter fields, then Custom Request Body last so it wins every collision. The composed body is what gets validated, so an override cannot carry content past the image and parameter checks, and parameters the console does not model pass through untouched. Two fields are not the operator's to set: `user_agent` is a transport header rather than a body field (the panel shows it in the preview and in the copied cURL, never inside the JSON), and a non-streaming body is refused by name because this route projects allowlisted SSE events.
- **User-Agent**: The outbound header is the operator's value when they set one, otherwise a product token naming the running build (`Oh-My-CPA/<version>` from `OMCPA_VERSION`). A value containing control characters or exceeding the length limit is refused as a parameter error rather than surfacing later as a gateway failure. Only the dedicated User-Agent field sets the header: a `user_agent` key written inside the Custom Request Body is an ordinary upstream body parameter, passed through like any other, and never reaches the header.
- **Tokens per second (TPS)**: Output-token rate for one attempt, shown consistently in request records and the Playground. The deployment-wide TPS Calculation Mode chooses the denominator; it never changes recorded usage or timing. A remaining interval after the first token may include server-side tool calls and is not a precise measurement of pure generation time.
- **TPS Calculation Mode**: Whether TPS includes first-token latency. `exclude_ttft` (default) divides output tokens by total latency minus first-token latency when the remaining interval is at least 50 ms; missing, invalid or collapsed first-token measurements fall back to total latency. `include_ttft` always divides by total latency. Stored as `omc_tps_calculation_mode`; an absent or unsupported preference uses the default. The choice applies to historical readouts without changing observations or the independent TTFT and non-streaming indicators.


- **Agent**: The console's `/agent` workspace: a server-orchestrated conversation with a model callable through CPA, which may call declared OMC capabilities (tools) to read or change OMC state. It is separate from the **Playground**, which remains an ephemeral model-debugging surface without tool calls. The Agent page sends the operator's message, and the OMC business data the agent reads to answer it, to the selected CPA model and its upstream; the page states this beside the composer, and sending is the act the statement describes (ADR 0027). The model never receives the operator's CPA management key or capability internals. The operator's key, Call Point and reasoning effort are the `agent_target` Preference: a choice that survives reloads and new conversations, apart from the target each stored turn ran with.
- **Browser Run**: A console-managed execution identified by `X-OMC-Run-ID`, separate from its browser subscription. Disconnects and reloads reattach to its bounded server-owned journal; only Stop explicitly cancels execution. Completed journals are process-local and recoverable for 15 minutes, until replacement or restart, never a durable job queue. Recovery does not resubmit a generation or repeat capability writes. Playground persists the acknowledged journal id as `last_run_id` so a completed journal cannot restore a conversation the operator cleared. See ADR 0044.
- **Agent Turn**: One user message plus the model rounds and capability calls it produced, stored in the server-side latest session. A turn is `running`, `pending` (waiting for a human decision), `success`, `error`, or `interrupted`/`uncertain` after a restart or an unverified write. A turn records what the model produced as ordered parts - reasoning, answer text and capability calls, in the order they happened - and the console draws it in that order; reasoning never enters the context later rounds are built from. It also records its rounds, the token usage the gateway reported and the system prompt version it ran with. A turn stopped by the operator is stored as an error carrying the `cancelled` code; the console reads that pair as "stopped" rather than rewriting the stored turn. The server owns the transcript; the browser only renders it and cannot inject tool results, approvals, or history.
- **Agent Run**: One request to `/agent/run`, spoken in AG-UI (ADR 0041): it either starts a turn from one new message or resumes the turn that stopped for the operator. A run is **accepted** once the server has persisted its turn - until then a refused message is handed back to the composer - and it ends in success, an error, or an **interrupt**: the list of operations waiting for the operator, each naming the call that raised it. A resume names exactly those operations, each already decided.
- **Display call**: A `render_chart` or `render_table` call (ADR 0042). The model references rows of an earlier capability call in the same conversation instead of copying them; the server resolves the reference and freezes the resulting **view** - the rows, columns and chart shape - on the call, so the figures drawn are the capability's figures and stay the same after a reload. A display call is not a capability: it changes nothing and never waits for the operator. A view is a selective final-answer artifact - the model investigates first, and the console publishes it only from a successful turn.
- **Capability**: One declared operation OMC exposes to agents: a stable snake_case name, description, JSON Schema for its typed input and output, permission (`read`, `write`, or `destructive`), risk, adapter exposure, and handler. The same declaration backs the built-in Agent, the MCP bridge, the capability catalogue, and its tests. **The whole registry is what the model is offered**: every declared capability is a tool from the first round of every Agent turn, so a capability added here is reachable without a discovery step, and its description is a per-turn cost rather than a one-off.
- **Capability Operation**: The server-side record of one capability invocation that needed a decision or produced a durable outcome: its normalized arguments, structured preview, target revision, status, and result. Destructive or otherwise high-risk calls wait for one allow-or-deny operator decision bound to that preview (ADR 0035), made on a card under the call that raised it (ADR 0043); an `ask_question` call waits for the operator's answer instead. An operation is consumed once, expires after 10 minutes if undecided (24 hours for a question), and terminal records are retained for 7 days.
- **Operator question**: An `ask_question` call: 1-4 questions the Agent asks the operator mid-turn, each with optional labelled choices and a typed answer always available. The turn waits for the answer; skipping it is a rejection the model is told of.
- **Readable table**: A database table `database_query` may read, with the columns it hides. Every table is classified readable or hidden (ADR 0036); a table a migration adds is unreadable until classified. Raw query rows belong to the Agent's investigation, not to a console preview; the model still receives them and may use them in its answer or an explicit display.
- **MCP bridge**: `oh-my-cpa mcp`, a stdio transport that maps the capability registry to MCP tools for external agents. It carries no business logic and no approval policy; it authenticates to OMC with the CPA management key and cannot approve, submit secrets, or complete OAuth.

- **Plugin**: A CPA extension loaded into the gateway process from its plugin directory. A plugin is *installed* when CPA discovers its file, *configured* when `plugins.configs.<id>` exists, *registered* when the running host loaded it, and *running* (`effective_enabled`) only when it is enabled, registered and the plugin system is on; the console states which of these holds rather than a bare on/off. A plugin's **declared fields** are the settings its manifest describes (name, type, enum values, description); its **settings document** is `plugins.configs.<id>`, which also holds the host's own `enabled` and `priority`, the **install record** CPA writes under `store` when it installs the plugin from a registry (shown as where the plugin came from, never edited), and may hold keys the plugin never declared. Editing keeps those undeclared keys.
- **Plugin Auth Provider**: A plugin that implements CPA's credential-handling provider interface. CPA reports this capability as `supports_oauth`, but that flag alone does not establish an interactive OAuth login flow; a provider can handle API-key credentials instead. The installed-plugin capability badge therefore says **Auth provider**, without inferring the credential type or login method. The connection picker labels these entries **Plugin-managed**, uses the registered plugin page when available, and otherwise requests interactive login only on an explicit user action. A successful CPA login response determines the session flow; existing credentials do not depend on login capability.
- **Plugin Page**: A page a running plugin registers with CPA (`menus`): an HTML resource the plugin serves under `/v0/resource/plugins/<id>/`, listed in the console's navigation under the label the plugin gave it and shown in a frame. The page is the plugin's own document and calls the plugin's own management routes. Only a running plugin has pages.
- **Plugin Host**: The console's authenticated route tree (`/api/v1/plugin-host/`) a Plugin Page is loaded through. It reads plugin resources without the management key and calls plugin-registered management routes with the key added server-side; CPA's own management roots are refused, so it is not a general CPA proxy. The management key never reaches the page, but the page is same-origin with the console and so acts with the signed-in operator's authority: installing a plugin is the trust decision (ADR 0060).
- **Plugin System Settings**: The three host-owned keys of the `plugins` section - `enabled` (whether CPA loads plugins at all), `store-sources` (registries read in addition to the built-in official one) and `store-auth` (authentication rules for registry, metadata and artifact requests, matched by URL prefix). A rule names environment variables; the credential itself never appears in the file or the console. They are edited on the plugin page, not the configuration page, and saved against the loaded revision (ADR 0029).
- **Official Plugin**: A store entry supplied by CPA's built-in registry whose repository is under the first-party GitHub organisation. Both are required, because a third-party registry can copy a repository name; every other entry is **third-party**, and installing one requires typing the plugin id.

- **Gateway Log**: CPA's own log file and its request error files, read through the Management API. It is CPA's record, not Oh My CPA's: the console only tails it, and truncating it acts on CPA.
- **Service Log**: Oh My CPA's own process log. The process writes every record to stderr, which remains the durable log a deployment collects; the console reads a bounded, redacted in-memory copy of the latest 2,000 records that starts empty on every restart. Field values are scrubbed with the same redaction as audit rows, and any field whose name marks a credential (including every `*key` name) is replaced outright.
- **Audit Trail**: The append-only record of what operators and the Agent did through Oh My CPA (`audit_events`). A write records an `attempt` row before it acts and an outcome row after; the trail reads them as one **Audit Entry** whose result is the outcome, pairing the rows by the request id every request is given on arrival (rows written before that pairing existed - older than migration 027 - are matched by action, target and a one-minute window). An attempt with no outcome stays visible as unfinished, and is a filter of its own. The trail is read on its own Audit page, narrowed by outcome, action category, text and time range, with each outcome and category counted over the whole trail rather than the page on screen. Reading the trail is not audited; exporting it is, and the export is withheld when that record cannot be written.

- **Source**: The service origin a user recognizes, such as OpenAI, OpenCode Go, Command Code GOAT, DeepSeek, or a relay station. It is not the same as CPA's technical provider field.
- **Subscription**: A purchased plan or entitlement associated with a Source. One subscription may have multiple accounts or credentials.
- **Account**: A user or upstream identity associated with a Source or Subscription. A local account ID is stable even if an upstream email or identifier changes.
- **Credential**: Authentication material that CPA can use, such as an OAuth auth file, API key, service account, or runtime-only credential. Oh My CPA references and describes credentials; it does not expose secrets in normal resource responses. Auth-file routing fields may be read and written through an explicit safe projection, and a write is only reported as successful once CPA's runtime entry agrees with it: the fields that live in the downloaded JSON are additionally verified against a server-side projection of it, and the update response carries that projection only when it was read back.
- **OAuth Management Workspace**: The console's single credential-centred destination at `/oauth-management`. Auth files own collection membership; quota observations join only by one unique exact nonempty `auth_index`, and a missing or duplicate index remains visible as an operational diagnostic rather than selecting a filename, email, provider or positional fallback. Authorization, configuration, model lists and provider aliases are contextual tasks inside this workspace, while the historical `/oauth`, `/auth-files` and `/quota` URLs remain parameter-safe compatibility redirects.
- **Display Provider Key**: The canonical provider family used by the workspace's filters and brand resolution. It is presentation identity, not the credential's auth index and not necessarily the vendor's authorization route.
- **Authorization Provider ID**: The console's id for an OAuth sign-in provider. It is declared per sign-in provider (for example the Claude display family starts `anthropic`), may come from a plugin's `oauth_provider`, and is resolved without fuzzy matching from the display key. The id CPA's shared login endpoint expects can differ: the management client translates it when it starts a flow (`anthropic` is sent as `provider=claude`), and a plugin's id passes through unchanged.
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
- **CPA v8 Baseline**: Oh My CPA requires CPA v8.0.0 or later and speaks the v8 Management API (`/v8/management`). Whether a gateway serves it is observed by reading `/v8/management/config/config-version` and requiring the value `8`, never inferred from a version string. A gateway that answers "not v8" is refused before any request (`cpa_v8_required`), `/api/healthz` reports it as `cpa_management_api: unsupported`, and the console shows upgrade guidance in place of every page. A gateway with no management secret answers 404 on both management trees; it is reported as `disabled` (`cpa_management_disabled`) and the console shows the management-secret setting instead, because its version cannot be observed. `/v0/management`, which v8 still serves, is used only for the reads v8 does not offer: each upstream key's `auth-index`, and the configuration file as stored (ADR 0034, ADR 0037, ADR 0038). Every configuration write, provider credentials, OAuth model aliases and plugin settings included, goes through the v8 configuration API.
- **Configuration Layout**: The spelling a CPA `config.yaml` is stored in: `v8` (the v8 sections, marked `config-version: 8`) or `legacy` (a pre-v8 file, which a v8 gateway reads unchanged). The console reads and writes only the v8 layout: CPA renders any stored file in it, and each save names v8 paths. The first v8 configuration write to a legacy file makes CPA convert the whole file once (Configuration Backup). In the v8 layout the root `api-keys` key holds the upstream provider groups and client keys live at `access.api-keys`.
- **Configuration Backup**: The encrypted copy of CPA's `config.yaml`, as stored, that Oh My CPA keeps before every configuration write (`cpa_config_backups`, ADR 0051), labelled with the kind of write it preceded (its reason) and its Configuration Layout. A copy identical to the newest one is not kept twice. v8 copies are kept to the operator's retention (default 20, between 5 and 100); legacy copies, which include the file as it was before CPA converted it, are kept apart (the latest ten). A write whose copy cannot be kept is refused before anything is sent (`config_backup_failed`). The configuration page lists the copies, takes one on demand, and downloads or deletes one; every read or removal is audited.
- **Configuration Restore**: Writing a v8 Configuration Backup back to the gateway as a whole-document save, on the server (the document never reaches the browser). The save keeps the file it replaces like any other write, so a restore is itself undoable. A legacy copy cannot be restored through the v8 API and is download-only. Restore is withheld while the configuration editor has unsaved changes, and it is not an agent capability.
- **Configuration Change Set**: What a visual or Keys-page save sends: the v8 paths the draft changed, each with its new value or marked removed, against the revision the draft was loaded at. CPA writes each path in place, so settings the save does not name are neither sent nor overwritten. A path, value or name CPA does not accept is refused without writing that request, with CPA's reason (`config_rejected`). Earlier valid requests in the same change set may already have been written; those saves return `config_partially_applied` without rolling them back.
- **Unclaimed Resource**: A CPA resource discovered by Oh My CPA that has no confirmed local user identity or override yet. Discovery, the claim status column, and `PATCH /resources/{id}/override` all still exist, but the console no longer routes a triage page: since navigation aligned with gateway surfaces, CPA runtime resources are managed directly through Providers and OAuth management pages instead. The discovery engine persists rows into `discovered_resources` and `cpa_bindings` (queried via `/resources`), so the domain model remains load-bearing even without a dedicated triage screen.
- **Model Price**: The current CPA model catalog is the maintenance scope. Each catalog identity has one current price projection: four per-1M-token rates (prompt, completion, cache read, cache write), a model multiplier and optional Price Tiers. OpenRouter's public model list is the only automatic source; a cache rate it does not publish is the prompt rate, never zero.
- **Pricing Provider Membership**: The exact set of current model identities a configured API-key provider or OAuth provider serves, captured with the complete CPA pricing catalog. It is presentation grouping, not a separate provider-specific price: a model can belong to several providers and still has one Model Price. Provider group labels and icons reuse the management identity; model labels remain text-only with a metadata extension point. Groups sort by routing priority and name, and models use case-aware natural name ordering. An alias with conflicting routed targets has an empty price target and remains unpriced unless an operator supplies a link or custom price; it does not invalidate the rest of the catalog.
- **Price Mode**: How a Model Price is maintained. `auto` follows the automatic OpenRouter match, `linked` follows an OpenRouter model the operator chose (a pin), `custom` uses the operator's own rates. Syncs refresh `auto` and `linked` and never touch `custom`; a name that only resembles an OpenRouter model is offered as a suggestion, never matched. A price synced from models.dev before OpenRouter became the source is a legacy `auto` row until a sync matches it.
- **Price Candidate**: An OpenRouter model a `custom` or `linked` Model Price could follow that the operator has not answered — typically one OpenRouter started listing after the price was set by hand. A custom price's candidate is its automatic match, else its first suggestion; a linked price's is an automatic match different from its link. Saving the price or ignoring the candidate records it as answered, so only a different candidate is announced again. Following one is an ordinary mode change; ignoring one changes no price.
- **Price Tier**: A conditional override of a price's rates: a long-context threshold over the request's full input (cached tokens included), a UTC time-of-day window read from the request's own timestamp, or both. Exactly one tier governs a request - the highest threshold, then a windowed tier - and rates it leaves out inherit the base price.
- **Channel Multiplier**: A multiplier on every request one CPA provider label (`usage_events.provider`) answered, on top of the model's price: a relay that resells at 30% of list is 0.3. It is versioned and locked per request like a price; a channel without one is 1×.
- **Price Version**: An immutable, time-effective price (or channel multiplier) snapshot. A change creates a new version; deleting a current price creates a tombstone so future requests stay unpriced while existing snapshots remain valid.
- **Request Cost Snapshot**: The price version, channel version, tier and USD nanos amount selected in the same transaction as a usage event, using the request timestamp. It is never recalculated from the current price projection; the request detail recomputes a breakdown from the locked versions only to explain it.
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
  the compared data does not support. An empty release feed is established only
  by a successful check; a failed first attempt remains `not_checked_yet`, with its
  failure reported separately. An HTTP-successful check response can contain a failure
  for either product, so its transport status is not an update-check verdict.
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
  shown alone. That fallback belongs to the uncomparable case only: a build that is up
  to date or ahead has an empty interval, and its card offers no change log. The log states that the interval is **not fully known** only when a
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
  rather than as an error. The server retains the last job's status in process memory for
  the life of the process, so that record is a **retained status** rather than news: the
  console does not present it as the current reader's result. It shows a job it observed
  (one already running when the page opened, one it started, or one admitted elsewhere that a
  later read reported as running) and reports that job's outcome once, which the reader may
  dismiss; dismissing it is local, so re-reading the server's retained record does not bring it
  back. A job that finishes and is replaced within one poll interval is followed too: the first
  sign of the replacement is its own terminal record, and dropping it would leave the page
  polling for a job the server had already moved past. Which job a record describes is decided by
  its **job id**, the reservation the job was admitted under: it is monotonic within the process,
  which the start time cannot promise, since the start time is the wall clock and two jobs can
  share a millisecond or a synchronised clock can step backwards. A job still running is always
  shown, because the panel is the reader's only evidence that a Maintenance Action holds the
  Write Gate, and a reader must not be able to hide live work.
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
- **Streaming Usage Record**: Whether CPA executed a request in streaming mode, captured from CPA's `stream` field into `usage_events.stream` (`1` for streaming, `0` for non-streaming, `NULL` for historical rows where the flag was not recorded). The flag is operator-facing metadata, not the sole classifier for TTFT validity: an upstream executor can capture a genuine first-token boundary even when the client requested `stream: false`. TPS Calculation Mode controls whether the first-token measurement is subtracted. Exclusion requires a measurable residual window of at least 50 ms and otherwise falls back to total latency; inclusion always uses total latency. The recorded `stream` flag does not override the formula or first-token validity. A collapsed window means the proxy observed the response at completion rather than a progressive stream, so subtracting it would create timer artifacts such as 768,588 t/s. Presentation shows TTFT only when the window is measurable and shows the non-stream badge when an explicit `stream: false` record has no measurable TTFT or when the residual window collapsed. Historical records (`stream IS NULL`) use the same residual-window heuristic.

## Demo mode

- **Demo mode**: A deployment of the same binary that serves the console from a fixture and refuses the operations a public deployment must not perform, switched on by `OMCPA_DEMO_MODE` and off unless it is. It is not a second product and not a second frontend: every page, DTO and read path is the operator's own. What it changes is where the gateway's answers come from, which credential the session is derived from, where the database lives, and which routes answer at all - see `docs/architecture.md` §13 and ADR 0016. It is also the generator for the public demonstration's dataset, so it stays in use now that the public deployment no longer runs this binary.
- **Public demonstration**: The page linked from the README. It serves the same console build as static assets, with its API answered by a Cloudflare Worker from a dataset generated out of the real handlers, on a fixed reference instant that is re-based onto the viewer's clock as each response is served. It shows the console rather than running the product: no gateway, database, capture pipeline or authentication is behind it, and a write is refused rather than simulated. It is read-only in a way demo mode is not - demo mode lets a visitor's write land in the in-memory fixture, and the demonstration has nowhere to put one. The one choice a visitor does keep is the theme: under demo mode and the public demonstration alike it lives in that browser only, neither pushed to the server nor adopted from it, because visitors share one server and a refused push would be retried, and reported, on every later page load. See ADR 0021 and `docs/ops/cloudflare-demo.md`.
- **Generated dataset**: The captured responses the public demonstration is served from, produced by `internal/api/demo_export_test.go` through the real handlers and committed under `deploy/cloudflare/data/`. Generated rather than hand-written so every response carries a shape the product actually emits, and gated by `pnpm check:demo`, which fails when a console route loses coverage, when a source it derives from changes, or when it carries a value that must not be public.
- **Re-basing**: Moving a captured response's timestamps onto the viewer's clock by one delta before serving it. One delta per response rather than per field, so a window's bounds, its buckets and the rows inside it keep describing a single span. It is what stops a generated dataset from being visibly stale: the console asks for a window by name, and a frozen capture would describe one that ended when it was generated. An instant is recognised by field name (`*_at_ms`) and text instants only when the whole string is an RFC 3339 instant - `Date.parse` reads `claude-haiku-4-5` as a date.
- **Demo fixture**: The in-process stand-in for CLIProxyAPI that answers the management API the console reads, on a loopback socket, with a key minted per process. It never contacts the URL it is handed: a provider quota read is resolved against its own catalogue and anything else is refused, so a demo performs no outbound request. It stands in for the *gateway*, not for the console: pages that read Oh My CPA's own stored data read the real database.
- **Demo refusal**: A `403` from the route classification, marked with its own header and naming the reason. It is what a route the demonstration must not serve answers, and it is the boundary - a control the console hides or disables is a courtesy to the reader, never the protection.
- **Not-persisted notice**: The statement the console makes after a write demo mode permits. Such a write lands either in the fixture (a credential's enabled state or its metadata) or in the instance's own temporary database (a caller-key name, a preference, a price row, a resource override), and in both cases it is gone when the process is replaced. The public demonstration never reaches this notice, because it refuses every write. Sign-in is excluded: it is not a write, and the notice beside a successful sign-in would say the opposite of what happened. It is shown because "the button worked" and "the change is durable" are different claims, and only the first is true here.

## Naming rule

User-facing names, icons, colors, ownership, and subscription metadata belong to Oh My CPA. CPA driver names, auth indexes, base URLs, and raw provider fields remain technical details and are shown secondarily.

One exception, and only for the icon: a provider a CPA plugin registers carries the logo that plugin publishes, because the plugin is the only authority on it and the console's own catalog cannot be updated by installing a plugin. The logo is fetched by the OMC process and inlined rather than loaded from the plugin's host, and the console's catalog mark is the fallback when the plugin publishes nothing usable — so an operator icon override does not apply to a plugin-owned provider. See `docs/architecture.md` §3.

## Provider disable rule

A provider toggle must change the gateway, not the console. `openai-compatibility`
entries carry CPA's native `disabled` field; a `{family}-api-key` credential
(claude, codex, gemini, meta, xai, vertex, interactions) has none, so OMC applies CPA's own mechanism
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
CPA management key (`management.secret-key`), passed as
`OMCPA_CPA_MANAGEMENT_KEY`. This is distinct from `OMCPA_MASTER_KEY` (which is a
system encryption secret used for AES-GCM at rest). Oh My CPA has no separate
admin password: the login form takes the management key, submits it to the
server, and derives the session signature from it (HMAC-SHA256 over a fixed
label). Because it is the site's only login credential, the sign-in form is the
only password field in the console: every other secret (an upstream provider key,
a gateway client key) is entered through `SecretInput`, a text field masked by
style, so the browser neither fills the management key into it nor offers to save
a provider key as the console login. The key is never persisted in browser storage and is omitted from normal
API responses; sessions are HttpOnly SameSite=Strict cookies. Rotating the CPA
key invalidates existing sessions once Oh My CPA reloads the new key (e.g. upon
restart or configuration reload). No key configured means the app boots but
sign-in answers 503 until `OMCPA_CPA_MANAGEMENT_KEY` is set. The same key
authorises the external capability endpoints (`/api/v1/capabilities...`) when
presented as `Authorization: Bearer`; there is no second external credential
store. Holding it is therefore administrator-equivalent, and approval, private
secret submission, and OAuth authorization still require a signed-in browser. Demo mode is the one
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
- **Window resolution**: A preset and an open-ended range end at the server's
  "now", never the browser's. Every read of stored records sends the window as
  chosen (a preset name, or the picked bounds) and the server resolves it, because
  records are stamped on the server's clock: an end computed in a browser whose
  clock runs behind hides every record newer than that clock, and no refresh
  brings them back. The console may still estimate the bounds locally to print
  them.
- **Quota Window**: One metered period of a provider credential's quota (for
  Codex, the 5-hour and weekly windows), each carrying its own used share. A
  provider flag that marks a whole rate limit as reached (Codex
  `limit_reached` / `allowed: false`) does not say which window tripped, so it
  never overrides a window's own reading: it pins to 100% only a window that
  reports no usage, or, when every window reports usage below 100 because
  upstream rounds, the most used one. Pinning every window would show the weekly
  quota as spent whenever the 5-hour window runs out.
- **Estimated Window Capacity**: What a whole Quota Window is worth: usage this
  deployment recorded in the indicated cycle and metered model scope divided by
  the share upstream reports as used. It is capacity at 100%, not a forecast of
  consumption when the window ends. Usage stops at the observation, and cost uses
  Request Cost Snapshots. Below 5% consumption no current-cycle estimate is given;
  dollar estimates additionally require at least 95% of recorded requests to be
  priced. Unknown boundaries, expired or failed readings, unresolved model scopes,
  unavailable evidence and observed mid-cycle resets also withhold estimates.
  The rounding allowance covers half a percentage point, not statistical confidence.
  Codex and Claude global windows, model-metered windows and reviewed Antigravity
  groups can be estimated. An opaque historical alias without an identifiable served
  model makes a scoped estimate unavailable; it is never treated as zero usage.
  Unrecorded traffic is invisible, late-arriving recorded events can revise an
  estimate, and the figure varies with model mix. It never feeds routing or status.
- **Previous-Cycle Capacity Reference**: The last retained valid capacity estimate
  from the immediately preceding scheduled cycle, offered when a fresh current
  cycle has too little usage, no recorded traffic or no used-share reading. It is
  explicitly labelled as historical and carries its observation and cycle bounds;
  it is neither current capacity nor the previous cycle's actual total consumption.
  A changed scope or period, a missing adjacent cycle or an observed early reset
  makes the reference unavailable. Detected reset evidence and failed history-read
  evidence remain attached to subsequent observations of that cycle even after the original readings expire.
  An evidence failure withholds estimates but does not block saving a fresh reading.
- **Preference**: Console state stored server-side rather than in the browser,
  so it follows the deployment across devices, browsers, incognito windows, and
  cleared browser storage rather than binding to a single client instance.
  Values are JSON documents under a closed set of named keys
  (`repository.Preference*`); the API rejects any key not on that list, so the
  preference endpoint cannot become a general blob store reachable through the
  session. The keys in use are the dashboard window, the log page's filters,
  the provider icon, display-name and website overrides, the usage-event view
  and column layout, and the console's own display settings — the token unit
  style (`omc_token_style`), TPS calculation mode (`omc_tps_calculation_mode`),
  the model panels' grouping view
  (`omc_models_view`), the theme (`omc_theme`) and scroll smoothing
  (`omc_scroll_smoothing`).
- **Scroll Smoothing**: Whether a wheel notch or a scrolling key glides to its
  destination instead of jumping — `on` (default), `system` (glide unless the
  system reports reduced motion) or `off`, stored as `omc_scroll_smoothing`.
  It smooths only discrete input; trackpads and touch are never glided.
  It is the one motion that does not follow `prefers-reduced-motion` by
  default, because it is the reader's own input and on Windows that signal is
  the switch that removes the browser's glide (ADR 0046).
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
- **Served Model**: The model an upstream reported having served for one request,
  as CPA v8 publishes it in the usage record (`response_model`) and Oh My CPA
  stores it beside the requested model. It is an upstream's own statement, not a
  measurement: it shows rerouting, a canary under a new name and which snapshot
  an alias resolved to, and it cannot show a model whose quality changed under
  an unchanged name. Unknown is a distinct state - an upstream that declared no
  model, or a record ingested before the field was stored - and is never read as
  "served as requested". A request is **substituted** when the Served Model
  names a different model than both the upstream model name and the alias the
  client asked for; a dated snapshot, a `-latest` alias, a provider prefix and a
  thinking suffix of the same model are not substitutions. The verdict is decided
  once at ingestion (`internal/usage/served_model.go`, following CPA's own
  substitution rule) and stored, so the list, the filter and the detail view
  agree on it.
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
- **Provider Key Mask**: The display mask of the upstream credential that answered one request, shown beneath the provider name on a request record. CPA's usage payload does not carry the key: it carries the credential's runtime `auth_index`, and the keys live only in CPA's configuration. The mask is therefore resolved on the server as the request list is read, by matching that index — inside the one credential list the record's own provider label names, and only for the two label shapes CPA writes for a key-backed provider — against the credential lists CPA currently reports: the config API-key families and the `openai-compatibility` providers. It is **current-config resolution, not a snapshot taken with the request**: a credential that has since been rotated or deleted stops claiming its index, so the row prints nothing — from the moment the operator changes it here, or within the cached read's short TTL when it is changed outside the console. A provider that has only been switched off is not a removal: it reports no index to claim, and the key that served an earlier request stays named. Nothing is ever reconstructed or guessed, and the resolved value is absent rather than empty when there is none. An index claimed by more than one credential resolves to nothing as well, even when the masks are alike, because neither an index nor a mask is an identity (the same rule the resource join follows). Only API-key records have one — an OAuth record names the account it used instead — and the mask is display only: it exists on no stored row and is never a filter value.
- **Configured Provider Traffic**: The requests a configured provider served, counted from the runtime `auth_index` of the credential that answered each of them — one index belongs to one provider's key, and that is the only exact identity available. CPA's `provider` label names the upstream *family*, which every key of that family and that family's OAuth channel share, so a family label, a display name and a substring are all matches that credit one surface with another's requests; none of them is used. Only an `openai-compatibility` provider also claims a label, and only the exact `openai-compatible-<name>` one CPA derives from that provider's own name, because those records carry no index. Every configured provider is a row of its own: two providers left at CPA's default name, and two keys of one family, are distinct providers and neither is merged into the other. Traffic that names no index — records stored before the index was captured, and records whose credential has since been deleted — is credited to no configured provider, and is never inferred onto one.
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
   Oh My CPA must never wipe, overwrite, or mutate pre-existing CPA configuration entries that it does not own. Configuration writes are revision-guarded and name only the paths the operator changed (Configuration Change Set), so unrelated provider definitions, routing rules and plugin settings are never sent or rewritten. The one exception is CPA's own conversion of a legacy file on the first v8 write, which reformats the file, adds CPA's defaults and turns unknown sections into comments; Oh My CPA keeps the file as it was before that write, as before every write (Configuration Backup), and refuses the write when it cannot.

2. **Immediate discovery without configuration modification**:
   When connecting to an existing CPA instance:
   - Pre-configured client keys (`access.api-keys` in CPA's v8 rendering, which is where a legacy file's root `api-keys:` list appears too) are immediately discovered and rendered in the Key Management console (`/api-keys`), without writing the file.
   - Discovered keys start with no alias and fall back to displaying their masked key, but their HMAC usage fingerprints (`api_group_key` with purpose `usage-api-key`) immediately join with any historical request traffic captured in `usage_events`.
   - Adding, renaming, or clearing a custom name (alias) is stored as Oh My CPA presentation metadata in the SQLite table `client_key_aliases`, keyed by `(instance_id, key_fingerprint)`. It **never** mutates CPA's `config.yaml`, never rotates CPA configuration revisions, and never disrupts running proxy traffic.
   - When adding new keys, operators can optionally supply a custom name immediately; leaving it blank keeps the key unnamed.

3. **Client key removal boundary**:
   CPA authenticates inbound caller requests strictly against its active client-key list (`api-keys:`, or `access.api-keys` in a v8-layout file), and that list is the only state a client key has: present (accepted) or absent (rejected with 401 Unauthorized). Oh My CPA deliberately models no suspended or disabled state of its own, because a flag stored here could not stop CPA from accepting the key and would therefore read as a security control it is not. Stopping a key means removing it from that list, through the same revision-guarded draft transaction as every other configuration write (see ADR 0010).
   - Removal is irreversible for the secret: Oh My CPA stores no copy of a key value, so the console's delete confirmation states that the value cannot be recovered and must be copied first if it is wanted.
   - A custom name and the key's historical traffic outlive its removal, because `client_key_aliases` and `usage_events` are keyed by the usage fingerprint rather than by the key text.
   - The list on the Key Management console (`/api-keys`) carries no status filter, because there is no status to filter: it is exactly what CPA will accept.

4. **Multi-dimensional observability and filtering**:
   - Both the Request Records console (`/usage/events`) and the Dashboard (`/dashboard`) support filtering metrics, throughput, token volume, model ranking, and drill-down links by specific client key fingerprint (`api_key`).
   - Pre-existing traffic with or without custom names remains fully filterable via the stable HMAC fingerprint.

## Time zone

- **Deployment Time Zone**: The server's local calendar, resolved from `TZ` when configured or the operating system's timezone otherwise. Container deployments pass an IANA name through `TZ`; the supplied Compose stacks default to UTC and give CPA and OMC the same value.
- **OMC Time Zone**: The deployment-wide calendar chosen in OMC Settings. An unset choice uses the Deployment Time Zone. A manual IANA choice takes precedence until the operator selects the server's zone again. Browser timezone does not override this choice. UTC offsets are evaluated at each instant, including daylight-saving changes.
- The OMC Time Zone governs console timestamps, audit day grouping, calendar selections, daily token totals and OMC service-log timestamps. Stored epoch timestamps, durations, rolling windows and wire-format instants remain absolute. Switching zones never moves or rewrites historical events. Raw upstream logs remain evidence in their original form; offset-free CPA log timestamps are interpreted in the shared Deployment Time Zone before display. Price Tier time-of-day windows retain their explicit UTC contract; the price editor may accept a window in the OMC Time Zone, but converts it at the zone's current offset and saves the UTC rule it shows.

## Custom icon library

A **Custom Icon** is reusable, operator-owned static artwork in the current deployment. Its name and artwork can change without changing its identity or its provider assignments. A saved icon exists independently of an unfinished provider edit. Replacing its artwork changes every assignment; deletion removes every matching persisted override in the same transaction and restores affected providers to their normal default icon or placeholder. The confirmation explains this reset before deletion. Plugin-owned providers retain the plugin's branding authority.
