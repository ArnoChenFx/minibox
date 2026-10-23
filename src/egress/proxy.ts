/** The proxy listens here on both of its networks. The box reaches it by the alias on its internal network. */
export const PROXY_PORT = 3128;
export const PROXY_ALIAS = "minibox-proxy";

/** Entry point for `node -e`. A proxy run never writes a request path or body, only the host and the byte counts. */
const PROXY_LINES = [
  '"use strict";',
  'const http = require("node:http");',
  'const net = require("node:net");',
  'const dns = require("node:dns").promises;',
  "const PORT = Number(process.env.MINIBOX_EGRESS_PORT || 3128);",
  'const ALLOW = JSON.parse(process.env.MINIBOX_EGRESS_ALLOW || "[]");',
  "const TIMEOUT_MS = 10000;",
  "const PRIVATE = [",
  "  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],",
  "  [0xac100000, 12], [0xc0000000, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4],",
  "];",
  "const maskOf = (bits) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);",
  "const ipInt = (text) => { const p = text.split('.').map(Number); return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0; };",
  "const isPrivate = (ip) => { const v = ipInt(ip); return PRIVATE.some(([base, bits]) => ((v & maskOf(bits)) >>> 0) === ((base & maskOf(bits)) >>> 0)); };",
  "const log = (entry) => process.stdout.write(JSON.stringify({ v: 1, ts: Date.now(), ...entry }) + '\\n');",
  "const allowed = (host) => ALLOW.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p));",
  "const clean = (name) => name.toLowerCase().replace(/\\.$/, '').slice(0, 253);",
  "async function resolveTarget(host) {",
  "  if (!allowed(host)) return { deny: 'not_allowed' };",
  "  let found;",
  "  try { found = await dns.lookup(host, { family: 4, all: true }); } catch (e) { return { deny: 'dns_failed' }; }",
  "  const usable = found.map((a) => a.address).filter((ip) => !isPrivate(ip));",
  "  return usable.length === 0 ? { deny: 'private_address' } : { ip: usable[0] };",
  "}",
  "const server = http.createServer();",
  "server.on('request', async (req, res) => {",
  "  req.on('error', () => {});",
  "  res.on('error', () => {});",
  "  let url = null;",
  "  try { url = new URL(req.url); } catch (e) { url = null; }",
  "  if (!url || url.protocol !== 'http:') {",
  "    res.writeHead(403, { 'content-type': 'text/plain' });",
  "    res.end('minibox egress: use this address as a proxy, or CONNECT for HTTPS\\n');",
  "    return;",
  "  }",
  "  const host = clean(url.hostname);",
  "  const port = Number(url.port || 80);",
  "  const verdict = port === 80 ? await resolveTarget(host) : { deny: 'port' };",
  "  if (verdict.deny) {",
  "    log({ e: 'denied', host, port, reason: verdict.deny });",
  "    res.writeHead(403, { 'content-type': 'text/plain' });",
  "    res.end('minibox egress: ' + verdict.deny + '\\n');",
  "    return;",
  "  }",
  "  const headers = { ...req.headers, host: url.host };",
  "  for (const h of ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive']) delete headers[h];",
  "  const started = Date.now();",
  "  let up = 0;",
  "  let down = 0;",
  "  const upstream = http.request({ host: verdict.ip, port, method: req.method, path: url.pathname + url.search, headers, timeout: TIMEOUT_MS }, (response) => {",
  "    const out = { ...response.headers };",
  "    for (const h of ['connection', 'keep-alive', 'proxy-connection']) delete out[h];",
  "    res.writeHead(response.statusCode, out);",
  "    response.on('data', (c) => { down += c.length; });",
  "    response.on('end', () => log({ e: 'allowed', host, port, scheme: 'http', up, down, ms: Date.now() - started }));",
  "    response.pipe(res);",
  "  });",
  "  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));",
  "  upstream.on('error', () => {",
  "    log({ e: 'failed', host, port, reason: 'upstream' });",
  "    if (!res.headersSent) res.writeHead(502);",
  "    res.end();",
  "  });",
  "  req.on('data', (c) => { up += c.length; });",
  "  req.pipe(upstream);",
  "});",
  "server.on('connect', async (req, client, head) => {",
  "  client.on('error', () => {});",
  "  const at = req.url.lastIndexOf(':');",
  "  const host = clean(at > 0 ? req.url.slice(0, at) : req.url);",
  "  const port = at > 0 ? Number(req.url.slice(at + 1)) : 443;",
  "  const verdict = port === 443 ? await resolveTarget(host) : { deny: 'port' };",
  "  if (verdict.deny) {",
  "    log({ e: 'denied', host, port, reason: verdict.deny });",
  "    client.end('HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n');",
  "    return;",
  "  }",
  "  const started = Date.now();",
  "  let up = 0;",
  "  let down = 0;",
  "  let open = false;",
  "  const upstream = net.connect({ host: verdict.ip, port, timeout: TIMEOUT_MS });",
  "  upstream.once('connect', () => {",
  "    open = true;",
  "    upstream.setTimeout(0);",
  "    client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');",
  "    if (head && head.length) { up += head.length; upstream.write(head); }",
  "    client.on('data', (c) => { up += c.length; });",
  "    upstream.on('data', (c) => { down += c.length; });",
  "    client.pipe(upstream);",
  "    upstream.pipe(client);",
  "  });",
  "  upstream.on('timeout', () => upstream.destroy());",
  "  upstream.on('error', () => {});",
  "  upstream.on('close', () => {",
  "    if (open) {",
  "      client.destroy();",
  "      log({ e: 'allowed', host, port, scheme: 'https', up, down, ms: Date.now() - started });",
  "    } else {",
  "      client.end('HTTP/1.1 502 Bad Gateway\\r\\nConnection: close\\r\\n\\r\\n');",
  "      log({ e: 'failed', host, port, reason: 'upstream' });",
  "    }",
  "  });",
  "  client.on('close', () => upstream.destroy());",
  "});",
  "process.on('uncaughtException', (e) => log({ e: 'error', reason: 'internal' }));",
  "server.maxConnections = 512;",
  "server.listen(PORT, '0.0.0.0', () => log({ e: 'listening', port: PORT, allow: ALLOW.length }));",
];

