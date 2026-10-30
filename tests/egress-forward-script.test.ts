import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FORWARD_PROBE_SCRIPT, FORWARD_REPAIR_SCRIPT, judgeForwardReport } from "../src/egress/forward";

/**
 * The two helper scripts, run for real against stand-ins for `iptables`, `ip` and `apk`. The string checks in
 * `egress-forward.test.ts` say what the scripts contain; this says what they do: in what order they touch the firewall,
 * and that a host they cannot help is left exactly as it was.
 *
 * The child's `PATH` holds only the stand-ins and a few symlinked system tools, so a machine that has a real
 * `iptables` (or `iptables-legacy`) on it is never reached, whoever runs the test and as whom.
 */

const TOOLS = ["awk", "sort", "grep", "rm", "touch", "cat", "tr", "ls"] as const;
const SH = "/bin/sh";
const CHAIN = "MINIBOX-FWD-test";
const BRIDGE = "br-1a2b3c4d5e6f";

const missing = TOOLS.filter((name) => Bun.which(name) === null);
const runnable = process.platform !== "win32" && existsSync(SH) && missing.length === 0;

/** Records every call and remembers one thing, whether the jump to MiniBox's chain is in `FORWARD`, so `-D` loops end. */
const FAKE_IPTABLES = `#!${SH}
echo "$*" >> "$FAKE_DIR/calls"
case "$*" in
  "-D FORWARD -j "*)
    if [ -e "$FAKE_DIR/jump" ]; then rm "$FAKE_DIR/jump"; exit 0; fi
    exit 1 ;;
  "-A FORWARD -j "*) touch "$FAKE_DIR/jump" ;;
  "-S") cat "$FAKE_DIR/rules" ;;
esac
exit 0
`;
/** The calls with each run of identical ones collapsed: a `-D` loop asks once more than the jumps it removes. */
const distinct = (list: readonly string[]): string[] => list.filter((call, index) => call !== list[index - 1]);

const FAKE_IP = `#!${SH}\ncat "$FAKE_DIR/routes"\n`;
const FAKE_APK = `#!${SH}\nexit 0\n`;

