// @summary Local callback server for interactive OAuth flows
export interface CallbackResult {
  code: string;
  state: string;
}

export function waitForCallback(
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
  signal?: AbortSignal,
): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("OAuth flow cancelled"));
      return;
    }

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
          cleanup();
          reject(new Error(`OAuth error: ${error}`));
          return new Response(renderCallbackHtml("Authentication failed."), {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!code || state !== expectedState) {
          cleanup();
          reject(new Error("Invalid callback: missing code or state mismatch"));
          return new Response(renderCallbackHtml("Invalid callback."), {
            headers: { "Content-Type": "text/html" },
          });
        }

        setTimeout(() => server.stop(), 1000);
        cleanup({ keepServer: true });
        resolve({ code, state });
        return new Response(renderCallbackHtml("Authentication successful! You can close this window."), {
          headers: { "Content-Type": "text/html" },
        });
      },
    });

    const timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("OAuth flow cancelled"));
    };

    function cleanup(opts?: { keepServer?: boolean }): void {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      if (!opts?.keepServer) server.stop();
    }

    signal?.addEventListener("abort", onAbort);
  });
}

function renderCallbackHtml(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>Diligent Auth</title></head>
<body style="font-family:sans-serif;text-align:center;padding:2em">
<h2>${message}</h2></body></html>`;
}
