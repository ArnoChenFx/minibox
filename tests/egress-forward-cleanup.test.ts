import { expect, test } from "bun:test";

import type { Engine } from "../src/docker/engine";
import { hostFirewallMethods } from "../src/docker/host-firewall";

test("empty bridge cleanup reaches the helper instead of failing interface validation", async () => {
  let reached = false;
  const engine = {
    docker: {
      getImage: () => ({
        inspect: async () => {
          reached = true;
          throw new Error("test stops before launching a helper");
        },
      }),
    },
  } as unknown as Engine;
  await expect(hostFirewallMethods(engine).allowHostForward("minibox", "")).rejects.toBeDefined();
  expect(reached).toBe(true);
});
