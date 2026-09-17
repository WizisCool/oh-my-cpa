# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Core Users**: Individual developers and self-hosters running AI infrastructure on local workstations, personal servers, HomeLabs, VPS instances, or private Tailscale mesh networks.
- **Scenarios & Tasks**: Users maintain multiple heterogeneous AI credentials (such as ChatGPT Plus/Pro OAuth credentials, OpenCode Go or Command Code API keys, DeepSeek, and upstream aggregation relays) unified through CLIProxyAPI (CPA) for protocol translation and dispatch; users rely on Oh My CPA as their control console to assign clear business ownership, intuitive naming, health monitoring, model pricing, and usage analytics to technical drivers.
- **Secondary Audience (Restricted Phase)**: Small teams or studio members sharing a single CPA instance with read-only or scoped console access (future evolutionary target).

## Product Purpose

- Provide a dedicated, user-owned "AI Resource Identity & Organization Console" for CLIProxyAPI (CPA).
- Resolve the ambiguity of unstructured technical fields (driver types, auth indexes, raw file paths) in proxy gateways by establishing a clean local metadata mapping layer.
- **Success Criteria**:
  1. **Zero Secret Leakage**: CPA management keys and upstream secrets never enter browser storage, ordinary logs, or public API responses;
  2. **Closed Discovery & Organization Loop**: Underlying configuration and credential file changes are tracked into `discovered_resources` and `cpa_bindings`; unclaimed resource states can be identified, and historical attribution does not drift when upstreams change (detailed in `docs/adr/0002-cpa-binding-and-identity-hierarchy.md`);
  3. **Real-time Perception & Telemetry**: Sliding live (15m) to multi-period usage dashboards, accurate request-time model cost estimation, and cache hit rate metrics;
  4. **Clean, Fast Operator Experience**: Millisecond UI responses, out-of-the-box readiness, and zero CDN dependencies.

## Positioning

- **"CPA executes; Oh My CPA organizes and identifies."**
- Oh My CPA does not duplicate the underlying protocol proxying of the execution plane, nor does it act as a generic reverse proxy; it is a dedicated control plane.
- Establishes a user-owned source of truth for names, icons, colors, notes, and pricing, persisted in local SQLite and decoupled from the CPA instance.

## Operating Context

- **Deployment Model**: Co-deployed alongside CPA on the same host, typically within a Docker Compose internal network or bound to local intranet ports;
- **Access Entrypoint**: Bound to the sub-path `/omc/` by default, reached via Caddy or Nginx reverse proxies or Vite during development;
- **Architecture Topology**: Go modular monolith backend (providing `/omc/api/v1` endpoints), SQLite in WAL mode for storage, and an embedded React + TypeScript + Ant Design SPA frontend;
- **Development Workflow**: Air watches `.go` and `.sql` files for automatic hot reloading; Vite provides frontend HMR and proxies API requests;
- **Authentication Model**: Single system credential source—the CPA Management Key. The server derives session signatures via HMAC-SHA256 and issues HttpOnly `SameSite=Strict` cookies; the frontend holds no secondary administrative passwords and no persistent secrets.

## Capabilities and Constraints

- **Core Capabilities**:
  - CPA resource discovery and stable binding: Resource families (`auth-files`, `codex-api-key`, `openai-compatibility`, etc.) are resolved via a three-layer identity hierarchy derived from ADR 0002 (family-scoped `auth_index`, keyed HMAC of non-empty API keys, and non-sensitive metadata fingerprints, marking identity collisions when both are missing). The discovery engine persists entries into `discovered_resources` and `cpa_bindings` (queried via `/api/v1/resources` and triggered by `/instances/default/discover`). The console currently surfaces live CPA runtime entries directly through the Providers and OAuth management pages (layering user preferences) rather than a separate unclaimed queue screen;
  - Gateway client key management: Dedicated Key Management page (`/api-keys`, deployed under `/omc/api-keys`) to manage proxy client API keys; keys belong to CPA's `api-keys` configuration, sharing draft editing, revision checks, and conflict protection with the config panel. Each key can be assigned an alias (stored in `client_key_aliases` indexed by `(instance_id, usage fingerprint)`), and renaming never rewrites CPA's configuration document; aliases appear across request lists, detail drawers, caller facets, and filter chips, falling back to masked keys when unnamed. The table also shows request counts and last-used timestamps within the active window with explicit scope labels;
  - Resource business attribute overrides: Custom DisplayName, Color, built-in PresetIcon / LobeIcon, and Notes (backend `PATCH /resources/{id}/override` and `resource_overrides` exist for discovery overrides);
  - Credential lifecycle and effective blocking: OAuth credential file management (listing, upload, download, deletion, enable/disable toggles, priority/weight/note field editing, and model lists); provider-level disablement is enforced at CPA's protocol level (via `excluded-models: ['*']`). The backend auth-file field allowlist accepts `prefix`, `proxy_url`, `headers`, `priority`, `weight`, `disable_cooling`, `websockets`, `using_api`, `note`, `excluded_models`, and `expired`; the detail drawer edits every one of those except `headers`. Each update is read back from CPA before it is reported as saved, and the response carries the safe projection only when that projection was read back;
  - Monitoring dashboard and usage streaming: Streaming usage event collection over the CPA RESP protocol; supports a 15m sliding live window, multiple preset periods, and custom closed or open-ended calendar ranges. Every dashboard panel follows that window, from the six traffic KPI tiles through the per-model token trend and usage-share ring; the token activity grid is the deliberate exception, carrying a fixed rolling year so its shape stays a calendar rather than collapsing to a single column at the shortest preset. The model panels rank by call point (the client-requested alias) or by upstream model, carry each group's priced spend, and persist the grouping on the panels themselves plus a console-wide token unit style as deployment-stored preferences, the latter managed alongside six registered visual themes and language on an OMC Settings page and reachable without leaving the page you are on from the console header's own theme and language menus;
  - Model pricing and cost computation: Request-time price locking (ADR 0003), automated pricing sync from models.dev, and local row-level pricing overrides;
  - System health self-checks, sanitized diagnostics export, plugin and plugin store management, and append-only audit logging;
  - Zero-CDN offline execution: Frontend assets are embedded into the Go binary for completely offline operation.
