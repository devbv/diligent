import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const SAMPLE_DIR = dirname(new URL(import.meta.url).pathname);
const SESSIONS_DIR = join(SAMPLE_DIR, "sessions");
const KNOWLEDGE_DIR = join(SAMPLE_DIR, "knowledge");

function jsonl(entries: unknown[]): string {
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

// --- Sample 001: Simple 2-turn conversation with 1 tool call each ---
const sample001 = [
  {
    type: "session_header",
    id: "sample-001",
    timestamp: 1708900000000,
    cwd: "/home/user/project",
    version: "0.0.1",
  },
  {
    id: "msg-001-01",
    role: "user",
    content: "Read the package.json file and tell me what dependencies we have.",
    timestamp: 1708900001000,
  },
  {
    id: "msg-001-02",
    parentId: "msg-001-01",
    role: "assistant",
    content: [
      { type: "text", text: "I'll read the package.json file for you." },
      {
        type: "tool_call",
        id: "tc-001-01",
        name: "read",
        input: { path: "package.json" },
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 100 },
    stopReason: "tool_use",
    timestamp: 1708900002000,
  },
  {
    id: "msg-001-03",
    parentId: "msg-001-02",
    role: "tool_result",
    toolCallId: "tc-001-01",
    toolName: "read",
    output: '{\n  "name": "my-project",\n  "dependencies": {\n    "express": "^4.18.0",\n    "zod": "^3.24.0"\n  }\n}',
    isError: false,
    timestamp: 1708900003000,
  },
  {
    id: "msg-001-04",
    parentId: "msg-001-03",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Your project has **2 dependencies**:\n\n- `express` ^4.18.0 — web framework\n- `zod` ^3.24.0 — schema validation\n\nWould you like me to check for outdated versions?",
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 200, outputTokens: 60, cacheReadTokens: 100, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: 1708900004000,
  },
  {
    id: "msg-001-05",
    parentId: "msg-001-04",
    role: "user",
    content: "Yes, check for updates.",
    timestamp: 1708900010000,
  },
  {
    id: "msg-001-06",
    parentId: "msg-001-05",
    role: "assistant",
    content: [
      { type: "text", text: "Let me check the latest versions." },
      {
        type: "tool_call",
        id: "tc-001-02",
        name: "bash",
        input: { command: "npm outdated --json" },
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 280, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: 0 },
    stopReason: "tool_use",
    timestamp: 1708900011000,
  },
  {
    id: "msg-001-07",
    parentId: "msg-001-06",
    role: "tool_result",
    toolCallId: "tc-001-02",
    toolName: "bash",
    output: '{"express": {"current": "4.18.0", "wanted": "4.21.0", "latest": "5.0.1"}}',
    isError: false,
    timestamp: 1708900013000,
  },
  {
    id: "msg-001-08",
    parentId: "msg-001-07",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Express has an update available: **4.18.0 → 5.0.1**. Note that v5 is a major version bump — check the migration guide before upgrading.",
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 350, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: 1708900014000,
  },
];

// --- Sample 002: Complex 5-turn with multiple tools + error ---
const sample002 = [
  {
    type: "session_header",
    id: "sample-002",
    timestamp: 1708910000000,
    cwd: "/home/user/project",
    version: "0.0.1",
  },
  {
    id: "msg-002-01",
    role: "user",
    content: "Fix the failing tests in src/utils.ts",
    timestamp: 1708910001000,
  },
  {
    id: "msg-002-02",
    parentId: "msg-002-01",
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking:
          "The user wants me to fix tests. I should first read the test file and the source file to understand what's failing.",
      },
      { type: "text", text: "Let me look at the test file and source." },
      {
        type: "tool_call",
        id: "tc-002-01",
        name: "read",
        input: { path: "src/utils.ts" },
      },
      {
        type: "tool_call",
        id: "tc-002-02",
        name: "read",
        input: { path: "test/utils.test.ts" },
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 150, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 120 },
    stopReason: "tool_use",
    timestamp: 1708910002000,
  },
  {
    id: "msg-002-03",
    parentId: "msg-002-02",
    role: "tool_result",
    toolCallId: "tc-002-01",
    toolName: "read",
    output:
      'export function parseDate(s: string): Date {\n  return new Date(s);\n}\n\nexport function formatBytes(n: number): string {\n  if (n < 1024) return n + " B";\n  return (n / 1024).toFixed(1) + " KB";\n}',
    isError: false,
    timestamp: 1708910003000,
  },
  {
    id: "msg-002-04",
    parentId: "msg-002-02",
    role: "tool_result",
    toolCallId: "tc-002-02",
    toolName: "read",
    output:
      'import { parseDate, formatBytes } from "../src/utils";\n\ntest("parseDate handles ISO strings", () => {\n  expect(parseDate("2024-01-15").getFullYear()).toBe(2024);\n});\n\ntest("formatBytes handles edge cases", () => {\n  expect(formatBytes(0)).toBe("0 B");\n  expect(formatBytes(1024)).toBe("1.0 KB");\n  expect(formatBytes(1536)).toBe("1.5 KB");\n  expect(formatBytes(-1)).toBe("-1 B"); // this test fails\n});',
    isError: false,
    timestamp: 1708910003100,
  },
  {
    id: "msg-002-05",
    parentId: "msg-002-04",
    role: "assistant",
    content: [
      { type: "text", text: "Let me run the tests first to see the exact failure." },
      {
        type: "tool_call",
        id: "tc-002-03",
        name: "bash",
        input: { command: "bun test test/utils.test.ts" },
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 450, outputTokens: 35, cacheReadTokens: 120, cacheWriteTokens: 0 },
    stopReason: "tool_use",
    timestamp: 1708910004000,
  },
  {
    id: "msg-002-06",
    parentId: "msg-002-05",
    role: "tool_result",
    toolCallId: "tc-002-03",
    toolName: "bash",
    output:
      'FAIL test/utils.test.ts\n  formatBytes handles edge cases\n    Expected: "-1 B"\n    Received: "-0.0 KB"\n\nTests: 1 failed, 1 passed, 2 total',
    isError: true,
    timestamp: 1708910006000,
  },
  {
    id: "msg-002-07",
    parentId: "msg-002-06",
    role: "assistant",
    content: [
      {
        type: "text",
        text: 'The issue is that `formatBytes` doesn\'t handle negative numbers. The comparison `n < 1024` fails for -1 because -1 < 1024, so it returns "-1 B" — wait, that should work. Let me re-read...\n\nActually the issue is different — the function hits the `< 1024` branch for -1, which returns `"-1 B"`. The test expects `"-1 B"` and should pass. Let me fix the test expectation based on actual behavior.',
      },
      {
        type: "tool_call",
        id: "tc-002-04",
        name: "edit",
        input: {
          path: "src/utils.ts",
          old: 'if (n < 1024) return n + " B";',
          new: 'if (n < 0) return "-" + formatBytes(-n);\n  if (n < 1024) return n + " B";',
        },
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 600, outputTokens: 120, cacheReadTokens: 120, cacheWriteTokens: 0 },
    stopReason: "tool_use",
    timestamp: 1708910007000,
  },
  {
    id: "msg-002-08",
    parentId: "msg-002-07",
    role: "tool_result",
    toolCallId: "tc-002-04",
    toolName: "edit",
    output: "Applied edit to src/utils.ts",
    isError: false,
    timestamp: 1708910008000,
  },
  {
    id: "msg-002-09",
    parentId: "msg-002-08",
    role: "assistant",
    content: [
      { type: "text", text: "Now let me run the tests again to verify the fix." },
      {
        type: "tool_call",
        id: "tc-002-05",
        name: "bash",
        input: { command: "bun test test/utils.test.ts" },
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 700, outputTokens: 30, cacheReadTokens: 120, cacheWriteTokens: 0 },
    stopReason: "tool_use",
    timestamp: 1708910009000,
  },
  {
    id: "msg-002-10",
    parentId: "msg-002-09",
    role: "tool_result",
    toolCallId: "tc-002-05",
    toolName: "bash",
    output: "PASS test/utils.test.ts\n\nTests: 2 passed, 2 total\nTime: 0.12s",
    isError: false,
    timestamp: 1708910010000,
  },
  {
    id: "msg-002-11",
    parentId: "msg-002-10",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "All tests pass now. The fix adds a guard for negative numbers in `formatBytes()` — it now recursively formats the absolute value and prepends a minus sign.",
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 780, outputTokens: 55, cacheReadTokens: 120, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: 1708910011000,
  },
];

// --- Sample 003: 3 turns + compaction + forked branch ---
const sample003 = [
  {
    type: "session_header",
    id: "sample-003",
    timestamp: 1708920000000,
    cwd: "/home/user/webapp",
    version: "0.0.1",
  },
  {
    id: "msg-003-01",
    role: "user",
    content: "Set up a new Express API with a health endpoint.",
    timestamp: 1708920001000,
  },
  {
    id: "msg-003-02",
    parentId: "msg-003-01",
    role: "assistant",
    content: [
      { type: "text", text: "I'll create the Express server with a health endpoint." },
      {
        type: "tool_call",
        id: "tc-003-01",
        name: "write",
        input: {
          path: "src/server.ts",
          content:
            'import express from "express";\n\nconst app = express();\n\napp.get("/health", (req, res) => {\n  res.json({ status: "ok", timestamp: Date.now() });\n});\n\nexport default app;',
        },
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 100, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 80 },
    stopReason: "tool_use",
    timestamp: 1708920002000,
  },
  {
    id: "msg-003-03",
    parentId: "msg-003-02",
    role: "tool_result",
    toolCallId: "tc-003-01",
    toolName: "write",
    output: "Created src/server.ts",
    isError: false,
    timestamp: 1708920003000,
  },
  {
    id: "msg-003-04",
    parentId: "msg-003-03",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Created `src/server.ts` with a `/health` endpoint that returns `{ status: 'ok', timestamp }`. Want me to add a main entry point to start the server?",
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 250, outputTokens: 50, cacheReadTokens: 80, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: 1708920004000,
  },
  // Compaction entry
  {
    id: "msg-003-05",
    parentId: "msg-003-04",
    type: "compaction",
    summary:
      "Set up Express API project. Created src/server.ts with /health endpoint returning JSON status. User asked for an Express API with health endpoint — completed successfully.",
    details: {
      readFiles: [],
      modifiedFiles: ["src/server.ts"],
    },
    timestamp: 1708920005000,
  },
  // Post-compaction continuation
  {
    id: "msg-003-06",
    parentId: "msg-003-05",
    role: "user",
    content: "Yes, add the entry point and also add a /ready endpoint.",
    timestamp: 1708920010000,
  },
  {
    id: "msg-003-07",
    parentId: "msg-003-06",
    role: "assistant",
    content: [
      { type: "text", text: "I'll create the entry point and add the readiness endpoint." },
      {
        type: "tool_call",
        id: "tc-003-02",
        name: "write",
        input: {
          path: "src/index.ts",
          content:
            // biome-ignore lint/suspicious/noTemplateCurlyInString: sample data contains template literals
            'import app from "./server";\n\nconst PORT = process.env.PORT || 3000;\napp.listen(PORT, () => console.log(`Server running on port ${PORT}`));',
        },
      },
      {
        type: "tool_call",
        id: "tc-003-03",
        name: "edit",
        input: {
          path: "src/server.ts",
          old: "export default app;",
          new: 'app.get("/ready", (req, res) => {\n  res.json({ ready: true });\n});\n\nexport default app;',
        },
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 180, outputTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 150 },
    stopReason: "tool_use",
    timestamp: 1708920011000,
  },
  {
    id: "msg-003-08",
    parentId: "msg-003-07",
    role: "tool_result",
    toolCallId: "tc-003-02",
    toolName: "write",
    output: "Created src/index.ts",
    isError: false,
    timestamp: 1708920012000,
  },
  {
    id: "msg-003-09",
    parentId: "msg-003-07",
    role: "tool_result",
    toolCallId: "tc-003-03",
    toolName: "edit",
    output: "Applied edit to src/server.ts",
    isError: false,
    timestamp: 1708920012100,
  },
  // Forked branch: alternative response from msg-003-06
  {
    id: "msg-003-10",
    parentId: "msg-003-06",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Actually, let me suggest using Fastify instead of Express for better TypeScript support and performance.",
      },
    ],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 180, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: 1708920013000,
  },
];

// --- Knowledge entries ---
const knowledge = [
  {
    id: "k-001",
    timestamp: 1708900020000,
    sessionId: "sample-001",
    type: "pattern",
    content: "User prefers checking dependencies with npm outdated before upgrading.",
    confidence: 0.7,
    tags: ["workflow", "npm"],
  },
  {
    id: "k-002",
    timestamp: 1708910020000,
    sessionId: "sample-002",
    type: "decision",
    content: "formatBytes should handle negative numbers by formatting absolute value with minus prefix.",
    confidence: 0.9,
    tags: ["utils", "formatting"],
  },
  {
    id: "k-003",
    timestamp: 1708920020000,
    sessionId: "sample-003",
    type: "discovery",
    content: "Project uses Express 4.x for API layer with standard /health and /ready endpoints.",
    confidence: 0.85,
    tags: ["architecture", "api"],
  },
  {
    id: "k-004",
    timestamp: 1708920025000,
    sessionId: "sample-003",
    type: "preference",
    content: "User prefers TypeScript strict mode for all server-side code.",
    confidence: 0.6,
    tags: ["typescript", "config"],
  },
  {
    id: "k-005",
    timestamp: 1708920030000,
    sessionId: "sample-002",
    type: "correction",
    content:
      "Test assertions should match actual function behavior, not assumed behavior. Always run tests before modifying code.",
    confidence: 0.95,
    supersedes: "k-002",
    tags: ["testing", "workflow"],
  },
];

// Generate files
mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(KNOWLEDGE_DIR, { recursive: true });

writeFileSync(join(SESSIONS_DIR, "sample-001.jsonl"), jsonl(sample001));
writeFileSync(join(SESSIONS_DIR, "sample-002.jsonl"), jsonl(sample002));
writeFileSync(join(SESSIONS_DIR, "sample-003.jsonl"), jsonl(sample003));
writeFileSync(join(KNOWLEDGE_DIR, "knowledge.jsonl"), jsonl(knowledge));

console.log("Generated sample data:");
console.log(`  ${join(SESSIONS_DIR, "sample-001.jsonl")} (${sample001.length} entries)`);
console.log(`  ${join(SESSIONS_DIR, "sample-002.jsonl")} (${sample002.length} entries)`);
console.log(`  ${join(SESSIONS_DIR, "sample-003.jsonl")} (${sample003.length} entries)`);
console.log(`  ${join(KNOWLEDGE_DIR, "knowledge.jsonl")} (${knowledge.length} entries)`);
