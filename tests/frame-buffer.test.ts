import { describe, expect, test } from "bun:test";

import { FrameBuffer } from "../src/events/frames";

describe("FrameBuffer", () => {
  test("a keyed frame replaces the one queued under its key, in that frame's place", () => {
    const buffer = new FrameBuffer({ frames: 10, bytes: 1000 });
    buffer.push("sample 1", "sample");
    buffer.push("box");
    buffer.push("sample 2", "sample");
    buffer.push("sample 3", "sample");
    expect(buffer.length).toBe(2);
    expect(buffer.take(10)).toEqual(["sample 3", "box"]);
  });

  test("once a keyed frame is taken, the next one with its key queues as a new frame", () => {
    const buffer = new FrameBuffer({ frames: 10, bytes: 1000 });
    buffer.push("host 1", "host");
    expect(buffer.take(1)).toEqual(["host 1"]);
    buffer.push("host 2", "host");
    expect(buffer.take(10)).toEqual(["host 2"]);
  });

  test("the frame limit counts a replacement once, not twice", () => {
    const buffer = new FrameBuffer({ frames: 2, bytes: 1000 });
    expect(buffer.push("a")).toBe(true);
    expect(buffer.push("b", "k")).toBe(true);
    expect(buffer.push("c")).toBe(false);
    expect(buffer.push("d", "k")).toBe(true);
    expect(buffer.take(10)).toEqual(["a", "d"]);
  });

  test("the byte limit counts UTF-8 bytes, not characters", () => {
    const buffer = new FrameBuffer({ frames: 10, bytes: 10 });
    expect(buffer.push("é".repeat(6))).toBe(false);
    expect(buffer.push("é".repeat(5))).toBe(true);
    expect(buffer.push("x")).toBe(false);
  });

  test("a replacement swaps the bytes it held for its own", () => {
    const buffer = new FrameBuffer({ frames: 10, bytes: 10 });
    expect(buffer.push("aaaaaaaaaa", "k")).toBe(true);
    expect(buffer.push("bbbbbbbbbbb", "k")).toBe(false);
    expect(buffer.push("cccc", "k")).toBe(true);
    expect(buffer.push("dddddd")).toBe(true);
    expect(buffer.push("e")).toBe(false);
    expect(buffer.take(10)).toEqual(["cccc", "dddddd"]);
  });

  test("taking frames frees their bytes", () => {
    const buffer = new FrameBuffer({ frames: 10, bytes: 4 });
    expect(buffer.push("abcd")).toBe(true);
    expect(buffer.push("e")).toBe(false);
    expect(buffer.take(1)).toEqual(["abcd"]);
    expect(buffer.push("e")).toBe(true);
  });

  test("a forced frame is queued past the limits", () => {
    const buffer = new FrameBuffer({ frames: 1, bytes: 1 });
    expect(buffer.push("abc")).toBe(false);
    buffer.force("abc");
    expect(buffer.take(10)).toEqual(["abc"]);
  });

  test("raising the byte limit admits the frames behind a forced frame, and never lowers the limit", () => {
    const buffer = new FrameBuffer({ frames: 10, bytes: 4 });
    buffer.force("abcdefgh");
    expect(buffer.push("x")).toBe(false);
    buffer.raiseByteLimit(12);
    expect(buffer.push("xyz")).toBe(true);
    buffer.raiseByteLimit(5);
    expect(buffer.push("wx")).toBe(false);
    expect(buffer.push("w")).toBe(true);
  });

  test("clear empties the buffer and forgets its keys and bytes", () => {
    const buffer = new FrameBuffer({ frames: 10, bytes: 10 });
    buffer.push("aaaaaaaaaa", "k");
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.push("bbbbbbbbbb", "k")).toBe(true);
    expect(buffer.take(10)).toEqual(["bbbbbbbbbb"]);
  });
});
