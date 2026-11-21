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

/**
 * Matches GitHub rate-limit (429 / 403 exhausted) or rejected-token diagnostics
 * surfaced by release checks and plugin store sources so pages can direct operators
 * straight to OMC Settings.
 */
export function isGitHubTokenError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /rate[\s_-]?limit|\b429\b|github[\s_-]?token|server\.github-token/i.test(message);
}
