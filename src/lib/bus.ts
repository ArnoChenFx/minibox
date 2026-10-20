import { log } from "./logger";

/**
 * An in-process publish and subscribe channel with a fixed set of topics. Listeners run synchronously, in the order they
 * subscribed. A listener that throws is logged and does not stop the others or the publisher. A listener that subscribes
 * during a publish first hears the next one.
 */
export class Bus<Topics extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Topics, Set<(payload: never) => void>>();

  subscribe<K extends keyof Topics & string>(topic: K, listener: (payload: Topics[K]) => void): () => void {
    const set = this.listeners.get(topic) ?? new Set<(payload: never) => void>();
    this.listeners.set(topic, set);
    const entry = listener as (payload: never) => void;
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  publish<K extends keyof Topics & string>(topic: K, payload: Topics[K]): void {
    const set = this.listeners.get(topic);
    if (!set) return;
    for (const listener of new Set(set)) {
      try {
        (listener as (payload: Topics[K]) => void)(payload);
      } catch (e) {
        log.error("bus.listener_failed", { topic, error: String(e) });
      }
    }
  }

  listenerCount<K extends keyof Topics>(topic: K): number {
    return this.listeners.get(topic)?.size ?? 0;
  }
}
