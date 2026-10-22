import { esc } from "./dom.js";

/**
 * Terminal output as styled runs. Only the 16 basic foreground colors and bold survive. Every other SGR attribute is
 * dropped, and so is every other escape or control sequence. A carriage return starts its line again, and the text
 * written after the last one is what the line shows, which is what a progress redraw expects.
 */

const ESC = "\x1b";
const CSI_C1 = "\u009b";
const OSC_C1 = "\u009d";
const ST_C1 = "\u009c";

function isControl(ch) {
  const code = ch.charCodeAt(0);
  return (code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f);
}

const needsCare = (ch) => ch === ESC || ch === "\n" || ch === "\r" || isControl(ch);
const isIntermediate = (ch) => ch >= " " && ch <= "/";
const isParameter = (ch) => ch >= "0" && ch <= "?";
const isCsiFinal = (ch) => ch >= "@" && ch <= "~";
const isFinal = (ch) => ch >= "0" && ch <= "~";

/**
 * @typedef {{ text: string, fg: number | null, bold: boolean }} AnsiRun
 */

/** @param {string} input @returns {AnsiRun[]} */
export function parseAnsi(input) {
  const lines = [[]];
  const style = { fg: null, bold: false };
  let rewind = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ESC) {
      i = skipEscape(input, i, style);
    } else if (ch === CSI_C1) {
      i = skipCsi(input, i + 1, style);
    } else if (ch === OSC_C1) {
      i = skipString(input, i + 1);
    } else if (ch === "\n") {
      lines.push([]);
      rewind = false;
      i += 1;
    } else if (ch === "\r") {
      rewind = true;
      i += 1;
    } else if (isControl(ch)) {
      i += 1;
    } else {
      if (rewind) {
        lines[lines.length - 1] = [];
        rewind = false;
      }
      let end = i + 1;
      while (end < input.length && !needsCare(input[end])) end += 1;
      append(lines[lines.length - 1], input.slice(i, end), style);
      i = end;
    }
  }
  return joinLines(lines);
}

/** @param {string} input */
export function ansiToHtml(input) {
  return parseAnsi(input)
    .map(({ text, fg, bold }) => {
      const body = esc(text);
      const classes = [];
      if (fg !== null) classes.push(`ansi-fg-${fg}`);
      if (bold) classes.push("ansi-bold");
      return classes.length ? `<span class="${classes.join(" ")}">${body}</span>` : body;
    })
    .join("");
}

/** @param {string} input */
export function stripAnsi(input) {
  return parseAnsi(input)
    .map((run) => run.text)
    .join("");
}

function append(line, text, style) {
  const last = line.at(-1);
  if (last && last.fg === style.fg && last.bold === style.bold) last.text += text;
  else line.push({ text, fg: style.fg, bold: style.bold });
}

function joinLines(lines) {
  const runs = [];
  lines.forEach((line, index) => {
    if (index > 0) runs.push({ text: "\n", fg: null, bold: false });
    for (const run of line) runs.push(run);
  });
  return runs;
}

/** Returns the index after the escape sequence that starts at `start`. Sequences that draw nothing are consumed whole. */
function skipEscape(input, start, style) {
  const next = input[start + 1];
  if (next === undefined) return input.length;
  if (next === "[") return skipCsi(input, start + 2, style);
  if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") return skipString(input, start + 2);
  let j = start + 1;
  while (j < input.length && isIntermediate(input[j])) j += 1;
  if (j >= input.length) return input.length;
  return isFinal(input[j]) ? j + 1 : start + 1;
}

/** `from` is the first byte after the introducer, where the parameters begin. */
function skipCsi(input, from, style) {
  let j = from;
  while (j < input.length && isParameter(input[j])) j += 1;
  const params = input.slice(from, j);
  const bodyEnd = j;
  while (j < input.length && isIntermediate(input[j])) j += 1;
  if (j >= input.length) return input.length;
  if (!isCsiFinal(input[j])) return j;
  if (input[j] === "m" && bodyEnd === j && /^[\d;]*$/.test(params)) applySgr(params, style);
  return j + 1;
}

/**
 * Operating system commands and device strings end at BEL or ST. One that runs into a line break or another escape
 * ends there, so an unterminated sequence cannot hide the output after it.
 */
function skipString(input, from) {
  for (let j = from; j < input.length; j += 1) {
    const ch = input[j];
    if (ch === "\x07" || ch === ST_C1) return j + 1;
    if (ch === "\n" || ch === "\r") return j;
    if (ch === ESC) return input[j + 1] === "\\" ? j + 2 : j;
  }
  return input.length;
}

function applySgr(params, style) {
  const codes = params === "" ? [0] : params.split(";").map((code) => (code === "" ? 0 : Number(code)));
  for (let k = 0; k < codes.length; k += 1) {
    const code = codes[k];
    if (code === 0) {
      style.fg = null;
      style.bold = false;
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 22) {
      style.bold = false;
    } else if (code >= 30 && code <= 37) {
      style.fg = code - 30;
    } else if (code >= 90 && code <= 97) {
      style.fg = code - 90 + 8;
    } else if (code === 39) {
      style.fg = null;
    } else if (code === 38 || code === 48) {
      const mode = codes[k + 1];
      if (mode === 5) k += 2;
      else if (mode === 2) k += 4;
    }
  }
}
