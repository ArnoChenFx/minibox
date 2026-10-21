/**
 * Runs power changes for one box one at a time (#12): start, wake, stop, sleep, restart and delete. A wake therefore
 * cannot race a sleep, and two requests that wake the same box start its container once. Other boxes do not wait.
 * Each host context owns one instance, and a box belongs to exactly one host.
 */
export class BoxPower {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(boxId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(boxId) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(boxId, tail);
    void tail.then(() => {
      if (this.tails.get(boxId) === tail) this.tails.delete(boxId);
    });
    return result;
  }
}
