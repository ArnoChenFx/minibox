import { describe, expect, test } from "bun:test";

import { AppError } from "../src/lib/errors";
import { boxCreate, boxDelete, boxList, boxLogs, boxResources } from "../src/operations/boxes";
import { snapshotCreate, snapshotFork } from "../src/operations/snapshots";
import type { Operation } from "../src/operations/types";

/** The error an input is rejected with. Fails the test when the input is accepted. */
function rejection(op: Operation, raw: unknown): AppError {
  try {
    op.parse(raw);
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected the input to be rejected");
}

function expectValidation(op: Operation, raw: unknown, field?: string): AppError {
  const error = rejection(op, raw);
  expect(error.status).toBe(400);
  expect(error.code).toBe("validation_failed");
  if (field) expect(error.details).toEqual({ field });
  return error;
}

describe("box names", () => {
  test("accepts docker-safe names and trims", () => {
    expect(boxCreate.parse({ name: "dev-1" })).toMatchObject({ name: "dev-1" });
    expect(boxCreate.parse({ name: "  a.b_c " })).toMatchObject({ name: "a.b_c" });
  });
  test("rejects empty, bad first char, illegal chars, too long", () => {
    for (const bad of ["", "   ", "-x", ".x", "a b", "名字", "a/b", "x".repeat(64), 42, null]) {
      expectValidation(boxCreate, { name: bad }, "name");
    }
  });
  test("the message key says whether the name is missing or malformed", () => {
    expect(rejection(boxCreate, {})).toMatchObject({ key: "field_required", params: { label: "boxName" } });
    expect(rejection(boxCreate, { name: "bad name!" })).toMatchObject({ key: "name_invalid" });
  });
});

describe("resources", () => {
  test("cpus range and rounding", () => {
    expect(boxCreate.parse({ name: "a", cpus: 2 })).toMatchObject({ cpus: 2 });
    expect(boxCreate.parse({ name: "a", cpus: "1.555" })).toMatchObject({ cpus: 1.56 });
    expectValidation(boxCreate, { name: "a", cpus: 0 }, "cpus");
    expectValidation(boxCreate, { name: "a", cpus: 65 }, "cpus");
    expectValidation(boxCreate, { name: "a", cpus: "abc" }, "cpus");
  });
  test("memory must be integer MB within range", () => {
    expect(boxCreate.parse({ name: "a", memoryMb: 4096 })).toMatchObject({ memoryMb: 4096 });
    expectValidation(boxCreate, { name: "a", memoryMb: 64 }, "memoryMb");
    expectValidation(boxCreate, { name: "a", memoryMb: 1024.5 }, "memoryMb");
  });
  test("a resize requires at least one limit, and null counts as absent", () => {
    expect(boxResources.parse({ id: "alpha", cpus: 4 })).toMatchObject({ cpus: 4 });
    expect(boxResources.parse({ id: "alpha", cpus: null, memoryMb: 512 })).toMatchObject({ memoryMb: 512 });
    expect(rejection(boxResources, { id: "alpha" })).toMatchObject({ key: "resources_required", details: undefined });
    expect(rejection(boxResources, { id: "alpha", cpus: null, memoryMb: null }).key).toBe("resources_required");
  });
  test("the first failing field is the one the legacy validators reported", () => {
    expect(rejection(boxResources, { id: "alpha", cpus: 999, memoryMb: "x" }).details).toEqual({ field: "cpus" });
    expect(rejection(boxCreate, { name: "ok", cpus: 0, template: "bad ref" }).details).toEqual({ field: "template" });
  });
});

describe("box create", () => {
  test("applies defaults", () => {
    expect(boxCreate.parse({ name: "demo" })).toEqual({
      name: "demo",
      template: undefined,
      cpus: 2,
      memoryMb: 4096,
    });
  });
  test("validates the template reference", () => {
    expect(boxCreate.parse({ name: "a", template: "minibox-template:base" })).toMatchObject({
      template: "minibox-template:base",
    });
    expectValidation(boxCreate, { name: "a", template: "bad ref" }, "template");
    expect(rejection(boxCreate, { name: "a", template: null })).toMatchObject({ key: "template_required" });
  });
  test("an empty template means the base template", () => {
    expect(boxCreate.parse({ name: "a", template: "" }).template).toBeUndefined();
  });
  test("rejects a body that is not an object", () => {
    expectValidation(boxCreate, null);
    expectValidation(boxCreate, "x");
    expect(rejection(boxCreate, [])).toMatchObject({ key: "invalid_json_object" });
  });
});

describe("snapshots", () => {
  test("a snapshot name is optional, and empty means the box name", () => {
    expect(snapshotCreate.parse({ id: "alpha" }).name).toBeUndefined();
    expect(snapshotCreate.parse({ id: "alpha", name: "" }).name).toBeUndefined();
    expect(snapshotCreate.parse({ id: "alpha", name: null }).name).toBeUndefined();
    expect(snapshotCreate.parse({ id: "alpha", name: "nightly" }).name).toBe("nightly");
    expect(rejection(snapshotCreate, { id: "alpha", name: "bad name!" })).toMatchObject({
      key: "name_invalid",
      params: { label: "snapshotName" },
    });
  });
  test("a fork keeps the reference as sent and checks the trimmed form", () => {
    expect(snapshotFork.parse({ name: "a", ref: " mbtest-snap:x " })).toMatchObject({ ref: " mbtest-snap:x " });
    expect(rejection(snapshotFork, { name: "a", ref: "bad ref" }).details).toEqual({ field: "template" });
    expect(rejection(snapshotFork, { name: "a", ref: "   " })).toMatchObject({ key: "template_required" });
  });
  test("a fork reports the name before the reference, and the reference before the resources", () => {
    expect(rejection(snapshotFork, { name: "bad name!", ref: "bad ref" }).details).toEqual({ field: "name" });
    expect(rejection(snapshotFork, { name: "ok", ref: "bad ref", cpus: 0 }).details).toEqual({ field: "template" });
  });
});

describe("query parameters", () => {
  test("tail defaults to 300 and must be an integer from 1 to 5000", () => {
    expect(boxLogs.parse({ id: "alpha" })).toMatchObject({ tail: 300 });
    expect(boxLogs.parse({ id: "alpha", tail: "50" })).toMatchObject({ tail: 50 });
    expect(boxLogs.parse({ id: "alpha", tail: "" })).toMatchObject({ tail: 300 });
    expectValidation(boxLogs, { id: "alpha", tail: "0" }, "tail");
    expectValidation(boxLogs, { id: "alpha", tail: "9999" }, "tail");
    expectValidation(boxLogs, { id: "alpha", tail: "2.5" }, "tail");
  });
  test("deleteVolume accepts true, false, 1 and 0, and nothing else", () => {
    expect(boxDelete.parse({ id: "alpha" })).toMatchObject({ deleteVolume: false });
    expect(boxDelete.parse({ id: "alpha", deleteVolume: "true" })).toMatchObject({ deleteVolume: true });
    expect(boxDelete.parse({ id: "alpha", deleteVolume: "1" })).toMatchObject({ deleteVolume: true });
    expect(boxDelete.parse({ id: "alpha", deleteVolume: "0" })).toMatchObject({ deleteVolume: false });
    expect(boxDelete.parse({ id: "alpha", deleteVolume: false })).toMatchObject({ deleteVolume: false });
    expectValidation(boxDelete, { id: "alpha", deleteVolume: "yes" }, "deleteVolume");
    expectValidation(boxDelete, { id: "alpha", deleteVolume: "" }, "deleteVolume");
  });
  test("stats is on unless the value is exactly false", () => {
    expect(boxList.parse({})).toMatchObject({ stats: true });
    expect(boxList.parse({ stats: "false" })).toMatchObject({ stats: false });
    expect(boxList.parse({ stats: "0" })).toMatchObject({ stats: true });
  });
});
