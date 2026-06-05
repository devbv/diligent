// @summary ChatGPT OAuth flow — provider config for the shared OAuth router
import type { OpenAIOAuthTokens } from "@diligent/core/auth";
import { buildOAuthTokens, createChatGPTOAuthRequest, exchangeCodeForTokens } from "@diligent/core/auth/chatgpt-oauth";
import type { OAuthFlowOptions } from "./oauth-router";
import { runOAuthFlow } from "./oauth-router";

export async function runChatGPTOAuth(options: OAuthFlowOptions = {}): Promise<OpenAIOAuthTokens> {
  return runOAuthFlow(
    {
      createRequest: createChatGPTOAuthRequest,
      exchangeCode: async (code, codeVerifier) => {
        const rawTokens = await exchangeCodeForTokens(code, codeVerifier);
        return buildOAuthTokens(rawTokens);
      },
    },
    options,
  );
}
