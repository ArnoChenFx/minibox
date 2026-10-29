import { expect, test } from "bun:test";

test("cold Docker inspection bounds concurrent requests and preserves container order", async () => {
  const { containerMethods } = await import("../src/docker/containers");
  const ids = Array.from({ length: 120 }, (_, i) => `container-${i}`);
  let active = 0;
  let peak = 0;
  const methods = containerMethods({
    changes: 0,
    inspected: new Map(),
    docker: {
      listContainers: async () => ids.map((Id) => ({ Id, State: "running" })),
      getContainer: (id: string) => ({
        inspect: async () => {
          peak = Math.max(peak, ++active);
          await Bun.sleep(1);
          active--;
          return {
            Id: id,
            Name: `/${id}`,
            Created: "2026-10-29T00:00:00Z",
            Config: { Image: "alpine:3.20", Labels: {} },
            State: { Status: "running", Running: true, StartedAt: "2026-10-29T00:00:00Z" },
            HostConfig: {},
            NetworkSettings: { Networks: {} },
          };
        },
      }),
    },
  } as unknown as Parameters<typeof containerMethods>[0]);
  expect((await methods.listContainers({ labels: {} })).map((c) => c.id)).toEqual(ids);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(12);
});
