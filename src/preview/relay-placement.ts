import type { HostCtx } from "../host/registry";
import { placeRelay } from "./relay-binary";

/** The two ways a preview relay runs in a box: the placed static binary, or the python3 script it falls back to. */
export type RelayKind = "binary" | "python3";

/** How many entries each record keeps before its oldest are dropped. */
const CACHE_LIMIT = 1024;

/**
 * What the preview relay remembers about the containers it has reached, and the one placement per container that
 * concurrent connections share. It holds the bookkeeping only: `relay.ts` still starts the relay, waits for its
 * handshake and copies the bytes.
 *
 * The invariants this class protects:
 *
 * - **One placement per container.** The first connection that needs a binary starts the architecture lookup and the
 *   file write, and every connection that arrives while that is still in flight awaits the same promise instead of
 *   writing a second copy over the first. The in-flight promise is dropped when the write settles, whatever its
 *   outcome, so a failed placement is not remembered as a refusal: a later connection tries the write again.
 * - **One decision, two halves, one key.** "The binary is at this path" and "this container has no usable binary" are
 *   the two outcomes of the same decision, so both live under the engine and container they belong to. `place()`
 *   records the path it wrote, `forget()` drops a path whose binary started but could not run, so the next attempt
 *   writes it again, and only `reject()` — which the caller decides after its retries — keeps a container off the
 *   binary for good. A key is never both placing and rejected: the caller asks `isRejected()` before it places.
 * - **The key is the container, not the box.** A box rebuilt under the same id gets a fresh container, whose writable
 *   layer has no file, so a placement recorded for the old container must not be reused. The architecture is looked up
 *   for the container's image ID, never its template tag, which is mutable and can point at another architecture after
 *   a pull or on another engine.
 * - **Bounded.** Every record drops its oldest entries past `CACHE_LIMIT`, so a long-lived process that has seen many
 *   boxes does not grow without limit. Entries are written only when a connection learns something, and the oldest
 *   entry is the one dropped, so a live container's entry can be evicted by newer ones and is then simply rebuilt.
 */
export class RelayPlacements {
  /** Container key to the path of the relay written into it. */
  private readonly placed = new Map<string, string>();
  /** Container keys whose binary has been given up on, and which use the python3 script from then on. */
  private readonly rejected = new Set<string>();
  /** Container key to the implementation its traffic settled on, so a repeat is not reported twice. */
  private readonly chosen = new Map<string, RelayKind>();
  /** Container key to the placement in flight, shared by every connection that arrives meanwhile. */
  private readonly placing = new Map<string, Promise<string | null>>();
  /** Image ID key to the architecture reported for it, or null where the engine reported none. */
  private readonly archs = new Map<string, string | null>();

  /** Whether this container's binary has already been given up on, so the caller can go straight to the script. */
  isRejected(host: HostCtx, containerId: string): boolean {
    return this.rejected.has(containerKey(host, containerId));
  }

  /** Remembers that this container's binary does not work, so every later connection runs the script. */
  reject(host: HostCtx, containerId: string): void {
    this.rejected.add(containerKey(host, containerId));
    this.trim();
  }

  /** Drops the path of a binary that was placed but could not run, so the next attempt writes it again. */
  forget(host: HostCtx, containerId: string): void {
    this.placed.delete(containerKey(host, containerId));
  }

  /**
   * The path of the relay in this container, placed on the first call and shared by every call that overlaps it. Null
   * when this image's architecture has no embedded build, or when the write itself failed: the caller falls back.
   */
  place(host: HostCtx, containerId: string, imageId: string | null): Promise<string | null> {
    const key = containerKey(host, containerId);
    const pending = this.placing.get(key);
    if (pending) return pending;
    const placed = this.placed.get(key);
    if (placed !== undefined) return Promise.resolve(placed);
    const work = (async () => {
      try {
        const relay = placeRelay(await this.archOf(host, containerId, imageId));
        if (relay === null) return null;
        await host.runtime.writeContainerFile(containerId, relay.path, relay.bytes, { user: "dev", mode: 0o755 });
        this.placed.set(key, relay.path);
        this.trim();
        return relay.path;
      } catch {
        return null;
      }
    })();
    this.placing.set(key, work);
    return this.settle(key, work);
  }

  /** Drops the in-flight entry once the write settles, so a later connection places again rather than reading a stale null. */
  private async settle(key: string, work: Promise<string | null>): Promise<string | null> {
    try {
      return await work;
    } finally {
      this.placing.delete(key);
    }
  }

  /**
   * Records which implementation a container's traffic used, and says whether that is news: false when this container
   * had already settled on the same one, so the caller reports a container's choice once and stays silent after.
   */
  select(host: HostCtx, containerId: string, relay: RelayKind): boolean {
    const key = containerKey(host, containerId);
    if (this.chosen.get(key) === relay) return false;
    this.chosen.set(key, relay);
    this.trim();
    return true;
  }

  /** Reads the container's actual image ID for legacy specs without a digest, never its mutable template tag. */
  private async archOf(host: HostCtx, containerId: string, imageId: string | null): Promise<string | undefined> {
    try {
      const image = imageId ?? (await host.runtime.inspectContainer(containerId)).imageId;
      const key = `${host.host.id}:${image}`;
      if (this.archs.has(key)) return this.archs.get(key) ?? undefined;
      const arch = (await host.runtime.inspectImage(image)).arch;
      const known = arch === "" || arch === "unknown" ? null : arch;
      this.archs.set(key, known);
      this.trim();
      return known ?? undefined;
    } catch {
      return undefined;
    }
  }

  private trim(): void {
    for (const cache of [this.placed, this.rejected, this.chosen, this.archs]) {
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
  }
}

/** The key every record above uses for one engine's container. */
function containerKey(host: HostCtx, containerId: string): string {
  return `${host.host.id}:${containerId}`;
}
