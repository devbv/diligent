// @summary Tests that instance.schema.search validates its input and forwards read-only searches to Studio.

import { describe, expect, test } from "bun:test";
import type { Tool } from "@diligent/core/tool-contract";
import { createStudioRpcToolProvider } from "../../../../src/tools/studiorpc";
import { method, params } from "../../../../src/tools/studiorpc/methods/instance.schema.search";
import { mutatingMethods, savingMethods } from "../../../../src/tools/studiorpc/tool-registry";

const toolName = "studiorpc_instance_schema_search";

type RpcCall = { method: string; params?: Record<string, unknown> };

async function loadTool(respond: (call: RpcCall) => unknown, calls: RpcCall[] = []): Promise<Tool> {
  const provider = createStudioRpcToolProvider({
    callRpc: async (rpcMethod, rpcParams) => {
      const call = { method: rpcMethod, params: rpcParams };
      calls.push(call);
      return respond(call);
    },
  });
  const tools = await provider.createTools({ cwd: "/tmp/project", host: { approve: async () => "once" } });
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`${toolName} is not advertised`);
  return tool;
}

function toolContext() {
  return { toolCallId: "test", signal: new AbortController().signal, abort: () => {} };
}

describe("instance.schema.search arguments", () => {
  test("requires a query or a class list, so an empty call cannot ask for the whole schema", () => {
    expect(() => params.parse({})).toThrow();
    expect(params.parse({ query: "color" }).query).toBe("color");
    expect(params.parse({ classes: ["Part"] }).classes).toEqual(["Part"]);
  });

  test("defaults limit to the server's page size and rejects out-of-range values", () => {
    expect(params.parse({ query: "color" }).limit).toBe(50);
    expect(params.parse({ query: "color", limit: 100 }).limit).toBe(100);
    expect(() => params.parse({ query: "color", limit: 0 })).toThrow();
    expect(() => params.parse({ query: "color", limit: 101 })).toThrow();
    expect(() => params.parse({ query: "color", limit: 1.5 })).toThrow();
  });

  test("rejects blank names and oversized class lists rather than sending them to Studio", () => {
    expect(() => params.parse({ query: "" })).toThrow();
    expect(() => params.parse({ classes: [""] })).toThrow();
    expect(() => params.parse({ classes: Array.from({ length: 21 }, (_, index) => `Class${index}`) })).toThrow();
  });

  test("rejects unknown fields so a misspelled filter cannot be silently dropped", () => {
    expect(() => params.parse({ query: "color", writableOnly: false })).toThrow();
  });

  test("accepts an opaque cursor for the next page", () => {
    expect(params.parse({ query: "color", cursor: "abc" }).cursor).toBe("abc");
  });
});

describe("instance.schema.search tool", () => {
  test("is read-only: it neither takes the write lock nor saves the level", () => {
    expect(mutatingMethods.has(method)).toBe(false);
    expect(savingMethods.has(method)).toBe(false);
  });

  test("forwards the search to Studio and returns the structured result", async () => {
    const calls: RpcCall[] = [];
    const result = {
      schemaVersion: "blake3:abc",
      matches: [
        {
          class: "Part",
          creatable: true,
          service: false,
          property: { name: "Color", declaredOn: "BasePart", valueSchema: { type: "object" } },
        },
      ],
      nextCursor: null,
    };
    const tool = await loadTool(() => result, calls);

    const executed = await tool.execute({ query: "color", classes: ["Part"], limit: 50 }, toolContext());

    expect(calls).toEqual([
      { method: "instance.schema.search", params: { query: "color", classes: ["Part"], limit: 50 } },
    ]);
    expect(JSON.parse(executed.output)).toEqual(result);
    expect(executed.metadata).toMatchObject({ method: "instance.schema.search" });
  });

  test("reports an empty result as an empty match list, not as a failure", async () => {
    const tool = await loadTool(() => ({ schemaVersion: "blake3:abc", matches: [], nextCursor: null }));

    const executed = await tool.execute({ classes: ["NoSuchClass"] }, toolContext());

    expect(JSON.parse(executed.output).matches).toEqual([]);
    expect(executed.metadata).not.toMatchObject({ error: true });
  });

  test("propagates a Studio error instead of reporting an empty schema", async () => {
    const tool = await loadTool(() => {
      throw new Error("Invalid params: cursor does not belong to this query");
    });

    await expect(tool.execute({ query: "color", cursor: "stale" }, toolContext())).rejects.toThrow(
      "cursor does not belong to this query",
    );
  });
});
