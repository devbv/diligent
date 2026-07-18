// @summary Tests for NDJSON JSON-RPC stream parsing and serialization
import { describe, expect, it } from "bun:test";
import type { JSONRPCMessage } from "@diligent/protocol";
import { createNdjsonParser, formatNdjsonMessage } from "@diligent/runtime";

describe("NDJSON framing", () => {
  it("parses and formats JSON-RPC frames", () => {
    const seen: JSONRPCMessage[] = [];
    const parser = createNdjsonParser((message) => {
      seen.push(message);
    });

    const first = formatNdjsonMessage({ id: 1, method: "initialize", params: { clientName: "cli" } });
    const second = formatNdjsonMessage({ method: "initialized" });

    parser.push(first.slice(0, 10));
    parser.push(first.slice(10) + second);
    parser.end();

    expect(seen).toEqual([{ id: 1, method: "initialize", params: { clientName: "cli" } }, { method: "initialized" }]);
  });
});
