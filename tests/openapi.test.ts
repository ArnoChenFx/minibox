import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { compileErrors, validate } from "@readme/openapi-parser";

import pkg from "../package.json";
import { renderOpenApi, toOpenApiPath } from "../src/operations/openapi";
import { OPERATIONS } from "../src/operations/registry";
import { RUN_HEADER } from "../src/operations/run";
import { ErrorSchema, TaskAcceptedSchema } from "../src/operations/schemas";
import { compilePath } from "../src/routes/router";
import type { Exchange } from "./parity/scenario";

const DOCUMENT = join(import.meta.dir, "..", "docs", "openapi.json");
const TRANSCRIPT = join(import.meta.dir, "fixtures", "parity-transcript.json");
const RENDERED = renderOpenApi(OPERATIONS, pkg.version);

interface DocumentedOperation {
  operationId: string;
  parameters: { name: string; in: string }[];
  responses: Record<string, unknown>;
}

interface DocumentShape {
  paths: Record<string, Record<string, DocumentedOperation>>;
}

const documentOf = (text: string) => JSON.parse(text) as DocumentShape;

const bindingsOf = () => OPERATIONS.flatMap((operation) => operation.rest.map((binding) => ({ operation, binding })));

describe("OpenAPI document", () => {
  test("the generated document passes OpenAPI 3.1 validation with no warnings", async () => {
    const result = await validate(JSON.parse(RENDERED));
    expect(result.valid ? "valid" : compileErrors(result)).toBe("valid");
    expect(result.warnings).toEqual([]);
  });

  test("a document that breaks the OpenAPI schema is rejected", async () => {
    const broken = { ...JSON.parse(RENDERED), info: { version: pkg.version } };
    expect((await validate(broken)).valid).toBe(false);
  });

  test("docs/openapi.json is the current output of the registry", () => {
    expect(readFileSync(DOCUMENT, "utf8")).toBe(RENDERED);
  });

  test("the committed document passes validation too", async () => {
    const result = await validate(JSON.parse(readFileSync(DOCUMENT, "utf8")));
    expect(result.valid).toBe(true);
  });

  test("documents exactly the REST bindings of the registry", () => {
    const documented = Object.entries(documentOf(RENDERED).paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    );
    const expected = bindingsOf().map(({ binding }) => `${binding.method} ${toOpenApiPath(binding.path)}`);
    expect(documented.toSorted()).toEqual(expected.toSorted());
  });

  test("each binding carries the operationId the registry derives for it", () => {
    const ids = Object.values(documentOf(RENDERED).paths).flatMap((item) =>
      Object.values(item).map((operation) => operation.operationId),
    );
    expect(ids.toSorted()).toEqual([
      "box.action.restart",
      "box.action.start",
      "box.action.stop",
      "box.create",
      "box.delete",
      "box.get",
      "box.list",
      "box.logs",
      "box.rebuild",
      "box.resources",
      "box.rollback",
      "box.rollback.confirm",
      "box.rollback.get",
      "box.rollback.undo",
      "box.stats",
      "box.update",
      "checkpoint.create",
      "checkpoint.delete",
      "checkpoint.fork",
      "checkpoint.get",
      "checkpoint.list",
      "checkpoint.update",
      "checkpoint.usage",
      "events.list",
      "exec.get",
      "exec.kill",
      "exec.output",
      "exec.run",
      "files.copy",
      "files.download",
      "files.list",
      "files.read",
      "files.upload",
      "files.write",
      "pool.list",
      "pool.replace",
      "port.expose",
      "port.list",
      "port.unexpose",
      "secret.delete",
      "secret.list",
      "secret.set",
      "session.close",
      "session.list",
      "session.read",
      "session.send",
      "session.start",
      "snapshot.create",
      "snapshot.delete",
      "snapshot.fork",
      "snapshot.list",
      "task.cancel",
      "task.get",
      "task.list",
      "template.build",
      "template.delete",
      "template.list",
      "template.promote",
      "token.create",
      "token.list",
      "token.revoke",
      "tool.catalog",
      "tool.install",
      "tool.list",
      "tool.reconcile",
      "tool.uninstall",
      "tool.upgrade",
      "volume.attach",
      "volume.create",
      "volume.delete",
      "volume.detach",
      "volume.get",
      "volume.list",
      "volume.usage",
    ]);
  });

  test("every operation documents the X-Minibox-Run header", () => {
    const missing = Object.entries(documentOf(RENDERED).paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, operation]) => !operation.parameters.some((p) => p.name === RUN_HEADER && p.in === "header"))
        .map(([method]) => `${method} ${path}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("recorded HTTP transcript", () => {
  const transcript = JSON.parse(readFileSync(TRANSCRIPT, "utf8")) as Exchange[];
  const document = documentOf(RENDERED);
  // The router answers a request with the first binding that matches it, so each exchange is checked against that one.
  const matched = transcript.flatMap((exchange) => {
    const pathname = new URL(exchange.path, "http://127.0.0.1").pathname;
    const first = bindingsOf().find(
      ({ binding }) => binding.method === exchange.method && compilePath(binding.path).pattern.test(pathname),
    );
    return first ? [{ exchange, ...first }] : [];
  });

  test("the transcript answers every REST binding at least once", () => {
    const exercised = new Set(matched.map(({ binding }) => `${binding.method} ${binding.path}`));
    expect(bindingsOf().filter(({ binding }) => !exercised.has(`${binding.method} ${binding.path}`))).toEqual([]);
  });

  test("each success is the status its binding declares", () => {
    for (const { exchange, binding } of matched) {
      if (exchange.status >= 300) continue;
      expect({ step: exchange.step, status: exchange.status }).toEqual({
        step: exchange.step,
        status: binding.status ?? 200,
      });
    }
  });

  test("each answer is a status the document lists for its operation", () => {
    for (const { exchange, binding } of matched) {
      const documented = document.paths[toOpenApiPath(binding.path)]?.[binding.method.toLowerCase()]?.responses ?? {};
      expect({ step: exchange.step, listed: Object.keys(documented).includes(String(exchange.status)) }).toEqual({
        step: exchange.step,
        listed: true,
      });
    }
  });

  test("each body is JSON that matches the output schema, or the error schema for 4xx and 5xx", () => {
    for (const { exchange, operation } of matched) {
      expect({ step: exchange.step, contentType: exchange.contentType?.split(";")[0] }).toEqual({
        step: exchange.step,
        contentType: "application/json",
      });
      const body: unknown = JSON.parse(exchange.body);
      const schema =
        exchange.status === 202 ? TaskAcceptedSchema : exchange.status >= 400 ? ErrorSchema : operation.output;
      const parsed = schema.safeParse(body);
      expect({ step: exchange.step, valid: parsed.success }).toEqual({ step: exchange.step, valid: true });
      if (parsed.success) expect({ step: exchange.step, body: parsed.data }).toEqual({ step: exchange.step, body });
    }
  });
});
