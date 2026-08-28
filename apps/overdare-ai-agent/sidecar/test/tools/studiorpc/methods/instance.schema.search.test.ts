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

  test("rejects blank names and oversized class lists rather than sending them to Studio", () => {
    expect(() => params.parse({ query: "" })).toThrow();
    expect(() => params.parse({ classes: [""] })).toThrow();
    expect(() => params.parse({ classes: Array.from({ length: 21 }, (_, index) => `Class${index}`) })).toThrow();
  });

  test("rejects unknown fields so a misspelled filter cannot be silently dropped", () => {
    expect(() => params.parse({ query: "color", writableOnly: false })).toThrow();
  });

  test("rejects the removed pagination arguments", () => {
    expect(() => params.parse({ query: "color", limit: 10 })).toThrow();
    expect(() => params.parse({ query: "color", cursor: "abc" })).toThrow();
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
      classes: [
        {
          class: "Part",
          creatable: true,
          service: false,
          properties: [{ name: "Color", declaredOn: "BasePart", valueSchema: { type: "object" } }],
        },
      ],
    };
    const tool = await loadTool(() => result, calls);

    const executed = await tool.execute({ query: "color", classes: ["Part"] }, toolContext());

    expect(calls).toEqual([{ method: "instance.schema.search", params: { query: "color", classes: ["Part"] } }]);
    expect(JSON.parse(executed.output)).toEqual(result);
    expect(executed.metadata).toMatchObject({ method: "instance.schema.search" });
  });

  test("reports an empty result as an empty class list, not as a failure", async () => {
    const tool = await loadTool(() => ({ schemaVersion: "blake3:abc", classes: [] }));

    const executed = await tool.execute({ classes: ["NoSuchClass"] }, toolContext());

    expect(JSON.parse(executed.output).classes).toEqual([]);
    expect(executed.metadata).not.toMatchObject({ error: true });
  });

  test("propagates a Studio error instead of reporting an empty schema", async () => {
    const tool = await loadTool(() => {
      throw new Error("Schema search failed");
    });

    await expect(tool.execute({ query: "color" }, toolContext())).rejects.toThrow("Schema search failed");
  });
});
