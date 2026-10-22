/**
 * The raw bytes an operation reads or returns: a streamed response, and the request body of an upload. Operations use
 * these types and never the HTTP module, so the route turns them into a request read or a response.
 */

/** A response whose body an operation streams, such as a file or a folder archive. The route sends it unbuffered. */
export interface ByteStream {
  readonly kind: "bytes";
  readonly filename: string;
  readonly contentType: string;
  /** Known for a single file; a generated archive has no length up front. */
  readonly length: number | null;
  readonly body: ReadableStream<Uint8Array>;
}

export function isByteStream(value: unknown): value is ByteStream {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "bytes";
}

/** The request body of a raw upload: the bytes as they arrive, and the length the request declared up front. */
export interface RawBody {
  readonly stream: ReadableStream<Uint8Array> | null;
  readonly length: number;
}
