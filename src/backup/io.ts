import type { FileHandle } from "node:fs/promises";

const READ_CHUNK = 256 * 1024;

export function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

export async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    offset += bytesWritten;
  }
}

/**
 * The first `size` bytes of an open file. Each piece is a fresh buffer, because the consumer may hold on to it. A file
 * that ends early means it changed under the reader, which fails the archive rather than writing a short entry.
 */
export async function* readBody(handle: FileHandle, size: number): AsyncGenerator<Buffer> {
  let position = 0;
  while (position < size) {
    const want = Math.min(READ_CHUNK, size - position);
    const buffer = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buffer, 0, want, position);
    if (bytesRead === 0) throw new Error("a file shrank while it was being backed up");
    position += bytesRead;
    yield bytesRead === want ? buffer : buffer.subarray(0, bytesRead);
  }
}
