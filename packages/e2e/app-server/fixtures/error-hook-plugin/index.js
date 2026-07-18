// @summary Plugin fixture whose prompt hook throws to verify app-server error isolation
export const manifest = {
  name: "error-hook-plugin",
  apiVersion: "1.0",
  version: "0.1.0",
};

export async function createTools() {
  return [];
}

/**
 * UserPromptSubmit hook: always throws to exercise the error non-blocking path.
 * Errors in plugin hooks must not block the prompt or crash the server.
 */
export async function onUserPromptSubmit(_input) {
  throw new Error("intentional error from error-hook-plugin");
}
