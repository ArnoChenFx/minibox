import { describe, expect, test } from "bun:test";

import { type PreviewCheck, type PreviewProbe, type ProbeAnswer, runPreviewSelfCheck } from "../src/preview/selfcheck";

const BASE = "preview.example.net";

interface Stub {
  resolves?: boolean;
  answer?: ProbeAnswer;
}

function probeWith(stub: Stub = {}): PreviewProbe & { asked: { resolves: string[]; get: string[] } } {
  const asked = { resolves: [] as string[], get: [] as string[] };
  return {
    asked,
    async resolves(hostname) {
      asked.resolves.push(hostname);
      return stub.resolves ?? true;
    },
    async get(url) {
      asked.get.push(url);
      return stub.answer ?? { ok: true, status: 404, marked: true };
    },
  };
}

function byId(checks: PreviewCheck[], id: PreviewCheck["id"]): PreviewCheck {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`no ${id} check`);
  return check;
}

describe("preview self-check", () => {
  test("a working wildcard passes every check", async () => {
    const checks = await runPreviewSelfCheck({
      base: BASE,
      consoleHost: "minibox.example.com",
      probe: probeWith(),
    });
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["console", "ok"],
      ["same_site", "ok"],
      ["dns", "ok"],
      ["https", "ok"],
    ]);
  });

  test("the console inside the preview domain is an error, with the console's address", async () => {
    const checks = await runPreviewSelfCheck({
      base: BASE,
      consoleHost: "console.preview.example.net",
      probe: probeWith(),
    });
    const console = byId(checks, "console");
    expect(console.status).toBe("error");
    expect(console.message).toMatchObject({
      key: "preview_check_console_in_base",
      params: { host: "console.preview.example.net", base: BASE },
    });
  });

  test("a console on the same registrable domain is a warning, not an error", async () => {
    const checks = await runPreviewSelfCheck({
      base: BASE,
      consoleHost: "minibox.example.net",
      probe: probeWith(),
    });
    expect(byId(checks, "same_site")).toMatchObject({ status: "warn", message: { key: "preview_check_same_site" } });
  });

  test("a probe name under the base that does not resolve is an error", async () => {
    const probe = probeWith({ resolves: false });
    const checks = await runPreviewSelfCheck({ base: BASE, consoleHost: "minibox.example.com", probe });
    const dns = byId(checks, "dns");
    expect(dns.status).toBe("error");
    expect(dns.message.key).toBe("preview_check_dns");
    expect(probe.asked.resolves).toHaveLength(1);
    expect(probe.asked.resolves[0]).toMatch(
      new RegExp(`^minibox-probe-[0-9a-f]{12}\\.${BASE.replaceAll(".", "\\.")}$`),
    );
  });

  test("a probe that cannot be reached over HTTPS is an error that names the reason", async () => {
    const checks = await runPreviewSelfCheck({
      base: BASE,
      consoleHost: "minibox.example.com",
      probe: probeWith({ answer: { ok: false, reason: "certificate has expired" } }),
    });
    expect(byId(checks, "https")).toMatchObject({
      status: "error",
      message: { key: "preview_check_https", params: { detail: "certificate has expired", base: BASE } },
    });
  });

  test("an answer that does not carry MiniBox's marker is another server, and an error", async () => {
    const checks = await runPreviewSelfCheck({
      base: BASE,
      consoleHost: "minibox.example.com",
      probe: probeWith({ answer: { ok: true, status: 200, marked: false } }),
    });
    expect(byId(checks, "https")).toMatchObject({ status: "error", message: { key: "preview_check_other_server" } });
  });

  test("the HTTPS probe asks a random name under the base, from MiniBox's own host", async () => {
    const probe = probeWith();
    await runPreviewSelfCheck({ base: BASE, consoleHost: "minibox.example.com", probe });
    expect(probe.asked.get).toHaveLength(1);
    expect(probe.asked.get[0]).toMatch(
      new RegExp(`^https://minibox-probe-[0-9a-f]{12}\\.${BASE.replaceAll(".", "\\.")}/$`),
    );
  });
});
