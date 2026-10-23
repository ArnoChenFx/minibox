import { lang, t } from "./i18n.js";

const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "always", style: "long" });

export function bytes(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${u[i]}`;
}

export const gb = (n) => (n == null ? "—" : `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`);
export const pct = (n, d = 1) => (n == null || Number.isNaN(n) ? "—" : `${Number(n).toFixed(d)}%`);
/** English counts one core and many cores; Chinese has one form, so its `unit.core` matches `unit.cores`. */
export const cpus = (c) =>
  c == null ? t("common.unlimited") : t(Number(c) === 1 ? "unit.core" : "unit.cores", { n: Number(c) });
export const mem = (m) => (m == null ? t("common.unlimited") : gbOrMb(m));
export function gbOrMb(b) {
  const mb = b / 1024 / 1024;
  return mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function duration(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return t("fmt.days", { d, h });
  if (h) return t("fmt.hours", { h, m });
  return t("fmt.minutes", { m: Math.max(m, 0) });
}

/** A span read to the second, such as "42s" or "3m 05s". From an hour on it reads as `duration` does. */
export function elapsed(fromIso, toMs = Date.now()) {
  const from = new Date(fromIso ?? "").getTime();
  if (Number.isNaN(from)) return "—";
  const sec = Math.max(0, Math.floor((toMs - from) / 1000));
  if (sec >= 3600) return duration(sec);
  const m = Math.floor(sec / 60);
  if (!m) return t("fmt.seconds", { s: sec });
  return t("fmt.minutesSeconds", { m, s: String(sec % 60).padStart(2, "0") });
}

export function relTime(iso) {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return t("fmt.justNow");
  if (s < 60) return rtf.format(-s, "second");
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  if (s < 86400 * 30) return rtf.format(-Math.floor(s / 86400), "day");
  return dateTime(iso);
}

export function dateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(lang, {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const shortId = (id) => (id ? id.replace(/^sha256:/, "").slice(0, 12) : "—");

export function level(p) {
  if (p >= 90) return "crit";
  if (p >= 75) return "warn";
  return "";
}
