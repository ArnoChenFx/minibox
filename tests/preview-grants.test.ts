import { describe, expect, test } from "bun:test";

import {
  clearPreviewCookie,
  GRANT_TTL_MS,
  PREVIEW_COOKIE,
  PreviewGrants,
  type PreviewScope,
  previewCookie,
  previewToken,
  TICKET_TTL_MS,
} from "../src/preview/grants";

const scope: PreviewScope = { hostname: "5173-demo.preview.test", boxId: "bx_abc12345", port: 5173 };

function setup(liveSessions = ["s1"]) {
  let now = 1_000_000;
  const live = new Set(liveSessions);
  const grants = new PreviewGrants({ sessionLive: (id) => live.has(id), now: () => now });
  return {
    grants,
    live,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("preview tickets", () => {
  test("a ticket is spent by the first redemption, which returns a grant token", () => {
    const { grants } = setup();
    const ticket = grants.issueTicket(scope, "s1");
    const grant = grants.redeemTicket(ticket, scope);
    expect(grant).toBeString();
    expect(grant).not.toBe(ticket);
    expect(grants.redeemTicket(ticket, scope)).toBeNull();
  });

  test("a ticket for another preview is refused, and stays unspent for the right one", () => {
    const { grants } = setup();
    const ticket = grants.issueTicket(scope, "s1");
    expect(grants.redeemTicket(ticket, { ...scope, port: 3000 })).toBeNull();
    expect(grants.redeemTicket(ticket, { ...scope, boxId: "bx_other" })).toBeNull();
    expect(grants.redeemTicket(ticket, scope)).not.toBeNull();
  });

  test("a ticket expires after its short lifetime", () => {
    const { grants, advance } = setup();
    const ticket = grants.issueTicket(scope, "s1");
    advance(TICKET_TTL_MS);
    expect(grants.redeemTicket(ticket, scope)).toBeNull();
  });

  test("a ticket is refused once the sign-in it was minted under has ended", () => {
    const { grants, live } = setup();
    const ticket = grants.issueTicket(scope, "s1");
    live.delete("s1");
    expect(grants.redeemTicket(ticket, scope)).toBeNull();
  });

  test("an unknown ticket is refused", () => {
    const { grants } = setup();
    expect(grants.redeemTicket("not-a-ticket", scope)).toBeNull();
  });
});

describe("preview grants", () => {
  test("the grant opens its own preview host and no other", () => {
    const { grants } = setup();
    const token = grants.redeemTicket(grants.issueTicket(scope, "s1"), scope);
    if (token === null) throw new Error("the ticket should redeem");
    expect(grants.authorize(token, scope.hostname)).toMatchObject({ ...scope, sessionId: "s1" });
    expect(grants.authorize(token, "3000-demo.preview.test")).toBeNull();
  });

  test("a grant runs out after its lifetime", () => {
    const { grants, advance } = setup();
    const token = grants.redeemTicket(grants.issueTicket(scope, "s1"), scope);
    if (token === null) throw new Error("the ticket should redeem");
    advance(GRANT_TTL_MS - 1);
    expect(grants.authorize(token, scope.hostname)).not.toBeNull();
    advance(1);
    expect(grants.authorize(token, scope.hostname)).toBeNull();
  });

  test("a grant is refused once its sign-in ends", () => {
    const { grants, live } = setup();
    const token = grants.redeemTicket(grants.issueTicket(scope, "s1"), scope);
    if (token === null) throw new Error("the ticket should redeem");
    live.delete("s1");
    expect(grants.authorize(token, scope.hostname)).toBeNull();
  });

  test("an unknown grant is refused", () => {
    const { grants } = setup();
    expect(grants.authorize("never-issued", scope.hostname)).toBeNull();
  });

  test("the oldest tickets are dropped once there are too many", () => {
    const { grants } = setup();
    const tickets = Array.from({ length: 1001 }, (_, i) => grants.issueTicket({ ...scope, port: 1000 + i }, "s1"));
    expect(grants.redeemTicket(tickets[0] ?? "", { ...scope, port: 1000 })).toBeNull();
    expect(grants.redeemTicket(tickets[1000] ?? "", { ...scope, port: 2000 })).toBeString();
  });
});

describe("preview cookies", () => {
  test("the grant cookie is __Host-, HttpOnly, Secure and Lax, with no Domain", () => {
    expect(previewCookie("tok")).toBe(`${PREVIEW_COOKIE}=tok; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`);
    expect(PREVIEW_COOKIE.startsWith("__Host-")).toBe(true);
  });

  test("clearing it expires it at once", () => {
    expect(clearPreviewCookie()).toBe(`${PREVIEW_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  });

  test("the grant is read from a cookie header that carries other cookies", () => {
    expect(previewToken(`a=1; ${PREVIEW_COOKIE}=tok_1-2; b=2`)).toBe("tok_1-2");
    expect(previewToken("a=1")).toBeUndefined();
    expect(previewToken(null)).toBeUndefined();
  });
});
