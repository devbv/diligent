// @summary List and download Studio archives from AWS S3 with isolated SigV4 credentials.

import { createHash, createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type StudioReleaseObject, selectLatestWindowsStudioRelease } from "./release-selection";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3StudioSource {
  bucket: string;
  region: string;
  prefix: string;
  credentials: AwsCredentials;
}

interface CreateSignedRequestOptions extends S3StudioSource {
  method: "GET";
  key?: string;
  query?: Record<string, string>;
  now?: Date;
}

export interface S3ListPage {
  objects: StudioReleaseObject[];
  nextContinuationToken?: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function encodeAwsComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeObjectKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeAwsComponent(segment))
    .join("/");
}

function canonicalQueryString(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([key, value]) => [encodeAwsComponent(key), encodeAwsComponent(value)] as const)
    .sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function validateS3Address(bucket: string, region: string): void {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new Error("OVERDARE_STUDIO_S3_BUCKET is not a valid DNS-compatible S3 bucket name");
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d+$/.test(region)) {
    throw new Error("OVERDARE_STUDIO_S3_REGION is not a valid AWS region");
  }
}

export function createS3SignedRequest(options: CreateSignedRequestOptions): {
  url: string;
  headers: Record<string, string>;
} {
  validateS3Address(options.bucket, options.region);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Cannot sign an S3 request with an invalid date");

  const host =
    options.region === "us-east-1"
      ? `${options.bucket}.s3.amazonaws.com`
      : `${options.bucket}.s3.${options.region}.amazonaws.com`;
  const canonicalUri = options.key ? `/${encodeObjectKey(options.key)}` : "/";
  const canonicalQuery = canonicalQueryString(options.query ?? {});
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaderValues: Record<string, string> = {
    host,
    "x-amz-content-sha256": EMPTY_SHA256,
    "x-amz-date": amzDate,
  };
  if (options.credentials.sessionToken) {
    canonicalHeaderValues["x-amz-security-token"] = options.credentials.sessionToken;
  }
  const signedHeaderNames = Object.keys(canonicalHeaderValues).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${canonicalHeaderValues[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    EMPTY_SHA256,
  ].join("\n");
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${options.credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, options.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope},` +
    `SignedHeaders=${signedHeaders},Signature=${signature}`;
  const url = `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;

  return {
    url,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": amzDate,
      ...(options.credentials.sessionToken ? { "x-amz-security-token": options.credentials.sessionToken } : {}),
    },
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hexadecimal: string) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]) : undefined;
}

export function parseS3ListObjectsXml(xml: string): S3ListPage {
  const objects: StudioReleaseObject[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = xmlValue(match[1], "Key");
    const lastModified = xmlValue(match[1], "LastModified");
    const sizeText = xmlValue(match[1], "Size");
    if (!key || !lastModified) continue;
    const size = sizeText === undefined ? undefined : Number(sizeText);
    objects.push({
      key,
      lastModified,
      ...(Number.isFinite(size) ? { size } : {}),
    });
  }

  const isTruncated = xmlValue(xml, "IsTruncated")?.toLowerCase() === "true";
  const nextContinuationToken = xmlValue(xml, "NextContinuationToken");
  if (isTruncated && !nextContinuationToken) {
    throw new Error("S3 returned a truncated object list without a continuation token");
  }
  return {
    objects,
    ...(nextContinuationToken ? { nextContinuationToken } : {}),
  };
}

async function s3Error(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  const code = xmlValue(body, "Code");
  const message = xmlValue(body, "Message");
  return new Error(
    `S3 request failed: HTTP ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`,
  );
}

export async function listS3Objects(
  source: S3StudioSource,
  signal: AbortSignal,
  fetchRequest: typeof fetch = fetch,
): Promise<StudioReleaseObject[]> {
  const objects: StudioReleaseObject[] = [];
  const seenTokens = new Set<string>();
  let continuationToken: string | undefined;

  do {
    const query: Record<string, string> = {
      "list-type": "2",
      prefix: source.prefix,
    };
    if (continuationToken) query["continuation-token"] = continuationToken;
    const request = createS3SignedRequest({ ...source, method: "GET", query });
    const response = await fetchRequest(request.url, {
      method: "GET",
      headers: request.headers,
      signal,
    });
    if (!response.ok) throw await s3Error(response);
    const page = parseS3ListObjectsXml(await response.text());
    objects.push(...page.objects);
    continuationToken = page.nextContinuationToken;
    if (continuationToken) {
      if (seenTokens.has(continuationToken)) throw new Error("S3 repeated an object-list continuation token");
      seenTokens.add(continuationToken);
    }
  } while (continuationToken);

  return objects;
}

export async function resolveLatestS3StudioRelease(
  source: S3StudioSource,
  signal: AbortSignal,
  fetchRequest: typeof fetch = fetch,
): Promise<StudioReleaseObject> {
  return selectLatestWindowsStudioRelease(await listS3Objects(source, signal, fetchRequest), source.prefix);
}

export async function downloadS3Object(
  source: S3StudioSource,
  key: string,
  destination: string,
  signal: AbortSignal,
  fetchRequest: typeof fetch = fetch,
): Promise<void> {
  const request = createS3SignedRequest({ ...source, method: "GET", key });
  const response = await fetchRequest(request.url, {
    method: "GET",
    headers: request.headers,
    signal,
  });
  if (!response.ok) throw await s3Error(response);
  if (!response.body) throw new Error("S3 object response did not include a body");
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination), { signal });
}
