import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface S3DoubleOptions {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region?: string;
  /** Keys per list page. Small values exercise the continuation token. */
  readonly pageSize?: number;
  /** The interface to listen on. A Docker test binds the bridge gateway, so a container can reach it. Defaults to loopback. */
  readonly hostname?: string;
}

export interface S3Double {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Completed objects by key. */
  readonly objects: Map<string, Uint8Array>;
  /** Every request as `METHOD path?query`, in order. */
  readonly requests: string[];
  /** Multipart uploads begun and neither completed nor aborted. */
  openUploads(): number;
  /** Makes the next `times` requests that match fail with `status` and the S3 error `code`. */
  failNext(match: (method: string, key: string) => boolean, status: number, code: string, times?: number): void;
  stop(): void;
}

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

const hmac = (key: Uint8Array | string, data: string): Buffer => createHmac("sha256", key).update(data).digest();

const rfc3986 = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function xml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    headers: { "content-type": "application/xml" },
  });
}

function errorResponse(status: number, code: string, method: string): Response {
  if (method === "HEAD") return new Response(null, { status });
  const body = `<Error><Code>${code}</Code><Message>${code}</Message></Error>`;
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

/**
 * Recomputes the SigV4 signature of a request from the secret it was signed with. The request is refused when the
 * access key or the signature does not match, the way a real service refuses it.
 */
function verifySigV4(req: Request, url: URL, accessKeyId: string, secret: string): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("AWS4-HMAC-SHA256 ")) return "AccessDenied";
  const fields = new Map(
    header
      .slice("AWS4-HMAC-SHA256 ".length)
      .split(",")
      .map((part) => part.trim().split("=") as [string, string]),
  );
  const credential = fields.get("Credential") ?? "";
  const [keyId = "", date = "", region = "", service = ""] = credential.split("/");
  if (keyId !== accessKeyId) return "InvalidAccessKeyId";
  const signedHeaders = (fields.get("SignedHeaders") ?? "").split(";");
  const amzDate = req.headers.get("x-amz-date") ?? "";
  const payloadHash = req.headers.get("x-amz-content-sha256") ?? EMPTY_HASH;
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalHeaders = signedHeaders
    .map((name) => `${name}:${(req.headers.get(name) ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const canonicalRequest = [
    req.method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = [date, region, service, "aws4_request"].reduce<Uint8Array | string>(
    (parent, part) => hmac(parent, part),
    `AWS4${secret}`,
  );
  const expected = Buffer.from(hmac(key, stringToSign).toString("hex"));
  const given = Buffer.from(fields.get("Signature") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected) ? null : "SignatureDoesNotMatch";
}

/**
 * An S3-compatible service on 127.0.0.1, addressed path-style. It keeps objects in memory, completes multipart uploads
 * from their parts, and checks every request's signature against the secret key it was given.
 */
export function startS3Double(options: S3DoubleOptions): S3Double {
  const region = options.region ?? "us-east-1";
  const pageSize = options.pageSize ?? 1000;
  const objects = new Map<string, Uint8Array>();
  const modified = new Map<string, Date>();
  const requests: string[] = [];
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const rules: { match: (method: string, key: string) => boolean; status: number; code: string; left: number }[] = [];
  let uploadSeq = 0;

  const hostname = options.hostname ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const [bucket = "", ...rest] = url.pathname.split("/").slice(1);
      const key = decodeURIComponent(rest.join("/"));
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      const body = new Uint8Array(await req.arrayBuffer());
      const denied = verifySigV4(req, url, options.accessKeyId, options.secretAccessKey);
      if (denied) return errorResponse(403, denied, req.method);
      if (bucket !== options.bucket) return errorResponse(404, "NoSuchBucket", req.method);
      const hit = rules.find((candidate) => candidate.left > 0 && candidate.match(req.method, key));
      if (hit) {
        hit.left -= 1;
        return errorResponse(hit.status, hit.code, req.method);
      }

      if (req.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const after = url.searchParams.get("continuation-token");
        const limit = Math.min(Number(url.searchParams.get("max-keys") ?? pageSize), pageSize);
        const matching = [...objects.keys()].filter((name) => name.startsWith(prefix) && (!after || name > after));
        matching.sort();
        const page = matching.slice(0, limit);
        const truncated = matching.length > page.length;
        const contents = page
          .map((name) => {
            const bytes = objects.get(name)?.byteLength ?? 0;
            const at = modified.get(name)?.toISOString() ?? new Date(0).toISOString();
            return `<Contents><Key>${name}</Key><LastModified>${at}</LastModified><ETag>"x"</ETag><Size>${bytes}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
          })
          .join("");
        const next = truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : "";
        return xml(
          `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${options.bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${limit}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`,
        );
      }

      // minio-go, which restic uses, asks for the bucket and its location before it touches an object.
      if (key === "" && (req.method === "HEAD" || req.method === "GET")) {
        if (url.searchParams.has("location")) {
          return xml(
            `<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${region}</LocationConstraint>`,
          );
        }
        return new Response(null, { status: 200 });
      }

      if (req.method === "POST" && url.searchParams.has("uploads")) {
        const uploadId = `upload-${++uploadSeq}`;
        uploads.set(uploadId, { key, parts: new Map() });
        return xml(
          `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${options.bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
      }

      const uploadId = url.searchParams.get("uploadId");
      if (uploadId !== null) {
        const upload = uploads.get(uploadId);
        if (!upload) return errorResponse(404, "NoSuchUpload", req.method);
        if (req.method === "PUT") {
          upload.parts.set(Number(url.searchParams.get("partNumber")), body);
          return new Response(null, { status: 200, headers: { etag: `"part-${upload.parts.size}"` } });
        }
        if (req.method === "POST") {
          const numbers = [...upload.parts.keys()].toSorted((a, b) => a - b);
          const total = numbers.reduce((sum, n) => sum + (upload.parts.get(n)?.byteLength ?? 0), 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const n of numbers) {
            const part = upload.parts.get(n) ?? new Uint8Array();
            merged.set(part, offset);
            offset += part.byteLength;
          }
          objects.set(upload.key, merged);
          modified.set(upload.key, new Date());
          uploads.delete(uploadId);
          return xml(
            `<CompleteMultipartUploadResult><Location>${url.origin}/${options.bucket}/${upload.key}</Location><Bucket>${options.bucket}</Bucket><Key>${upload.key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`,
          );
        }
        if (req.method === "DELETE") {
          uploads.delete(uploadId);
          return new Response(null, { status: 204 });
        }
      }

      if (req.method === "HEAD" || req.method === "GET") {
        const stored = objects.get(key);
        if (!stored) return errorResponse(404, "NoSuchKey", req.method);
        const headers = {
          "content-length": String(stored.byteLength),
          "content-type": "application/octet-stream",
          etag: '"x"',
          "last-modified": (modified.get(key) ?? new Date(0)).toUTCString(),
        };
        if (req.method === "HEAD") return new Response(null, { status: 200, headers });
        return new Response(stored, { status: 200, headers });
      }

      if (req.method === "PUT") {
        objects.set(key, body);
        modified.set(key, new Date());
        return new Response(null, { status: 200, headers: { etag: '"x"' } });
      }

      if (req.method === "DELETE") {
        objects.delete(key);
        modified.delete(key);
        return new Response(null, { status: 204 });
      }

      return errorResponse(405, "MethodNotAllowed", req.method);
    },
  });

  return {
    endpoint: `http://${hostname}:${server.port}`,
    region,
    bucket: options.bucket,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    objects,
    requests,
    openUploads: () => uploads.size,
    failNext(match, status, code, times = 1) {
      rules.push({ match, status, code, left: times });
    },
    stop() {
      server.stop(true);
    },
  };
}
