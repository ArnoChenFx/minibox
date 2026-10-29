import { describe, expect, test } from "bun:test";

import { networkMethods } from "../src/docker/networks";

interface Held {
  Id: string;
  Name: string;
  Driver: string;
  Labels: Record<string, string> | null;
  Options?: Record<string, string>;
  IPAM?: { Config?: Array<{ Subnet?: string }> };
}

const held = (name: string, labels: Record<string, string> | null): Held => ({
  Id: `id-${name}`,
  Name: name,
  Driver: "bridge",
  Labels: labels,
  IPAM: { Config: [{ Subnet: "172.30.0.0/24" }] },
});

/** An engine that holds `networks` and records the bodies it is asked to create networks with. */
function engineOf(networks: Held[]) {
  const created: Array<Record<string, unknown>> = [];
  const docker = {
    listNetworks: async () => networks,
    createNetwork: async (body: Record<string, unknown>) => {
      created.push(body);
    },
    getNetwork: (name: string) => ({
      inspect: async () => {
        const found = networks.find((network) => network.Name === name);
        if (!found) throw Object.assign(new Error("network not found"), { statusCode: 404 });
        return found;
      },
    }),
  };
  const engine = { docker, inspected: new Map(), changes: 0, mutate: <T>(fn: () => Promise<T>) => fn() };
  return { methods: networkMethods(engine as unknown as Parameters<typeof networkMethods>[0]), created };
}

describe("the labels of a network", () => {
  test("a network the call creates carries the labels it was given, and one given none is made as before", async () => {
    const { methods, created } = engineOf([]);
    await methods.ensureBridgeNetwork("mine", { interContainerComm: false, labels: { "minibox-agent.host": "edge" } });
    await methods.ensureBridgeNetwork("plain", { interContainerComm: true });
    await methods.ensureBridgeNetwork("empty", { interContainerComm: true, labels: {} });
    expect(created[0]).toMatchObject({ Name: "mine", Labels: { "minibox-agent.host": "edge" } });
    expect(created[1]).not.toHaveProperty("Labels");
    expect(created[2]).not.toHaveProperty("Labels");
  });

  test("a network that exists is left as it is, since an engine does not change the labels of one", async () => {
    const { methods, created } = engineOf([held("old", null)]);
    await methods.ensureBridgeNetwork("old", { interContainerComm: true, labels: { "minibox-agent.host": "edge" } });
    expect(created).toEqual([]);
  });

  test("a list names each network's labels, and a network made without any has none", async () => {
    const { methods } = engineOf([held("labelled", { "minibox-agent.host": "edge" }), held("bare", null)]);
    expect(await methods.listNetworks()).toEqual([
      { name: "labelled", subnets: ["172.30.0.0/24"], labels: { "minibox-agent.host": "edge" } },
      { name: "bare", subnets: ["172.30.0.0/24"], labels: {} },
    ]);
  });
});
