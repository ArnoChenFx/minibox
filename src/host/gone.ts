import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";

/**
 * The refusal a store gives a write for a host that was removed while the caller was working. The record is not written:
 * a late write would bring back a record of a host that MiniBox no longer holds, which nothing could then remove.
 */
export const hostGone = (hostId: string): AppError => new AppError(409, "conflict", msg("host_gone", { host: hostId }));

/** One registration of a host. Reusing its id never revives requests holding this registration. */
export class HostLifetime {
  private removed = false;

  constructor(private readonly hostId: string) {}

  retire(): void {
    this.removed = true;
  }

  assertActive(): void {
    if (this.removed) throw hostGone(this.hostId);
  }
}

/**
 * A host's view of a shared store. All methods still use the original store's state and lock queues. Record creation
 * additionally checks this registration's lifetime; reads and cleanup remain available after removal.
 */
export function fenceHostWrites<T extends object>(store: T, lifetime: HostLifetime, writes: readonly (keyof T)[]): T {
  const guarded = new Set<PropertyKey>(writes);
  const view = Object.create(store) as T;
  for (
    let proto: object | null = store;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor" || Object.hasOwn(view, key)) continue;
      const value = Reflect.get(store, key);
      if (typeof value !== "function") continue;
      const method = guarded.has(key)
        ? (...args: unknown[]) => {
            lifetime.assertActive();
            return Reflect.apply(value, store, args);
          }
        : value.bind(store);
      Object.defineProperty(view, key, { value: method, writable: true, configurable: true });
    }
  }
  return view;
}
