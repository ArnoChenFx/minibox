import { SELF_TOKEN_PATH } from "../../src/services/self-token";
import type { FakeRuntime } from "./fake-runtime";

/** The file a container received as its self token, as the box's agent reads it. */
export interface SelfTokenFile {
  readonly secret: string;
  readonly mode: number;
  readonly uid: number;
}

/** The token file a container was given, as a process in it wrote it. Throws when it was given none. */
export async function selfTokenFileOf(runtime: FakeRuntime, containerId: string): Promise<SelfTokenFile> {
  const file = runtime.containerFile(containerId, SELF_TOKEN_PATH);
  if (!file) throw new Error(`container ${containerId} holds no self token file`);
  return {
    secret: file.data.toString("utf8").trim(),
    mode: file.mode,
    uid: Number(file.user.split(":")[0]),
  };
}

/** Only the secret, for tests that call the API with it. */
export async function selfTokenOf(runtime: FakeRuntime, containerId: string): Promise<string> {
  return (await selfTokenFileOf(runtime, containerId)).secret;
}
