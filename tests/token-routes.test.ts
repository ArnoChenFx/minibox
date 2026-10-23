import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LoginLimiter } from "../src/auth";
import { OPERATIONS } from "../src/operations/registry";
import { OWNER, type Principal, type TokenPrincipal } from "../src/operations/types";
import { routes } from "../src/routes";
import { matchRoute, type Route, routeAllows } from "../src/routes/router";
import { authorizeOperation, hasAccessRule } from "../src/tokens/authorize";
import { hostAllowed, requiredScopes, type Scope, type TokenCreateInput } from "../src/tokens/model";
import { SELF_SCOPE } from "../src/tokens/self-policy";
import { rejectionOf, silenceLogs } from "./support/app";
import { call, type Harness, mint, principalOf, refused, startHarness } from "./support/tokens";

/** The credentials the table runs every route against. `exec-only` is a hand-made grant, not a preset. */
const SUBJECTS: readonly { name: string; input: TokenCreateInput }[] = [
  { name: "readonly", input: { name: "readonly", preset: "readonly" } },
  { name: "operator", input: { name: "operator", preset: "operator" } },
  { name: "sandboxed-agent", input: { name: "sandboxed-agent", preset: "sandboxed-agent" } },
  { name: "exec-only", input: { name: "exec-only", scopes: ["exec"] } },
  { name: "admin", input: { name: "admin", preset: "admin" } },
];

/** The owner-only routes, written out. A new route that no token may reach must be added here on purpose. */
const OWNER_ONLY_ROUTES = [
  "DELETE /api/auth/sessions/:id",
  "DELETE /api/backups/:id",
  "DELETE /api/boxes/:id/checkpoint-schedule",
  "DELETE /api/hosts/:id",
  "DELETE /api/notify/channels/:id",
  "DELETE /api/secrets/:id",
  "DELETE /api/targets/:id",
  "DELETE /api/tokens/:id",
  "DELETE /api/tools/custom/:id",
  "DELETE /api/trash/:id",
  "GET /api/activity",
  "GET /api/auth/sessions",
  "GET /api/backups",
  "GET /api/backups/:id/download",
  "GET /api/boxes/:id/checkpoint-schedule",
  "GET /api/checkpoints/usage",
  "GET /api/host/metrics",
  "GET /api/hosts",
  "GET /api/packages/:id/download",
  "GET /api/hosts/usage",
  "GET /api/notify/channels",
  "GET /api/notify/deliveries",
  "GET /api/overview",
  "GET /api/pools",
  "GET /api/preview/setup",
  "GET /api/secrets",
  "GET /api/system",
  "GET /api/targets",
  "GET /api/targets/:id/check",
  "GET /api/targets/:id/objects",
  "GET /api/templates/official",
  "GET /api/tokens",
  "GET /api/tools/custom",
  "GET /api/trash",
  "POST /api/auth/sessions/revoke-others",
  "POST /api/backups",
  "POST /api/checkpoints/:id/copy",
  "POST /api/checkpoints/:id/export",
  "POST /api/hosts",
  "POST /api/hosts/:id/revoke",
  "POST /api/hosts/pairing",
  "POST /api/hosts/test",
  "POST /api/images/pull",
  "POST /api/notify/channels/:id/test",
  "POST /api/packages",
  "POST /api/packages/:id/import",
  "POST /api/targets",
  "POST /api/targets/:id/pull",
  "POST /api/targets/:id/push",
  "POST /api/targets/test",
  "POST /api/templates",
  "POST /api/templates/base/build",
  "POST /api/templates/official/:id/build",
  "POST /api/templates/:id/rebuild",
  "POST /api/templates/:id/sync",
  "POST /api/tasks/:id/cancel",
  "POST /api/tokens",
  "POST /api/trash/:id/restore",
  "PUT /api/boxes/:id/checkpoint-schedule",
  "PUT /api/notify/channels/:id",
  "PUT /api/pools",
  "PUT /api/secrets/:id",
  "PUT /api/tools/custom/:id",
  "PUT /api/volumes/:id/limits",
];

/** The routes a box's own agent reaches, written out. Only the box-self principal reaches them. */
const SELF_ROUTES = [
  "GET /api/self",
  "GET /api/self/questions/:id",
  "GET /api/self/tasks/:id",
  "POST /api/self/checkpoints",
  "POST /api/self/questions",
  "POST /api/self/status",
];

/** The path a route was compiled from, read back from its pattern: `/api/boxes/:id`. */
function templateOf(route: Route): string {
  return route.pattern.source
    .slice(1, -1)
    .replace(/\(\[\^\/\]\+\)/g, ":id")
    .replace(/\\(.)/g, "$1");
}

