/**
 * The usage figures the console shows for a volume: the bar, the trend, the limit and the limits form. Pure, so the rules
 * can be tested without a browser. The server decides each level; these functions only read it back, and turn the form
 * into a limits request. A soft limit is best effort, not a quota, and the console says so next to the form.
 */

const GIB = 1024 ** 3;

/**
 * A volume's usage as the console reads it. `limit` is the hard limit when one is set, else the soft one, else null, and
 * `kind` says which. `scale` is that limit's bytes, which the bar and the trend are drawn against. `shared` is true for
 * an NFS volume, whose figure is the usage of the whole share.
 */
export function usageSummary(volume) {
  const hard = volume.limits?.hardBytes ?? null;
  const soft = volume.limits?.softBytes ?? null;
  const limit = hard !== null ? { kind: "hard", bytes: hard } : soft !== null ? { kind: "soft", bytes: soft } : null;
  return {
    bytes: volume.bytes ?? null,
    limit,
    scale: limit?.bytes ?? null,
    level: volume.usage?.level ?? "unknown",
    history: volume.usage?.history ?? [],
    shared: volume.usage?.scope === "share",
  };
}

/** The bar's fill, from 0 to 100, against the scale. Null when there is no reading or no scale to read it against. */
export function fillPercent(bytes, scale) {
  if (bytes == null || !scale) return null;
  return Math.min(100, Math.max(0, (bytes / scale) * 100));
}

/**
 * The trend's points from 0 to 100. Against the scale when there is one, else against the largest point, so a volume
 * without a limit still shows its shape.
 */
export function trendValues(points, scale) {
  const top = scale ?? Math.max(0, ...points.map((point) => point.bytes));
  if (!top) return points.map(() => 0);
  return points.map((point) => Math.min(100, (point.bytes / top) * 100));
}

/** The bar's colour class for a level: `crit` over the hard limit, `warn` over the soft one, none otherwise. */
export function levelClass(level) {
  if (level === "hard") return "crit";
  if (level === "soft") return "warn";
  return "";
}

/** The label key of a level's badge, or null for a level with no badge. */
export function levelLabelKey(level) {
  if (level === "hard") return "vol.overHard";
  if (level === "soft") return "vol.overSoft";
  return null;
}

/** A limit typed in GiB as bytes. Empty is no limit. Anything that is not a positive whole number of bytes is refused. */
export function bytesOfGb(text) {
  const value = String(text ?? "").trim();
  if (value === "") return { ok: true, bytes: null };
  const gb = Number(value);
  const bytes = Math.round(gb * GIB);
  if (!(gb > 0) || !Number.isSafeInteger(bytes)) return { ok: false, key: "vol.limitInvalid" };
  return { ok: true, bytes };
}

/** The request body for a limits form, or the translation key of the first thing wrong with it. */
export function limitsBody({ soft, hard, action }) {
  const softLimit = bytesOfGb(soft);
  if (!softLimit.ok) return { error: softLimit.key };
  const hardLimit = bytesOfGb(hard);
  if (!hardLimit.ok) return { error: hardLimit.key };
  if (softLimit.bytes !== null && hardLimit.bytes !== null && softLimit.bytes > hardLimit.bytes) {
    return { error: "vol.limitOrder" };
  }
  return {
    body: { softBytes: softLimit.bytes, hardBytes: hardLimit.bytes, action: action === "stop" ? "stop" : "warn" },
  };
}

/** The starting values of the limits form for a volume's limits, with each limit in GiB as text. */
export function limitDraft(limits) {
  return {
    soft: gbText(limits?.softBytes ?? null),
    hard: gbText(limits?.hardBytes ?? null),
    action: limits?.action === "stop" ? "stop" : "warn",
  };
}

/** Full precision, so a form saved without changes sends the limit back as it was stored. */
function gbText(bytes) {
  if (bytes === null) return "";
  return String(bytes / GIB);
}