export const PROXY_PROGRAM = PROXY_LINES.join("\n");

/** Environment for the proxy container: the allowlist and the port the program listens on. */
export function proxyEnv(allow: readonly string[]): string[] {
  return [`MINIBOX_EGRESS_ALLOW=${JSON.stringify(allow)}`, `MINIBOX_EGRESS_PORT=${PROXY_PORT}`];
}

/** Proxy settings for a box on a proxy-only network. Local addresses stay direct. */
export function boxProxyEnv(): string[] {
  const url = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
  return [
    `HTTP_PROXY=${url}`,
    `HTTPS_PROXY=${url}`,
    `http_proxy=${url}`,
    `https_proxy=${url}`,
    "NO_PROXY=localhost,127.0.0.1,::1",
    "no_proxy=localhost,127.0.0.1,::1",
  ];
}

export type ProxyEvent =
  | {
      readonly kind: "allowed";
      readonly host: string;
      readonly port: number;
      readonly scheme: string;
      readonly up: number;
      readonly down: number;
      readonly ms: number;
    }
  | { readonly kind: "denied"; readonly host: string; readonly port: number; readonly reason: string }
  | { readonly kind: "failed"; readonly host: string; readonly port: number; readonly reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** One line of the proxy's log as an event, or null for lines that are not about a connection (such as the start line). */
export function parseProxyLine(line: string): ProxyEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1) return null;
  const host = typeof value.host === "string" ? value.host : null;
  const port = typeof value.port === "number" ? value.port : null;
  const reason = typeof value.reason === "string" ? value.reason : "";
  if (host === null || port === null) return null;
  if (value.e === "denied") return { kind: "denied", host, port, reason };
  if (value.e === "failed") return { kind: "failed", host, port, reason };
  if (value.e === "allowed") {
    const num = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : 0);
    const scheme = typeof value.scheme === "string" ? value.scheme : "https";
    return { kind: "allowed", host, port, scheme, up: num("up"), down: num("down"), ms: num("ms") };
  }
  return null;
}
