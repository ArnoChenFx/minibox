import { describe, expect, test } from "bun:test";

import { ansiToHtml, parseAnsi, stripAnsi } from "../web/js/lib/ansi.js";

const ESC = "\x1b";

describe("ansi colors and bold", () => {
  test("the 8 basic and 8 bright foreground colors become their palette index", () => {
    const basic = [30, 31, 32, 33, 34, 35, 36, 37].map((code) => parseAnsi(`${ESC}[${code}mx`)[0]?.fg);
    const bright = [90, 91, 92, 93, 94, 95, 96, 97].map((code) => parseAnsi(`${ESC}[${code}mx`)[0]?.fg);
    expect(basic).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(bright).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });

  test("a color applies to the text after it and stops at a reset", () => {
    expect(parseAnsi(`${ESC}[31mred${ESC}[0m plain`)).toEqual([
      { text: "red", fg: 1, bold: false },
      { text: " plain", fg: null, bold: false },
    ]);
  });

  test("39 restores the default foreground without touching bold", () => {
    expect(parseAnsi(`${ESC}[1;33mA${ESC}[39mB`)).toEqual([
      { text: "A", fg: 3, bold: true },
      { text: "B", fg: null, bold: true },
    ]);
  });

  test("bold turns on with 1 and off with 22, and a bare m is a reset", () => {
    expect(parseAnsi(`${ESC}[1mB${ESC}[22mN${ESC}[1mC${ESC}[mD`)).toEqual([
      { text: "B", fg: null, bold: true },
      { text: "N", fg: null, bold: false },
      { text: "C", fg: null, bold: true },
      { text: "D", fg: null, bold: false },
    ]);
  });

  test("a parameter list with several codes applies all of them in order", () => {
    expect(parseAnsi(`${ESC}[1;92mok`)).toEqual([{ text: "ok", fg: 10, bold: true }]);
  });

  test("attributes the console does not draw are dropped and their text kept", () => {
    expect(parseAnsi(`${ESC}[4;3mu${ESC}[24m`)).toEqual([{ text: "u", fg: null, bold: false }]);
  });

  test("background colors and extended colors do not change the foreground", () => {
    expect(parseAnsi(`${ESC}[41mA`)).toEqual([{ text: "A", fg: null, bold: false }]);
    expect(parseAnsi(`${ESC}[38;5;208mB${ESC}[38;2;1;2;3mC${ESC}[32mD`)).toEqual([
      { text: "BC", fg: null, bold: false },
      { text: "D", fg: 2, bold: false },
    ]);
  });
});

describe("ansi escape and control sequences", () => {
  test("cursor moves, erase, and private modes are removed and their text kept", () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1A${ESC}[10;20Hline${ESC}[?25l${ESC}[?1049h`)).toBe("line");
  });

  test("OSC sequences end at BEL or ST, and their payload is removed", () => {
    expect(stripAnsi(`${ESC}]0;window title\x07text`)).toBe("text");
    expect(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
  });

  test("an OSC that is never terminated stops at the line break instead of hiding the rest", () => {
    expect(stripAnsi(`${ESC}]0;title\nnext line`)).toBe("\nnext line");
  });

  test("an escape inside an unterminated OSC starts the next sequence, so a color after it still applies", () => {
    expect(parseAnsi(`${ESC}]0;title${ESC}[31mred`)).toEqual([{ text: "red", fg: 1, bold: false }]);
  });

  test("single-character escapes and charset designations are removed", () => {
    expect(stripAnsi(`${ESC}7a${ESC}8b${ESC}(Bc${ESC}=d`)).toBe("abcd");
  });

  test("the 8-bit C1 forms of CSI and OSC are removed like their 7-bit forms", () => {
    expect(parseAnsi("\u009b31mred\u009b0m")).toEqual([{ text: "red", fg: 1, bold: false }]);
    expect(stripAnsi("\u009d0;title\x07text")).toBe("text");
  });

  test("bell, backspace and DEL are dropped, and tabs are kept", () => {
    expect(stripAnsi("a\x07b\x08c\x7fd\te")).toBe("abcd\te");
  });

  test("an escape at the very end of the input is dropped", () => {
    expect(stripAnsi(`done${ESC}`)).toBe("done");
    expect(stripAnsi(`done${ESC}[31`)).toBe("done");
  });
});

describe("carriage returns and line breaks", () => {
  test("a carriage return starts the line again, so the last segment is what shows", () => {
    expect(stripAnsi("10%\r50%\r100%\n")).toBe("100%\n");
  });

  test("the last segment keeps its own color", () => {
    expect(parseAnsi(`${ESC}[31m50%\r${ESC}[32m100%`)).toEqual([{ text: "100%", fg: 2, bold: false }]);
  });

  test("a line that ends in a carriage return keeps its text until something overwrites it", () => {
    expect(stripAnsi("working...\r")).toBe("working...");
    expect(stripAnsi("working...\rdone\n")).toBe("done\n");
  });

  test("CRLF is one line break, not a redraw", () => {
    expect(stripAnsi("first\r\nsecond\r\n")).toBe("first\nsecond\n");
  });

  test("a carriage return followed by a line break does not blank the line", () => {
    expect(stripAnsi("step one\r\rstep two\n")).toBe("step two\n");
  });
});

describe("html output", () => {
  test("text is escaped and never parsed as markup", () => {
    const html = ansiToHtml(`<img src=x onerror="alert('x')"> & ${ESC}[31m<b>${ESC}[0m`);
    expect(html).toBe(
      `&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; <span class="ansi-fg-1">&lt;b&gt;</span>`,
    );
    expect(html).not.toContain("<img");
  });

  test("escaped sequences are never reflected into the markup", () => {
    expect(ansiToHtml(`${ESC}]0;<script>\x07ok`)).toBe("ok");
    expect(ansiToHtml(`${ESC}[31m${ESC}[1m`)).toBe("");
  });

  test("a span carries only the classes the console names", () => {
    expect(ansiToHtml(`${ESC}[1;36mcyan bold${ESC}[0m`)).toBe(`<span class="ansi-fg-6 ansi-bold">cyan bold</span>`);
    expect(ansiToHtml(`${ESC}[1mbold`)).toBe(`<span class="ansi-bold">bold</span>`);
  });

  test("plain output needs no span and empty input gives nothing", () => {
    expect(ansiToHtml("plain text\n")).toBe("plain text\n");
    expect(ansiToHtml("")).toBe("");
  });

  test("a line break inside a colored run keeps the run's color on the next line", () => {
    expect(ansiToHtml(`${ESC}[32mone\ntwo${ESC}[0m`)).toBe(
      `<span class="ansi-fg-2">one</span>\n<span class="ansi-fg-2">two</span>`,
    );
  });
});
