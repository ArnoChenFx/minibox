import { describe, expect, test } from "bun:test";

import { StreamSlots } from "../src/events/slots";
import { AppError } from "../src/lib/errors";

function refusalOf(take: () => unknown): AppError {
  try {
    take();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("the slot was granted");
}

describe("StreamSlots", () => {
  test("grants up to its maximum, then refuses with 429 and names the limit", () => {
    const slots = new StreamSlots(2);
    slots.acquire();
    slots.acquire();
    expect(refusalOf(() => slots.acquire())).toMatchObject({
      status: 429,
      code: "too_many_requests",
      key: "stream_limit",
      params: { max: 2 },
    });
    expect(slots.count).toBe(2);
  });

  test("a released slot is granted again", () => {
    const slots = new StreamSlots(1);
    const release = slots.acquire();
    expect(() => slots.acquire()).toThrow(AppError);
    release();
    expect(slots.count).toBe(0);
    slots.acquire();
    expect(slots.count).toBe(1);
  });

  test("releasing a slot twice gives back one slot only", () => {
    const slots = new StreamSlots(2);
    const first = slots.acquire();
    slots.acquire();
    first();
    first();
    expect(slots.count).toBe(1);
    slots.acquire();
    expect(() => slots.acquire()).toThrow(AppError);
  });
});
