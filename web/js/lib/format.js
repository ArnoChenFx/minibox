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
export const cpus = (c) => (c == null ? "不限" : `${Number(c)} 核`);
export const mem = (m) => (m == null ? "不限" : gbOrMb(m));
export function gbOrMb(b) {
  const mb = b / 1024 / 1024;
  return mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function duration(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分钟`;
  return `${Math.max(m, 0)} 分钟`;
}

export function relTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return dateTime(iso);
}

export function dateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", {
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
