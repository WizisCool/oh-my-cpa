export interface OAuthProviderItem {
  id: string;
  name: string;
  description: string;
}

export interface StartOAuthResponse {
  url: string;
  state?: string;
  session_id: string;
  provider: string;
}

export interface OAuthStatusResponse {
  status: string;
  message?: string;
  error?: string;
}

export interface OAuthCallbackResponse {
  status: string;
  completed?: boolean;
}
