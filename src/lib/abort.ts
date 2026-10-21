/** The error a cancelled task throws so the executor can tell it from a failed one. */
export function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/** True for the cancellation error, including one that crossed a promise boundary. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Rejects with the cancellation error as soon as `signal` aborts, even if `promise` never settles. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
