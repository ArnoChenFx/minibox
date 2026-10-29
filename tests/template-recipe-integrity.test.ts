import { afterAll, afterEach, expect, test } from "bun:test";

import { createDeclaredTemplate, editRecipe, readRecipe, templateAndRecipe } from "../src/services/template-builds";
import { editTemplate } from "../src/services/templates";
import { commandText, initOf } from "../web/js/lib/template-edit.js";
import { silenceLogs } from "./support/app";
import { call, mint, principalOf, startHarness, type Harness } from "./support/tokens";
const restore = silenceLogs();
afterAll(restore);
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.stop();
});
const source = { kind: "dockerfile" as const, text: "FROM alpine:3.20\nRUN true\n" };

for (const [stalePatch, currentPatch] of [
  [{ source: { ...source, text: "FROM alpine:3.21\n" } }, { description: "New description" }],
  [{ source: { ...source, text: "FROM alpine:3.21\n" } }, { init: { forwardPorts: [8080] } }],
  [{ init: { forwardPorts: [3000] } }, { source: { ...source, text: "FROM alpine:3.21\n" } }],
] as const)
  test(`a stale ${Object.keys(stalePatch)[0]} edit cannot replace a newer ${Object.keys(currentPatch)[0]} after authorization I/O`, async () => {
    const harness = startHarness();
    harnesses.push(harness);
    const { app, runtime } = harness;
    const host = app.hosts.get();
    const maker = mint(app, { name: "maker", preset: "operator" });
    await createDeclaredTemplate(host, { name: "tool", source, createdBy: maker.id }, { log: () => {} });
    const inspect = runtime.inspectImage.bind(runtime);
    let count = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    runtime.inspectImage = async (ref) => {
      if (++count === 4) {
        entered.resolve();
        await release.promise;
      }
      return inspect(ref);
    };
    const ctx = {
      host,
      principal: principalOf(app, maker.secret),
      source: "rest" as const,
      events: app.events,
      tokens: app.tokens,
      execs: app.execs,
      terminals: app.terminals,
    };
    const stale = app.operations.run("template.edit", ctx, { ref: "mbtest-template:tool", ...stalePatch });
    await entered.promise;
    await app.operations.run("template.edit", ctx, { ref: "mbtest-template:tool", ...currentPatch });
    release.resolve();
    await expect(stale).rejects.toMatchObject({ status: 409, key: "template_busy" });
    expect((await templateAndRecipe(host, "mbtest-template:tool"))[0].recipe).toMatchObject(currentPatch);
  });

test("full template form clears each field while an unchanged argv remains safe", async () => {
  const harness = startHarness();
  harnesses.push(harness);
  const { app } = harness;
  const host = app.hosts.get();
  await createDeclaredTemplate(host, { name: "tool", source, createdBy: "owner" }, { log: () => {} });
  let [declared, image] = await templateAndRecipe(host, "mbtest-template:tool");
  editRecipe(host, declared, { init: { postCreate: ["/bin/sh", "-c", "echo OLD"], forwardPorts: [3000] } });
  [declared, image] = await templateAndRecipe(host, "mbtest-template:tool");
  await editTemplate(host, declared, image, { init: initOf("", [3000]) });
  expect(readRecipe(host, "tool")?.init).toEqual({ forwardPorts: [3000] });
  [declared, image] = await templateAndRecipe(host, "mbtest-template:tool");
  await editTemplate(host, declared, image, { init: initOf("echo NEW", []) });
  expect(readRecipe(host, "tool")?.init).toEqual({ postCreate: ["/bin/sh", "-c", "echo NEW"] });
  const args = ["printf", "%s|", "$LITERAL_ARGUMENT", "", "a'b", "a b", "$(echo BAD)", "`echo BAD`", ";"];
  const rendered = commandText(args);
  const command = initOf(rendered, [])!.postCreate!;
  const child = Bun.spawn(command, { stdout: "pipe", env: { ...process.env, LITERAL_ARGUMENT: "expanded" } });
  expect(await new Response(child.stdout).text()).toBe(
    args
      .slice(2)
      .map((arg) => `${arg}|`)
      .join(""),
  );
  expect(await child.exited).toBe(0);
});

test("invisible recipe references do not disclose whether a source exists", async () => {
  const h = startHarness();
  harnesses.push(h);
  const host = h.app.hosts.get();
  h.runtime.seedImage("mbtest-template:foreign", {
    [host.keys.template]: "true",
    [host.keys.templateName]: "foreign",
    [host.keys.createdBy]: "tok_other",
  });
  const reader = mint(h.app, { name: "reader", preset: "readonly" });
  const rpc = (method: string, params: unknown, session?: string) =>
    fetch(`${h.base}/mcp?toolsets=tools`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${reader.secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  const session = initialized.headers.get("mcp-session-id") ?? "";
  for (const ref of ["mbtest-template:foreign", "mbtest-template:absent"]) {
    const result = await call(h.base, `/api/templates/${encodeURIComponent(ref)}/recipe`, { token: reader.secret });
    expect(result.status).toBe(403);
    expect(result.json.error?.key).toBe("template_out_of_scope");
    const mcp = (await (
      await rpc("tools/call", { name: "get_template_source", arguments: { ref } }, session)
    ).json()) as {
      result: { isError: boolean; structuredContent: { code: string; key: string } };
    };
    expect(mcp.result.isError).toBe(true);
    expect(mcp.result.structuredContent).toMatchObject({ code: "forbidden", key: "template_out_of_scope" });
  }
});
