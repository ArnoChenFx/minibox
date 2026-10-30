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

  /** True once the registration was removed. It never goes back, even if the same host id is added again. */
  get retired(): boolean {
    return this.removed;
  }

  retire(): void {
    this.removed = true;
  }

  assertActive(): void {
    if (this.removed) throw hostGone(this.hostId);
  }
}

/** The store behind each view `fenceHostWrites` made, for state that belongs to the store rather than to a registration. */
const behind = new WeakMap<object, object>();

/**
 * The shared store behind a host's view of it. Keep state that must hold across registrations (a reservation that keeps
 * a volume from being removed) under this key: every registration of a host has a view of its own, and state kept under
 * a view would not be seen by the next registration.
 */
export function sharedStore<T extends object>(view: T): T {
  return (behind.get(view) as T | undefined) ?? view;
}

/**
 * A host's view of a shared store. All methods still use the original store's state and lock queues, and are looked up on
 * the store at each call, so a stub placed on the shared store later is the one that runs. The methods named in `writes`
 * additionally check this registration's lifetime first; reads and cleanup remain available after removal.
 */
export function fenceHostWrites<T extends object>(store: T, lifetime: HostLifetime, writes: readonly (keyof T)[]): T {
  const guarded = new Set<PropertyKey>(writes);
  const view = Object.create(store) as T;
  for (
    let proto: object | null = store;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Reflect.ownKeys(proto)) {
      if (key === "constructor" || Object.hasOwn(view, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (descriptor?.get || descriptor?.set) {
        // An accessor runs with the store as `this`, as it does on the store itself.
        Object.defineProperty(view, key, {
          get: descriptor.get ? () => Reflect.get(store, key) : undefined,
          set: descriptor.set ? (value: unknown) => void Reflect.set(store, key, value) : undefined,
          configurable: true,
        });
        continue;
      }
      if (typeof descriptor?.value !== "function") continue;
      const method = (...args: unknown[]): unknown => {
        if (guarded.has(key)) lifetime.assertActive();
        return Reflect.apply(Reflect.get(store, key) as (...rest: unknown[]) => unknown, store, args);
      };
      Object.defineProperty(view, key, { value: method, writable: true, configurable: true });
    }
  }
  behind.set(view, store);
  return view;
}