describe.skipIf(!runnable)("the helper scripts, run against stand-ins for the firewall", () => {
  let root = "";
  let stubs = "";
  let bare = "";
  let fake = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "minibox-forward-script-"));
    stubs = join(root, "stubs");
    bare = join(root, "bare");
    mkdirSync(stubs);
    mkdirSync(bare);
    for (const [dir, files] of [
      [stubs, { iptables: FAKE_IPTABLES, ip: FAKE_IP, apk: FAKE_APK }],
      [bare, { ip: FAKE_IP, apk: FAKE_APK }],
    ] as const) {
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(dir, name), body);
        chmodSync(join(dir, name), 0o755);
      }
      for (const tool of TOOLS) symlinkSync(Bun.which(tool) ?? "", join(dir, tool));
    }
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    fake = mkdtempSync(join(root, "run-"));
    writeFileSync(join(fake, "routes"), "");
    writeFileSync(join(fake, "rules"), "");
  });

  const calls = (): string[] =>
    existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : [];
  const jumpInForward = () => existsSync(join(fake, "jump"));

  function run(script: string, env: Record<string, string>, dir = stubs) {
    const result = Bun.spawnSync([SH, "-c", script], {
      env: { PATH: dir, FAKE_DIR: fake, MINIBOX_FORWARD_CHAIN: CHAIN, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  }

  const repair = (bridge: string, routes: string, dir?: string) => {
    writeFileSync(join(fake, "routes"), routes);
    return run(FORWARD_REPAIR_SCRIPT, { MINIBOX_UPLINK_BRIDGE: bridge }, dir);
  };

  const ETH0 = "default via 10.0.0.1 dev eth0 proto dhcp metric 100\n";

  test("a host with no default route is refused before the firewall is touched, and keeps the jump it had", () => {
    writeFileSync(join(fake, "jump"), "");
    const result = repair(BRIDGE, "");
    expect(result.code).toBe(3);
    expect(result.err).toContain("no IPv4 default route");
    // Not even the removal of an older jump: a refusal that took the working rule away would be worse than no repair.
    expect(calls()).toEqual([]);
    expect(jumpInForward()).toBe(true);
  });

  test("the chain is filled first and the jump to it is appended last, never inserted", () => {
    const result = repair(BRIDGE, ETH0);
    expect(result.code).toBe(0);
    expect(distinct(calls())).toEqual([
      "-S FORWARD",
      `-D FORWARD -j ${CHAIN}`,
      `-N ${CHAIN}`,
      `-F ${CHAIN}`,
      `-A ${CHAIN} -i ${BRIDGE} -o eth0 -j ACCEPT`,
      `-A ${CHAIN} -i eth0 -o ${BRIDGE} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
      `-A FORWARD -j ${CHAIN}`,
    ]);
    expect(calls().some((call) => call.startsWith("-I "))).toBe(false);
    expect(jumpInForward()).toBe(true);
  });

  test("a jump an older MiniBox inserted at the top is taken out and put back at the end, once", () => {
    writeFileSync(join(fake, "jump"), "");
    expect(repair(BRIDGE, ETH0).code).toBe(0);
    const added = calls().filter((call) => call === `-A FORWARD -j ${CHAIN}`);
    expect(added).toHaveLength(1);
    expect(calls().indexOf(`-D FORWARD -j ${CHAIN}`)).toBeLessThan(calls().indexOf(added[0] ?? ""));
    expect(jumpInForward()).toBe(true);
  });

  test("each interface the default route leaves through gets its own pair of rules, and nothing else is accepted", () => {
    const routes = "default via 10.0.0.1 dev eth0 metric 100\ndefault via 10.1.0.1 dev wg0 metric 200\n";
    expect(repair(BRIDGE, routes).code).toBe(0);
    const accepted = calls().filter((call) => call.startsWith(`-A ${CHAIN} `));
    expect(accepted).toEqual([
      `-A ${CHAIN} -i ${BRIDGE} -o eth0 -j ACCEPT`,
      `-A ${CHAIN} -i eth0 -o ${BRIDGE} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
      `-A ${CHAIN} -i ${BRIDGE} -o wg0 -j ACCEPT`,
      `-A ${CHAIN} -i wg0 -o ${BRIDGE} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
    ]);
    // `! -o <bridge>` is what let a box reach another bridge on the host; no rule may say it.
    expect(calls().some((call) => call.includes("!"))).toBe(false);
  });

  test("an empty bridge takes the jump and the chain away, on a host with or without a default route", () => {
    for (const routes of [ETH0, ""]) {
      writeFileSync(join(fake, "jump"), "");
      rmSync(join(fake, "calls"), { force: true });
      expect(repair("", routes).code).toBe(0);
      expect(distinct(calls())).toEqual(["-S FORWARD", `-D FORWARD -j ${CHAIN}`, `-F ${CHAIN}`, `-X ${CHAIN}`]);
      expect(jumpInForward()).toBe(false);
    }
  });

  test("a helper image with no iptables at all is a failure, not a repair that changed nothing and said so", () => {
    const result = repair(BRIDGE, ETH0, bare);
    expect(result.code).toBe(4);
    expect(result.err).toContain("no iptables binary");
  });

  test("the probe's report is what judgeForwardReport reads: interfaces, the default route, then the rules", () => {
    writeFileSync(join(fake, "routes"), ETH0);
    writeFileSync(join(fake, "rules"), "-P INPUT ACCEPT\n-P FORWARD DROP\n-P OUTPUT ACCEPT\n");
    const probe = run(FORWARD_PROBE_SCRIPT, {});
    expect(probe.code).toBe(0);
    expect(calls()).toEqual(["-S"]);
    const verdict = judgeForwardReport(probe.out, { bridge: BRIDGE, source: "240.0.0.2" });
    expect(verdict.egress).toEqual(["eth0"]);
    expect(verdict).toMatchObject({ dropped: true, cause: "policy" });
    expect(verdict.backends.map((backend) => backend.backend)).toEqual(["iptables"]);
  });
});
