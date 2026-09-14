# ADR 0002: CPA Binding and Resource Identity Hierarchy Strategy

- **Status**: Accepted
- **Date**: 2026-09-04
- **Scope**: Discovery Model, Domain Entities, Usage Attribution, Database Migrations

---

## 1. Context and Problem

Oh My CPA is built on top of CLIProxyAPI (CPA) as the user management and business identity layer:
- CPA handles underlying credential rotation, outbound proxying, and execution-plane protocol translation;
- Oh My CPA discovers CPA runtime resources, assigns business semantics (Source, Connection, name, icon, usage category), and aggregates usage statistics.

In legacy implementations, several critical issues existed:
1. **Identity fragility and array index dependence**: For configuration entries lacking a stable `auth_index` (such as certain Codex API keys or OpenAI-compatible providers), earlier code used array indices, causing custom names and configurations to shift when upstream configs were reordered.
2. **Credential secrets must never serve as plaintext identifiers**: Plaintext API keys, OAuth tokens, or credential-bearing proxy URLs must never enter primary keys, database foreign keys, regular logs, or standard browser responses.
3. **Ambiguity of CPA runtime indices**: The same `auth_index` can recur across different Resource Families; matching cross-family directly leads to fan-out and duplicated events.
4. **Historical usage attribution continuity**: When upstream credentials rotate or entries are temporarily removed (becoming Missing), historical usage events must permanently retain their attribution semantics rather than being corrupted or cascaded away.

---

## 2. Decision

### 2.1 Entity Model Boundaries

Based on `CONTEXT.md`, establish the layered relationships of domain entities:

```text
Source (business provider origin, e.g. DeepSeek, OpenAI, Command Code GOAT)
  └─ Connection (user-callable usable line, holding name, icon, color, status, and notes)
       ├─ Credential Metadata (credential descriptors, no plaintext secrets)
       ├─ Endpoint (network target URL, stripped of userinfo)
       └─ CPA Binding (physical binding mapping to a concrete CPA instance)
            ├─ Instance ID (owning CPA instance)
            ├─ Resource Family / Type (e.g. codex-api-key, auth-file, openai-compatibility)
            ├─ Auth Index (CPA runtime stable credential index, if any)
            └─ Binding Fingerprint (irreversible secure fingerprint)
```

### 2.2 Discovery Identity Hierarchy

When the discovery engine scans a CPA instance, it resolves unique Resource Keys and Binding Fingerprints strictly through a five-tier priority chain, prohibiting physical array positions:

1. **Tier 1: Verified Immutable Upstream ID (Immutable Upstream ID)**:
   - Prioritized when an upstream provides a globally stable unique identifier.
2. **Tier 2: Family-Scoped Stable Authentication Index (Family-Scoped Auth Index)**:
   - Format: `auth-index:<family>:<auth_index>`;
   - Isolates identically named indices across different Resource Families.
3. **Tier 3: Salted Keyed HMAC of Normalized Credential Material (Versioned Keyed HMAC)**:
   - Used when lacking `auth_index` but having a non-empty client API key;
   - Computed by the server master key `OMCPA_MASTER_KEY` as `hmac:v1:<family>:<sha256-hmac>`;
   - Never stores plaintext, preventing offline rainbow-table attacks.
4. **Tier 4: Unique Non-Sensitive Metadata Fingerprint (Non-Sensitive Metadata Fingerprint)**:
   - Derived from normalized `(family, base_url, prefix, provider_name)`;
   - URLs are stripped of userinfo authentication details, query parameters, and fragments.
5. **Tier 5: Explicit Identity Collision Reporting (Explicit Identity Collision)**:
   - If two entries in the same scan cycle have identical non-sensitive metadata and credentials, the system marks `identity_collision=true`;
   - Blocks unreliable automatic overwrites and alerts the operator to intervene.

### 2.3 Key Rotation and Rebinding Strategy

- Keyed HMAC is a pseudonymous identifier. When a physical key rotates, its HMAC changes;
- The system accepts that key rotation alters the HMAC, relying on a stable `auth_index` or the associated business Connection to maintain user-level identity. For resources relying solely on Keyed HMAC, explicit rebinding is supported rather than forcing fragile heuristics.

### 2.4 Historical Usage and Lifecycle Continuity

- Ingestion binds usage events to the current unique `cpa_bindings` record;
- If an upstream configuration deletion causes a resource to become `missing`, `cpa_bindings` records `missing_at_ms` and foreign keys use `ON DELETE SET NULL`;
- Historical usage events preserve their point-in-time snapshots; modifying, disabling, or deleting a current resource never alters historical request facts.

---

## 3. Consequences

- **Positive**:
  - Reordering or prepending upstream configurations no longer misaligns Oh My CPA custom names or icons;
  - Plaintext secrets are completely kept out of indices, primary keys, and relationships;
  - Duplicate `auth_index` values across different families no longer cause event collisions or pagination confusion;
  - Entity boundaries are cleanly defined, aligning with the modular monolith architecture.
- **Trade-offs**:
  - Unidentified entries lacking an `auth_index` and API key require operator intervention;
  - Introduces `cpa_bindings` to synchronize discovery state projections with persistent storage.
