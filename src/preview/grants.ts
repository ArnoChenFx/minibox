import { randomBytes } from "node:crypto";

import { parseCookies } from "../auth";
import { sha256 } from "../lib/hash";

/** The grant cookie. The `__Host-` prefix pins it to the preview host: Secure, Path=/, and no Domain. */
export const PREVIEW_COOKIE = "__Host-minibox_preview";
/** The query parameter that carries a ticket from the console to the preview host. */
export const TICKET_PARAM = "minibox_ticket";
/** A ticket is spent by the first navigation that presents it, so it only has to survive the redirect to the preview. */
export const TICKET_TTL_MS = 60_000;
/** How long a preview stays open after its ticket is spent, unless its sign-in ends first. */
export const GRANT_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_TICKETS = 1000;
const MAX_GRANTS = 5000;
const TOKEN_BYTES = 32;

/** The one preview a ticket or grant opens: a hostname, the box behind it, and the port. */
export interface PreviewScope {
  readonly hostname: string;
  readonly boxId: string;
  readonly port: number;
}

export interface PreviewGrant extends PreviewScope {
  /** The console sign-in the grant was made under. Ending that sign-in ends the grant. */
  readonly sessionId: string;
  /** Epoch milliseconds after which the grant is refused. */
  readonly expiresAt: number;
}

export interface PreviewGrantsOptions {
  /** Whether a console sign-in is still live. Tickets and grants of a sign-in that ended are refused. */
  readonly sessionLive: (sessionId: string) => boolean;
  readonly now?: () => number;
}

/**
 * Tickets and grants for subdomain previews. A signed-in console request mints a ticket. The preview host spends it once
 * and answers with a grant cookie, which then opens that preview until its time is up or its sign-in ends. Both are kept
 * under the SHA-256 hash of their token, in maps of bounded size, so a stolen cookie cannot be read back out of memory.
 */
export class PreviewGrants {
  private readonly tickets = new Map<string, PreviewGrant>();
  private readonly grants = new Map<string, PreviewGrant>();
  private readonly now: () => number;

  constructor(private readonly opts: PreviewGrantsOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** A ticket for one preview. The token is returned once, and only its hash is kept. */
  issueTicket(scope: PreviewScope, sessionId: string): string {
    const now = this.now();
    const token = randomToken();
    this.tickets.set(sha256(token), { ...scope, sessionId, expiresAt: now + TICKET_TTL_MS });
    prune(this.tickets, now);
    bound(this.tickets, MAX_TICKETS);
    return token;
  }

  /**
   * Spends a ticket for the preview it was minted for, and returns the token of the grant that replaces it. A ticket
   * presented for another preview is refused and stays unspent, so a copied link cannot use up the real one.
   */
  redeemTicket(token: string, scope: PreviewScope): string | null {
    const key = sha256(token);
    const ticket = this.tickets.get(key);
    if (!ticket) return null;
    const now = this.now();
    if (now >= ticket.expiresAt || !this.opts.sessionLive(ticket.sessionId)) {
      this.tickets.delete(key);
      return null;
    }
    if (!sameScope(ticket, scope)) return null;
    this.tickets.delete(key);
    const grant = randomToken();
    this.grants.set(sha256(grant), {
      hostname: scope.hostname,
      boxId: scope.boxId,
      port: scope.port,
      sessionId: ticket.sessionId,
      expiresAt: now + GRANT_TTL_MS,
    });
    prune(this.grants, now);
    bound(this.grants, MAX_GRANTS);
    return grant;
  }

  /**
   * The grant behind a cookie, for the hostname it was issued to. Null when the cookie is unknown, belongs to another
   * host, has run out, or its sign-in has ended. The caller still checks that the box exists.
   */
  authorize(token: string, hostname: string): PreviewGrant | null {
    const key = sha256(token);
    const grant = this.grants.get(key);
    if (!grant) return null;
    if (this.now() >= grant.expiresAt || !this.opts.sessionLive(grant.sessionId)) {
      this.grants.delete(key);
      return null;
    }
    return grant.hostname === hostname ? grant : null;
  }
}

/** The grant cookie a preview host sets after a ticket is spent. Lax, so the preview's own top-level navigations carry it. */
export function previewCookie(token: string): string {
  return `${PREVIEW_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${GRANT_TTL_MS / 1000}`;
}

export function clearPreviewCookie(): string {
  return `${PREVIEW_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** The grant token a request presents, or undefined when it presents none. */
export function previewToken(cookieHeader: string | null): string | undefined {
  return parseCookies(cookieHeader)[PREVIEW_COOKIE];
}

function randomToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function sameScope(a: PreviewScope, b: PreviewScope): boolean {
  return a.hostname === b.hostname && a.boxId === b.boxId && a.port === b.port;
}

function prune(map: Map<string, PreviewGrant>, now: number): void {
  for (const [key, entry] of map) {
    if (now >= entry.expiresAt) map.delete(key);
  }
}

/** Drops the oldest entries past `max`. Maps keep insertion order, so the first key is the oldest. */
function bound(map: Map<string, PreviewGrant>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
