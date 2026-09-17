export interface OAuthProviderItem {
  id: string;
  name: string;
  description: string;
  /** "redirect" or "device": the shape of the authorization CPA will start. */
  flow: string;
}

export interface StartOAuthResponse {
  url: string;
  state?: string;
  session_id: string;
  provider: string;
  /** CPA's own flow label, present for device grants. */
  flow?: string;
  /** The short code a device grant asks the operator to confirm. */
  user_code?: string;
  /** Device grant lifetime in seconds. */
  expires_in?: number;
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

export interface OAuthCancelResponse {
  status: string;
  /**
   * False when CPA could not cancel because the session already completed or
   * expired. The card must not claim a cancellation it did not get.
   */
  cancelled?: boolean;
}
