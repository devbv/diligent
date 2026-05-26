// @summary OAuth token types for ChatGPT subscription authentication

export interface OpenAIOAuthTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  /** Unix timestamp in milliseconds */
  expires_at: number;
  /** ChatGPT account ID extracted from JWT claims (for ChatGPT-Account-Id header) */
  account_id?: string;
  /** Provider account metadata extracted from OAuth JWT claims. */
  account_info?: OpenAIAccountInfo;
}

export interface OpenAIAccountInfo {
  email?: string;
  chatgpt_plan_type?: string;
  chatgpt_user_id?: string;
  chatgpt_account_id?: string;
  chatgpt_account_is_fedramp?: boolean;
}
