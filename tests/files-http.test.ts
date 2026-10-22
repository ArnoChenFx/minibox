import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Config } from "../src/config";
import { silenceLogs, TEST_KEY } from "./support/app";
import { call, type Harness, mint, startHarness } from "./support/tokens";

const MB = 1024 * 1024;
const OCTET = "application/octet-stream";

const harnesses: Harness[] = [];
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop();
  restoreLogs();
});

function open(overrides: Partial<Config> = {}): Harness {
  const harness = startHarness(overrides);
  harnesses.push(harness);
  return harness;
}

async function volumeOf(harness: Harness): Promise<string> {
  const made = await call(harness.base, "/api/volumes", { body: { name: "notes", confirm: true } });
  expect(made.status).toBe(201);
  return made.json.volume?.id ?? "";
}

const streamPath = (volume: string, path: string) =>
  `/api/volumes/${volume}/files/stream?path=${encodeURIComponent(path)}`;

function uploadTo(
  harness: Harness,
  volume: string,
  path: string,
  body: NonNullable<RequestInit["body"]>,
  { token = TEST_KEY, contentType = OCTET }: { token?: string; contentType?: string } = {},
): Promise<Response> {
  return fetch(`${harness.base}${streamPath(volume, path)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType },
    body,
  });
}

async function errorKeyOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { key?: string } }).error?.key;
}

/**
 * A PUT written byte by byte, so the framing fetch would correct is left as the test wrote it: here, no Content-Length.
 * Resolves with the status line's code and the whole reply.
 */
function rawPut(
  harness: Harness,
  target: string,
  extraHeaders: string[] = [],
): Promise<{ status: number; text: string }> {
  const port = Number(new URL(harness.base).port);
  const head = [
    `PUT ${target} HTTP/1.1`,
    "Host: 127.0.0.1",
    `Authorization: Bearer ${TEST_KEY}`,
    `Content-Type: ${OCTET}`,
    ...extraHeaders,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    let reply = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => {
          socket.write(head);
        },
        data: (_socket, chunk) => {
          reply += new TextDecoder().decode(chunk);
        },
        close: () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1]), text: reply }),
        error: (_socket, error) => reject(error),
      },
    }).catch(reject);
  });
}

describe("uploading a file over HTTP", () => {
  test("a body that does not declare application/octet-stream is refused with 415, and no helper runs", async () => {
    const harness = open();
    const volume = await volumeOf(harness);
    const before = harness.runtime.callsTo("putArchive").length;
    const res = await uploadTo(harness, volume, "a.txt", "hello", { contentType: "text/plain" });
    expect(res.status).toBe(415);
    expect(await errorKeyOf(res)).toBe("file_upload_type");
    expect(harness.runtime.callsTo("putArchive").length).toBe(before);
  });

  test("a body with no Content-Length is refused with 411, as a chunked body would be", async () => {
    const harness = open();
    const volume = await volumeOf(harness);
    const reply = await rawPut(harness, streamPath(volume, "a.txt"));
    expect(reply.status).toBe(411);
    expect(reply.text).toContain("length_required");
  });

  test("a Content-Length that is not a number is refused with 400", async () => {
    const harness = open();
    const volume = await volumeOf(harness);
    const reply = await rawPut(harness, streamPath(volume, "a.txt"), ["Content-Length: twelve"]);
    expect(reply.status).toBe(400);
  });

  test("a file larger than FILE_UPLOAD_MAX_MB is refused with 413 before any of its bytes are written", async () => {
    const harness = open({ fileUploadMaxMb: 1 });
    const volume = await volumeOf(harness);
    const before = harness.runtime.callsTo("putArchive").length;
    const res = await uploadTo(harness, volume, "big.bin", new Uint8Array(MB + 1));
    expect(res.status).toBe(413);
    expect(await errorKeyOf(res)).toBe("file_upload_too_large");
    expect(harness.runtime.callsTo("putArchive").length).toBe(before);
  });
});

describe("token access to a volume's files", () => {
  test("a token reads the files of a volume granted to it, and is refused a volume it was not granted", async () => {
    const harness = open();
    const volume = await volumeOf(harness);
    expect((await uploadTo(harness, volume, "a.txt", "hello")).status).toBe(200);

    const reader = mint(harness.app, {
      name: "reader",
      scopes: ["files:read"],
      volumes: { type: "list", ids: [volume] },
    });
    const reads = await fetch(`${harness.base}${streamPath(volume, "a.txt")}`, {
      headers: { authorization: `Bearer ${reader.secret}` },
    });
    expect(reads.status).toBe(200);
    expect(await reads.text()).toBe("hello");

    const stranger = mint(harness.app, {
      name: "stranger",
      scopes: ["files:read"],
      volumes: { type: "list", ids: [] },
    });
    const blind = await fetch(`${harness.base}${streamPath(volume, "a.txt")}`, {
      headers: { authorization: `Bearer ${stranger.secret}` },
    });
    expect(blind.status).toBe(403);
    expect(await errorKeyOf(blind)).toBe("volume_not_granted");
  });

  test("an upload needs files:write as well as a grant, and a read-only token is refused", async () => {
    const harness = open();
    const volume = await volumeOf(harness);
    const reader = mint(harness.app, {
      name: "reader",
      scopes: ["files:read"],
      volumes: { type: "list", ids: [volume] },
    });
    const writer = mint(harness.app, {
      name: "writer",
      scopes: ["files:write"],
      volumes: { type: "list", ids: [volume] },
    });

    const refused = await uploadTo(harness, volume, "b.txt", "nope", { token: reader.secret });
    expect(refused.status).toBe(403);

    const stored = await uploadTo(harness, volume, "b.txt", "from writer", { token: writer.secret });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({ volume: "notes", path: "b.txt", bytesWritten: 11, overwritten: false });
  });
});
