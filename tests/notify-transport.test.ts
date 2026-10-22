import { afterEach, describe, expect, test } from "bun:test";

import { DeliveryError, isPublicAddress, send } from "../src/notify/transport";

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function listen(fetch: (req: Request) => Response | Promise<Response>): { port: number } {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  stops.push(() => server.stop(true));
  return { port: server.port ?? 0 };
}

/** A port that was just in use and now has no listener, so a connection to it is refused. */
function closedPort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof DeliveryError) return e.code;
    throw e;
  }
  throw new Error("expected the delivery to fail");
}

const request = (url: string) => ({ url, headers: { "content-type": "application/json" }, body: '{"ok":true}' });

describe("which addresses a notification may reach", () => {
  test.each([
    { address: "8.8.8.8", reachable: true },
    { address: "172.32.0.1", reachable: true },
    { address: "100.128.0.1", reachable: true },
    { address: "2001:4860:4860::8888", reachable: true },
    { address: "::ffff:8.8.8.8", reachable: true },
    { address: "127.0.0.1", reachable: false },
    { address: "10.0.0.1", reachable: false },
    { address: "172.16.5.5", reachable: false },
    { address: "192.168.1.1", reachable: false },
    { address: "169.254.169.254", reachable: false },
    { address: "100.64.0.1", reachable: false },
    { address: "100.127.255.255", reachable: false },
    // Fake-IP DNS proxies answer from 198.18.0.0/15 and connect to the real address themselves.
    { address: "198.18.0.1", reachable: true },
    { address: "198.19.0.1", reachable: true },
    { address: "0.0.0.0", reachable: false },
    { address: "224.0.0.1", reachable: false },
    { address: "240.0.0.1", reachable: false },
    { address: "::1", reachable: false },
    { address: "::", reachable: false },
    { address: "fc00::1", reachable: false },
    { address: "fd12:3456::1", reachable: false },
    { address: "fe80::1", reachable: false },
    { address: "febf::1", reachable: false },
    { address: "ff02::1", reachable: false },
    { address: "::ffff:127.0.0.1", reachable: false },
    { address: "::ffff:7f00:1", reachable: false },
    { address: "::ffff:a9fe:a9fe", reachable: false },
    { address: "64:ff9b::a9fe:a9fe", reachable: false },
    { address: "64:ff9b::10.0.0.1", reachable: false },
    { address: "64:ff9b::808:808", reachable: true },
    { address: "fec0::1", reachable: false },
  ])("$address reachable: $reachable", ({ address, reachable }) => {
    expect(isPublicAddress(address)).toBe(reachable);
  });
});

describe("sending a request", () => {
  test("a URL that is not http or https, or that carries a user name, is refused before anything is connected", async () => {
    for (const url of ["not a url", "ftp://example.com/hook", "http://user:secret@example.com/hook"]) {
      expect(await codeOf(send(request(url), { allowPrivate: false, timeoutMs: 1000 }))).toBe("bad_url");
    }
  });

  test("a loopback, private or link-local address is blocked unless private addresses are allowed", async () => {
    const urls = [
      "http://127.0.0.1:9/hook",
      "http://10.0.0.7/hook",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]:9/hook",
      "http://localhost:9/hook",
    ];
    for (const url of urls) {
      expect(await codeOf(send(request(url), { allowPrivate: false, timeoutMs: 1000 }))).toBe("blocked_address");
    }
  });

  test("a name that resolves only to non-public addresses is blocked, and one that resolves to nothing fails name resolution", async () => {
    const onlyPrivate = {
      allowPrivate: false,
      timeoutMs: 1000,
      resolve: async () => [{ address: "192.168.1.20", family: 4 }],
    };
    expect(await codeOf(send(request("https://hooks.example.com/x"), onlyPrivate))).toBe("blocked_address");

    const nothing = { allowPrivate: false, timeoutMs: 1000, resolve: async () => [] };
    expect(await codeOf(send(request("https://hooks.example.com/x"), nothing))).toBe("dns_failed");

    const failing = {
      allowPrivate: false,
      timeoutMs: 1000,
      resolve: async (): Promise<never> => {
        throw new Error("ENOTFOUND");
      },
    };
    expect(await codeOf(send(request("https://hooks.example.com/x"), failing))).toBe("dns_failed");
  });

  test("a name whose lookup never returns is cut off by the timeout, so resolution cannot hold a delivery", async () => {
    const started = Date.now();
    const hanging = { allowPrivate: false, timeoutMs: 50, resolve: () => new Promise<never>(() => {}) };
    expect(await codeOf(send(request("https://slow.example.com/x"), hanging))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the request goes to the address the policy checked, and the name is kept for the Host header", async () => {
    let host = "";
    const server = listen((req) => {
      host = req.headers.get("host") ?? "";
      return new Response("ok");
    });
    const status = await send(request(`http://hook.test:${server.port}/notify`), {
      allowPrivate: true,
      timeoutMs: 2000,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(status).toBe(200);
    expect(host).toBe(`hook.test:${server.port}`);
  });

  test("a local server receives the method, path, headers and body, and the status it answers with is returned", async () => {
    const seen: { method: string; path: string; type: string | null; body: string }[] = [];
    const server = listen(async (req) => {
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        type: req.headers.get("content-type"),
        body: await req.text(),
      });
      return new Response("", { status: 202 });
    });
    const status = await send(request(`http://127.0.0.1:${server.port}/hook/path?x=1`), {
      allowPrivate: true,
      timeoutMs: 2000,
    });
    expect(status).toBe(202);
    expect(seen).toEqual([{ method: "POST", path: "/hook/path", type: "application/json", body: '{"ok":true}' }]);
  });

  test("a redirect is not followed: its status is the answer, so a public hook cannot bounce to a private address", async () => {
    const paths: string[] = [];
    const server = listen((req) => {
      paths.push(new URL(req.url).pathname);
      return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    });
    expect(await send(request(`http://127.0.0.1:${server.port}/hook`), { allowPrivate: true, timeoutMs: 2000 })).toBe(
      302,
    );
    expect(paths).toEqual(["/hook"]);
  });

  test("an error status is an answer, not a failure: the status is returned for the caller to judge", async () => {
    const server = listen(() => new Response("broken", { status: 500 }));
    expect(await send(request(`http://127.0.0.1:${server.port}/hook`), { allowPrivate: true, timeoutMs: 2000 })).toBe(
      500,
    );
  });

  test("a server that never answers is cut off by the timeout", async () => {
    const server = listen(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const code = await codeOf(
      send(request(`http://127.0.0.1:${server.port}/hang`), { allowPrivate: true, timeoutMs: 150 }),
    );
    expect(code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("nothing listening on the port is a network failure", async () => {
    const port = closedPort();
    expect(await codeOf(send(request(`http://127.0.0.1:${port}/hook`), { allowPrivate: true, timeoutMs: 2000 }))).toBe(
      "network",
    );
  });

  test("an https address with nothing listening is a network failure, through the same pinned path", async () => {
    const port = closedPort();
    expect(await codeOf(send(request(`https://127.0.0.1:${port}/hook`), { allowPrivate: true, timeoutMs: 2000 }))).toBe(
      "network",
    );
  });
});
