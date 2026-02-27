import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../src/tool/types";
import { bashTool, filterSensitiveEnv } from "../src/tools/bash";

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    toolCallId: "tc_bash",
    signal: signal ?? new AbortController().signal,
    approve: async () => "once" as const,
  };
}

describe("bash tool", () => {
  test("simple command (echo hello)", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, makeCtx());
    expect(result.output.trim()).toBe("hello");
  });

  test("non-zero exit code → exit code in header", async () => {
    const result = await bashTool.execute({ command: "exit 42" }, makeCtx());
    expect(result.output).toContain("[Exit code: 42]");
    expect(result.metadata?.exitCode).toBe(42);
  });

  test("timeout → kills process, timeout message", async () => {
    const result = await bashTool.execute({ command: "sleep 10", timeout: 200 }, makeCtx());
    expect(result.output).toContain("Timed out");
    expect(result.metadata?.timedOut).toBe(true);
  }, 5000);

  test("AbortSignal → kills process, aborted message", async () => {
    const ac = new AbortController();
    const promise = bashTool.execute({ command: "sleep 10" }, makeCtx(ac.signal));
    setTimeout(() => ac.abort(), 100);
    const result = await promise;
    expect(result.output).toContain("Aborted");
    expect(result.metadata?.aborted).toBe(true);
  }, 5000);

  test("stderr output → merged with [stderr] prefix", async () => {
    const result = await bashTool.execute({ command: "echo err >&2" }, makeCtx());
    expect(result.output).toContain("[stderr]");
    expect(result.output).toContain("err");
  });

  test("large output → truncated", async () => {
    // Generate output larger than 50KB
    const result = await bashTool.execute({ command: "python3 -c \"print('x' * 60000)\"" }, makeCtx());
    expect(result.metadata?.truncated).toBe(true);
  });

  test("description in metadata", async () => {
    const result = await bashTool.execute({ command: "echo hi", description: "test desc" }, makeCtx());
    expect(result.metadata?.description).toBe("test desc");
  });

  test("filters sensitive env variables from child process", async () => {
    const original = process.env.TEST_API_KEY;
    process.env.TEST_API_KEY = "secret-value";
    try {
      const result = await bashTool.execute({ command: 'echo "key=$TEST_API_KEY"' }, makeCtx());
      expect(result.output).not.toContain("secret-value");
    } finally {
      if (original === undefined) delete process.env.TEST_API_KEY;
      else process.env.TEST_API_KEY = original;
    }
  });

  test("preserves non-sensitive env variables", async () => {
    const result = await bashTool.execute({ command: "echo $HOME" }, makeCtx());
    expect(result.output.trim()).toBe(process.env.HOME);
  });
});

describe("filterSensitiveEnv", () => {
  test("removes _API_KEY suffix variables", () => {
    const env = { HOME: "/home", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" };
    const result = filterSensitiveEnv(env as NodeJS.ProcessEnv);
    expect(result.HOME).toBe("/home");
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.OPENAI_API_KEY).toBeUndefined();
  });

  test("removes _SECRET suffix variables", () => {
    const env = { PATH: "/usr/bin", AWS_SECRET_ACCESS_KEY: "aws-secret" };
    const result = filterSensitiveEnv(env as NodeJS.ProcessEnv);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  test("removes _TOKEN suffix variables", () => {
    const env = { GITHUB_TOKEN: "ghp_abc", SHELL: "/bin/zsh" };
    const result = filterSensitiveEnv(env as NodeJS.ProcessEnv);
    expect(result.SHELL).toBe("/bin/zsh");
    expect(result.GITHUB_TOKEN).toBeUndefined();
  });

  test("removes _PASSWORD suffix variables", () => {
    const env = { DB_PASSWORD: "pass123", USER: "dev" };
    const result = filterSensitiveEnv(env as NodeJS.ProcessEnv);
    expect(result.USER).toBe("dev");
    expect(result.DB_PASSWORD).toBeUndefined();
  });

  test("removes exact-match sensitive names", () => {
    const env = { API_KEY: "key", SECRET_KEY: "sk", TOKEN: "tok", PASSWORD: "pw", HOME: "/home" };
    const result = filterSensitiveEnv(env as NodeJS.ProcessEnv);
    expect(result.HOME).toBe("/home");
    expect(result.API_KEY).toBeUndefined();
    expect(result.SECRET_KEY).toBeUndefined();
    expect(result.TOKEN).toBeUndefined();
    expect(result.PASSWORD).toBeUndefined();
  });
});
