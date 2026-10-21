import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Bun's `idleTimeout` is a hard cap measured from the start of the request. uWebSockets rounds it up to a multiple of
 * 4 seconds, so a timeout of 1 still closes at about 4 seconds, and a timeout of 4 closes at 4. Writes, including SSE
 * heartbeats, do not extend it. `server.timeout(req, 0)` disables it.
 *
 * Checked on Bun 1.4.3 with a separate process: a silent handler and a stream that writes every second both fail with
 * ECONNRESET at about 4 seconds, while `server.timeout(req, 0)` survives a longer sleep. The same-process `fetch`
 * hides the shorter timeouts, so this test uses a child process. Production stays at 60 seconds
 * (`src/server.ts`); long work returns 202 and the progress stream disables the timer, so the request that would
 * have been held open for the whole build no longer exists.
 */
const SCRIPT = `
const started = Date.now();
try {
  const res = await fetch(process.argv[2]);
  const text = await res.text();
  console.log(JSON.stringify({ ok: true, status: res.status, ms: Date.now() - started, text }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ ok: false, ms: Date.now() - started, message }));
}
`;

async function fetchFromChild(
  url: string,
): Promise<{ ok: boolean; status?: number; ms: number; text?: string; message?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "minibox-idle-"));
  const script = join(dir, "fetch.ts");
  writeFileSync(script, SCRIPT);
  const proc = Bun.spawn(["bun", script, url], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0 && !out.trim()) throw new Error(err || `child exited ${code}`);
  return JSON.parse(out) as { ok: boolean; status?: number; ms: number; text?: string; message?: string };
}

describe("Bun idleTimeout", () => {
  test("a silent request and a heartbeat stream die at the cap, and timeout 0 does not", async () => {
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      idleTimeout: 4,
      async fetch(req, srv) {
        const path = new URL(req.url).pathname;
        if (path === "/zero") {
          srv.timeout(req, 0);
          await Bun.sleep(5000);
          return new Response("ok");
        }
        if (path === "/beat") {
          let timer: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              timer = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode(": keep-alive\n\n"));
                } catch {
                  if (timer) clearInterval(timer);
                }
              }, 1000);
              setTimeout(() => {
                if (timer) clearInterval(timer);
                try {
                  controller.close();
                } catch {
                  /* the idle timer already closed it */
                }
              }, 8000);
            },
            cancel() {
              if (timer) clearInterval(timer);
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        await Bun.sleep(8000);
        return new Response("late");
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const [hang, beat, zero] = await Promise.all([
        fetchFromChild(`${base}/hang`),
        fetchFromChild(`${base}/beat`),
        fetchFromChild(`${base}/zero`),
      ]);
      expect(hang.ok).toBe(false);
      expect(hang.message ?? "").toMatch(/ECONNRESET|closed|reset/i);
      // The 4s step can land a little early when the machine is busy. It must still be the idle cap, not an instant
      // failure and not the 8s the handler would have slept.
      expect(hang.ms).toBeGreaterThan(1500);
      expect(hang.ms).toBeLessThan(6500);
      expect(beat.ok).toBe(false);
      expect(beat.ms).toBeGreaterThan(1500);
      expect(beat.ms).toBeLessThan(6500);
      expect(zero).toMatchObject({ ok: true, status: 200, text: "ok" });
      expect(zero.ms).toBeGreaterThan(4800);
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
