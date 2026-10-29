import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DANGEROUS_GROUP, PRESET_NAMES, presetPolicy, SCOPE_GROUPS, SCOPES, tokenCatalog } from "../src/tokens/model";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import { allScopes, matchesPreset, sameScopes, scopeRequest, summarizeScopes } from "../web/js/lib/token-scopes.js";
import { silenceLogs } from "./support/app";
import { call, type Harness, mint, refused, startHarness } from "./support/tokens";

const catalog = JSON.parse(JSON.stringify(tokenCatalog())) as ReturnType<typeof tokenCatalog>;

describe("the scope catalog the new-token dialog reads", () => {
  test("every scope is in exactly one group", () => {
    const listed = SCOPE_GROUPS.flatMap((group) => [...group.scopes]);
    expect(listed.toSorted()).toEqual([...SCOPES].toSorted());
    expect(new Set(listed).size).toBe(listed.length);
  });

  test("the presets are the ones the server compiles, scopes and starting range included", () => {
    expect(catalog.presets.map((preset) => preset.name)).toEqual([...PRESET_NAMES]);
    for (const preset of catalog.presets) {
      const policy = presetPolicy(preset.name);
      expect(preset.scopes).toEqual([...policy.scopes]);
      expect(preset.quotas).toEqual(policy.quotas);
      expect(preset.boxes).toBe(policy.boxes.type);
    }
  });

  test("the flagged group is secret:use, trash:skip and volume:delete, and no preset but admin holds secret:use", () => {
    const flagged = catalog.groups.filter((group) => group.danger);
    expect(flagged.map((group) => group.id)).toEqual([DANGEROUS_GROUP]);
    expect(flagged[0]?.scopes).toEqual(["secret:use", "trash:skip", "volume:delete"]);
    const holders = (scope: string) =>
      catalog.presets.filter((p) => p.scopes.includes(scope as never)).map((p) => p.name);
    expect(holders("secret:use")).toEqual(["admin"]);
    expect(holders("trash:skip")).toEqual([]);
    expect(holders("volume:delete")).toEqual(["admin"]);
  });

  test("the preset descriptions match the scope sets", () => {
    const scopes = (name: string): string[] => [...(catalog.presets.find((p) => p.name === name)?.scopes ?? [])];
    expect(scopes("readonly")).toEqual(["box:read", "files:read"]);
    const lost = (a: string, b: string) => scopes(a).filter((scope) => !scopes(b).includes(scope));
    expect(lost("operator", "sandboxed-agent")).toEqual(
      ["box:ssh", "volume:attach", "tool:install"].toSorted(
        (x, y) => scopes("operator").indexOf(x) - scopes("operator").indexOf(y),
      ),
    );
    expect(lost("admin", "operator")).toEqual(["volume:delete", "secret:use"]);
    expect(lost("operator", "admin")).toEqual([]);
    expect(catalog.presets.find((p) => p.name === "sandboxed-agent")?.quotas).toMatchObject({
      maxBoxes: 5,
      maxCpus: 8,
      maxMemoryMb: 16_384,
    });
  });

  test("every scope, group and preset has text in both languages, and a risky scope has a hint", () => {
    const keys = [
      ...SCOPES.map((scope) => `st.scope.${scope}`),
      ...SCOPE_GROUPS.map((group) => `st.scopeGroup.${group.id}`),
      ...PRESET_NAMES.flatMap((name) => [`st.preset.${name}`, `st.presetDesc.${name}`]),
      ...SCOPE_GROUPS.filter((group) => group.id === DANGEROUS_GROUP).flatMap((group) =>
        group.scopes.map((scope) => `st.scopeHint.${scope}`),
      ),
    ];
    for (const key of keys) {
      expect([key, typeof en[key], en[key] !== ""]).toEqual([key, "string", true]);
      expect([key, typeof zh[key], zh[key] !== en[key]]).toEqual([key, "string", true]);
    }
  });
});

describe("the dialog's scope helpers", () => {
  const operator = catalog.presets.find((p) => p.name === "operator");
  if (!operator) throw new Error("no operator preset");

  test("a preset with nothing changed submits the preset alone", () => {
    expect(scopeRequest("operator", [...operator.scopes].toReversed(), catalog as never)).toEqual({
      preset: "operator",
    });
  });

  test("a changed selection submits the preset and the scopes, in catalog order", () => {
    const chosen: string[] = operator.scopes.filter((scope) => scope !== "box:delete").toReversed();
    chosen.push("trash:skip");
    const body = scopeRequest("operator", chosen, catalog as never);
    expect(body.preset).toBe("operator");
    expect(body.scopes).toEqual(allScopes(catalog as never).filter((scope: string) => chosen.includes(scope)));
    expect(body.scopes).not.toContain("box:delete");
    expect(body.scopes).toContain("trash:skip");
  });

  test("the list names a token's preset when its scopes are the preset's, and custom with a count otherwise", () => {
    const base = { volumes: { type: "list", ids: [] } };
    expect(summarizeScopes({ ...base, preset: "operator", scopes: [...operator.scopes] }, catalog as never)).toEqual({
      kind: "preset",
      name: "operator",
      count: operator.scopes.length,
    });
    expect(summarizeScopes({ ...base, preset: "operator", scopes: ["exec"] }, catalog as never)).toEqual({
      kind: "custom",
      base: "operator",
      count: 1,
    });
    expect(summarizeScopes({ ...base, preset: null, scopes: ["exec", "box:read"] }, catalog as never)).toEqual({
      kind: "custom",
      base: null,
      count: 2,
    });
    expect(summarizeScopes({ ...base, preset: "admin", scopes: ["exec"] }, undefined)).toEqual({
      kind: "preset",
      name: "admin",
      count: 1,
    });
  });

  test("the volume:attach the server adds for a volume grant does not turn a preset into a custom token", () => {
    const readonly = catalog.presets.find((p) => p.name === "readonly");
    const scopes = [...(readonly?.scopes ?? []), "volume:attach"];
    expect(matchesPreset(scopes, readonly as never, false)).toBe(false);
    expect(matchesPreset(scopes, readonly as never, true)).toBe(true);
    expect(sameScopes(["a", "b"], ["b", "a"])).toBe(true);
  });
});

