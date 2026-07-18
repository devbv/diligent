// @summary App-server e2e tests for image upload persistence and attachment responses

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let tmpDir = "";
let client: ProtocolTestClient;

afterEach(async () => {
  client?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  tmpDir = "";
});

describe("image upload", () => {
  test("image/upload stores bytes under the current thread and returns a local attachment", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-image-upload-"));
    const server = createTestServer({ cwd: tmpDir });
    client = createProtocolClient(server);

    const threadId = await client.initAndStartThread(tmpDir);
    const result = (await client.request("image/upload", {
      threadId,
      fileName: "screen shot.png",
      mediaType: "image/png",
      dataBase64: ONE_PIXEL_PNG,
    })) as {
      attachment: {
        type: string;
        path: string;
        mediaType: string;
        fileName: string;
      };
    };

    expect(result.attachment).toMatchObject({
      type: "local_image",
      mediaType: "image/png",
      fileName: "screen shot.png",
    });
    expect(result.attachment.path).toContain(join(".diligent", "images", threadId));
    expect((await readFile(result.attachment.path)).byteLength).toBeGreaterThan(0);
  });
});
