export interface GitHubTokenStatus {
  configured: boolean;
  masked_token?: string;
  cpa_revision: string;
}

export interface GitHubTokenInput {
  token: string;
  cpa_revision: string;
}

export type GitHubTokenTestStatus = 'valid' | 'anonymous' | 'invalid' | 'error';

export interface GitHubTokenTestResult {
  status: GitHubTokenTestStatus;
  authenticated: boolean;
  limit?: number;
  remaining?: number;
  used?: number;
  reset_at_ms?: number;
  message?: string;
}

export const GITHUB_TOKEN_QUERY_KEY = ['github-token'] as const;
export const GITHUB_TOKEN_SETTINGS_PATH = '/omc-settings#github-token';

export interface GitHubTokenErrorSource {
  /** True for built-in GitHub-backed registries (official / OMC). */
  isBuiltInGitHub?: boolean;
  /** Registry URL of the failing source, when known. */
  sourceUrl?: string | null;
}

export function isGitHubHostedURL(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const host = new URL(rawUrl.trim()).hostname.toLowerCase();
    return host === 'github.com'
      || host.endsWith('.github.com')
      || host === 'githubusercontent.com'
      || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

/**
 * Matches GitHub rate-limit (429 / 403 exhausted) or rejected-token diagnostics
 * surfaced by release checks and plugin store sources so pages can direct operators
 * straight to OMC Settings. When a plugin store source is supplied, generic 429 /
 * rate-limit errors only match if that source is GitHub-hosted.
 */
export function isGitHubTokenError(
  message: string | null | undefined,
  source?: GitHubTokenErrorSource,
): boolean {
  if (!message) return false;
  if (/github[\s_-]?token|server\.github-token/i.test(message)) return true;
  if (!/rate[\s_-]?limit|\b429\b/i.test(message)) return false;
  if (!source) return true;
  return Boolean(source.isBuiltInGitHub) || isGitHubHostedURL(source.sourceUrl);
}
