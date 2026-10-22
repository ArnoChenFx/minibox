import { type CliIo, flagValue, request, fail } from "./shared";

export async function filesCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub.startsWith("--")) throw new Error("minibox files needs ls, read, write, cp, download or upload");
  if (sub === "ls") {
    const volume = rest[0];
    if (!volume || volume.startsWith("--")) throw new Error("minibox files ls needs a volume");
    let path: string | undefined;
    let depth: string | undefined;
    let limit: string | undefined;
    let asJson = false;
    for (let i = 1; i < rest.length; i++) {
      const token = rest[i];
      if (token === undefined) break;
      if (token === "--json") asJson = true;
      else if (token === "--path") path = flagValue(rest, i++, "--path");
      else if (token === "--depth") depth = flagValue(rest, i++, "--depth");
      else if (token === "--limit") limit = flagValue(rest, i++, "--limit");
      else throw new Error(`Unknown option ${token}`);
    }
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    if (depth) query.set("maxDepth", depth);
    if (limit) query.set("limit", limit);
    const q = query.toString();
    const res = await request(env, "GET", `/api/volumes/${encodeURIComponent(volume)}/files${q ? `?${q}` : ""}`);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) {
      io.stdout(`${JSON.stringify(res.json)}\n`);
      return 0;
    }
    const body = res.json as { entries?: { path: string; type: string; size: number | null }[] };
    for (const entry of body.entries ?? []) {
      const size = entry.size === null ? "-" : String(entry.size);
      io.stdout(`${entry.type}\t${size}\t${entry.path}\n`);
    }
    return 0;
  }
  if (sub === "read") {
    const volume = rest[0];
    const filePath = rest[1];
    if (!volume || !filePath) throw new Error("minibox files read needs a volume and a path");
    let encoding = "utf-8";
    for (let i = 2; i < rest.length; i++) {
      const token = rest[i];
      if (token === undefined) break;
      if (token === "--encoding") encoding = flagValue(rest, i++, "--encoding");
      else throw new Error(`Unknown option ${token}`);
    }
    const query = new URLSearchParams({ path: filePath, encoding });
    const res = await request(env, "GET", `/api/volumes/${encodeURIComponent(volume)}/files/content?${query}`);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    const body = res.json as { content?: string };
    io.stdout(body.content ?? "");
    if (encoding === "utf-8" && body.content && !body.content.endsWith("\n")) io.stdout("\n");
    return 0;
  }
  if (sub === "write") {
    const volume = rest[0];
    const filePath = rest[1];
    if (!volume || !filePath) throw new Error("minibox files write needs a volume and a path");
    let encoding = "utf-8";
    let content: string | undefined;
    let fromStdin = false;
    for (let i = 2; i < rest.length; i++) {
      const token = rest[i];
      if (token === undefined) break;
      if (token === "--encoding") encoding = flagValue(rest, i++, "--encoding");
      else if (token === "--content") content = flagValue(rest, i++, "--content");
      else if (token === "--stdin") fromStdin = true;
      else throw new Error(`Unknown option ${token}`);
    }
    if (fromStdin === (content !== undefined)) {
      throw new Error("minibox files write needs exactly one of --content or --stdin");
    }
    if (fromStdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      content = encoding === "base64" ? raw.toString("base64") : raw.toString("utf8");
    }
    const res = await request(env, "PUT", `/api/volumes/${encodeURIComponent(volume)}/files/content`, {
      path: filePath,
      content,
      encoding,
    });
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    const body = res.json as { bytesWritten?: number };
    io.stdout(`${body.bytesWritten ?? 0}\n`);
    return 0;
  }
  if (sub === "cp") {
    const volume = rest[0];
    const from = rest[1];
    const to = rest[2];
    if (!volume || !from || !to) throw new Error("minibox files cp needs a volume, from and to");
    const res = await request(env, "POST", `/api/volumes/${encodeURIComponent(volume)}/files/copy`, { from, to });
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    io.stdout(`${from} -> ${to}\n`);
    return 0;
  }
  if (sub === "download") {
    const volume = rest[0];
    if (!volume) throw new Error("minibox files download needs a volume");
    const filePath = rest[1] && !rest[1].startsWith("--") ? rest[1] : "/";
    const query = new URLSearchParams();
    if (filePath) query.set("path", filePath);
    const res = await request(env, "GET", `/api/volumes/${encodeURIComponent(volume)}/files/archive?${query}`);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    const body = res.json as { content?: string };
    io.stdout(`${body.content ?? ""}\n`);
    return 0;
  }
  if (sub === "upload") {
    const volume = rest[0];
    if (!volume) throw new Error("minibox files upload needs a volume");
    const filePath = rest[1] && !rest[1].startsWith("--") ? rest[1] : "/";
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks).toString("utf8").trim();
    const res = await request(env, "PUT", `/api/volumes/${encodeURIComponent(volume)}/files/archive`, {
      path: filePath,
      content,
      encoding: "base64",
    });
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    const body = res.json as { bytes?: number };
    io.stdout(`${body.bytes ?? 0}\n`);
    return 0;
  }
  throw new Error(`Unknown files subcommand ${sub}`);
}
