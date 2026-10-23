import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { ActivityLog } from "../src/activity";
import { generateKeyPairPem } from "../src/agent/identity";
import { AGENT_PROTOCOL } from "../src/agent/protocol";
import type { App } from "../src/app";
import type { RawBody } from "../src/lib/body";
import { isByteStream } from "../src/lib/body";
import { AppError } from "../src/lib/errors";
import { setLogLevel } from "../src/lib/logger";
import { defineOperation } from "../src/operations/define";
import { type AuditEvent, Executor, type ExecutorHooks, logAudit, ownerOnly } from "../src/operations/executor";
import { cliCommands, DEFAULT_TOOLSETS, mcpTools } from "../src/operations/projections";
import { OPERATIONS, registryProblems } from "../src/operations/registry";
import type { Operation, OperationContext, Principal } from "../src/operations/types";
import { runOf } from "../src/routes/operations";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import { compileToken } from "../src/tokens/model";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { type S3Double, startS3Double } from "./support/s3-double";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };
const SNAPSHOT_REF = "mbtest-snap:nightly";
const TEMPLATE_REF = "mbtest-template:gold";
const SYNCED_TEMPLATE_REF = "mbtest-template:synced";
const CHECKPOINT_PLACEHOLDER = `ck_${"0".repeat(16)}`;
const PACKAGE_PLACEHOLDER = `pk_${"0".repeat(16)}`;
const BACKUP_PLACEHOLDER = `bk_${"0".repeat(16)}`;
const TARGET_PLACEHOLDER = `tgt_${"0".repeat(16)}`;
const PASSPHRASE = "correct horse battery staple";
const SAMPLE_TARGET_KEY = "AKIATESTONLY0003";
const SAMPLE_TARGET_SECRET = "test-only-secret-key-0003";
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CUSTOM_TOOL = {
  id: "sample-tool",
  name: "Sample tool",
  description: "A sample entry.",
  source: "npm",
  package: "sample-tool",
  bin: "sample-tool",
  install: "npm install -g --prefix {{prefix}} {{package_spec}}",
  upgrade: "npm install -g --prefix {{prefix}} {{package_spec}}",
  uninstall: "npm uninstall -g --prefix {{prefix}} {{package}}",
  detect: "command -v sample-tool >/dev/null && sample-tool --version 2>/dev/null",
};
const CUSTOM_TOOL_FILE = { ...CUSTOM_TOOL, category: "agents", needsRoot: false, estimatedMb: 50 };
const NOTIFY_CHANNEL = {
  id: "alerts",
  type: "webhook" as const,
  name: "Alerts",
  events: ["box.oom"],
  url: "http://127.0.0.1:9/hook",
  secret: "signing-key-1",
};

let sampleTarget: S3Double | undefined;

/** The S3 double the sample targets are reached at. It starts on first use and stops when this file's tests are done. */
function sampleTargetDouble(): S3Double {
  sampleTarget ??= startS3Double({
    accessKeyId: SAMPLE_TARGET_KEY,
    secretAccessKey: SAMPLE_TARGET_SECRET,
    bucket: "backups",
  });
  return sampleTarget;
}

afterAll(() => sampleTarget?.stop());

function sampleTargetFields() {
  const double = sampleTargetDouble();
  return {
    kind: "s3",
    path: "minibox",
    endpoint: double.endpoint,
    region: double.region,
    bucket: double.bucket,
    accessKeyId: SAMPLE_TARGET_KEY,
    secretAccessKey: SAMPLE_TARGET_SECRET,
  };
}

async function storedTargetOf(app: App, ctx: OperationContext): Promise<string> {
  const added = (await app.operations.run("target.add", ctx, { name: "archive", ...sampleTargetFields() })) as {
    target: { id: string };
  };
  return added.target.id;
}

