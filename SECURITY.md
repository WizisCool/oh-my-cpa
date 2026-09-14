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
- **Secret Separation**: The storage encryption key (`OMCPA_MASTER_KEY`) encrypts credentials and raw usage payloads at rest via AES-GCM. Losing it permanently prevents decryption.
- **Sanitized Projections**: Ordinary API responses use strict DTO allowlists and redact secrets (displaying only fingerprints or masks).
- **Audited Administrative Surfaces**: Operations that intentionally access or modify secrets (such as viewing raw YAML source or revealing client API keys) require active admin sessions, CSRF / same-origin validation, and are recorded to the append-only `audit_events` log.
- **No Arbitrary Upstream Proxying**: Generic `/api-call` forwarding is disabled for browser traffic to prevent SSRF.