/** A request path the route matches: each parameter becomes `x`. */
function concretePathOf(route: Route): string {
  return route.pattern.source
    .slice(1, -1)
    .replace(/\(\[\^\/\]\+\)/g, "x")
    .replace(/\\(.)/g, "$1");
}

function isSelfRoute(route: Route): boolean {
  return !route.public && route.access.kind === "scope" && route.access.scope === SELF_SCOPE;
}

function isOwnerOnly(route: Route): boolean {
  if (route.public || isSelfRoute(route)) return false;
  return route.access.kind === "owner" || requiredScopes(route.access.scope) === "owner";
}

/** What the scope mapping says a route should admit: a route that names a scope the principal holds. */
function expectedAllowed(route: Route, scopes: readonly Scope[]): boolean {
  if (route.public) return true;
  if (route.access.kind !== "scope") return false;
  const need = requiredScopes(route.access.scope);
  return need !== "owner" && need.some((scope) => scopes.includes(scope));
}

let harness: Harness;
let restoreLogs: () => void;
let subjects: { name: string; secret: string; principal: TokenPrincipal }[];

beforeEach(() => {
  restoreLogs = silenceLogs();
  harness = startHarness();
  subjects = SUBJECTS.map((subject) => {
    const minted = mint(harness.app, subject.input);
    return { name: subject.name, secret: minted.secret, principal: principalOf(harness.app, minted.secret) };
  });
});

afterEach(() => {
  harness.stop();
  restoreLogs();
});

function subjectNamed(name: string) {
  const subject = subjects.find((item) => item.name === name);
  if (!subject) throw new Error(`no subject named ${name}`);
  return subject;
}

