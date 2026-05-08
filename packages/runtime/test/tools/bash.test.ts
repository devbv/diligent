// @summary Tests for bash tool execution, error handling, and env var filtering
import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@diligent/core/tool/types";
import { createBashTool, filterSensitiveEnv } from "@diligent/runtime/tools";

const bashTool = createBashTool(process.cwd());

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    toolCallId: "tc_bash",
    signal: signal ?? new AbortController().signal,
    abort: () => {},
  };
}

describe("bash tool", () => {
  test("simple command (echo hello)", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, makeCtx());
    expect(result.output.trim()).toBe("hello");
    expect(result.render?.outputSummary).toBe("Command completed");
    expect(result.render?.blocks[0]).toMatchObject({ type: "command", command: "echo hello" });
  });

  test("non-zero exit code → exit code in header", async () => {
    const result = await bashTool.execute({ command: "exit 42" }, makeCtx());
    expect(result.output).toContain("[Exit code: 42]");
    expect(result.render?.outputSummary).toBe("Command failed (exit 42)");
    expect(result.render?.blocks[0]).toMatchObject({ type: "command", isError: true });
    expect(result.metadata?.exitCode).toBe(42);
  });

  test("timeout → kills process, timeout message", async () => {
    const result = await bashTool.execute({ command: "sleep 10", timeout: 200 }, makeCtx());
    expect(result.output).toContain("Timed out");
    expect(result.render?.outputSummary).toBe("Command timed out");
    expect(result.metadata?.timedOut).toBe(true);
  }, 5000);

  test("AbortSignal → kills process, aborted message", async () => {
    const ac = new AbortController();
    const promise = bashTool.execute({ command: "sleep 10" }, makeCtx(ac.signal));
    setTimeout(() => ac.abort(), 100);
    const result = await promise;
    expect(result.output).toContain("Aborted");
    expect(result.render?.outputSummary).toBe("Command aborted");
    expect(result.metadata?.aborted).toBe(true);
  }, 5000);

  test("stderr output → merged with [stderr] prefix", async () => {
    const result = await bashTool.execute({ command: "echo err >&2" }, makeCtx());
    expect(result.output).toContain("[stderr]");
    expect(result.output).toContain("err");
  });

  test("large output → truncated", async () => {
    // Generate output larger than 50KB
    const result = await bashTool.execute(
      { command: "bun --eval \"process.stdout.write('x'.repeat(60001))\"" },
      makeCtx(),
    );
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
    const original = process.env.TEST_NON_SENSITIVE_VAR;
    process.env.TEST_NON_SENSITIVE_VAR = "visible-value";
    try {
      const result = await bashTool.execute({ command: "echo $TEST_NON_SENSITIVE_VAR" }, makeCtx());
      expect(result.output.trim()).toBe("visible-value");
    } finally {
      if (original === undefined) delete process.env.TEST_NON_SENSITIVE_VAR;
      else process.env.TEST_NON_SENSITIVE_VAR = original;
    }
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
    const env = { MY_APP_TOKEN: "tok_abc", SHELL: "/bin/zsh" };
    const result = filterSensitiveEnv(env as NodeJS.ProcessEnv);
    expect(result.SHELL).toBe("/bin/zsh");
    expect(result.MY_APP_TOKEN).toBeUndefined();
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

  test("passes through CI passlist tokens (GH_TOKEN, GITHUB_TOKEN, NPM_TOKEN)", () => {
    const env = { GH_TOKEN: "ghs_abc", GITHUB_TOKEN: "ghp_xyz", NPM_TOKEN: "npm_tok", MY_TOKEN: "secret" };
    const result = filterSensitiveEnv(env as NodeJS.ProcessEnv);
    expect(result.GH_TOKEN).toBe("ghs_abc");
    expect(result.GITHUB_TOKEN).toBe("ghp_xyz");
    expect(result.NPM_TOKEN).toBe("npm_tok");
    expect(result.MY_TOKEN).toBeUndefined();
  });
});
