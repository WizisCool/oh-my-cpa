# Security Policy

Oh My CPA takes the security of credentials, proxy configurations, and administrative access seriously.

## Supported Versions

Only the latest commit on the `master` branch and the most recent release tag receive security patches.

| Version / Branch | Supported |
| --- | --- |
| `master` | Yes |
| Older releases | No (please upgrade to latest) |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

If you discover a potential vulnerability in Oh My CPA, please report it through **GitHub Private Vulnerability Reporting**:

1. Navigate to the [Security tab](https://github.com/WizisCool/oh-my-cpa/security) of the repository.
2. Click **Report a vulnerability** under "Advisories".
3. Provide a detailed report including:
   - Type of issue (e.g., SSRF, auth bypass, secret disclosure, SQL injection).
   - Clear step-by-step instructions or proof-of-concept (PoC) to reproduce.
   - Affected components, endpoints, or versions.
   - Potential impact of exploitation.

If GitHub Private Vulnerability Reporting is unavailable, you may contact the maintainers directly via email at `127123086+WizisCool@users.noreply.github.com` with `[SECURITY]` in the subject line.

## Response Process

- **Acknowledgment**: We aim to acknowledge receipt of your report within 48 hours.
- **Triage & Assessment**: We will verify the issue and determine severity and impact.
- **Fix & Patch**: A fix will be developed, reviewed, and tested in a private branch or security advisory draft.
- **Public Disclosure**: Once patched, a public release will be published alongside security advisory release notes crediting the researcher (unless anonymity is requested).

## Security Model & Design Invariants

When evaluating potential vulnerabilities, please keep the following security boundaries in mind:

- **Single System Credential**: The only administrator login credential is the CPA Management Key (`OMCPA_CPA_MANAGEMENT_KEY`). Entering the key at login derives an HMAC-signed `HttpOnly` session cookie (`SameSite=Strict`).
- **External Agents Hold the Same Credential**: The management key is also accepted as a bearer token, only on the capability endpoints (`/api/v1/capabilities`) and the MCP endpoint (`/api/mcp`), with the login throttle applied. That caller can read and prepare operations but never approve one, submit a secret or complete OAuth: approval requires a browser session and refuses requests carrying an `Authorization` header.
- **Secret Separation**: The storage encryption key (`OMCPA_MASTER_KEY`) encrypts credentials and raw usage payloads at rest via AES-GCM. Losing it permanently prevents decryption.
- **Sanitized Projections**: Ordinary API responses use strict DTO allowlists and redact secrets (displaying only fingerprints or masks).
- **Audited Administrative Surfaces**: Operations that intentionally access or modify secrets (such as viewing raw YAML source or revealing client API keys) require active admin sessions, CSRF / same-origin validation, and are recorded to the append-only `audit_events` log.
- **No Arbitrary Upstream Proxying**: Generic `/api-call` forwarding is disabled for browser traffic to prevent SSRF.

## Dependency Security Overrides

Workspace-wide overrides in `pnpm-workspace.yaml` keep transitive dependencies on
patched releases even when their parent packages still request vulnerable versions.
`pnpm-lock.yaml` records the resolved dependency graph; regenerate it with
`pnpm install` whenever an override changes.

| Dependency | Patched version | Advisory | Dependency path |
| --- | --- | --- | --- |
| KaTeX | 0.18.2 | GHSA-238p-pmpm-9mq7 | Markdown and Mermaid rendering through Ant Design X |
| sharp | 0.35.5 | GHSA-wq5f-xc86-pv6w | Wrangler / Miniflare demonstration tooling |
| source-map-js | 1.2.2 | GHSA-68fv-2mgg-jv7q | Vite / PostCSS source-map processing |

These overrides apply to every consumer in the workspace. Remove one only after
all parent packages resolve to a patched version without it. Use
`pnpm why <package> --recursive` to inspect consumers and `pnpm audit` to inspect
the resolved graph. The KaTeX override crosses the minor version requested by its
parents, so check their mathematical rendering when changing it.

## Trusted plugin pages

Installing a plugin authorizes its same-origin page to act as the signed-in operator.
The authenticated Plugin Host intentionally exposes native v0/v8 management responses,
including provider and client secrets, but never injects the stored management key into
page resources or browser storage. An explicit page management credential is compared with the stored key inside OMC and
never forwarded, so a wrong one cannot spend CPA's failed-attempt ban (ADR 0069);
model-directory requests receive only the page's client Authorization. All API reads and
writes are audited without request payloads, path suffixes or queries, and are uncached.
Native config writes share serialization and encrypted pre-write backups. Both outbound
`api-call` bridges are denied. This exception does not alter ordinary DTO projections,
Agent/MCP capabilities or demo restrictions (ADR 0067).
