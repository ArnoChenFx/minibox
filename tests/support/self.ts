import { firstFileData } from "../../src/services/files-tar";
import { SELF_TOKEN_DIR } from "../../src/services/self-token";
import type { FakeRuntime } from "./fake-runtime";

/** The file a container received as its self token, as the box's agent reads it. */
export interface SelfTokenFile {
  readonly secret: string;
  readonly mode: number;
  readonly uid: number;
}

/** Offsets of the octal mode and uid fields in a ustar header block. */
const MODE_OFFSET = 100;
const UID_OFFSET = 108;
const NUMBER_WIDTH = 8;

const octalField = (bytes: Buffer, offset: number): number =>
  Number.parseInt(bytes.subarray(offset, offset + NUMBER_WIDTH).toString("ascii"), 8);

/** The token file a container was given, read back from the archive the engine received. Throws when it was given none. */
export async function selfTokenFileOf(runtime: FakeRuntime, containerId: string): Promise<SelfTokenFile> {
  const chunks: Buffer[] = [];
  for await (const chunk of await runtime.getArchive(containerId, `${SELF_TOKEN_DIR}/self-token`)) {
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const entry = firstFileData(bytes);
  if (!entry) throw new Error(`container ${containerId} holds no self token file`);
  return {
    secret: entry.data.toString("utf8").trim(),
    mode: octalField(bytes, MODE_OFFSET),
    uid: octalField(bytes, UID_OFFSET),
  };
}

/** Only the secret, for tests that call the API with it. */
export async function selfTokenOf(runtime: FakeRuntime, containerId: string): Promise<string> {
  return (await selfTokenFileOf(runtime, containerId)).secret;
}
