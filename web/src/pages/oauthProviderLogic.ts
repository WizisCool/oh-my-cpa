/**
 * The OAuth provider contract for the console: which authorizations exist, how
 * each one has to be rendered, and how a pasted redirect is judged.
 *
 * It is one table rather than per-provider branches in the page because the
 * differences between providers are few and data-shaped: an icon, an i18n key
 * base, a flow shape, and - for the redirect flows that a remote browser cannot
 * complete - the rules for reading the code out of the browser's address bar.
 * Adding a provider is a row here plus its i18n copy.
 *
 * The ids must stay in step with the CPA contract registry
 * (`internal/cpa/management/oauth_providers.go`), which is what decides the
 * management path and whether CPA opens its loopback callback listener.
 */

export type OAuthFlowKind = 'manual-callback' | 'device';

/** Why a pasted redirect was refused. */
export type OAuthCallbackError = 'invalid' | 'state_mismatch';

export interface OAuthCallbackErrorKeys {
  /** The paste is not a usable redirect at all. */
  invalid: string;
  /** The paste belongs to a different attempt. Only providers that bind state raise this. */
  stateMismatch?: string;
  /** There is no session state to bind the paste to. */
  missingState: string;
  /** Overrides the generic "paste the URL here" hint when the provider needs its own wording. */
  hintKey?: string;
  placeholderKey?: string;
}

export interface OAuthCallbackRules {
  /** Refuses a paste that cannot belong to this attempt. */
  validate?: (input: string, expectedState?: string) => OAuthCallbackError | undefined;
  /** Rewrites the paste into the exact URL CPA must receive. */
  resolve?: (input: string, expectedState?: string) => string | null;
  errorKeys: OAuthCallbackErrorKeys;
}

export interface OAuthProviderDefinition {
  /** Provider id, matching CPA's `{id}-auth-url` route. */
  id: string;
  /** Brand mark id resolved against the lobe icon catalog. */
  iconId: string;
  /** i18n key base: `oauth.{keyBase}_title`, `_hint` and `_login`. */
  keyBase: string;
  flow: OAuthFlowKind;
  /**
   * A login already in flight must be cancelled before another is started.
   *
   * This is for providers whose authorization URL is one-shot: the operator may
   * still be holding the previous attempt's redirect, and a second session would
   * leave two of them open with no way to tell which paste belongs where.
   */
  requiresExplicitCancel?: boolean;
  callback?: OAuthCallbackRules;
}

/**
 * xAI's redirect target. Grok shows a bare code rather than redirecting, so the
 * callback URL is rebuilt from the fixed local address plus the live state.
 */
export const XAI_CALLBACK_URL = 'http://127.0.0.1:56121/callback';

export const OAUTH_PROVIDER_PATTERN = /^[a-z0-9-]+$/;

// normalizeOAuthStatus maps CPA get-auth-status variants to one UI contract:
// "ok" completed, "error" failed, "wait" still in flight. "success"/"pending"
// are legacy aliases that must not flip the card into a terminal state.
export function normalizeOAuthStatus(status: unknown): 'ok' | 'error' | 'wait' {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized === 'ok' || normalized === 'success') return 'ok';
  if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') return 'error';
  return 'wait';
}

/**
 * normalizeOAuthFlow narrows CPA's own flow label onto the two shapes the card
 * can render. An unknown or absent label keeps the provider's declared flow,
 * because a provider never silently loses its callback box to a CPA that has not
 * started reporting the field yet.
 */
export function normalizeOAuthFlow(flow: unknown): OAuthFlowKind | undefined {
  const normalized = String(flow ?? '').trim().toLowerCase();
  if (normalized === 'device') return 'device';
  if (normalized === 'redirect' || normalized === 'callback') return 'manual-callback';
  return undefined;
}

