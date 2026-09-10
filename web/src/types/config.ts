export interface AppConfig {
  basePath: string;
  apiBaseUrl: string;
  mediaBaseUrl: string;
  appName: string;
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

  let basePath = (injected?.basePath ?? '/omc').trim();
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
  };
}