describe("creating a token with the dialog's body", () => {
  let harness: Harness;
  let restoreLogs: () => void;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    harness = startHarness();
  });
  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  test("the owner reads the catalog and a token does not", async () => {
    const owner = await call(harness.base, "/api/tokens/presets");
    expect(owner.status).toBe(200);
    expect(owner.json).toEqual(catalog as never);
    const operator = mint(harness.app, { name: "op", preset: "operator" });
    expect(refused(await call(harness.base, "/api/tokens/presets", { token: operator.secret })).status).toBe(403);
  });

  test("a preset with edited scopes keeps the preset's quotas, and the token carries exactly the scopes sent", async () => {
    const operator = catalog.presets.find((p) => p.name === "sandboxed-agent");
    const body = scopeRequest(
      "sandboxed-agent",
      (operator?.scopes ?? []).filter((scope) => scope !== "port:expose"),
      catalog as never,
    );
    const reply = await call(harness.base, "/api/tokens", { body: { name: "custom", ...body } });
    expect(reply.status).toBe(201);
    const record = reply.json.record as unknown as {
      preset: string;
      scopes: string[];
      quotas: { maxBoxes: number };
      audit: string;
    };
    expect(record.preset).toBe("sandboxed-agent");
    expect(record.scopes).toEqual(body.scopes ?? []);
    expect(record.scopes).not.toContain("port:expose");
    expect(record.quotas.maxBoxes).toBe(5);
  });

  test("an admin with edited scopes loses the full audit log, and an unedited one keeps it", async () => {
    const admin = catalog.presets.find((p) => p.name === "admin");
    const wanted = { boxes: "*", hosts: "*" };
    const plain = await call(harness.base, "/api/tokens", {
      body: { name: "plain", ...scopeRequest("admin", admin?.scopes ?? [], catalog as never), ...wanted },
    });
    const edited = await call(harness.base, "/api/tokens", {
      body: {
        name: "edited",
        ...scopeRequest(
          "admin",
          (admin?.scopes ?? []).filter((scope) => scope !== "secret:use"),
          catalog as never,
        ),
        ...wanted,
      },
    });
    expect((plain.json.record as unknown as { audit: string }).audit).toBe("all");
    expect((edited.json.record as unknown as { audit: string }).audit).toBe("scoped");
  });

  test("a box typed by name in the dialog is stored as its stable id, with the edited scopes", async () => {
    const created = await call(harness.base, "/api/boxes", { body: { name: "zcode-01", cpus: 1, memoryMb: 256 } });
    const operator = catalog.presets.find((p) => p.name === "operator");
    const body = {
      name: "by-name",
      ...scopeRequest(
        "operator",
        (operator?.scopes ?? []).filter((scope) => scope !== "port:expose"),
        catalog as never,
      ),
      boxes: { ids: ["zcode-01"] },
    };
    const reply = await call(harness.base, "/api/tokens", { body });
    expect(reply.status).toBe(201);
    const record = reply.json.record as unknown as { scopes: string[]; boxes: { type: string; ids: string[] } };
    expect(record.boxes).toEqual({ type: "ids", ids: [created.json.box?.boxId ?? ""] });
    expect(record.scopes).not.toContain("port:expose");
    expect((await call(harness.base, "/api/boxes/zcode-01", { token: reply.json.token })).status).toBe(200);
  });

  test("an empty scope list is refused", async () => {
    const reply = await call(harness.base, "/api/tokens", { body: { name: "none", preset: "operator", scopes: [] } });
    expect(reply.status).toBe(400);
  });

  test("only the owner creates tokens, so the sensitive scopes are the owner's own grants", async () => {
    // volume:delete stays in the console's flagged group for the owner's own tokens, and no preset carries it.
    const owner = await call(harness.base, "/api/tokens", { body: { name: "by-owner", scopes: ["volume:delete"] } });
    expect(owner.status).toBe(201);
    expect((owner.json.record as unknown as { scopes: string[] }).scopes).toEqual(["volume:delete"]);

    // A token cannot create one, not even the admin preset that holds every other scope.
    for (const input of [
      { name: "admin", preset: "admin" as const },
      { name: "operator", preset: "operator" as const },
      { name: "deleter", scopes: ["volume:delete"] as const },
    ]) {
      const token = mint(harness.app, input);
      const reply = await call(harness.base, "/api/tokens", {
        body: { name: "by-token", scopes: ["volume:delete"] },
        token: token.secret,
      });
      expect(reply.status).toBe(403);
    }
  });
});
