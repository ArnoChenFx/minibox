import type { App, AppDeps } from "../../src/app";
import type { Config } from "../../src/config";
import type { TokenPrincipal } from "../../src/operations/types";
import { startServer } from "../../src/server";
import { compileToken, type TokenCreateInput } from "../../src/tokens/model";
import { createTestApp, TEST_KEY } from "./app";
import type { FakeRuntime } from "./fake-runtime";

export interface Harness {
  readonly app: App;
  readonly runtime: FakeRuntime;
  readonly base: string;
  stop(): void;
}

/** An app with its base template seeded, served on an ephemeral port. `stop` ends every watcher the app opened. */
export function startHarness(
  overrides: Partial<Config> = {},
  deps: Pick<AppDeps, "cliBuild" | "notify"> = {},
): Harness {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest", ...overrides }, undefined, {}, deps);
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  const server = startServer(app);
  return {
    app,
    runtime,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
      app.throttle.stop();
      app.sessions.stop();
      app.tokens.stop();
      app.events.close();
    },
  };
}

export interface Minted {
  readonly id: string;
  readonly secret: string;
}

/** Mints a token. Rate limiting is off unless a test sets it, so a test can make as many calls as it needs. */
export function mint(app: App, input: TokenCreateInput): Minted {
  const created = app.tokens.create(compileToken({ ...input, quotas: { rateLimit: null, ...input.quotas } }), "owner");
  return { id: created.record.id, secret: created.secret };
}

export function principalOf(app: App, secret: string): TokenPrincipal {
  const principal = app.tokens.authenticate(secret, "127.0.0.1");
  if (!principal) throw new Error("the token does not authenticate");
  return principal;
}

export interface Body {
  token?: string;
  record?: { id: string; name: string; scopes: string[]; revokedAt: string | null };
  box?: {
    id: string;
    boxId: string;
    name: string;
    ttlSec: number | null;
    profile: string | null;
    revision: number;
    createdBy: string | null;
  };
  boxes?: { id: string; name: string; createdBy: string | null }[];
  volume?: { id: string; name: string };
  volumes?: { id: string; name: string; createdBy: string | null }[];
  snapshots?: { ref: string; source: string | null; createdBy: string | null }[];
  templates?: { ref: string; name: string | null; createdBy: string | null }[];
  taskId?: string;
  clone?: { taskId?: string };
  tasks?: { id: string }[];
  events?: {
    seq: number;
    op: string;
    principal: { id: string; type?: string; name?: string };
    target?: { kind: string; id?: string; name: string };
  }[];
  checkpoint?: CheckpointBody;
  checkpoints?: CheckpointBody[];
  nextCursor?: number | null;
  result?: {
    snapshot?: { ref?: string };
    checkpoint?: CheckpointBody;
    box?: { boxId: string; name: string };
    replaced?: { id: string; name: string }[];
  };
  deletedBoxes?: string[];
  failedBoxes?: { id: string; name: string; hostId: string; message: string }[];
  tools?: { name: string; description: string; stop?: string | null }[];
  tool?: { id: string; name: string; overridesBuiltin: boolean; stop?: string | null };
  id?: string;
  restoredBuiltin?: boolean;
  isError?: boolean;
  error?: { code: string; key?: string; details?: { field?: string; taskId?: string; preview?: RollbackPreviewBody } };
}

export interface CheckpointBody {
  id: string;
  legacy: boolean;
  label: string;
  reason: string;
  boxId: string | null;
  createdBy: string | null;
  pinned: boolean;
  consistency: string;
  data: { volumeId: string; path: string; ownership: string; snapshotId: string; bytes: number }[];
  system: { image: string; imageId: string } | null;
}

export interface RollbackPreviewBody {
  checkpoint: { id: string; label: string };
  restores: { path: string; role: string | null; volume: string }[];
  revision: { current: number; next: number };
}

export interface CallInit {
  readonly method?: string;
  readonly body?: unknown;
  readonly token?: string;
  readonly headers?: Record<string, string>;
}

export interface Reply {
  readonly status: number;
  readonly json: Body;
  readonly headers: Headers;
}

/** One request with a credential. Without `token` it uses the access key, which is the owner. */
export async function call(base: string, path: string, init: CallInit = {}): Promise<Reply> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${init.token ?? TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : (JSON.parse(text) as Body), headers: res.headers };
}

/** Polls a background task until it leaves `running`, and returns its final view. */
export async function finishedTask(
  base: string,
  taskId: string,
): Promise<{ status: string; result?: Body["result"]; error?: { code: string; key?: string; message: string } }> {
  for (;;) {
    const view = await call(base, `/api/tasks/${taskId}`);
    const json = view.json as unknown as {
      status: string;
      result?: Body["result"];
      error?: { code: string; key?: string; message: string };
    };
    if (json.status !== "running") return json;
    await Bun.sleep(5);
  }
}

/** The status and key of a refused call, so a test asserts the refusal and not only the status code. */
export function refused(reply: Reply): { status: number; key: string | undefined } {
  return { status: reply.status, key: reply.json.error?.key };
}
