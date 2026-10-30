import { afterEach, beforeEach, expect, test } from "bun:test";

import type { OperationContext, Principal } from "../src/operations/types";
import { getBox } from "../src/services/boxes";
import { silenceLogs } from "./support/app";
import { startHarness } from "./support/tokens";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };

let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
});
afterEach(() => restoreLogs());

/**
 * A person who takes a session over arms a timer that hands it back after `takeoverIdleSec`. The timer writes to the event
 * log, which a stopped harness has closed, and an error thrown from a timer fails whichever test happens to be running
 * then, which in the full run is a test of another file, minutes later (a rollback test failed that way in CI).
 */
test("stopping a harness ends the takeover timers of its sessions", async () => {
  const harness = startHarness({ takeoverIdleSec: 1 });
  const host = harness.app.hosts.get();
  const ctx: OperationContext = {
    host,
    principal: OWNER,
    source: "rest",
    events: harness.app.events,
    tokens: harness.app.tokens,
    execs: harness.app.execs,
  };
  const created = (await harness.app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 })) as {
    box: { id: string };
  };
  const box = await getBox(host, created.box.id);
  await harness.app.terminals.start(host, box, "work", "rest");
  const viewer = await harness.app.terminals.attach(host, box, "work", { source: "ui", principal: OWNER });
  expect(harness.app.terminals.takeOver(viewer)).toBe(true);

  harness.stop();

  // The timer would fire after one second.
  await Bun.sleep(1400);
});
