import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { type ClientRequest, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { Outgoing } from "./channels";

/**
 * A delivery that did not succeed. `code` is a short word the record shows: timeout, network, dns_failed,
 * blocked_address, bad_url. Messages are never kept, because a request can carry a token in its path.
 */
export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "DeliveryError";
  }
}

export interface SendOptions {
  /** Addresses that are not public may be called, as a self-hosted ntfy or a LAN webhook needs. */
  readonly allowPrivate: boolean;
  /** Bounds the whole delivery, name resolution included. */
  readonly timeoutMs: number;
  /** Replaces the system resolver. Tests pass one that hangs or fails, to prove the timeout covers it. */
  readonly resolve?: (hostname: string) => Promise<LookupAddress[]>;
}

/** The address a request is sent to, chosen once and used for the whole request, so a second lookup cannot change it. */
interface Pinned {
  readonly address: string;
  readonly family: number;
}

/** Whether an address is one a notification should reach: not loopback, private, link-local, shared or reserved. */
export function isPublicAddress(address: string): boolean {
  const mapped = ipv4Mapped(address);
  if (mapped !== null) return isPublicIPv4(mapped);
  if (isIP(address) === 4) return isPublicIPv4(address);
  return isPublicIPv6(address.toLowerCase());
}

function ipv4Mapped(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const rest = lower.slice("::ffff:".length);
  if (isIP(rest) === 4) return rest;
  const groups = rest.split(":");
  if (groups.length !== 2) return null;
  const [high, low] = groups.map((group) => Number.parseInt(group ?? "", 16));
  if (high === undefined || low === undefined || Number.isNaN(high) || Number.isNaN(low)) return null;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function isPublicIPv4(address: string): boolean {
  const [a = -1, b = -1] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return a < 224;
}

function isPublicIPv6(address: string): boolean {
  if (address === "::" || address === "::1") return false;
  const first = address.split(":")[0] ?? "";
  if (first.startsWith("fc") || first.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(first)) return false;
  return !first.startsWith("ff");
}

const systemResolve = (hostname: string) => lookup(hostname, { all: true, verbatim: true });

/** Where the request goes: an address from the URL, or the first address the name resolves to that is allowed. */
async function pin(hostname: string, options: SendOptions): Promise<Pinned> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  const found =
    family === 0
      ? await (options.resolve ?? systemResolve)(bare).catch(() => {
          throw new DeliveryError("dns_failed");
        })
      : [{ address: bare, family }];
  if (found.length === 0) throw new DeliveryError("dns_failed");
  const allowed = found.find((candidate) => options.allowPrivate || isPublicAddress(candidate.address));
  if (!allowed) throw new DeliveryError("blocked_address");
  return allowed;
}

/**
 * Sends one request and returns its status. The connection is made to the address the policy checked, with the name kept
 * for the Host header and TLS, so a name that resolves differently on the second lookup cannot reach another machine.
 * The status is the only thing read: the body of the answer is discarded, and the request is closed once it arrives.
 */
export function send(request: Outgoing, options: SendOptions): Promise<number> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return Promise.reject(new DeliveryError("bad_url"));
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return Promise.reject(new DeliveryError("bad_url"));
  }
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let outgoing: ClientRequest | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new DeliveryError("timeout")));
      outgoing?.destroy();
    }, options.timeoutMs);
    pin(url.hostname, options).then(
      (pinned) => {
        if (settled) return;
        const client = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = client(
          {
            hostname: url.hostname.replace(/^\[|\]$/g, ""),
            port: url.port === "" ? undefined : url.port,
            path: `${url.pathname}${url.search}`,
            method: "POST",
            headers: { ...request.headers, "content-length": String(Buffer.byteLength(request.body)) },
            lookup: (_name, lookupOptions, callback) => {
              const all = typeof lookupOptions === "object" && lookupOptions !== null && "all" in lookupOptions;
              if (all && lookupOptions.all) callback(null, [pinned]);
              else callback(null, pinned.address, pinned.family);
            },
          },
          (response) => {
            const status = response.statusCode ?? 0;
            response.resume();
            finish(() => resolve(status));
            req.destroy();
          },
        );
        outgoing = req;
        req.on("error", (error) => {
          finish(() => reject(error instanceof DeliveryError ? error : new DeliveryError("network")));
        });
        req.end(request.body);
      },
      (error: unknown) => {
        finish(() => reject(error instanceof DeliveryError ? error : new DeliveryError("dns_failed")));
      },
    );
  });
}
