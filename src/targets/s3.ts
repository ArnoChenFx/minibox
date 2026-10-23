import { S3Client } from "bun";

import { classifyFailure, isMissing, TargetFailure } from "./errors";
import type { RemoteObject, S3Connection, TargetSession } from "./session";

/** The size of each part of a streamed upload. S3 needs every part but the last to be at least 5 MiB. */
const PART_BYTES = 8 * 1024 * 1024;
const QUEUE_SIZE = 4;
const RETRY = 3;
const LIST_PAGE = 1000;

function keyOf(path: string, name: string): string {
  return path === "" ? name : `${path}/${name}`;
}

/**
 * An S3-compatible bucket, reached with path-style addressing, which every S3-compatible service accepts. A write is one
 * multipart upload that S3 completes only when every part has arrived, so a failed write leaves no object behind.
 */
export function openS3Session(conn: S3Connection): TargetSession {
  const client = new S3Client({
    accessKeyId: conn.accessKeyId,
    secretAccessKey: conn.secretAccessKey,
    endpoint: conn.endpoint,
    region: conn.region,
    bucket: conn.bucket,
    virtualHostedStyle: false,
    retry: RETRY,
  });

  async function statOf(name: string): Promise<RemoteObject | null> {
    try {
      const info = await client.file(keyOf(conn.path, name)).stat();
      return { name, bytes: info.size, modifiedAt: info.lastModified.toISOString() };
    } catch (e) {
      if (isMissing(e)) return null;
      throw classifyFailure(e);
    }
  }

  return {
    async probe() {
      try {
        await client.list({ prefix: conn.path === "" ? "" : `${conn.path}/`, maxKeys: 1 });
      } catch (e) {
        throw classifyFailure(e);
      }
    },

    async list(folder) {
      const prefix = `${keyOf(conn.path, folder)}/`;
      const found: RemoteObject[] = [];
      let continuationToken: string | undefined;
      do {
        let page;
        try {
          page = await client.list({ prefix, continuationToken, maxKeys: LIST_PAGE });
        } catch (e) {
          throw classifyFailure(e);
        }
        for (const item of page.contents ?? []) {
          const rest = item.key.slice(prefix.length);
          if (rest === "" || rest.includes("/")) continue;
          found.push({ name: `${folder}/${rest}`, bytes: item.size ?? 0, modifiedAt: item.lastModified ?? null });
        }
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken !== undefined);
      return found;
    },

    stat: statOf,

    async read(name) {
      if ((await statOf(name)) === null) throw new TargetFailure("missing", name);
      return chunksOf(client.file(keyOf(conn.path, name)).stream());
    },

    async write(name, body) {
      const key = keyOf(conn.path, name);
      const writer = client.file(key).writer({ partSize: PART_BYTES, queueSize: QUEUE_SIZE, retry: RETRY });
      try {
        for await (const chunk of body) await writer.write(chunk);
        await writer.end();
      } catch (e) {
        await discard(client, key, writer, e);
        throw classifyFailure(e);
      }
    },

    async close() {},
  };
}

/**
 * Ends a writer that failed. The writer has no abort: ending it completes whatever it has sent, so the object that
 * results is deleted. Nothing reads an object without its record, so the window before the delete is harmless.
 */
async function discard(client: S3Client, key: string, writer: { end(cause?: Error): unknown }, cause: unknown) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  await Promise.resolve()
    .then(() => writer.end(error))
    .catch(() => undefined);
  await client
    .file(key)
    .delete()
    .catch(() => undefined);
}

/** The chunks of a web stream. A read that fails midway is classified, and a consumer that stops early cancels it. */
async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } catch (e) {
    finished = true;
    throw classifyFailure(e);
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
  }
}
