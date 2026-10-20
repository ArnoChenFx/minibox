import { describe, expect, test } from "bun:test";

import { toRuntimeError } from "../src/docker/errors";
import { AppError, toAppError } from "../src/lib/errors";
import { RuntimeError, type RuntimeErrorKind } from "../src/runtime";

/** The shape dockerode and docker-modem give for an HTTP error from the engine. */
const engineResponse = (statusCode: number, message: string) =>
  Object.assign(new Error(`(HTTP code ${statusCode}) ${message}`), { statusCode, json: { message } });

/** The shape a failed connection to the socket gives. */
const socketError = (code: string) => Object.assign(new Error(`connect ${code} /var/run/docker.sock`), { code });

describe("engine failures become RuntimeError kinds", () => {
  test.each<[string, unknown, RuntimeErrorKind]>([
    ["404", engineResponse(404, "No such container: x"), "not_found"],
    ["409", engineResponse(409, "Conflict. The container name is already in use"), "conflict"],
    ["400", engineResponse(400, "invalid reference format"), "invalid"],
    ["422", engineResponse(422, "unprocessable"), "invalid"],
    ["500", engineResponse(500, "server error"), "engine"],
    ["ENOENT", socketError("ENOENT"), "unavailable"],
    ["ECONNREFUSED", socketError("ECONNREFUSED"), "unavailable"],
    ["EACCES", socketError("EACCES"), "unavailable"],
  ])("%s", (_name, error, kind) => {
    expect(toRuntimeError(error)).toMatchObject({ kind });
  });

  test("the engine's own message is the detail shown to users, and the full text is kept for logs", () => {
    expect(toRuntimeError(engineResponse(409, "name taken"))).toMatchObject({
      kind: "conflict",
      detail: "name taken",
      message: "(HTTP code 409) name taken",
    });
  });

  test("errors that are neither engine responses nor socket failures pass through unchanged", () => {
    const boom = new Error("boom");
    expect(toRuntimeError(boom)).toBe(boom);
    expect(toRuntimeError(null)).toBeNull();
    const already = new RuntimeError("engine", "x");
    expect(toRuntimeError(already)).toBe(already);
  });
});

describe("RuntimeError kinds become HTTP errors", () => {
  test.each<[RuntimeErrorKind, number, string, string | undefined]>([
    ["not_found", 404, "not_found", "docker_not_found"],
    ["conflict", 409, "conflict", "docker_conflict"],
    ["invalid", 400, "docker_error", undefined],
    ["unavailable", 503, "docker_unavailable", "docker_unavailable"],
    ["engine", 502, "docker_error", "docker_error"],
  ])("%s is HTTP %d (%s)", (kind, status, code, key) => {
    expect(toAppError(new RuntimeError(kind, "raw", "engine detail"))).toMatchObject({ status, code, key });
  });

  test("an unexpected error is a 500 that keeps its message", () => {
    expect(toAppError(new Error("boom"))).toMatchObject({ status: 500, code: "internal", message: "boom" });
  });

  test("an AppError is returned as it is", () => {
    const error = new AppError(422, "insufficient_capacity", "too big");
    expect(toAppError(error)).toBe(error);
  });
});
