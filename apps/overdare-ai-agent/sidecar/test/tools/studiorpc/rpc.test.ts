// @summary Tests Studio RPC transport cancellation.

import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { call } from "../../../src/tools/studiorpc/rpc";

let server: Server | undefined;
let accepted: Socket | undefined;
const previousHost = process.env.STUDIO_HOST;
const previousPort = process.env.STUDIO_PORT;

afterEach(async () => {
  accepted?.destroy();
  accepted = undefined;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (previousHost === undefined) delete process.env.STUDIO_HOST;
  else process.env.STUDIO_HOST = previousHost;
  if (previousPort === undefined) delete process.env.STUDIO_PORT;
  else process.env.STUDIO_PORT = previousPort;
});

describe("Studio RPC cancellation", () => {
  test("aborting a tool call closes its pending Studio socket", async () => {
    server = createServer((socket) => {
      accepted = socket;
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    process.env.STUDIO_HOST = "127.0.0.1";
    process.env.STUDIO_PORT = String(address.port);

    const controller = new AbortController();
    const connected = new Promise<void>((resolve) => server!.once("connection", () => resolve()));
    const pending = call("game.input.inject", {}, { timeoutMs: 10_000, signal: controller.signal });
    await connected;
    controller.abort(new DOMException("turn interrupted", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(accepted?.destroyed).toBe(true);
  });

  test("surfaces a structured Studio rejection reason without dropping its data", async () => {
    server = createServer((socket) => {
      accepted = socket;
      socket.once("data", (requestBytes) => {
        const request = JSON.parse(requestBytes.toString()) as { id: number };
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32111,
              message: "Move rejected",
              data: { name: "moveRejected", reason: "navigationSystemUnavailable" },
            },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    process.env.STUDIO_HOST = "127.0.0.1";
    process.env.STUDIO_PORT = String(address.port);

    const rejected = call("game.character.moveTo", {}, { timeoutMs: 1_000 });

    await expect(rejected).rejects.toMatchObject({
      code: -32111,
      data: { name: "moveRejected", reason: "navigationSystemUnavailable" },
      message: expect.stringContaining("Reason: navigationSystemUnavailable"),
    });
  });
});
