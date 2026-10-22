/**
 * Reports the per-file durations that `bun test --timings=<file> --update-timings` wrote, slowest first. In GitHub
 * Actions it also writes a table to the job summary, and a warning annotation for each file at or over SLOW_FILE_MS.
 * It never fails the job: a slow file is a prompt to look at it, not a broken build.
 *
 *   bun scripts/test-durations.ts <timings.json>
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const SLOW_FILE_MS = 10_000;

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/test-durations.ts <timings.json>");
  process.exit(2);
}
if (!existsSync(path)) {
  console.log(`no test timings were written to ${path}`);
  process.exit(0);
}

const { files } = JSON.parse(readFileSync(path, "utf8")) as { files: Record<string, number> };
const rows = Object.entries(files).toSorted(([, a], [, b]) => b - a);
const total = rows.reduce((sum, [, ms]) => sum + ms, 0);
const slow = rows.filter(([, ms]) => ms >= SLOW_FILE_MS);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const headline = `${rows.length} files, ${seconds(total)} of file time, ${slow.length} at or over ${SLOW_FILE_MS / 1000} s`;

console.log(`test file durations: ${headline}`);
for (const [file, ms] of rows.slice(0, 15)) console.log(`${seconds(ms).padStart(8)}  ${file}`);

if (process.env.GITHUB_ACTIONS === "true") {
  for (const [file, ms] of slow) {
    console.log(
      `::warning file=${file},title=Slow test file::${file} took ${seconds(ms)}, over ${SLOW_FILE_MS / 1000} s`,
    );
  }
}

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const table = rows.map(([file, ms]) => `| \`${file}\` | ${seconds(ms)}${ms >= SLOW_FILE_MS ? " (slow)" : ""} |`);
  appendFileSync(
    summary,
    ["## Test file durations", "", headline, "", "| File | Duration |", "| --- | ---: |", ...table, ""].join("\n"),
  );
}
