import type { ExecSession } from "../runtime";

/** A stream an agent request opened, named by that request's id. */
export type OpenStream =
  | { readonly kind: "exec"; readonly session: ExecSession; readonly tty: boolean }
  | { readonly kind: "abort"; readonly abort: AbortController };

/**
 * The streams one agent connection has open, and the ids whose operation is still starting. `AgentExecutor` asks it
 * what it may open, records what it opened, and detaches what a cancel or a closed connection names; it never holds
 * this state itself.
 *
 * The invariants this class protects:
 *
 * - **An id names at most one thing at a time.** An id is either starting, open, or free. A request takes its id
 *   before its operation runs, so a second request under the same id is refused while the first is still working, and
 *   a stream keeps its id until it ends. An id that has ended is free again and can be reused.
 * - **A cancel can arrive before the stream exists, and that is not an error.** `startExec` awaits the engine, and a
 *   `cancel` for the same id can arrive while it does. Such a cancel finds nothing to detach and says nothing; it does
 *   not mark the id for a later cancel, and it does not fail the request. The request that owns the id still answers
 *   it, and the stream it opens is the one a *later* cancel or a `close()` detaches. This is why `starting` exists as
 *   its own set rather than as a value in `open`: the id is taken (so a duplicate is refused) but names no stream yet.
 * - **`close()` is final for streams and for the connection, not for ids.** It detaches every open stream without
 *   reporting an end for any of them, and an operation that is still starting when it runs ends what it opened and
 *   answers `unavailable`. A request under an id that was already open when `close()` ran is refused as an id in use,
 *   because a detaching stream keeps its id until it is drained.
 * - **Nothing is detached twice.** An exec's stream is destroyed once, whether a cancel, an end or a `close()` reaches
 *   it first; an abort-based stream's controller is aborted once, with the same rule. The registries only hand out the
 *   stream that is still recorded, so a second caller finds nothing and does nothing.
 */
export class StreamRegistry {
  private readonly streams = new Map<string, OpenStream>();
  /** Ids whose operation is still running. An id is taken until its response is sent. */
  private readonly starting = new Set<string>();
  private closed = false;

  /** Whether the connection has closed, so an operation that is still starting must not open a stream. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Takes the id for a request that is about to run, unless a stream or another request already holds it. */
  claim(id: string): boolean {
    if (this.streams.has(id) || this.starting.has(id)) return false;
    this.starting.add(id);
    return true;
  }

  /** Gives the id back once its operation has answered, whether it opened a stream or not. */
  release(id: string): void {
    this.starting.delete(id);
  }

  /** Records the stream a request opened, under the id that request took. */
  open(id: string, stream: OpenStream): void {
    this.streams.set(id, stream);
  }

  /** The stream an id names, if it is open. */
  get(id: string): OpenStream | undefined {
    return this.streams.get(id);
  }

  /** The exec session an id names, if it names one. */
  exec(id: string): ExecSession | undefined {
    const stream = this.streams.get(id);
    return stream?.kind === "exec" ? stream.session : undefined;
  }

  /** Detaches the stream an id names, leaving its process running: an exec keeps running, an abort source is stopped. */
  cancel(id: string): void {
    const stream = this.streams.get(id);
    if (stream?.kind === "abort") stream.abort.abort();
    if (stream?.kind === "exec") stream.session.stream.destroy();
  }

  /**
   * Ends a stream that has finished on its own and says whether it was still open, so the caller reports its end once
   * and never for a stream a `close()` already detached.
   */
  take(id: string): OpenStream | undefined {
    const stream = this.streams.get(id);
    if (stream === undefined) return undefined;
    this.streams.delete(id);
    if (stream.kind === "exec") stream.session.stream.destroy();
    return stream;
  }

  /** Whether an id is still open, which a stream that produces items checks before it sends the next one. */
  has(id: string): boolean {
    return this.streams.has(id);
  }

  /** The connection closed: every open stream is detached and none of them reports an end. */
  close(): void {
    this.closed = true;
    for (const stream of this.streams.values()) {
      if (stream.kind === "abort") stream.abort.abort();
      else stream.session.stream.destroy();
    }
    this.streams.clear();
  }
}
