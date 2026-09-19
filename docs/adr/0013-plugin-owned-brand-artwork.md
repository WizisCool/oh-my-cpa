# ADR 0013: A plugin owns its provider's brand mark, and the server inlines it

- Status: Accepted; decision 1's *"Only an effectively-enabled plugin contributes"* clause is
  superseded by [ADR 0014](0014-plugin-branding-does-not-depend-on-plugin-enablement.md)
- Date: 2026-09-19

## Context

The provider tabs on **OAuth quota** and **OAuth management**, the credential cards, the quota cards,
the request records, the provider table and the dashboard's provider rows all draw a brand mark for
the provider behind a row. Two defects were reported against them:

1. **Devin, Meta and a plugin-registered provider (Codebuddy) drew a neutral placeholder** while their
   artwork sat unused in the bundle. The tabs resolved a mark through
   `web/src/components/common/providerMetadata.ts` alone, and that table had no row for them, so the
   mark was the empty string. `QuotaCard`/`AuthFileCard` escaped it only because they additionally
   consulted the vendored catalog.
2. **A plugin-provided icon was not used.** A plugin is the only authority on what the provider it
   registers looks like: the vendored catalog cannot be updated by installing a plugin, so a mark
   guessed from the provider key can belong to somebody else's brand.

The second point has a constraint the first does not. A plugin publishes its logo as an absolute URL
(CodeBuddy's plugin ships `https://cdn.jsdelivr.net/…/workbuddy/default.svg`), and this console cannot
load that in the browser:

- AGENTS.md §8 forbids a frontend resource that requires a CDN, and `README.md` promises no runtime CDN
  request; the SPA is embedded in the Go binary precisely so a deployment has no static-file
  dependency.
- The console already serves itself under `Content-Security-Policy-Report-Only: … img-src 'self' data:
  blob:` — a policy that a browser-side fetch of the plugin's host contradicts, and that this ADR
  brings the image path into line with rather than relaxing.

So the requirement "use the plugin's own icon" and the invariant "the browser loads nothing from
outside the binary" cannot both hold if the browser is the fetcher.

## Decision

**1. The plugin's published logo outranks the catalog mark, everywhere a provider's mark is drawn.**
`web/src/types/pluginOAuthProviders.ts` resolves the plugin list into provider-key logos, keyed by both
`oauth_provider` and the plugin's own id (a plugin whose auths are typed by its id has to resolve to the
same mark). `LobeIcon.tsx`'s `ProviderBrandIcon` is the one component that chooses between the plugin's
logo and the catalog mark, so the surfaces cannot disagree about a provider. Only an
effectively-enabled plugin contributes. The catalog mark remains the fallback, and an unmatched
provider is left *unbranded* rather than resolved to a default brand.

**2. The Go process fetches that logo and inlines it.** `internal/api/management_plugin_logos.go` is
called from the plugin list: it fetches the declared URL, requires an image media type from a bound
allowlist, caps the body at 512 KiB, and reports an inline `data:` URL on both `logo` and
`metadata.logo`. A logo that cannot be inlined is reported as **absent**, which is what drives the
catalog fallback. The frontend accepts only inline `data:image/*`, so a URL the browser may not load
cannot reach an `img` at all.

**3. A plugin-declared URL is held to a stricter destination policy than an operator-typed one.**
`internal/api/outbound_fetch.go` shares the redirect rule (a redirect that changes scheme or host is
refused) between the two outbound fetches, but not the destination rule:

| Fetch | Who chose the URL | Plaintext HTTP | Address check |
| --- | --- | --- | --- |
| Model-list pull | the operator, for a provider they run | allowed for localhost, loopback and private literals | none beyond the scheme |
| Plugin logo | an installed plugin's manifest | allowed only to this machine | resolved address refused in the dialer unless it is public internet space: the operator's network, carrier-grade NAT (`100.64.0.0/10`), multicast, unspecified and the reserved IANA blocks are all refused, and the fetch connects directly so the check cannot be moved onto a proxy |

The asymmetry is the point: a self-hosted relay on the operator's LAN is a normal model-pull target,
while a plugin manifest is third-party input and must not become a way to reach the operator's network
or `169.254.169.254`. Checking the **resolved** address at dial time is what makes that a boundary
rather than a name check — it also closes DNS rebinding.

**4. The plugin list is projected into the console's own DTO.** `PluginItemDTO` declares the response
fields explicitly, like every other management surface, so a field added to the facade model for
decoding cannot widen this API without a decision, and manifest text is bounded on the way out.

## Consequences

- **The plugin's own mark is drawn and the browser still loads only inline or same-origin artwork.**
  Verified live: the CodeBuddy plugin's jsdelivr logo arrives as `data:image/svg+xml;base64,…`
  (5 670 bytes) with zero CDN URLs in the response.
- **The deployment now contacts the plugin's host** (once per hour at most, per URL). An air-gapped
  deployment cannot, and falls back to the bundled mark — stated in `README.md` and `README.zh-CN.md`.
- **An operator's stored icon override no longer applies to a plugin-owned provider.** That is the
  accepted cost of the plugin owning its provider's identity, and it is recorded in `CONTEXT.md`'s
  naming rule, which otherwise says icons belong to Oh My CPA.
- **A logo hosted on the operator's own LAN will not load**, by design (see the table above); the
  fallback is the catalog mark.
- **A manifest may still point the fetch at a service on this machine**, and that is allowed on
  purpose: loopback is the machine itself, which a self-hosted or locally developed plugin store
  legitimately uses, and the request carries no credential, must answer with an image type from the
  allowlist, and is capped and cached. Refusing it would trade that case away for little - the plugin
  already runs in-process inside CPA, so it can reach local services directly if it wants to.
- **Failures are cached for an hour, but a fetch that ran out of its budget is not.** The console polls
  the plugin list, so an unreachable host must not be re-fetched per poll — and running out of time is
  not an answer about the logo, so a slow poll cannot cost a plugin its mark for a whole TTL.
- **One deadline covers the whole plugin list**, because what must stay bounded is the polled response,
  not each request.
- Keeping it honest: `scripts/test-provider-icons.ts` asserts that every built-in OAuth provider
  reaches a mark whose artwork actually ships in the bundle — the invariant the reported bug violated —
  and the browser suite asserts a catalog brand, a plugin-published logo and a request row.

## Alternatives considered

**Keep loading the plugin's logo in the browser** (the behaviour before this change). It satisfies "use
the plugin's own icon" in one line, and it was rejected because it makes the console's rendering depend
on a third-party host: the mark disappears silently when that host is unreachable, and the deployment's
stated offline contract and its own CSP both say the browser loads nothing from outside the binary.

**Refuse remote logos and keep only the catalog mark** (the smallest correct change, and what a code
review of this work first suggested). Rejected because it silently discards the plugin's declared mark —
the operator sees a brand the plugin did not choose, with no signal that the plugin published one — and
it leaves the requirement in the report unmet.

**Ask plugins to publish inline `data:` artwork instead.** The console already accepts it, and it would
remove the fetch entirely. It cannot be a decision here: it would break every plugin that already
declares a URL, and the plugin API's own field is documented as a display asset reference.

**Fetch the logo at build time and bundle it.** Impossible in principle: plugins are installed at
runtime, after the binary is built — the plugin list is exactly the thing that changes without a
rebuild.

**Use the same destination policy as a model pull** (allow LAN plaintext). Rejected: it would let an
installed plugin point this process at any address inside the operator's network and have the response
served back to the console, which is a capability the operator never granted.
