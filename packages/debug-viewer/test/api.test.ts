import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "path";
import { createApiHandler } from "../src/server/api.js";

const SAMPLE_DIR = resolve(import.meta.dir, "../src/server/sample-data");
let handleRequest: (req: Request) => Promise<Response | null>;

beforeAll(() => {
  handleRequest = createApiHandler(SAMPLE_DIR);
});

function makeReq(path: string): Request {
  return new Request(`http://localhost${path}`);
}

describe("GET /api/sessions", () => {
  test("returns list of sessions", async () => {
    const res = await handleRequest(makeReq("/api/sessions"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const data = await res!.json();
    expect(data.sessions).toBeArray();
    expect(data.sessions.length).toBe(3);

    // Sorted by lastActivity descending
    expect(data.sessions[0].lastActivity).toBeGreaterThanOrEqual(data.sessions[1].lastActivity);

    // Each session has expected fields
    for (const session of data.sessions) {
      expect(session.id).toBeString();
      expect(session.messageCount).toBeNumber();
      expect(session.toolCallCount).toBeNumber();
      expect(typeof session.hasErrors).toBe("boolean");
    }
  });
});

describe("GET /api/sessions/:id", () => {
  test("returns session entries for valid id", async () => {
    const res = await handleRequest(makeReq("/api/sessions/sample-001"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const data = await res!.json();
    expect(data.id).toBe("sample-001");
    expect(data.entries).toBeArray();
    expect(data.entries.length).toBe(9);
  });

  test("returns 404 for unknown session", async () => {
    const res = await handleRequest(makeReq("/api/sessions/nonexistent"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });
});

describe("GET /api/sessions/:id/tree", () => {
  test("returns tree structure", async () => {
    const res = await handleRequest(makeReq("/api/sessions/sample-003/tree"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const data = await res!.json();
    expect(data.id).toBe("sample-003");
    expect(data.tree.roots).toBeArray();
    expect(data.tree.roots.length).toBeGreaterThan(0);
    expect(data.tree.entries).toBeDefined();
    expect(data.tree.children).toBeDefined();

    // Verify forking: msg-003-06 has 2 children
    expect(data.tree.children["msg-003-06"].length).toBe(2);
  });

  test("returns 404 for unknown session", async () => {
    const res = await handleRequest(makeReq("/api/sessions/nonexistent/tree"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });
});

describe("GET /api/knowledge", () => {
  test("returns knowledge entries", async () => {
    const res = await handleRequest(makeReq("/api/knowledge"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const data = await res!.json();
    expect(data.entries).toBeArray();
    expect(data.entries.length).toBe(5);

    // Check types
    const types = data.entries.map((e: { type: string }) => e.type);
    expect(types).toContain("pattern");
    expect(types).toContain("decision");
    expect(types).toContain("discovery");
    expect(types).toContain("preference");
    expect(types).toContain("correction");
  });
});

describe("GET /api/search", () => {
  test("searches across all sessions", async () => {
    const res = await handleRequest(makeReq("/api/search?q=package.json"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const data = await res!.json();
    expect(data.query).toBe("package.json");
    expect(data.results.length).toBeGreaterThan(0);
  });

  test("searches within a specific session", async () => {
    const res = await handleRequest(makeReq("/api/search?q=express&session=sample-003"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const data = await res!.json();
    expect(data.results.length).toBeGreaterThan(0);
    for (const result of data.results) {
      expect(result.sessionId).toBe("sample-003");
    }
  });

  test("returns 400 when q param missing", async () => {
    const res = await handleRequest(makeReq("/api/search"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  test("returns empty results for no match", async () => {
    const res = await handleRequest(makeReq("/api/search?q=xyznonexistent123"));
    expect(res).not.toBeNull();
    const data = await res!.json();
    expect(data.results.length).toBe(0);
  });
});

describe("unknown routes", () => {
  test("returns null for non-API routes", async () => {
    const res = await handleRequest(makeReq("/something-else"));
    expect(res).toBeNull();
  });
});
