/**
 * A reader for a WebDAV `multistatus` body, and for the `href` values inside it. It is a small scanner rather than a full
 * XML parser, because it only has to understand what servers send for a PROPFIND: the namespace prefix varies (`d:`,
 * `D:`, `lp1:`) or is absent with a default namespace, a property may appear in one propstat and be refused in another,
 * and a name may be percent-encoded, written out in full, and escaped as XML entities.
 */

/** A property the PROPFIND asked for. Only the ones a propstat reports as present are filled in. */
const LENGTH = "getcontentlength";
const MODIFIED = "getlastmodified";
const COLLECTION = "collection";

/** What one `response` of a multistatus body says about one resource. */
export interface DavEntry {
  /** The href as the server wrote it, with XML entities decoded. */
  readonly href: string;
  /** True when the resource is a collection, which a `resourcetype` holding `collection` marks. */
  readonly collection: boolean;
  /** The size the server reported, or null when it reported none in a propstat that succeeded. */
  readonly bytes: number | null;
  readonly modifiedAt: string | null;
}

interface Props {
  collection: boolean;
  bytes: number | null;
  modifiedAt: string | null;
}

interface Frame {
  readonly name: string;
  text: string;
}

const NONE: Props = { collection: false, bytes: null, modifiedAt: null };

function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  // A prefix is what comes before the colon. `xmlns` declarations are not elements and never reach here.
  return colon === -1 ? name : name.slice(colon + 1);
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decodes the five entities XML defines and the numeric ones, which is all an href can hold. A numeric reference outside
 * the code points a string can hold is left as written, so a malformed answer never throws.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return isCodePoint(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return isCodePoint(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

/** Whether a numeric reference names a character a string can hold: not beyond the last code point, and no surrogate. */
function isCodePoint(code: number): boolean {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return false;
  return !(code >= 0xd800 && code < 0xe000);
}

interface Token {
  readonly kind: "open" | "close" | "self" | "text";
  readonly name: string;
  readonly text: string;
}

/**
 * Splits a document into tags and text. A `>` inside a quoted attribute does not end a tag, and a comment, a processing
 * instruction and a `CDATA` section are skipped, so only elements and their text remain.
 */
function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < xml.length) {
    const open = xml.indexOf("<", at);
    if (open === -1) {
      tokens.push({ kind: "text", name: "", text: xml.slice(at) });
      break;
    }
    if (open > at) tokens.push({ kind: "text", name: "", text: xml.slice(at, open) });
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      at = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      const text = xml.slice(open + 9, end === -1 ? xml.length : end);
      tokens.push({ kind: "text", name: "", text });
      at = end === -1 ? xml.length : end + 3;
      continue;
    }
    const end = tagEnd(xml, open);
    if (end === -1) {
      at = xml.length;
      break;
    }
    const raw = xml.slice(open + 1, end);
    at = end + 1;
    if (raw.startsWith("?") || raw.startsWith("!")) continue;
    if (raw.startsWith("/")) {
      tokens.push({ kind: "close", name: localName(elementName(raw.slice(1))), text: "" });
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    tokens.push({ kind: selfClosing ? "self" : "open", name: localName(elementName(body)), text: "" });
  }
  return tokens;
}

/** The end of a tag, past any `>` that sits inside an attribute value. */
function tagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let at = start + 1; at < xml.length; at += 1) {
    const char = xml[at];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return at;
    }
  }
  return -1;
}

function elementName(body: string): string {
  const match = /^[^\s/>]+/.exec(body.trimStart());
  return match?.[0] ?? "";
}

/** Reads every `response` of a multistatus body. A property in a propstat that failed is not reported as present. */
export function parseMultistatus(xml: string): DavEntry[] {
  const entries: DavEntry[] = [];
  const stack: Frame[] = [];
  let entry: { href: string; props: Props; failed: boolean } | null = null;
  let props: Props = NONE;
  let inPropstat = false;
  let inProp = false;
  let propstatStatus: string | null = null;

  const merge = (into: Props, from: Props): Props => ({
    collection: into.collection || from.collection,
    bytes: into.bytes ?? from.bytes,
    modifiedAt: into.modifiedAt ?? from.modifiedAt,
  });

  for (const token of tokenize(xml)) {
    if (token.kind === "text") {
      const frame = stack.at(-1);
      if (frame !== undefined) frame.text += token.text;
      continue;
    }
    if (token.kind === "open") {
      stack.push({ name: token.name, text: "" });
      if (token.name === "response") entry = { href: "", props: NONE, failed: false };
      else if (token.name === "propstat") {
        inPropstat = true;
        props = NONE;
        propstatStatus = null;
        inProp = false;
      } else if (token.name === "prop") inProp = true;
      continue;
    }
    if (token.kind === "self") {
      // An empty element, such as `<d:resourcetype/>` for a file or `<d:collection/>` for one. It belongs to whichever
      // propstat is open, so a refused one does not mark the entry.
      if (token.name === COLLECTION && inProp) props = { ...props, collection: true };
      continue;
    }
    // A closing tag: its text is complete.
    const frame = stack.pop() ?? { name: token.name, text: "" };
    const text = decodeEntities(frame.text).trim();
    if (token.name === "response") {
      if (entry !== null && entry.href !== "" && !entry.failed) entries.push({ href: entry.href, ...entry.props });
      entry = null;
      inPropstat = false;
      inProp = false;
    } else if (token.name === "propstat") {
      if (entry !== null && (propstatStatus === null || /\s2\d\d\b/.test(propstatStatus))) {
        entry.props = merge(entry.props, props);
      }
      inPropstat = false;
      inProp = false;
      props = NONE;
      propstatStatus = null;
    } else if (token.name === "prop") {
      inProp = false;
    } else if (token.name === "status") {
      if (inPropstat) propstatStatus = text;
      else if (entry !== null) entry.failed = true;
    } else if (entry === null) {
      // A property outside any response is not ours to read.
    } else if (token.name === "href") {
      if (entry.href === "") entry.href = text;
    } else if (inProp && token.name === LENGTH) {
      const bytes = Number(text);
      if (/^\d+$/.test(text) && Number.isSafeInteger(bytes)) props = { ...props, bytes };
    } else if (inProp && token.name === MODIFIED) {
      if (text !== "") props = { ...props, modifiedAt: text };
    } else if (inProp && token.name === COLLECTION) {
      props = { ...props, collection: true };
    }
  }
  return entries;
}

/** The path segments a URL path names, percent-decoded. Null when one is not decodable or would climb out of the tree. */
function segmentsOf(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const part of pathname.split("/")) {
    if (part === "") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\0")) return null;
    segments.push(decoded);
  }
  return segments;
}

/**
 * The name a `response` href gives for an entry directly inside the collection, or null when it names the collection
 * itself, a folder, or anything outside it. The href may be an absolute URL or an absolute path, and is percent-decoded.
 */
export function entryName(href: string, collection: URL): string | null {
  const base = `${collection.origin}${collection.pathname.replace(/\/+$/, "")}/`;
  let pathname: string;
  try {
    pathname = new URL(href, base).pathname;
  } catch {
    return null;
  }
  const segments = segmentsOf(pathname);
  const parent = segmentsOf(collection.pathname);
  if (segments === null || parent === null) return null;
  if (segments.length !== parent.length + 1) return null;
  for (let at = 0; at < parent.length; at += 1) {
    if (segments[at] !== parent[at]) return null;
  }
  return segments.at(-1) ?? null;
}
