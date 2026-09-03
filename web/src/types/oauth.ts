export interface OAuthProviderItem {
  id: string;
  name: string;
  description: string;
}

export interface StartOAuthResponse {
  url: string;
  session_id: string;
  provider: string;
}

export interface OAuthStatusResponse {
  status: string;
  message?: string;
}
