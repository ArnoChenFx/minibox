import { describe, expect, test } from "bun:test";

import { demuxLogs, LogLines } from "../src/docker/logs";

/** Feeds the chunks to a LogLines in order, and returns every line it yields, a final partial line included. */
function linesOf(...chunks: Buffer[]): string[] {
  const split = new LogLines();
  const lines = chunks.flatMap((chunk) => split.push(chunk));
  return [...lines, ...split.end()];
}

/** One frame as the engine multiplexes it for a container without a TTY: the stream kind, three zero bytes, the size. */
function frame(kind: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = kind;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** The lines of a whole stream as demuxLogs reads it, for comparison with the lines of a split one. */
function expectedLines(stream: Buffer): string[] {
  const text = demuxLogs(stream);
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

describe("LogLines reads a log stream as its bytes arrive", () => {
  test("a raw stream gives the same lines whatever the chunk boundaries, and drops a carriage return before a newline", () => {
    expect(linesOf(Buffer.from("alpha\nbeta\r\n\ngamma"))).toEqual(["alpha", "beta", "", "gamma"]);
    expect(linesOf(Buffer.from("alp"), Buffer.from("ha\nbe"), Buffer.from("ta\r\n\nga"), Buffer.from("mma"))).toEqual([
      "alpha",
      "beta",
      "",
      "gamma",
    ]);
  });

  test("frames are one byte stream, so a line can continue into a frame of the other kind", () => {
    expect(linesOf(frame(1, "hello\nwor"), frame(2, "ld\n"))).toEqual(["hello", "world"]);
  });

  test("a stream shorter than a frame header is waited for before it is read as raw text", () => {
    expect(linesOf(Buffer.from("ok"))).toEqual(["ok"]);
    const framed = frame(1, "one\n");
    expect(linesOf(framed.subarray(0, 3), framed.subarray(3))).toEqual(["one"]);
  });

  test("a character split across chunks is decoded whole", () => {
    const bytes = Buffer.from("héllo 世界\n");
    const at = bytes.indexOf(Buffer.from("世"));
    expect(linesOf(bytes.subarray(0, at + 1), bytes.subarray(at + 1))).toEqual(["héllo 世界"]);
  });

  test("a truncated last frame yields the payload that arrived, as demuxLogs does", () => {
    const truncated = frame(1, "abcdef\n").subarray(0, 11);
    expect(linesOf(truncated)).toEqual(["abc"]);
    expect(expectedLines(truncated)).toEqual(["abc"]);
  });

  test("a line past the size limit is yielded in pieces that keep every character whole", () => {
    const text = `x${"é".repeat(40_000)}`;
    const lines = linesOf(Buffer.from(text));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(text);
    expect(lines.some((line) => line.includes("\uFFFD"))).toBe(false);
  });

  test("the lines match demuxLogs for every two-chunk split of a framed, raw, short or empty stream", () => {
    const streams = [
      Buffer.concat([frame(1, "one\ntw"), frame(2, "o\n\nthr"), frame(1, "ee")]),
      Buffer.from("raw one\nraw two\n"),
      Buffer.from("short"),
      Buffer.alloc(0),
    ];
    for (const stream of streams) {
      for (let at = 0; at <= stream.length; at++) {
        expect(linesOf(stream.subarray(0, at), stream.subarray(at))).toEqual(expectedLines(stream));
      }
    }
  });
});
