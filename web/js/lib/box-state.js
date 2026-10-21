/**
 * The box list as the pages keep it. A `box` frame carries a box's view without its usage, so the usage the list already
 * holds is kept, and each `sample` frame replaces it. Both return what the page should draw. The list stays sorted by
 * name, as the server sorts it.
 */

const byName = (a, b) => a.name.localeCompare(b.name);

/** The list after one `box` frame: the view replaces the box it names, or is added, and a removal drops it. */
export function applyBoxFrame(boxes, frame) {
  const rest = boxes.filter((box) => box.boxId !== frame.boxId);
  if (frame.op === "remove") return rest;
  const previous = boxes.find((box) => box.boxId === frame.boxId);
  const stats = frame.box.running ? (previous?.stats ?? null) : null;
  return [...rest, { ...frame.box, stats }].toSorted(byName);
}

/** Gives each box its usage from `samples`. Returns whether any box in the list changed. */
export function applySamples(boxes, samples) {
  let changed = false;
  for (const sample of samples) {
    const box = boxes.find((item) => item.boxId === sample.boxId);
    if (!box) continue;
    box.stats = {
      cpuPercent: sample.cpuPercent,
      memUsage: sample.memUsage,
      memLimit: sample.memLimit,
      memPercent: sample.memPercent,
    };
    changed = true;
  }
  return changed;
}

/** The boxes a `sync` frame holds, or `null` while a host's cache is not current and the page should keep its list. */
export function boxesOfSync(frame) {
  if (!frame.hosts.every((host) => host.state === "live")) return null;
  return frame.hosts.flatMap((host) => host.boxes).toSorted(byName);
}
