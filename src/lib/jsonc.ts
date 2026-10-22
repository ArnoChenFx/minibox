/**
 * Parses JSON that may carry `//` and `/* *\/` comments, a byte order mark and trailing commas, as devcontainer.json
 * files do. Strings are read first, so a `//` inside a string, such as a URL, is kept. Throws SyntaxError otherwise.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(text.replace(/^\uFEFF/, ""))));
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) throw new SyntaxError("unterminated comment");
      out += " ";
      i = close + 2;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

/** The index just past the string that starts at `start`, honouring backslash escapes. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    i += text[i] === "\\" ? 2 : 1;
  }
  if (i >= text.length) throw new SyntaxError("unterminated string");
  return i + 1;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (char === ",") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next] ?? "")) next++;
      if (text[next] === "}" || text[next] === "]") {
        i++;
        continue;
      }
    }
    out += char;
    i++;
  }
  return out;
}