/** One valid input for each operation, given the id of a box that exists; see `withBox`. */
const SAMPLES: Record<string, (boxId: string, app: App) => unknown> = {
  "box.list": () => ({}),
  "box.get": (id) => ({ id }),
  "box.create": () => ({ name: "gamma", cpus: 1, memoryMb: 256 }),
  "box.delete": (id) => ({ id, deleteVolume: false }),
  "box.action": (id) => ({ id, action: "stop" }),
  "box.resources": (id) => ({ id, cpus: 1, expectedRevision: "1" }),
  "box.update": (id) => ({ id, idleTimeoutSec: 120, expectedRevision: "1" }),
  "box.rebuild": (id) => ({ id, profile: "strict", confirm: true, expectedRevision: "1" }),
  "box.move": (id) => ({ id, host: "lab", confirm: true, expectedRevision: "1" }),
  "box.logs": (id) => ({ id, tail: 10 }),
  "box.stats": (id) => ({ id }),
  "box.startup.get": (id) => ({ id }),
  "box.startup.set": (id) => ({ id, command: "echo ready", expectedRevision: "1" }),
  "box.startup.delete": (id) => ({ id, expectedRevision: "1" }),
  "box.startup.run": (id) => ({ id }),
  "exec.run": (id) => ({ id, argv: ["true"] }),
  "exec.get": () => ({ execId: `ex_${"0".repeat(26)}` }),
  "exec.kill": () => ({ execId: `ex_${"0".repeat(26)}` }),
  "exec.output": () => ({ execId: `ex_${"0".repeat(26)}` }),
  "port.list": (id) => ({ id }),
  "port.expose": (id) => ({ id, port: 3000 }),
  "port.unexpose": (id) => ({ id, port: 3000 }),
  "files.read": () => ({ id: "workspace", path: "hello.txt" }),
  "files.write": () => ({ id: "workspace", path: "hello.txt", content: "hi\n" }),
  "files.list": () => ({ id: "workspace", path: "/" }),
  "files.copy": () => ({ id: "workspace", from: "hello.txt", to: "hello2.txt" }),
  "files.download": () => ({ id: "workspace", path: "/" }),
  "files.upload": () => ({
    id: "workspace",
    path: "/",
    content: Buffer.from("not-a-real-tar").toString("base64"),
    encoding: "base64" as const,
  }),
  "files.stream.upload": () => ({ id: "workspace", path: "streamed.txt" }),
  "files.stream.download": () => ({ id: "workspace", path: "hello.txt" }),
  "files.mkdir": () => ({ id: "workspace", path: "made" }),
  "files.move": () => ({ id: "workspace", from: "hello.txt", to: "moved.txt" }),
  "files.delete": () => ({ id: "workspace", path: "hello.txt", confirm: true }),
  "volume.list": () => ({}),
  "volume.get": () => ({ id: "alpha-workspace" }),
  "volume.create": () => ({ name: "extra", confirm: true }),
  "volume.delete": () => ({ id: "spare", confirm: true }),
  "volume.delete.batch": () => ({ ids: ["spare"], confirm: true }),
  "volume.prune": () => ({ dryRun: false }),
  "volume.attach": (id) => ({
    id: "spare",
    box: id,
    path: "/srv/data",
    mode: "ro",
    confirm: true,
    expectedRevision: "1",
  }),
  "volume.detach": (id) => ({
    id: "alpha-workspace",
    box: id,
    path: "/workspace",
    confirm: true,
    expectedRevision: "1",
  }),
  "volume.usage": () => ({ id: "spare" }),
  "volume.limits.set": () => ({ id: "spare", softBytes: 1048576, hardBytes: 2097152, action: "warn" }),
  "pool.list": () => ({}),
  "pool.replace": () => ({ pools: [{ name: "local", backend: "local", default: true }], confirm: true }),
  "tool.catalog": () => ({}),
  "tool.list": () => ({}),
  "tool.install": (id) => ({ id, tool: "claude-code", version: "latest" }),
  "tool.upgrade": (id) => ({ id, tool: "claude-code", version: "latest" }),
  "tool.uninstall": (id) => ({ id, tool: "claude-code" }),
  "tool.reconcile": (id) => ({ id }),
  "tool.custom.list": () => ({}),
  "tool.custom.put": () => ({ ...CUSTOM_TOOL }),
  "tool.custom.delete": (_boxId, app) => {
    mkdirSync(join(app.cfg.dataDir, "tools.d"), { recursive: true });
    writeFileSync(join(app.cfg.dataDir, "tools.d", `${CUSTOM_TOOL.id}.json`), JSON.stringify(CUSTOM_TOOL_FILE));
    return { id: CUSTOM_TOOL.id };
  },
  "secret.list": () => ({}),
  "secret.set": () => ({ name: "vault", value: "s3cret-value" }),
  "secret.delete": () => ({ name: "vault", force: false }),
  "session.list": (id) => ({ id }),
  "session.start": (id) => ({ id, name: "work" }),
  "session.read": (id) => ({ id, name: "work", lines: 10 }),
  "session.send": (id) => ({ id, name: "work", text: "echo hi\n" }),
  "session.close": (id) => ({ id, name: "work" }),
  "snapshot.list": () => ({}),
  "snapshot.create": (id) => ({ id, name: "nightly" }),
  "snapshot.fork": () => ({ name: "delta", ref: SNAPSHOT_REF }),
  "snapshot.delete": () => ({ ref: SNAPSHOT_REF }),
  "checkpoint.list": () => ({}),
  "checkpoint.usage": () => ({}),
  "checkpoint.get": () => ({ id: CHECKPOINT_PLACEHOLDER }),
  "checkpoint.create": (id) => ({ id }),
  "checkpoint.fork": () => ({ id: CHECKPOINT_PLACEHOLDER, name: "delta" }),
  "checkpoint.update": () => ({ id: CHECKPOINT_PLACEHOLDER, pinned: true }),
  "checkpoint.delete": () => ({ id: CHECKPOINT_PLACEHOLDER }),
  "box.rollback": (id) => ({ id, checkpoint: CHECKPOINT_PLACEHOLDER, confirm: true, expectedRevision: "1" }),
  "box.rollback.get": (id) => ({ id }),
  "box.rollback.confirm": (id) => ({ id, confirm: true }),
  "box.rollback.undo": (id) => ({ id, confirm: true, expectedRevision: "2" }),
  "checkpoint.export": () => ({ id: CHECKPOINT_PLACEHOLDER, passphrase: PASSPHRASE }),
  "checkpoint.import": () => ({ id: PACKAGE_PLACEHOLDER, passphrase: PASSPHRASE }),
  "checkpoint.schedule.get": (id) => ({ id }),
  "checkpoint.schedule.set": (id) => ({ id, everyHours: 6 }),
  "checkpoint.schedule.clear": (id) => ({ id }),
  "backup.create": () => ({ passphrase: PASSPHRASE }),
  "backup.list": () => ({}),
  "backup.download": () => ({ id: BACKUP_PLACEHOLDER }),
  "backup.delete": () => ({ id: BACKUP_PLACEHOLDER }),
  "target.list": () => ({}),
  "target.test": () => sampleTargetFields(),
  "target.add": () => ({ name: "archive", ...sampleTargetFields() }),
  "target.check": () => ({ id: TARGET_PLACEHOLDER }),
  "target.objects": () => ({ id: TARGET_PLACEHOLDER }),
  "target.remove": () => ({ id: TARGET_PLACEHOLDER }),
  "target.push": () => ({ id: TARGET_PLACEHOLDER, object: BACKUP_PLACEHOLDER }),
  "target.pull": () => ({ id: TARGET_PLACEHOLDER, object: BACKUP_PLACEHOLDER }),
  "trash.list": () => ({}),
  "trash.restore": () => ({ id: CHECKPOINT_PLACEHOLDER, name: "restored" }),
  "trash.purge": () => ({ id: CHECKPOINT_PLACEHOLDER }),
  "template.list": () => ({}),
  "template.promote": () => ({ ref: SNAPSHOT_REF, name: "silver" }),
  "template.save": (id) => ({ id, name: "silver" }),
  "template.create": () => ({ name: "sample", source: { kind: "dockerfile", text: "FROM alpine:3.20\n" } }),
  "template.rebuild": () => ({ ref: "mbtest-template:sample" }),
  "template.build": () => ({}),
  "template.sync": () => ({ ref: SYNCED_TEMPLATE_REF, host: "local" }),
  "template.delete": () => ({ ref: TEMPLATE_REF }),
  "image.pull": () => ({ ref: "alpine:3.20" }),
  "task.list": () => ({}),
  "task.get": () => ({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
  "task.cancel": () => ({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
  "events.list": () => ({ op: "box.create" }),
  "token.list": () => ({}),
  "token.create": () => ({ name: "ci", preset: "readonly" }),
  "token.revoke": (_boxId, app) => ({
    id: app.tokens.create(compileToken({ name: "gone", preset: "readonly" }), "owner").record.id,
  }),
  "host.list": () => ({}),
  "host.usage": () => ({}),
  "host.add": () => ({ id: "lab", endpoint: "unix:///var/run/lab.sock" }),
  "host.test": () => ({ id: "lab", endpoint: "unix:///var/run/lab.sock" }),
  "host.remove": () => ({ id: "lab" }),
  "host.pairing.create": () => ({ id: "edge" }),
  "host.revoke": () => ({ id: "edge" }),
  "notify.channel.list": () => ({}),
  "notify.channel.set": () => ({ ...NOTIFY_CHANNEL }),
  "notify.channel.delete": () => ({ id: NOTIFY_CHANNEL.id }),
  "notify.channel.test": () => ({ id: NOTIFY_CHANNEL.id }),
  "notify.delivery.list": () => ({}),
  "self.info": () => ({}),
  "self.checkpoint": () => ({ label: "before-edit", reason: "Before a risky edit" }),
  "self.task": () => ({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
  "self.ask": () => ({ message: "Ship the change?", options: ["yes", "no"] }),
  "self.question": () => ({ id: `q_${"0".repeat(26)}` }),
  "self.status": () => ({ state: "working", note: "Running the tests" }),
  "box.self.revoke": (id) => ({ id }),
  "box.questions": (id) => ({ id }),
  "question.answer": () => ({ id: `q_${"0".repeat(26)}`, answer: "yes" }),
};

/** Operations that act on a checkpoint which must already exist, so `preparedInput` takes one first. */
const CHECKPOINT_OPERATIONS_ON_AN_EXISTING = [
  "checkpoint.get",
  "checkpoint.fork",
  "checkpoint.update",
  "checkpoint.delete",
  "checkpoint.export",
  "box.rollback",
];

/** Deletes a box of its own, so its data is kept in the recycle bin, and returns that entry's id. */
async function trashedBoxOf(app: App, ctx: OperationContext): Promise<string> {
  const { box } = (await app.operations.run("box.create", ctx, { name: "doomed", cpus: 1, memoryMb: 256 })) as {
    box: { id: string };
  };
  await app.operations.run("box.delete", ctx, { id: box.id, deleteVolume: true });
  const { trash } = (await app.operations.run("trash.list", ctx, {})) as {
    trash: { id: string; sourceName: string }[];
  };
  const entry = trash.find((item) => item.sourceName === "doomed");
  if (!entry) throw new Error("the sample box was not kept in the recycle bin");
  return entry.id;
}

/** Operations that act on a rollback waiting for its confirm or undo, so `preparedInput` rolls a box back first. */
const ROLLBACK_OPERATIONS_ON_A_PENDING = ["box.rollback.get", "box.rollback.confirm", "box.rollback.undo"];

/** Takes a checkpoint of the sample box and returns its id. The list is newest first. */
async function takeCheckpointOf(app: App, ctx: OperationContext, boxId: string): Promise<string> {
  await app.operations.run("checkpoint.create", ctx, { id: boxId });
  await app.tasks.drain();
  const { checkpoints } = (await app.operations.run("checkpoint.list", ctx, {})) as { checkpoints: { id: string }[] };
  const [newest] = checkpoints;
  if (!newest) throw new Error("the sample checkpoint was not listed");
  return newest.id;
}

/** Makes a backup of the sample app's data directory and returns its id. */
async function backupOf(app: App, ctx: OperationContext): Promise<string> {
  await app.operations.run("backup.create", ctx, { passphrase: PASSPHRASE });
  await app.tasks.drain();
  const { backups } = (await app.operations.run("backup.list", ctx, {})) as { backups: { id: string }[] };
  const [newest] = backups;
  if (!newest) throw new Error("the sample backup was not listed");
  return newest.id;
}

/**
 * Exports a checkpoint of the sample box, then deletes it, so the package is the only copy left. Returns the package id,
 * which `checkpoint.import` restores.
 */
async function packageOfCheckpoint(app: App, ctx: OperationContext, boxId: string): Promise<string> {
  const checkpoint = await takeCheckpointOf(app, ctx, boxId);
  const started = (await app.operations.run("checkpoint.export", ctx, { id: checkpoint, passphrase: PASSPHRASE })) as {
    taskId: string;
  };
  await app.tasks.drain();
  const finished = app.tasks.get(started.taskId, { output: false });
  const packaged = (finished?.result as { package?: { id: string } } | undefined)?.package?.id;
  if (!packaged) throw new Error("the export returned no package");
  await app.operations.run("checkpoint.delete", ctx, { id: checkpoint });
  await app.tasks.drain();
  return packaged;
}

/**
 * Rolls the sample box back to a new checkpoint, which leaves a rollback waiting. A rebuild replaces the container, so the
 * stable box id is used from here on. Returns that id and the box's revision after the rollback.
 */
async function pendingRollbackOf(
  app: App,
  ctx: OperationContext,
  boxId: string,
): Promise<{ id: string; revision: string }> {
  const { box: before } = (await app.operations.run("box.get", ctx, { id: boxId })) as { box: { boxId: string } };
  const checkpoint = await takeCheckpointOf(app, ctx, before.boxId);
  await app.operations.run("box.rollback", ctx, { id: before.boxId, checkpoint, confirm: true, expectedRevision: "1" });
  await app.tasks.drain();
  const { box } = (await app.operations.run("box.get", ctx, { id: before.boxId })) as { box: { revision: number } };
  return { id: before.boxId, revision: String(box.revision) };
}

/** Pairs an agent host called `id`, so an operation that acts on an agent host has one to act on. */
async function pairAgentHost(app: App, id: string): Promise<void> {
  const issued = await app.hostAdmin.createPairing({ id });
  await app.hostAdmin.pairAgent({
    code: issued.code,
    publicKey: generateKeyPairPem().publicKeyPem,
    version: "0.4.0",
    protocol: AGENT_PROTOCOL,
  });
}

function rawBodyOf(bytes: Buffer): RawBody {
  return { stream: new Response(bytes).body, length: bytes.length };
}

/** A real id for operations that cannot succeed against the placeholder in `SAMPLES`. */
interface Prepared {
  input: unknown;
  release?: () => void;
  body?: RawBody;
  /** Set when the operation acts as a box's own agent, which the owner may not be. */
  principal?: Principal;
}

/** The context an operation runs under: the caller's, with the principal and body a prepared input needs. */
function runContext(ctx: OperationContext, prepared: Prepared): OperationContext {
  return {
    ...ctx,
    ...(prepared.principal ? { principal: prepared.principal } : {}),
    ...(prepared.body ? { body: prepared.body } : {}),
  };
}

/** The box's own agent: the principal a self token authenticates, whose id is the box's stable id. */
async function agentOf(app: App, ctx: OperationContext, boxId: string): Promise<OperationContext> {
  const { box } = (await app.operations.run("box.get", ctx, { id: boxId })) as { box: { boxId: string; name: string } };
  return { ...ctx, principal: { type: "box-self", id: box.boxId, name: box.name } };
}

async function preparedInput(
  app: App,
  ctx: OperationContext,
  runtime: FakeRuntime,
  operation: Operation,
  boxId: string,
): Promise<Prepared> {
  if (operation.name === "self.task") {
    const agent = await agentOf(app, ctx, boxId);
    const started = (await app.operations.run("self.checkpoint", agent, SAMPLES["self.checkpoint"]?.(boxId, app))) as {
      taskId: string;
    };
    await app.tasks.drain();
    return { input: { id: started.taskId }, principal: agent.principal };
  }
  if (operation.name === "self.question" || operation.name === "question.answer") {
    const agent = await agentOf(app, ctx, boxId);
    const asked = (await app.operations.run("self.ask", agent, SAMPLES["self.ask"]?.(boxId, app))) as {
      question: { id: string };
    };
    if (operation.name === "question.answer") return { input: { id: asked.question.id, answer: "yes" } };
    return { input: { id: asked.question.id }, principal: agent.principal };
  }
  if (operation.name.startsWith("self.")) {
    const agent = await agentOf(app, ctx, boxId);
    return { input: SAMPLES[operation.name]?.(boxId, app), principal: agent.principal };
  }
  if (operation.name === "template.rebuild") {
    await app.operations.run("template.create", ctx, SAMPLES["template.create"]?.(boxId, app));
    await app.tasks.drain();
  }
  if (operation.name === "template.sync") {
    await app.operations.run("host.add", ctx, { id: "lab", endpoint: "unix:///var/run/lab.sock" });
    (app.hosts.get("lab").runtime as FakeRuntime).seedImage(SYNCED_TEMPLATE_REF, {
      [app.hosts.get().keys.template]: "true",
    });
    return { input: { ref: SYNCED_TEMPLATE_REF, host: "local" } };
  }
  if (operation.name === "task.get") {
    const started = (await app.operations.run("template.build", ctx, {})) as { taskId: string };
    await app.tasks.drain();
    return { input: { id: started.taskId } };
  }
  if (operation.name === "task.cancel") {
    const held = runtime.hold("buildImage");
    const started = (await app.operations.run("template.build", ctx, {})) as { taskId: string };
    return { input: { id: started.taskId }, release: held.release };
  }
  if (operation.name === "exec.get" || operation.name === "exec.output") {
    const started = (await app.operations.run("exec.run", ctx, { id: boxId, argv: ["true"] })) as { execId: string };
    return { input: { execId: started.execId } };
  }
  if (["session.read", "session.send", "session.close"].includes(operation.name)) {
    await app.operations.run("session.start", ctx, { id: boxId, name: "work" });
  }
  if (operation.name === "box.startup.run") {
    await app.operations.run("box.startup.set", ctx, { id: boxId, command: "echo ready", expectedRevision: "1" });
  }
  if (operation.name === "secret.delete") {
    await app.operations.run("secret.set", ctx, { name: "vault", value: "s3cret-value" });
  }
  if (operation.name === "notify.channel.test" || operation.name === "notify.channel.delete") {
    await app.operations.run("notify.channel.set", ctx, { ...NOTIFY_CHANNEL });
  }
  if (operation.name === "checkpoint.import") {
    const id = await packageOfCheckpoint(app, ctx, boxId);
    return { input: { id, passphrase: PASSPHRASE } };
  }
  if (operation.name === "backup.download" || operation.name === "backup.delete") {
    return { input: { id: await backupOf(app, ctx) } };
  }
  if (["target.check", "target.objects", "target.remove"].includes(operation.name)) {
    return { input: { id: await storedTargetOf(app, ctx) } };
  }
  if (operation.name === "target.push") {
    return { input: { id: await storedTargetOf(app, ctx), object: await backupOf(app, ctx) } };
  }
  if (operation.name === "target.pull") {
    const id = await storedTargetOf(app, ctx);
    const object = await backupOf(app, ctx);
    await app.operations.run("target.push", ctx, { id, object });
    await app.tasks.drain();
    await app.operations.run("backup.delete", ctx, { id: object });
    return { input: { id, object } };
  }
  if (operation.name === "trash.restore" || operation.name === "trash.purge") {
    const id = await trashedBoxOf(app, ctx);
    return { input: operation.name === "trash.purge" ? { id } : { id, name: "restored" } };
  }
  if (CHECKPOINT_OPERATIONS_ON_AN_EXISTING.includes(operation.name)) {
    const checkpoint = await takeCheckpointOf(app, ctx, boxId);
    const sample = SAMPLES[operation.name]?.(boxId, app) as Record<string, unknown>;
    return { input: { ...sample, ...(operation.name === "box.rollback" ? { checkpoint } : { id: checkpoint }) } };
  }
  if (ROLLBACK_OPERATIONS_ON_A_PENDING.includes(operation.name)) {
    const pending = await pendingRollbackOf(app, ctx, boxId);
    const sample = SAMPLES[operation.name]?.(pending.id, app) as Record<string, unknown>;
    return {
      input: operation.name === "box.rollback.undo" ? { ...sample, expectedRevision: pending.revision } : sample,
    };
  }
  if (operation.name === "exec.kill") {
    runtime.execScript = null;
    const started = (await app.operations.run("exec.run", ctx, {
      id: boxId,
      argv: ["sleep", "30"],
      background: true,
      timeoutSec: 30,
    })) as { execId: string };
    return { input: { execId: started.execId } };
  }
  if (operation.name === "port.unexpose") {
    await app.operations.run("port.expose", ctx, { id: boxId, port: 3000 });
  }
  if (operation.name.startsWith("files.")) {
    const box = (await app.operations.run("box.get", ctx, { id: boxId })) as {
      box: { mounts: { path: string; volumeId: string | null; volume: string }[] };
    };
    const workspace = box.box.mounts.find((mount) => mount.path === "/workspace");
    const volumeId = workspace?.volumeId ?? workspace?.volume;
    if (!volumeId) throw new Error("the sample box has no workspace volume");
    if (operation.name !== "files.write" && operation.name !== "files.upload") {
      await app.operations.run("files.write", ctx, { id: volumeId, path: "hello.txt", content: "hi\n" });
    }
    const sample = SAMPLES[operation.name];
    if (sample === undefined) throw new Error(`no sample input for ${operation.name}`);
    const input = sample(boxId, app) as Record<string, unknown>;
    const body = operation.name === "files.stream.upload" ? rawBodyOf(Buffer.from("streamed\n")) : undefined;
    return { input: { ...input, id: volumeId }, body };
  }
  if (operation.name === "host.remove" || operation.name === "box.move") {
    await app.operations.run("host.add", ctx, { id: "lab", endpoint: "unix:///var/run/lab.sock" });
  }
  if (operation.name === "host.revoke") {
    await pairAgentHost(app, "edge");
  }
  const sample = SAMPLES[operation.name];
  if (sample === undefined) throw new Error(`no sample input for ${operation.name}`);
  return { input: sample(boxId, app) };
}

function opNamed(name: string): Operation {
  const operation = OPERATIONS.find((op) => op.name === name);
  if (!operation) throw new Error(`no operation ${name}`);
  return operation;
}

/** One `test.each` row per registered operation, so each row builds its own app and a slow row fails by itself. */
function registeredNames(): [string][] {
  return OPERATIONS.map((operation) => [operation.name]);
}

const appsMade: App[] = [];
afterEach(() => {
  for (const app of appsMade.splice(0)) for (const host of app.hosts.list()) host.sampler.stop();
});

function appWith(hooks: Partial<ExecutorHooks> = {}) {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" }, undefined, hooks);
  appsMade.push(app);
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  runtime.seedImage(SNAPSHOT_REF, { [keys.snapshot]: "true" });
  runtime.seedImage(TEMPLATE_REF, { [keys.template]: "true", [keys.templateName]: "gold" });
  const ctx: OperationContext = {
    host: app.hosts.get(),
    principal: OWNER,
    source: "rest",
    events: app.events,
    tokens: app.tokens,
    execs: app.execs,
    terminals: app.terminals,
  };
  return { app, runtime, ctx };
}

async function withBox(app: App, ctx: OperationContext): Promise<string> {
  const { box } = (await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 })) as {
    box: { id: string };
  };
  await app.operations.run("volume.create", ctx, { name: "spare", confirm: true });
  return box.id;
}

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "01TESTTESTTESTTESTTESTTEST",
    ts: 1,
    durationMs: 0,
    status: "ok",
    op: "box.list",
    kind: "read",
    principal: OWNER,
    source: "rest",
    hostId: "local",
    summary: "List boxes",
    ...overrides,
  };
}

function serve(app: App) {
  const server = startServer(app);
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
      app.throttle.stop();
    },
  };
}

