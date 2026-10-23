import {
  type CliIo,
  request,
  fail,
  OUTPUT_SWITCHES,
  type Options,
  parseOptions,
  numberOption,
  readStdinText,
} from "./shared";
import { followTask } from "./task";

export async function boxLs(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const asJson = argv.includes("--json");
  const res = await request(env, "GET", "/api/boxes?stats=false");
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  const boxes = (res.json as { boxes?: Record<string, unknown>[] } | null)?.boxes ?? [];
  if (asJson) {
    io.stdout(`${JSON.stringify(res.json)}\n`);
    return 0;
  }
  io.stdout("NAME  STATE  RUNNING  IMAGE  ID\n");
  for (const box of boxes) {
    const id = String(box.id ?? "");
    io.stdout(
      `${String(box.name ?? "")}  ${String(box.state ?? "")}  ${String(box.running)}  ${String(box.image ?? "")}  ${id.slice(0, 12)}\n`,
    );
  }
  return 0;
}

const BOX_CREATE_VALUE_FLAGS = [
  "--template",
  "--cpus",
  "--memory",
  "--profile",
  "--egress",
  "--egress-preset",
  "--egress-domain",
  "--repo",
  "--branch",
  "--secret",
  "--startup-command",
];

const BOX_CREATE_SWITCHES = [...OUTPUT_SWITCHES, "--startup-command-stdin"];

/** Every value a repeatable flag names, in the order given. `parseOptions` keeps only the last one. */
function repeatedValues(argv: string[], flag: string): string[] {
  return argv.flatMap((token, index) => (token === flag ? [argv[index + 1] ?? ""] : []));
}

/** `--egress` names the tier. The presets and domains of `proxy-only` may repeat, and mean nothing without a tier. */
function egressOption(argv: string[], options: Options): Record<string, unknown> | undefined {
  const mode = options.values.get("--egress");
  const presets = repeatedValues(argv, "--egress-preset");
  const domains = repeatedValues(argv, "--egress-domain");
  if (mode === undefined) {
    if (presets.length > 0 || domains.length > 0) {
      throw new Error("minibox box create takes --egress-preset and --egress-domain only with --egress");
    }
    return undefined;
  }
  return {
    mode,
    ...(presets.length > 0 ? { presets } : {}),
    ...(domains.length > 0 ? { domains } : {}),
  };
}

export async function boxCreateCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, BOX_CREATE_VALUE_FLAGS, BOX_CREATE_SWITCHES);
  const [name, ...more] = options.positional;
  if (!name || more.length > 0) throw new Error("minibox box create needs one box name");
  const inline = options.values.get("--startup-command");
  const fromStdin = options.switches.has("--startup-command-stdin");
  if (inline !== undefined && fromStdin) {
    throw new Error("minibox box create takes --startup-command or --startup-command-stdin, not both");
  }
  const url = options.values.get("--repo");
  if (url === undefined && (options.values.has("--branch") || options.values.has("--secret"))) {
    throw new Error("minibox box create takes --branch and --secret only with --repo");
  }
  const body: Record<string, unknown> = { name };
  const template = options.values.get("--template");
  if (template !== undefined) body.template = template;
  const cpus = numberOption(options, "--cpus");
  if (cpus !== undefined) body.cpus = cpus;
  const memoryMb = numberOption(options, "--memory");
  if (memoryMb !== undefined) body.memoryMb = memoryMb;
  const profile = options.values.get("--profile");
  if (profile !== undefined) body.profile = profile;
  const egress = egressOption(argv, options);
  if (egress !== undefined) body.egress = egress;
  if (url !== undefined) {
    const repo: Record<string, string> = { url };
    const branch = options.values.get("--branch");
    const secret = options.values.get("--secret");
    if (branch !== undefined) repo.branch = branch;
    if (secret !== undefined) repo.secretRef = secret;
    body.repo = repo;
  }
  if (inline !== undefined) body.startupCommand = inline;
  if (fromStdin) body.startupCommand = await readStdinText(io);

  const res = await request(env, "POST", "/api/boxes", body);
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  const created = res.json as { box: { name: string }; clone?: { taskId: string } };
  const asJson = options.switches.has("--json");
  io.stdout(asJson ? `${JSON.stringify(res.json)}\n` : `${created.box.name}\n`);
  if (!created.clone) return 0;
  if (options.switches.has("--no-wait")) {
    io.stderr(`The clone runs as task ${created.clone.taskId}\n`);
    return 0;
  }
  const task = await followTask(env, io, created.clone.taskId);
  if (!task) return 1;
  if (task.status === "succeeded") return 0;
  io.stderr(`${created.box.name} was created, but its clone did not finish: ${task.error?.message ?? task.status}\n`);
  return 1;
}
