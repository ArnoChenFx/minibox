import { describe, expect, test } from "bun:test";

import { PREVIEW_COOKIE } from "../src/preview/grants";
import {
  boxCookies,
  filterRequestHeaders,
  filterResponseHeaders,
  hostOnlyCookie,
  PREVIEW_CSP,
  PREVIEW_SUBDOMAIN_CSP,
  previewCsp,
} from "../src/preview/headers";

describe("subdomain preview cookies", () => {
  test("a box sees its own cookies and never MiniBox's", () => {
    const header = `app=1; ${PREVIEW_COOKIE}=grant; minibox_session=console; minibox_key=legacy; theme=dark`;
    expect(boxCookies(header)).toBe("app=1; theme=dark");
  });

  test("when only MiniBox's cookies are present, none is forwarded", () => {
    expect(boxCookies(`${PREVIEW_COOKIE}=grant; minibox_session=console`)).toBeNull();
    expect(boxCookies("")).toBeNull();
  });

  test("a cookie the box sets loses its Domain attribute, so it stays on the preview host", () => {
    expect(hostOnlyCookie("sid=2; Path=/; Domain=preview.test; HttpOnly")).toBe("sid=2; Path=/; HttpOnly");
    expect(hostOnlyCookie("sid=2; Path=/")).toBe("sid=2; Path=/");
  });

  test("a cookie that would replace the grant cookie is dropped", () => {
    expect(hostOnlyCookie(`${PREVIEW_COOKIE}=evil; Path=/; Secure`)).toBeNull();
  });

  test("the request forwards the box's cookies and marks the request as https", () => {
    const src = new Headers({
      host: "5173-demo.preview.test",
      cookie: `app=1; ${PREVIEW_COOKIE}=grant`,
      authorization: "Bearer secret",
    });
    const out = filterRequestHeaders(src, "127.0.0.1:5173", "subdomain");
    expect(out.get("cookie")).toBe("app=1");
    expect(out.get("authorization")).toBeNull();
    expect(out.get("x-forwarded-proto")).toBe("https");
    expect(out.get("x-forwarded-host")).toBe("5173-demo.preview.test");
  });

  test("the response keeps host-only box cookies and drops any Domain attribute", () => {
    const src = new Headers();
    src.append("set-cookie", "sid=2; Path=/; Domain=preview.test");
    src.append("set-cookie", `${PREVIEW_COOKIE}=evil; Path=/`);
    const out = filterResponseHeaders(src, "", "subdomain");
    expect(out.getSetCookie()).toEqual(["sid=2; Path=/"]);
  });
});

describe("preview content security policy", () => {
  test("a subdomain preview may use its own storage, because it is its own origin", () => {
    expect(previewCsp("subdomain")).toBe(PREVIEW_SUBDOMAIN_CSP);
    expect(PREVIEW_SUBDOMAIN_CSP).toContain("allow-same-origin");
  });

  test("a path-mode preview keeps the opaque-origin sandbox", () => {
    expect(previewCsp("path")).toBe(PREVIEW_CSP);
    expect(PREVIEW_CSP).not.toContain("allow-same-origin");
  });
});