const auth = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${TEST_KEY}`, ...extra });

const requestWithRun = (value?: string) =>
  new Request("http://x/", value === undefined ? {} : { headers: { "x-minibox-run": value } });

function definition(overrides: Partial<Parameters<typeof defineOperation>[0]>) {
  return defineOperation({
    name: "thing.get",
    tag: "things",
    summary: "Get a thing",
    kind: "read",
    scope: "thing:read",
    async: false,
    input: z.object({ id: z.string() }),
    output: z.object({}),
    rest: [{ method: "GET", path: "/api/things/:id" }],
    run: async () => ({}),
    ...overrides,
  });
}

describe("registry definitions", () => {
  test("the registry is well formed", () => {
    expect(registryProblems(OPERATIONS)).toEqual([]);
  });

  test("the samples name every registry operation, in registry order", () => {
    expect(OPERATIONS.map((op) => op.name)).toEqual(Object.keys(SAMPLES));
  });

  test("the checker reports duplicate names, routes and operation ids", () => {
    const problems = registryProblems([definition({}), definition({ summary: "Again" })]).join("\n");
    expect(problems).toContain("duplicate operation: thing.get");
    expect(problems).toContain("duplicate REST route: GET /api/things/:id");
    expect(problems).toContain("duplicate operationId: thing.get");
  });

  test("the checker reports path parameters and query keys that are not inputs", () => {
    const orphan = definition({
      kind: "read",
      rest: [{ method: "GET", path: "/api/things/:thingId", query: ["verbose"] }],
    });
    const problems = registryProblems([orphan]).join("\n");
    expect(problems).toContain("path parameter :thingId that is not an input");
    expect(problems).toContain("binds verbose, which is not an input");
  });

  test("the checker reports writes without activity, and reads bound to a write method", () => {
    const quiet = definition({
      name: "thing.wipe",
      kind: "destructive",
      scope: "thing:delete",
      rest: [{ method: "DELETE", path: "/api/things/:id" }],
    });
    const mislabelled = definition({
      name: "thing.peek",
      rest: [{ method: "POST", path: "/api/things/:id", body: true }],
    });
    const problems = registryProblems([quiet, mislabelled]).join("\n");
    expect(problems).toContain("thing.wipe changes state but declares no activity");
    expect(problems).toContain("thing.peek is read but binds POST");
  });

  test("async operations answer 202, and a 202 binding is async", () => {
    const late = definition({
      name: "thing.build",
      kind: "write",
      async: true,
      activity: { action: () => "thing.build", target: () => "thing" },
      rest: [{ method: "POST", path: "/api/things/:id", body: true }],
    });
    const early = definition({
      name: "thing.peek",
      rest: [{ method: "GET", path: "/api/things/:id", status: 202 }],
    });
    const problems = registryProblems([late, early]).join("\n");
    expect(problems).toContain("thing.build is async but does not return 202");
    expect(problems).toContain("thing.peek returns 202 but is not async");
  });
});

describe("executor", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("the default authorize hook admits the owner and refuses anyone else", () => {
    const operation = opNamed("box.list");
    expect(ownerOnly({ principal: OWNER, operation })).toBe(true);
    expect(ownerOnly({ principal: { type: "owner", id: "other", name: "other" }, operation })).toBe(true);
  });

  test("operation names must be unique", () => {
    const box = opNamed("box.list");
    const hooks = { authorize: ownerOnly, audit: () => {} };
    expect(() => new Executor([box, box], { activity: new ActivityLog(), hooks })).toThrow(
      "operation names must be unique",
    );
  });

  test("an unknown operation name is a programming error, not a client error", async () => {
    const { app, ctx } = appWith();
    const error = await rejectionOf(app.operations.run("box.nope", ctx, {}));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
  });

  test("a refused execution is audited as denied and never reaches the engine", async () => {
    const events: AuditEvent[] = [];
    const { app, runtime, ctx } = appWith({ authorize: () => false, audit: (event) => events.push(event) });
    const error = await rejectionOf(app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 }));
    expect(error).toMatchObject({
      status: 403,
      code: "forbidden",
      key: "operation_forbidden",
      params: { op: "box.create" },
    });
    expect(events).toEqual([
      expect.objectContaining({
        op: "box.create",
        kind: "write",
        status: "denied",
        error: { code: "forbidden", status: 403 },
      }),
    ]);
    expect(runtime.calls).toEqual([]);
    expect(app.activity.list()).toEqual([]);
  });

  test("a refused request over HTTP gets a 403 that names the operation", async () => {
    const events: AuditEvent[] = [];
    const { app, runtime } = appWith({ authorize: () => false, audit: (event) => events.push(event) });
    const server = serve(app);
    try {
      const res = await fetch(`${server.base}/api/boxes`, { headers: auth() });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: {
          code: "forbidden",
          message: "This credential may not run box.list.",
          key: "operation_forbidden",
          params: { op: "box.list" },
          retryable: false,
        },
      });
      expect(events.map((e) => [e.op, e.status])).toEqual([["box.list", "denied"]]);
      expect(runtime.calls).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("validation failures are audited as failed and leave no activity entry", async () => {
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    await rejectionOf(app.operations.run("box.create", ctx, { name: "bad name!" }));
    expect(events).toEqual([
      expect.objectContaining({
        op: "box.create",
        kind: "write",
        status: "error",
        error: { code: "validation_failed", status: 400 },
      }),
    ]);
    expect(app.activity.list()).toEqual([]);
  });

  test.each(registeredNames())("every registered operation records its outcome when it succeeds: %s", async (name) => {
    const operation = opNamed(name);
    const events: AuditEvent[] = [];
    const { app, ctx, runtime } = appWith({ audit: (event) => events.push(event) });
    const boxId = await withBox(app, ctx);
    const prepared = await preparedInput(app, ctx, runtime, operation, boxId);
    events.length = 0;
    try {
      const result = await app.operations.run(operation.name, runContext(ctx, prepared), prepared.input);
      if (isByteStream(result)) await result.body.cancel();
      prepared.release?.();
      await app.tasks.drain();
      const mine = events.filter((event) => event.op === operation.name);
      expect(mine.map((event) => [event.op, event.kind, event.status])).toEqual(
        operation.async
          ? [
              [operation.name, operation.kind, "started"],
              [operation.name, operation.kind, "ok"],
            ]
          : [[operation.name, operation.kind, "ok"]],
      );
    } finally {
      prepared.release?.();
      await app.tasks.drain();
    }
  });

  test.each(registeredNames())("every registered operation calls the audit sink when it fails: %s", async (name) => {
    const operation = opNamed(name);
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    await app.operations.run(operation.name, ctx, {}).catch(() => undefined);
    await app.tasks.drain();
    expect(events.map((event) => event.op)).toEqual(
      operation.name === "template.build" ? ["template.build", "template.build"] : [operation.name],
    );
    if (operation.name === "template.build") expect(events.map((event) => event.status)).toEqual(["started", "ok"]);
  });

  test("an execution's event names the caller, the source, the host and the summary of the target", async () => {
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    const traced: OperationContext = { ...ctx, run: "run-7", parentId: "01PARENT0000000000000000AA" };
    await app.operations.run("box.create", traced, { name: "alpha", cpus: 1, memoryMb: 256 });
    const [event] = events;
    expect(event).toMatchObject({
      op: "box.create",
      kind: "write",
      status: "ok",
      principal: OWNER,
      source: "rest",
      hostId: "local",
      summary: "Create and start a box: alpha",
      target: { kind: "box", name: "alpha" },
      detail: { name: "alpha", cpus: 1, memoryMb: 256 },
      run: "run-7",
      parentId: "01PARENT0000000000000000AA",
    });
    expect(event?.id).toMatch(ULID);
    expect(event?.target?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event?.error).toBeUndefined();
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
    expect(event?.ts).toBeGreaterThan(0);
  });

  test("a box action names the box it resolved, and a refused lookup names no object", async () => {
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    const id = await withBox(app, ctx);
    await app.operations.run("box.action", ctx, { id, action: "stop" });
    await rejectionOf(app.operations.run("box.get", ctx, { id: "missing" }));
    const [action, lookup] = events.slice(-2);
    expect(action).toMatchObject({ op: "box.action", target: { kind: "box", id, name: "alpha" } });
    expect(lookup).toMatchObject({ op: "box.get", status: "error", summary: "Get one box" });
    expect(lookup?.target).toBeUndefined();
    expect(lookup?.detail).toEqual({ id: "missing" });
  });

  test("event ids sort in the order the executions ran", async () => {
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    for (let i = 0; i < 5; i++) await app.operations.run("box.list", ctx, {});
    const ids = events.map((event) => event.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual(ids.toSorted());
  });

  test("only operations that change state reach the activity feed, with the outcome of the handler", async () => {
    const { app, ctx } = appWith();
    await app.operations.run("box.list", ctx, {});
    await app.operations.run("box.get", ctx, { id: "missing" }).catch(() => undefined);
    expect(app.activity.list()).toEqual([]);

    await withBox(app, ctx);
    expect(app.activity.list()).toEqual([
      expect.objectContaining({ action: "volume.create", target: "spare", ok: true }),
      expect.objectContaining({ action: "box.create", target: "alpha", ok: true }),
    ]);

    const duplicate = await rejectionOf(
      app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 }),
    );
    expect(duplicate).toMatchObject({ status: 409, key: "box_exists" });
    expect(app.activity.list()[0]).toMatchObject({
      action: "box.create",
      target: "alpha",
      ok: false,
      message: "A box named “alpha” already exists.",
    });
  });

  test("a box action is recorded as the action it performed, on the box's name", async () => {
    const { app, ctx } = appWith();
    const id = await withBox(app, ctx);
    await app.operations.run("box.action", ctx, { id, action: "stop" });
    expect(app.activity.list()[0]).toMatchObject({ action: "box.stop", target: "alpha", ok: true });
  });

  test("box.delete returns the reason a volume could not be removed, and the box is gone", async () => {
    const { app, runtime, ctx } = appWith();
    const id = await withBox(app, ctx);
    runtime.fail("removeVolume", new RuntimeError("engine", "device busy", "device busy"));

    expect(await app.operations.run("box.delete", ctx, { id, deleteVolume: true })).toEqual({
      name: "alpha",
      volumeDeleted: false,
      volumeError: "device busy",
      trash: { id: expect.any(String), expiresAt: expect.any(String) },
    });
    expect(runtime.containers.size).toBe(0);
  });
});

describe("snapshot and template operations", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("a template name is checked with the template label and reported on the name field", async () => {
    const { app, ctx } = appWith();
    const error = await rejectionOf(
      app.operations.run("template.promote", ctx, { ref: SNAPSHOT_REF, name: "bad name!" }),
    );
    expect(error).toMatchObject({
      status: 400,
      key: "name_invalid",
      params: { label: "templateName" },
      details: { field: "name" },
    });
  });

  test("a missing snapshot or template is a 404 with its own key", async () => {
    const { app, ctx } = appWith();
    const snapshot = await rejectionOf(app.operations.run("snapshot.delete", ctx, { ref: "missing:1" }));
    const template = await rejectionOf(app.operations.run("template.delete", ctx, { ref: "missing:1" }));
    expect(snapshot).toMatchObject({ status: 404, key: "snapshot_not_found" });
    expect(template).toMatchObject({ status: 404, key: "template_not_found" });
  });

  test("deleting an image names it as the target in the audit event and the activity feed", async () => {
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    await app.operations.run("template.delete", ctx, { ref: TEMPLATE_REF });
    expect(events[0]).toMatchObject({
      op: "template.delete",
      kind: "destructive",
      status: "ok",
      summary: `Delete a template: ${TEMPLATE_REF}`,
      target: { kind: "template", name: TEMPLATE_REF },
    });
    expect(app.activity.list()[0]).toMatchObject({ action: "template.delete", target: TEMPLATE_REF, ok: true });
  });
});

describe("event log", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test.each(registeredNames())(
    "every registered operation leaves its outcome in the event log when it succeeds: %s",
    async (name) => {
      const operation = opNamed(name);
      const { app, ctx, runtime } = appWith();
      const boxId = await withBox(app, ctx);
      const prepared = await preparedInput(app, ctx, runtime, operation, boxId);
      const before = app.events.head();
      try {
        const result = await app.operations.run(operation.name, runContext(ctx, prepared), prepared.input);
        if (isByteStream(result)) await result.body.cancel();
        prepared.release?.();
        await app.tasks.drain();
        const rows = app.events.after(before, {}, 20).filter((event) => event.op === operation.name);
        expect(rows.map((event) => [event.op, event.status])).toEqual(
          operation.async
            ? [
                [operation.name, "started"],
                [operation.name, "ok"],
              ]
            : [[operation.name, "ok"]],
        );
        if (operation.async) expect(rows[0]?.ref?.taskId).toBe(rows[1]?.ref?.taskId);
      } finally {
        prepared.release?.();
        await app.tasks.drain();
      }
    },
  );

  test.each(registeredNames())(
    "every registered operation leaves one stored event when it is refused: %s",
    async (name) => {
      const operation = opNamed(name);
      const { app, ctx } = appWith({ authorize: () => false });
      await app.operations.run(operation.name, ctx, {}).catch(() => undefined);
      expect(app.events.after(0, {}, 10).map((event) => [event.op, event.status])).toEqual([
        [operation.name, "denied"],
      ]);
    },
  );

  test.each(registeredNames())(
    "every registered operation leaves one stored event whatever its input: %s",
    async (name) => {
      const operation = opNamed(name);
      const { app, ctx } = appWith();
      await app.operations.run(operation.name, ctx, {}).catch(() => undefined);
      await app.tasks.drain();
      expect(app.events.after(0, {}, 10).map((event) => event.op)).toEqual(
        operation.name === "template.build" ? ["template.build", "template.build"] : [operation.name],
      );
    },
  );

  test("a send records the counts it delivered, and a send that fails records none", async () => {
    const { app, ctx } = appWith();
    const boxId = await withBox(app, ctx);
    await app.operations.run("session.start", ctx, { id: boxId, name: "work" });
    const before = app.events.head();

    await app.operations.run("session.send", ctx, { id: boxId, name: "work", text: "echo hi\n" });
    expect(
      await rejectionOf(app.operations.run("session.send", ctx, { id: boxId, name: "missing", text: "echo hi\n" })),
    ).toMatchObject({ status: 404 });

    const sends = app.events.after(before, {}, 10).filter((event) => event.op === "session.send");
    expect(sends.map((event) => [event.status, event.detail])).toEqual([
      ["ok", { session: "work", keys: 0, bytes: 8 }],
      ["error", { session: "missing", keys: 0, bytes: 0 }],
    ]);
  });
});

describe("audit sink", () => {
  beforeEach(() => setLogLevel("debug"));
  afterEach(() => setLogLevel("info"));

  test("the default sink writes a structured info line for a write and a debug line for a read", () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      logAudit(auditEvent({ op: "box.create", kind: "write", run: "run-1", summary: "Create and start a box" }));
      logAudit(auditEvent({ op: "box.list", kind: "read" }));
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ level: "info", msg: "operation.ok", operation: "box.create", run: "run-1" }),
      expect.objectContaining({ level: "debug", msg: "operation.ok", operation: "box.list" }),
    ]);
  });

  test("a refusal logs at warn and a server-side failure at error, without the detail", () => {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      logAudit(auditEvent({ status: "denied", error: { code: "forbidden", status: 403 } }));
      logAudit(auditEvent({ status: "error", error: { code: "internal", status: 500 }, detail: { secret: "x" } }));
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ level: "warn", msg: "operation.denied", code: "forbidden", httpStatus: 403 }),
      expect.objectContaining({ level: "error", msg: "operation.failed", code: "internal", httpStatus: 500 }),
    ]);
    expect(lines.join("\n")).not.toContain("secret");
  });
});

describe("REST run grouping", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("X-Minibox-Run is recorded on the audit events of the request", async () => {
    const events: AuditEvent[] = [];
    const { app } = appWith({ audit: (event) => events.push(event) });
    const server = serve(app);
    try {
      await fetch(`${server.base}/api/boxes`, { headers: auth({ "x-minibox-run": "run-42" }) });
      await fetch(`${server.base}/api/boxes`, { headers: auth() });
    } finally {
      server.stop();
    }
    expect(events.map((e) => e.run)).toEqual(["run-42", undefined]);
  });

  test("a malformed X-Minibox-Run is refused before the operation runs", async () => {
    const events: AuditEvent[] = [];
    const { app, runtime } = appWith({ audit: (event) => events.push(event) });
    const server = serve(app);
    try {
      const res = await fetch(`${server.base}/api/boxes`, { headers: auth({ "x-minibox-run": "bad value!" }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "validation_failed", key: "run_invalid", details: { field: "X-Minibox-Run" } },
      });
    } finally {
      server.stop();
    }
    expect(events).toEqual([]);
    expect(runtime.calls).toEqual([]);
  });

  test("runOf accepts 1 to 64 characters of the allowed set and nothing else", () => {
    expect(runOf(requestWithRun())).toBeUndefined();
    expect(runOf(requestWithRun("run-1.a_b:c"))).toBe("run-1.a_b:c");
    expect(runOf(requestWithRun("a".repeat(64)))).toBe("a".repeat(64));
    for (const bad of ["", "-run", ".run", "has space", "a".repeat(65), "slash/run"]) {
      expect(() => runOf(requestWithRun(bad))).toThrow(AppError);
    }
  });
});

describe("projections", () => {
  test("MCP tools default to the core and meta toolsets", () => {
    expect(DEFAULT_TOOLSETS).toEqual(["core", "meta"]);
    expect(mcpTools(OPERATIONS).map((tool) => tool.name)).toEqual([
      "list_boxes",
      "get_box",
      "create_box",
      "delete_box",
      "box_action",
      "update_box",
      "get_startup_command",
      "set_startup_command",
      "delete_startup_command",
      "run_startup_command",
      "exec",
      "exec_get",
      "exec_kill",
      "read_file",
      "write_file",
      "list_files",
      "copy_files",
      "upload_files",
      "list_hosts",
      "get_host_usage",
      "add_host",
      "test_host",
      "remove_host",
      "list_notify_channels",
      "set_notify_channel",
      "delete_notify_channel",
      "test_notify_channel",
      "list_notify_deliveries",
    ]);
    expect(
      mcpTools(OPERATIONS, ["storage"])
        .map((tool) => tool.name)
        .toSorted(),
    ).toEqual([
      "add_target",
      "attach_volume",
      "check_target",
      "clear_checkpoint_schedule",
      "create_backup",
      "create_volume",
      "delete_backup",
      "delete_volume",
      "delete_volumes",
      "detach_volume",
      "export_checkpoint",
      "get_checkpoint_schedule",
      "get_volume",
      "import_checkpoint",
      "list_backups",
      "list_pools",
      "list_target_objects",
      "list_targets",
      "list_trash",
      "list_volumes",
      "measure_volume",
      "prune_volumes",
      "pull_from_target",
      "purge_trash",
      "push_to_target",
      "remove_target",
      "replace_pools",
      "restore_trash",
      "set_checkpoint_schedule",
      "set_volume_limits",
      "test_target",
    ]);
    expect(
      mcpTools(OPERATIONS, ["tools"])
        .map((tool) => tool.name)
        .toSorted(),
    ).toEqual([
      "create_template",
      "delete_custom_tool",
      "install_tool",
      "list_custom_tools",
      "list_templates",
      "list_tools",
      "pull_image",
      "put_custom_tool",
      "rebuild_template",
      "reconcile_tools",
      "save_template",
      "sync_template",
      "uninstall_tool",
      "upgrade_tool",
    ]);
  });

  test("rebuild_box is outside the default toolsets and only in the rebuild toolset", () => {
    expect(mcpTools(OPERATIONS, ["rebuild"]).map((tool) => tool.name)).toEqual(["rebuild_box"]);
    expect(mcpTools(OPERATIONS, ["rebuild"])[0]?.toolset).toBe("rebuild");
  });

  test("move_box is outside the default toolsets and only in the move toolset", () => {
    expect(mcpTools(OPERATIONS).map((tool) => tool.name)).not.toContain("move_box");
    expect(mcpTools(OPERATIONS, ["move"]).map((tool) => tool.name)).toEqual(["move_box"]);
    expect(mcpTools(OPERATIONS, ["move"])[0]?.toolset).toBe("move");
  });

  test("each tool carries the operation's input and output schemas and its read or destructive hint", () => {
    const tools = new Map(
      [...mcpTools(OPERATIONS), ...mcpTools(OPERATIONS, ["rebuild"])].map((tool) => [tool.name, tool]),
    );
    const create = tools.get("create_box");
    expect(create?.inputSchema).toMatchObject({ type: "object", required: ["name"] });
    expect(Object.keys((create?.inputSchema.properties ?? {}) as object)).toEqual([
      "name",
      "template",
      "cpus",
      "memoryMb",
      "profile",
      "egress",
      "mounts",
      "env",
      "idleTimeoutSec",
      "ttlSec",
      "host",
      "tools",
      "startupCommand",
      "selfToken",
      "repo",
    ]);
    expect(create?.outputSchema).toMatchObject({ type: "object", required: ["box"] });
    expect(create?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(tools.get("get_box")?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(tools.get("delete_box")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tools.get("rebuild_box")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  test("CLI commands come from the registry, with the operation kind", () => {
    const commands = cliCommands(OPERATIONS);
    expect(commands).toContainEqual(
      expect.objectContaining({ command: "box rm", operation: "box.delete", kind: "destructive" }),
    );
    expect(commands).toContainEqual(expect.objectContaining({ command: "snapshot fork", operation: "snapshot.fork" }));
    expect(new Set(commands.map((c) => c.command)).size).toBe(commands.length);
  });
});
