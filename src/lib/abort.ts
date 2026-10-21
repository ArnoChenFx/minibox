/** The error a cancelled task throws so the executor can tell it from a failed one. */
export function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/** True for the cancellation error, including one that crossed a promise boundary. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