- **Mandatory Constraints**:
  - Native sub-path compatibility: All code must natively support the `/omc` prefix (`VITE_BASE_URL`), forbidding hardcoded root paths (`/`);
  - Single-replica single-writer: Designed specifically for single-instance SQLite WAL; no distributed multi-writer mechanisms are introduced;
  - Strict allowlisted APIs: The browser communicates only with the Oh My CPA backend; arbitrary CPA endpoint pass-through proxies are forbidden;
  - Complete multilingual localization: Full Simplified Chinese, Traditional Chinese, English and Malay alignment (`web/src/i18n/index.tsx` plus the catalogs under `web/src/i18n/locales/`); no unlocalized captions or mixed languages in the UI.

## Brand Commitments

- **Brand Identity**: Oh My CPA, signature command-line prompt prefix `›_`, "Make CPA yours".
- **Visual Style**: Terminal-flat console (minimalist flat terminal developer console).
  - Flat with zero shadows: Global `box-shadow: none`, no decorative gradients; visual hierarchy is expressed purely via 1px hairline borders and background tonal shifts;
  - Universal monospace typography: Sarasa Mono SC prioritized, Berkeley Mono / IBM Plex Mono as fallbacks, with tabular numerical alignment;
  - Quiet chrome, loud data: UI scaffolding recedes into dark charcoal neutrals; saturated color is reserved exclusively for operational states;
  - Strictly semantic colors: Green (healthy/enabled), amber (degraded/warning), red (error/disabled), gray (offline/inactive);
  - High-tempo motion: Transitions pinned to ≤ 100ms with zero spring physics; hover states land within the 50ms fast token; no loading shimmer. Chart marks and the dashboard's KPI numbers are the one named exception, morphing on a 240ms `roll` token (ADR 0007, ADR 0008).

## Evidence on Hand

- **Core Domain Terminology & Rules**: `CONTEXT.md`;
- **Module Map, Data Flows & Invariants**: `docs/architecture.md`;
- **Architecture Decision Records**: `docs/adr/`;
- **Visual System & Token Authority**: `docs/design.md`, mirrored in code in `web/src/theme/themeConfig.ts` and `web/src/index.css` (root `DESIGN.md` is the synchronized design-tool summary);
- Automated test suites: `internal/api/*_test.go`, covering credential protection, dashboard statistics, quota throttling, and DTO allowlist enforcement.

## Product Principles

1. **User-Owned Identity**: Underlying drivers and protocol parameters are technical implementation details; business identity, naming, and organization belong to the user.
2. **Zero Secret Leakage in Ordinary Responses**: Administrative credentials and upstream secrets terminate at the backend; ordinary console views receive only sanitized status and necessary display data, while explicit secret-management actions (such as revealing keys or viewing raw configuration YAML) remain authenticated and audited.
3. **Honest UI & Granular States**: Clearly distinguish Blocked (cannot serve), Loading (no response yet), and Empty (live source with no data); preserve the previous frame during network blips and surface warnings rather than showing blank screens.
4. **Quiet & Restrained Craft**: Avoid frivolous animations and artificial placeholders; maximize information density and visual clarity for developer workflows.

## Accessibility & Inclusion

- Complete keyboard navigation with high-visibility `:focus-visible` outlines;
- Strict compliance with WCAG AA (≥ 4.5:1) color contrast; continuous states (such as Cache Rate) are computed in OKLCH color space to guarantee text contrast;
- Colorblind-safe status indication: All statuses are communicated through paired "status pip + text", never color alone;
- Full support for `prefers-reduced-motion`, automatically freezing dynamic progress bars, disabling transform animations, and dropping the chart marks' morph — the canvas library reads no such preference, so the switch is the console's own.
