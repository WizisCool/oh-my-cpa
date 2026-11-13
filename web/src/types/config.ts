export interface AppConfig {
  basePath: string;
  apiBaseUrl: string;
  mediaBaseUrl: string;
  appName: string;
  /**
   * True when the server is the public demonstration. The console reads it from
   * the page the server rendered rather than from an API call, so the demo marker
   * is in the first frame and no non-demo layout is ever painted first.
   */
  demo: boolean;
  /**
   * The running build's version, as the server reports it (`OMCPA_VERSION`).
   * The playground reads it to name the default User-Agent, so the panel and the
   * wire cannot disagree about which build is being identified.
   */
  version?: string;
  /**
   * The reading language the deployment pins for every visitor (`OMCPA_DEFAULT_LANGUAGE`). It
   * arrives with the document, so the sign-in page already reads in it. Empty or absent pins
   * nothing and each visitor's browser decides; the value is unvalidated here because the language
   * registry owns which ids the console reads, and the server refuses to boot on an unknown one.
   */
  defaultLanguage?: string;
}

declare global {
  interface Window {
    __OMCPA_CONFIG__?: Partial<AppConfig>;
  }
}

/**
 * Reads the runtime configuration injected by Oh My CPA Go server,
 * with safe fallbacks when running standalone or in development.
 */
export function getAppConfig(): AppConfig {
  const injected = typeof window !== 'undefined' ? window.__OMCPA_CONFIG__ : undefined;

  let basePath = (injected?.basePath ?? '').trim();
  if (basePath && !basePath.startsWith('/')) {
    basePath = '/' + basePath;
  }
  if (basePath.length > 1 && basePath.endsWith('/')) {
    basePath = basePath.slice(0, -1);
  }

  const normalizedBase = basePath === '/' ? '' : basePath;

  let apiBaseUrl = (injected?.apiBaseUrl ?? `${normalizedBase}/api/v1`).trim();
  if (apiBaseUrl && !apiBaseUrl.startsWith('/')) {
    apiBaseUrl = '/' + apiBaseUrl;
  }
  if (apiBaseUrl.length > 1 && apiBaseUrl.endsWith('/')) {
    apiBaseUrl = apiBaseUrl.slice(0, -1);
  }

  let mediaBaseUrl = (injected?.mediaBaseUrl ?? `${normalizedBase}/media`).trim();
  if (mediaBaseUrl && !mediaBaseUrl.startsWith('/')) {
    mediaBaseUrl = '/' + mediaBaseUrl;
  }
  if (mediaBaseUrl.length > 1 && mediaBaseUrl.endsWith('/')) {
    mediaBaseUrl = mediaBaseUrl.slice(0, -1);
  }

  const appName = injected?.appName || 'Oh My CPA';

  return {
    basePath,
    apiBaseUrl,
    mediaBaseUrl,
    appName,
    demo: injected?.demo === true,
    ...(typeof injected?.version === 'string' && injected.version.trim() ? { version: injected.version.trim() } : {}),
    ...(typeof injected?.defaultLanguage === 'string' && injected.defaultLanguage.trim()
      ? { defaultLanguage: injected.defaultLanguage.trim() }
      : {}),
  };
}

export function resolveApiDocsUrl(basePath: string): string {
  // When mounted under `/demo`, resolve `/api-docs/` on the same origin so both
  // `omc.junze.dev/demo/` and local `deploy/site` previews open their own API reference.
  return basePath === '/demo' ? '/api-docs/' : 'https://omc.junze.dev/api-docs/';
}