function readQueryLikeCallbackParams(value: string): URLSearchParams | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const queryStart = trimmed.indexOf('?');
  const hashStart = trimmed.indexOf('#');
  const rawParams = queryStart >= 0 ? trimmed.slice(queryStart + 1) : hashStart >= 0 ? trimmed.slice(hashStart + 1) : trimmed;
  if (!/(^|[&#?])(code|state|error)=/i.test(rawParams)) return null;
  try {
    return new URLSearchParams(rawParams.replace(/^[?#]/, ''));
  } catch {
    return null;
  }
}

function extractDisplayedXaiCode(value: string): string {
  const trimmed = value.trim();
  const codeMatch = trimmed.match(/\bcode\s*[:=]\s*([^\s&]+)/i);
  return (codeMatch?.[1] ?? trimmed).trim();
}

/**
 * resolveXaiCallback rebuilds the callback CPA must receive. A real callback URL
 * is submitted verbatim; a bare code or Grok's printed "Code: XXXX" line is only
 * usable together with the live state, because the state is what binds the code
 * to this session.
 */
export function resolveXaiCallback(input: string, expectedState?: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // The scheme decides whether this is a redirect at all. `new URL` happily
  // parses "Code: XXXX" as a `code:` URL, so an unguarded probe would submit the
  // printed code line verbatim and lose the code it contains.
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return trimmed;
    }
  } catch {
    // Relative input falls through to code/state reconstruction below.
  }
  const params = readQueryLikeCallbackParams(trimmed);
  if (params) {
    const code = params.get('code')?.trim();
    const error = params.get('error')?.trim();
    const errorDescription = params.get('error_description')?.trim();
    const callbackState = params.get('state')?.trim() || expectedState?.trim();
    if (!callbackState) return null;
    const callbackUrl = new URL(XAI_CALLBACK_URL);
    callbackUrl.searchParams.set('state', callbackState);
    if (code) callbackUrl.searchParams.set('code', code);
    if (error) callbackUrl.searchParams.set('error', error);
    if (errorDescription) callbackUrl.searchParams.set('error_description', errorDescription);
    return callbackUrl.toString();
  }
  const code = extractDisplayedXaiCode(trimmed);
  const callbackState = expectedState?.trim();
  if (!code || !callbackState) return null;
  const callbackUrl = new URL(XAI_CALLBACK_URL);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', callbackState);
  return callbackUrl.toString();
}

/**
 * validateDevinCallback judges a pasted Devin redirect.
 *
 * Devin's redirect target is a loopback address on the CPA host, so a remote
 * browser shows a page it cannot load and the operator has to copy the URL out
 * of the address bar. That paste is the only thing carrying the code, and it is
 * also the only place the attempt's state can be checked: nothing is inferred
 * and no URL is manufactured, so a URL from an earlier attempt is refused
 * instead of being submitted against the live session.
 */
export function validateDevinCallback(input: string, expectedState?: string): OAuthCallbackError | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return 'invalid';
  }
  const params = url.searchParams;
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    params.getAll('state').length !== 1 ||
    !params.get('state')?.trim() ||
    !['code', 'error', 'error_description'].some((key) => params.get(key)?.trim())
  ) {
    return 'invalid';
  }
  if (!expectedState || params.get('state') !== expectedState) {
    return 'state_mismatch';
  }
  return undefined;
}

/**
 * The built-in authorizations, in the order the cards are rendered.
 *
 * The device flows (Kimi, Meta Muse) confirm a short code on the vendor's own
 * page and are polled; the redirect flows land on a callback the operator may
 * have to submit by hand.
 */
export const BUILTIN_OAUTH_PROVIDERS: OAuthProviderDefinition[] = [
  {
    id: 'kimi',
    iconId: 'Kimi',
    keyBase: 'kimi',
    flow: 'device',
  },
  {
    id: 'codex',
    iconId: 'Codex',
    keyBase: 'codex',
    flow: 'manual-callback',
    callback: {
      errorKeys: {
        invalid: 'oauth.callback_invalid_url',
        missingState: 'oauth.missing_state',
      },
    },
  },
  {
    id: 'anthropic',
    iconId: 'Claude',
    keyBase: 'anthropic',
    flow: 'manual-callback',
    callback: {
      errorKeys: {
        invalid: 'oauth.callback_invalid_url',
        missingState: 'oauth.missing_state',
      },
    },
  },
  {
    id: 'antigravity',
    iconId: 'Antigravity',
    keyBase: 'antigravity',
    flow: 'manual-callback',
    callback: {
      errorKeys: {
        invalid: 'oauth.callback_invalid_url',
        missingState: 'oauth.missing_state',
      },
    },
  },
  {
    id: 'xai',
    iconId: 'Grok',
    keyBase: 'xai',
    flow: 'manual-callback',
    callback: {
      resolve: resolveXaiCallback,
      errorKeys: {
        invalid: 'oauth.callback_invalid_url',
        missingState: 'oauth.xai_callback_state_missing',
      },
    },
  },
  {
    id: 'devin',
    iconId: 'Devin',
    keyBase: 'devin',
    flow: 'manual-callback',
    // Devin's callback page is served by CPA on a loopback address, so the
    // operator has to paste the URL back. Holding one attempt at a time keeps a
    // stale paste from being read as the live session.
    requiresExplicitCancel: true,
    callback: {
      validate: validateDevinCallback,
      errorKeys: {
        invalid: 'oauth.devin_callback_invalid',
        stateMismatch: 'oauth.devin_callback_state_mismatch',
        missingState: 'oauth.missing_state',
        hintKey: 'oauth.devin_callback_hint',
        placeholderKey: 'oauth.devin_callback_placeholder',
      },
    },
  },
  {
    id: 'meta',
    iconId: 'Meta',
    keyBase: 'meta',
    flow: 'device',
  },
];

/** The plugin-supplied providers the card builder skips, because a built-in already owns the id. */
export const BUILTIN_OAUTH_IDS = new Set<string>(BUILTIN_OAUTH_PROVIDERS.map((provider) => provider.id));

export function lookupOAuthProvider(id: string): OAuthProviderDefinition | undefined {
  const normalized = (id || '').trim().toLowerCase();
  return BUILTIN_OAUTH_PROVIDERS.find((provider) => provider.id === normalized);
}
