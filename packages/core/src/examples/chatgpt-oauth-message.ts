// @summary Interactive ChatGPT OAuth example that signs in and sends one message without persisting tokens
import { spawn } from "node:child_process";
import { Agent } from "../agent/agent";
import { buildOAuthTokens, createChatGPTOAuthRequest, exchangeCodeForTokens } from "../auth/chatgpt-oauth";
import { createChatGPTNativeCompaction, createChatGPTStream } from "../llm/provider/chatgpt";
import { ProviderManager } from "../llm/provider-manager";

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim() || "Say hello in one short sentence.";

  const request = createChatGPTOAuthRequest();
  console.log(`Open this URL to sign in:\n${request.authUrl}\n`);
  openBrowser(request.authUrl);

  const { code } = await waitForCallback(request.state);
  const rawTokens = await exchangeCodeForTokens(code, request.codeVerifier);
  const tokens = buildOAuthTokens(rawTokens);

  const providerManager = new ProviderManager({
    auth: {
      chatgpt: {
        isConfigured: () => true,
        getStream: () => createChatGPTStream(() => tokens),
        getNativeCompaction: () => createChatGPTNativeCompaction(() => tokens),
      },
    },
  });
  const agent = new Agent("gpt-5.3-codex", [{ label: "system", content: "You are a concise assistant." }], [], {
    effort: "medium",
    llmMsgStreamFn: providerManager.createProxyStream(),
    llmCompactionFn: providerManager.createNativeCompactionForProvider("chatgpt"),
  });

  agent.subscribe((event) => {
    if (event.type === "message_delta" && event.delta.type === "text_delta") {
      process.stdout.write(event.delta.delta);
    }
    if (event.type === "message_end") {
      process.stdout.write("\n");
    }
  });

  await agent.prompt({
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  });
}

function openBrowser(url: string): void {
  if (process.platform === "win32") {
    const escaped = url.replace(/&/g, "^&");
    spawn("cmd", ["/c", "start", "", escaped], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

function waitForCallback(expectedState: string, timeoutMs = 5 * 60 * 1000): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      server.stop();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, timeoutMs);

    const server = Bun.serve({
      port: 1455,
      hostname: "localhost",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/auth/callback") {
          return new Response("Not found", { status: 404 });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          clearTimeout(timeoutId);
          server.stop();
          reject(new Error(`OAuth error: ${error}`));
          return new Response(renderCallbackHtml("Authentication failed."), {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!code || state !== expectedState) {
          clearTimeout(timeoutId);
          server.stop();
          reject(new Error("Invalid callback: missing code or state mismatch"));
          return new Response(renderCallbackHtml("Invalid callback."), {
            headers: { "Content-Type": "text/html" },
          });
        }

        clearTimeout(timeoutId);
        setTimeout(() => server.stop(), 1000);
        resolve({ code, state });
        return new Response(renderCallbackHtml("Authentication successful! You can close this window."), {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
  });
}

function renderCallbackHtml(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>Diligent Auth</title></head>
<body style="font-family:sans-serif;text-align:center;padding:2em">
<h2>${message}</h2></body></html>`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
