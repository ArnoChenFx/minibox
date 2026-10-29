import { detectCommand, shellQuote } from "./commands";
import { TOOLS_PREFIX, type CatalogEntry } from "./types";

/** Seconds one entry's detect command may run inside the batch. */
const DETECT_PROBE_SEC = 20;

const RECORD = "MBTOOL";

export interface DetectResult {
  installed: boolean;
  installedVersion: string | null;
  managed: boolean;
}

/**
 * One `sh` script that runs every entry's detect command in the PATH of the image it runs in, and prints one
 * tab-separated record per entry: the marker, the id, the exit status, whether the entry point is on the tools volume,
 * and the first non-empty line of output. One helper answers for the whole catalog.
 */
export function detectScript(entries: CatalogEntry[], prefix = TOOLS_PREFIX): string {
  return entries
    .map((entry) => {
      const probe = `timeout ${DETECT_PROBE_SEC} sh -c ${shellQuote(detectCommand(entry))} 2>/dev/null`;
      return [
        `out=$(${probe}); rc=$?`,
        `managed=0; [ -e ${shellQuote(`${prefix}/bin/${entry.bin}`)} ] && managed=1`,
        `line=$(printf '%s\\n' "$out" | sed -n '/./{p;q;}')`,
        `printf '${RECORD}\\t%s\\t%s\\t%s\\t%s\\n' ${shellQuote(entry.id)} "$rc" "$managed" "$line"`,
      ].join("\n");
    })
    .join("\n");
}

/** Reads the records `detectScript` printed. Other output, such as shell warnings, is ignored. */
export function parseDetectOutput(logs: string): Map<string, DetectResult> {
  const found = new Map<string, DetectResult>();
  for (const line of logs.split("\n")) {
    if (!line.startsWith(`${RECORD}\t`)) continue;
    const [, id, status, managed, ...rest] = line.split("\t");
    if (!id) continue;
    const version = rest.join("\t").trim();
    found.set(id, {
      installed: status === "0",
      installedVersion: version || null,
      managed: managed === "1",
    });
  }
  return found;
}
