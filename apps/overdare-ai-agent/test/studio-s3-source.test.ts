// @summary Verify AWS SigV4 requests and paginated S3 object-list parsing for the Studio smoke harness.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createS3SignedRequest,
  downloadS3Object,
  listS3Objects,
  parseS3ListObjectsXml,
} from "./studio-smoke/s3-source";

const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "session-token",
};

describe("Studio S3 source", () => {
  test("parses object metadata and a continuation token", () => {
    const page = parseS3ListObjectsXml(`<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>next&amp;token</NextContinuationToken>
        <Contents>
          <Key>Sandbox/Windows/a&amp;b_Sandbox_Shipping.zip</Key>
          <LastModified>2026-07-30T09:00:00.000Z</LastModified>
          <Size>123</Size>
        </Contents>
      </ListBucketResult>`);

    expect(page).toEqual({
      objects: [
        {
          key: "Sandbox/Windows/a&b_Sandbox_Shipping.zip",
          lastModified: "2026-07-30T09:00:00.000Z",
          size: 123,
        },
      ],
      nextContinuationToken: "next&token",
    });
  });

  test("creates an AWS Signature V4 request without putting credentials in the URL", () => {
    const request = createS3SignedRequest({
      method: "GET",
      bucket: "ovdr-build-binary",
      region: "ap-northeast-2",
      key: "Sandbox/Windows/build with spaces.zip",
      credentials: CREDENTIALS,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(request.url).toBe(
      "https://ovdr-build-binary.s3.ap-northeast-2.amazonaws.com/Sandbox/Windows/build%20with%20spaces.zip",
    );
    expect(request.url).not.toContain(CREDENTIALS.accessKeyId);
    expect(request.headers.Authorization).toContain("Credential=AKIDEXAMPLE/20260731/ap-northeast-2/s3/aws4_request");
    expect(request.headers["x-amz-security-token"]).toBe("session-token");
  });

  test("matches the AWS S3 ListObjects Signature V4 reference", () => {
    const request = createS3SignedRequest({
      method: "GET",
      bucket: "examplebucket",
      region: "us-east-1",
      prefix: "",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      query: {
        "max-keys": "2",
        prefix: "J",
      },
      now: new Date("2013-05-24T00:00:00.000Z"),
    });

    expect(request.headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date," +
        "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });

  test("follows S3 continuation tokens", async () => {
    const requestedUrls: string[] = [];
    const responses = [
      `<ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>page-2</NextContinuationToken>
        <Contents><Key>Sandbox/Windows/first.zip</Key><LastModified>2026-07-30T09:00:00Z</LastModified></Contents>
      </ListBucketResult>`,
      `<ListBucketResult>
        <IsTruncated>false</IsTruncated>
        <Contents><Key>Sandbox/Windows/second.zip</Key><LastModified>2026-07-31T09:00:00Z</LastModified></Contents>
      </ListBucketResult>`,
    ];
    const fetchRequest = (async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(responses.shift(), { status: 200 });
    }) as typeof fetch;

    const objects = await listS3Objects(
      {
        bucket: "ovdr-build-binary",
        region: "ap-northeast-2",
        prefix: "Sandbox/Windows/",
        credentials: CREDENTIALS,
      },
      new AbortController().signal,
      fetchRequest,
    );

    expect(objects.map((object) => object.key)).toEqual(["Sandbox/Windows/first.zip", "Sandbox/Windows/second.zip"]);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toContain("continuation-token=page-2");
  });

  test("streams an S3 object to disk before the response completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-s3-stream-"));
    const destination = join(root, "studio.zip");
    let finishResponse = () => {};
    let responseFinished = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        finishResponse = () => {
          if (responseFinished) return;
          responseFinished = true;
          controller.enqueue(new TextEncoder().encode("-second"));
          controller.close();
        };
      },
    });
    const fetchRequest = (async () => new Response(body, { status: 200 })) as typeof fetch;

    try {
      const download = downloadS3Object(
        {
          bucket: "ovdr-build-binary",
          region: "ap-northeast-2",
          prefix: "Sandbox/Windows/",
          credentials: CREDENTIALS,
        },
        "Sandbox/Windows/studio.zip",
        destination,
        new AbortController().signal,
        fetchRequest,
      );

      let streamedSize = 0;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        streamedSize = await stat(destination)
          .then((value) => value.size)
          .catch(() => 0);
        if (streamedSize > 0) break;
        await Bun.sleep(10);
      }
      finishResponse();
      await download;

      expect(streamedSize).toBe(5);
      expect(await readFile(destination, "utf8")).toBe("first-second");
    } finally {
      finishResponse();
      await rm(root, { recursive: true, force: true });
    }
  });
});
