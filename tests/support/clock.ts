import { jest } from "bun:test";

/** Lets the callbacks already queued run, without moving a fake clock. */
export const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Moves the fake clock forward, then lets the work its timers started run. */
export async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await turn();
}

/**
 * Moves the fake clock in 10 ms steps until `pending` settles, and returns its value or throws its error. Use `advance`
 * instead where the moment a call returns is the thing under test.
 */
export async function settle<T>(pending: Promise<T>): Promise<T> {
  const state = { done: false };
  const tracked = pending.finally(() => {
    state.done = true;
  });
  tracked.catch(() => undefined);
  await turn();
  for (let steps = 0; !state.done; steps++) {
    if (steps > 2000) throw new Error("the call did not settle while the fake clock ran");
    await advance(10);
  }
  return tracked;
}
