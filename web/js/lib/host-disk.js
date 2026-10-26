/**
 * The four classes `docker system df` counts, in the order the console lists them. `label` is the dictionary key.
 * `key` is the field of a reading's `breakdown`, as `GET /api/hosts/{id}/disk` reports it.
 */
export const DISK_CLASSES = [
  { key: "images", label: "st.disk.images" },
  { key: "containers", label: "st.disk.containers" },
  { key: "volumes", label: "st.disk.volumes" },
  { key: "buildCache", label: "st.disk.buildCache" },
];

/** A share of the whole, or 0 when the engine did not report a total it can be measured against. */
const share = (part, total) =>
  typeof total === "number" && total > 0 && typeof part === "number" ? (part / total) * 100 : 0;

/**
 * What one host's reading draws. `reason` is the dictionary key and params that say why there is no reading, or null
 * when there is one. `rows` holds one entry per class the engine reported, with the bytes already formatted by `format`:
 * a class, or a figure, the engine left out is skipped rather than drawn as zero.
 */
export function diskReading(disk, format) {
  if (!disk) return { reason: { key: "st.disk.unread", params: {} }, rows: [] };
  if (disk.supported === false) return { reason: { key: "st.disk.agentHost", params: {} }, rows: [] };
  if (!disk.breakdown) {
    const reason = disk.reason ?? "engine";
    return {
      reason: {
        key: `st.disk.${reason}`,
        params: reason === "engine" && disk.detail ? { detail: disk.detail } : {},
      },
      rows: [],
    };
  }
  const rows = [];
  for (const entry of DISK_CLASSES) {
    const found = disk.breakdown[entry.key];
    if (!found || found.totalBytes == null) continue;
    const reclaimable = found.reclaimableBytes;
    rows.push({
      key: entry.key,
      label: entry.label,
      total: format(found.totalBytes),
      totalBytes: found.totalBytes,
      reclaimable: reclaimable == null ? null : format(reclaimable),
      reclaimableBytes: reclaimable ?? null,
      reclaimablePercent: Math.round(share(reclaimable, found.totalBytes)),
      count: found.count,
      activeCount: found.activeCount,
    });
  }
  return { reason: rows.length === 0 ? { key: "st.disk.empty", params: {} } : null, rows };
}

/**
 * The reading of each host, fetched at once so one host that does not answer cannot hold up the others. Each entry is
 * `{ id, disk }` or `{ id, error }`, so the caller draws every host either way.
 */
export async function diskReadings(hosts, get) {
  const settled = await Promise.all(
    hosts.map(async (host) => {
      try {
        return { id: host.id, disk: await get(host.id) };
      } catch (error) {
        return { id: host.id, error };
      }
    }),
  );
  return settled;
}
