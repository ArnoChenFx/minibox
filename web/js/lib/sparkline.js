/** Render an SVG area sparkline for values in [0, max]. */
export function sparkline(values, { color = "var(--accent)", max = 100, height = 40, width = 240, id = "s" } = {}) {
  if (!values.length) return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"></svg>`;
  const n = Math.max(values.length, 2);
  const step = width / (n - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - (Math.min(v, max) / max) * (height - 4)]);
  if (pts.length === 1) pts.push([width, pts[0][1]]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L0,${height} Z`;
  const gid = `g-${id}`;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}
