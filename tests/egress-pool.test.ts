import { describe, expect, test } from "bun:test";

import { allocateBoxSubnet, EGRESS_POOL, inEgressPool, UPLINK_SUBNET } from "../src/egress/pool";
import { parseIpv4Cidr, ipv4Overlaps } from "../src/lib/cidr";
import { AppError } from "../src/lib/errors";

const net = (text: string) => {
  const parsed = parseIpv4Cidr(text);
  if (parsed === null) throw new Error(`bad test CIDR ${text}`);
  return parsed;
};

describe("egress pool", () => {
  test("the pool is 240.0.0.0/12 and the uplink /24 sits inside it", () => {
    expect(EGRESS_POOL).toEqual(net("240.0.0.0/12"));
    expect(inEgressPool(net(UPLINK_SUBNET))).toBe(true);
    expect(inEgressPool(net("172.18.0.0/16"))).toBe(false);
  });

  test("the first box subnet is the first /28 after the uplink", () => {
    expect(allocateBoxSubnet([])).toBe("240.0.1.0/28");
  });

  test("a subnet that overlaps any used network is skipped", () => {
    const used = [net("240.0.1.0/28"), net("240.0.1.16/28"), net("240.0.2.0/25")];
    const picked = allocateBoxSubnet(used);
    expect(picked).toBe("240.0.1.32/28");
    expect(used.some((network) => ipv4Overlaps(network, net(picked)))).toBe(false);
  });

  test("a network that is wider than a /28 blocks every /28 inside it", () => {
    expect(allocateBoxSubnet([net("240.0.1.0/24")])).toBe("240.0.2.0/28");
  });

  test("a full pool is a conflict, not a crash", () => {
    const everything = [net("240.0.0.0/12")];
    try {
      allocateBoxSubnet(everything);
      throw new Error("expected the pool to be full");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(409);
    }
  });
});