describe("default-deny route table", () => {
  test("the owner passes every route", () => {
    for (const route of routes) expect(routeAllows(route, OWNER), `${route.method} ${templateOf(route)}`).toBe(true);
  });

  test("the owner-only routes are exactly the listed ones, and no token reaches them", () => {
    const owned = routes
      .filter(isOwnerOnly)
      .map((route) => `${route.method} ${templateOf(route)}`)
      .toSorted();
    expect(owned).toEqual(OWNER_ONLY_ROUTES.toSorted());
    for (const subject of subjects) {
      for (const route of routes.filter(isOwnerOnly)) {
        expect(routeAllows(route, subject.principal), `${subject.name} ${route.method} ${templateOf(route)}`).toBe(
          false,
        );
      }
    }
  });

  test("the self routes are exactly the listed ones, and only a box's own agent reaches them", () => {
    const self = routes
      .filter(isSelfRoute)
      .map((route) => `${route.method} ${templateOf(route)}`)
      .toSorted();
    expect(self).toEqual(SELF_ROUTES.toSorted());
    const agent: Principal = { type: "box-self", id: "bx_01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "alpha" };
    for (const route of routes) {
      if (route.public) continue;
      expect(routeAllows(route, agent), `${route.method} ${templateOf(route)}`).toBe(isSelfRoute(route));
    }
  });

  test("each credential is admitted exactly where its scopes reach, on every route", () => {
    const mismatches: string[] = [];
    for (const subject of subjects) {
      for (const route of routes) {
        const allowed = routeAllows(route, subject.principal);
        if (allowed !== expectedAllowed(route, subject.principal.grants.scopes)) {
          mismatches.push(`${subject.name}: ${route.method} ${templateOf(route)} admitted=${allowed}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("every refused route answers 403 operation_forbidden over HTTP, for the credential that was refused", async () => {
    const misses: string[] = [];
    let refusedCalls = 0;
    for (const subject of subjects) {
      for (const route of routes) {
        if (route.public || routeAllows(route, subject.principal)) continue;
        const path = concretePathOf(route);
        const match = matchRoute(routes, route.method, path);
        if (match === null || match === "method_not_allowed" || match.route !== route) {
          misses.push(`${subject.name}: ${route.method} ${templateOf(route)} is not the route the server picks`);
          continue;
        }
        refusedCalls++;
        const reply = await call(harness.base, path, { method: route.method, token: subject.secret });
        const got = refused(reply);
        if (got.status !== 403 || got.key !== "operation_forbidden") {
          misses.push(`${subject.name}: ${route.method} ${templateOf(route)} -> ${got.status} ${got.key ?? "-"}`);
        }
      }
    }
    expect(misses).toEqual([]);
    const expectedRefusals = subjects.reduce(
      (total, subject) =>
        total +
        routes.filter((route) => !route.public && !expectedAllowed(route, subject.principal.grants.scopes)).length,
      0,
    );
    expect(refusedCalls).toBe(expectedRefusals);
  });

  test("a Bearer token does not open a console page: pages answer to the session cookie only", async () => {
    const res = await fetch(`${harness.base}/`, {
      headers: { authorization: `Bearer ${subjectNamed("admin").secret}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("fail-closed authorization", () => {
  test("every operation is owner-only or has an access rule, and the owner-only operations are the listed ones", () => {
    const ownerOperations = OPERATIONS.filter((op) => op.scope !== SELF_SCOPE && requiredScopes(op.scope) === "owner")
      .map((op) => op.name)
      .toSorted();
    expect(ownerOperations).toEqual([
      "backup.create",
      "backup.delete",
      "backup.download",
      "backup.list",
      "checkpoint.copy",
      "checkpoint.export",
      "checkpoint.import",
      "checkpoint.schedule.clear",
      "checkpoint.schedule.get",
      "checkpoint.schedule.set",
      "checkpoint.usage",
      "host.add",
      "host.list",
      "host.pairing.create",
      "host.remove",
      "host.revoke",
      "host.test",
      "host.usage",
      "image.pull",
      "notify.channel.delete",
      "notify.channel.list",
      "notify.channel.set",
      "notify.channel.test",
      "notify.delivery.list",
      "overview.get",
      "pool.list",
      "pool.replace",
      "secret.delete",
      "secret.list",
      "secret.set",
      "target.add",
      "target.check",
      "target.list",
      "target.objects",
      "target.pull",
      "target.push",
      "target.remove",
      "target.test",
      "task.cancel",
      "template.build",
      "template.create",
      "template.official.build",
      "template.official.list",
      "template.rebuild",
      "template.sync",
      "token.create",
      "token.list",
      "token.revoke",
      "tool.custom.delete",
      "tool.custom.list",
      "tool.custom.put",
      "trash.list",
      "trash.purge",
      "trash.restore",
      "volume.limits.set",
    ]);
    const unruled = OPERATIONS.filter((op) => requiredScopes(op.scope) !== "owner" && !hasAccessRule(op.name));
    expect(unruled.map((op) => op.name)).toEqual([]);
  });

  test("the self operations are a box's own agent's alone: no token reaches them, and the owner is refused", async () => {
    const selfOperations = OPERATIONS.filter((op) => op.scope === SELF_SCOPE).map((op) => op.name);
    expect(selfOperations.toSorted()).toEqual([
      "self.ask",
      "self.checkpoint",
      "self.info",
      "self.question",
      "self.status",
      "self.task",
    ]);
    for (const name of selfOperations) {
      const operation = OPERATIONS.find((op) => op.name === name);
      if (!operation) throw new Error(`no operation ${name}`);
      expect(await authorizeOperation({ principal: OWNER, operation })).toBe(false);
      for (const subject of subjects) {
        expect(await authorizeOperation({ principal: subject.principal, operation })).toBe(false);
      }
    }
  });

  test("an operation with no access rule passes the scope check and is refused at access, even for a token that holds every scope", async () => {
    const admin = subjectNamed("admin");
    const box = OPERATIONS.find((op) => op.name === "box.get");
    if (!box) throw new Error("box.get is registered");
    const unlisted = { ...box, name: "box.unlisted" };
    const request = {
      principal: admin.principal,
      operation: unlisted,
      host: harness.app.hosts.get(),
      input: {},
      resolved: undefined,
    };
    expect(await authorizeOperation({ ...request, phase: "scope" })).toBe(true);
    const error = await rejectionOf(authorizeOperation({ ...request, phase: "access" }));
    expect(error).toMatchObject({ key: "operation_forbidden" });
  });

  test("a host grant fails closed for a box with no recorded host, unless every host is granted", () => {
    expect(hostAllowed({ type: "list", ids: ["local"] }, undefined)).toBe(false);
    expect(hostAllowed({ type: "list", ids: ["local"] }, "local")).toBe(true);
    expect(hostAllowed({ type: "all" }, undefined)).toBe(true);
  });

  test("wrong Bearer keys count toward the login limit and answer 429 once it is reached", async () => {
    harness.app.throttle.stop();
    harness.app.throttle = new LoginLimiter({ perAddress: 3, total: 100, penaltyMs: 0 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await call(harness.base, "/api/tokens", { token: "mbx_not-a-real-token" })).status);
    }
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });
});
