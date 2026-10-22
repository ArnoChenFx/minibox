/**
 * Settles with `promise`, or with `late()` once `ms` has passed first. The promise is not cancelled: a helper that hangs
 * keeps running until its own timeout, and whoever awaits it moves on.
 */
export async function within<T>(promise: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late()), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}
