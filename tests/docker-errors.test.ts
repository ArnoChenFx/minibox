import { describe, expect, test } from "bun:test";

import { toRuntimeError } from "../src/docker/errors";
import { RuntimeError } from "../src/runtime";

const engineError = (statusCode: number, message: string, json?: unknown) =>
  Object.assign(new Error(message), { statusCode, json });

describe("toRuntimeError", () => {
  test.each([
    [404, "not_found"],
    [409, "conflict"],
    [400, "invalid"],
    [403, "invalid"],
    [500, "engine"],
    [503, "engine"],
  ])("HTTP %d becomes %s and keeps the engine message", (status, kind) => {
    const full = `(HTTP code ${status}) reason - daemon says so `;
    const err = toRuntimeError(engineError(status, full, { message: "daemon says so" }));
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err).toMatchObject({ kind, message: full, detail: "daemon says so" });
  });

  test("detail falls back to the transport message when the body has none", () => {
    const err = toRuntimeError(engineError(500, "(HTTP code 500) server error - boom ", "not json"));
    expect(err).toMatchObject({ kind: "engine", detail: "(HTTP code 500) server error - boom " });
  });

  test("connection failures are unavailable", () => {
    for (const code of ["ECONNREFUSED", "ENOENT", "EACCES"]) {
      const err = toRuntimeError(Object.assign(new Error(`connect ${code}`), { code }));
      expect(err).toMatchObject({ kind: "unavailable" });
    }
  });

  test("errors that are not from the engine pass through unchanged", () => {
    const plain = new Error("boom");
    const runtime = new RuntimeError("conflict", "x");
    expect(toRuntimeError(plain)).toBe(plain);
    expect(toRuntimeError(runtime)).toBe(runtime);
    expect(toRuntimeError("text")).toBe("text");
    expect(toRuntimeError(null)).toBeNull();
  });
});
