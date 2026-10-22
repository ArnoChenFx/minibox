import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { DIR_MODE, hostsPath, readSecretFile, SECRET_FILE_MODE, writeFileAtomic } from "../data-dir";
import { type Endpoint, parseEndpoint } from "./endpoint";
import { LOCAL_HOST_ID } from "./registry";

function endpointOrNull(raw: string): Endpoint | null {
  try {
    return parseEndpoint(raw);
  } catch {
    return null;
  }
}

/** A host id is the only name a host has in the API and in every record, so it is short and stable. */
export const HOST_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** What `hosts.json` records about one remote host. The credentials are not in it. */
export interface StoredHost {
  readonly id: string;
  readonly name: string;
  /** The endpoint without any credential, as `endpointLabel` writes it. */
  readonly endpoint: string;
  /** The SSH host key the host was added with, as `SHA256:…`. Null for TLS and unix hosts. */
  readonly hostKeyFingerprint: string | null;
  readonly createdAt: string;
}

/** Credential files of one host, by the name the caller gives. Each is written mode 600 under `hosts/<id>`. */
export const CREDENTIAL_FILES = {
  ca: "ca.pem",
  cert: "cert.pem",
  key: "key.pem",
  sshKey: "ssh_key",
} as const;

const StoredHostSchema = z
  .object({
    id: z.string().regex(HOST_ID_RE),
    name: z.string().trim().min(1).max(64),
    endpoint: z.string().min(1).max(512),
    hostKeyFingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]+$/)
      .nullable(),
    createdAt: z.string().min(1),
  })
  .strict();

const HostsFileSchema = z.object({ version: z.literal(1), hosts: z.array(StoredHostSchema) }).strict();

/** The file cannot be used as it is. The message names the file so the operator can fix or remove it. */
export class HostsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostsFileError";
  }
}

export class HostStore {
  constructor(private readonly dataDir: string) {}

  /** Every stored host. A missing or blank file holds none. A file that cannot be read is an error, never an empty list. */
  load(): StoredHost[] {
    const path = hostsPath(this.dataDir);
    const text = readSecretFile(path);
    if (text === null) return [];
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new HostsFileError(`${path} is not valid JSON (${String(e)}). Fix or remove it.`);
    }
    const parsed = HostsFileSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? issue.path.join(".") : "the file";
      throw new HostsFileError(`${path} does not match the hosts format at ${where}. Fix or remove it.`);
    }
    const seen = new Set<string>();
    for (const host of parsed.data.hosts) {
      if (host.id === LOCAL_HOST_ID || seen.has(host.id)) {
        throw new HostsFileError(
          `${path} lists host ${host.id} more than once or uses a reserved id. Fix or remove it.`,
        );
      }
      seen.add(host.id);
      const endpoint = endpointOrNull(host.endpoint);
      if (endpoint === null)
        throw new HostsFileError(`${path} has an endpoint for ${host.id} that is not valid. Fix or remove it.`);
      if ((endpoint.kind === "ssh") !== (host.hostKeyFingerprint !== null)) {
        throw new HostsFileError(
          `${path} has a host key for ${host.id} that does not match its endpoint. Fix or remove it.`,
        );
      }
    }
    return parsed.data.hosts;
  }

  /** Replaces the file. The file is mode 600 even though it holds no secret, since it names the machines. */
  save(hosts: readonly StoredHost[]): void {
    writeFileAtomic(hostsPath(this.dataDir), `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`, SECRET_FILE_MODE);
  }

  /** The directory that holds one host's credential files. */
  credentialDir(id: string): string {
    return join(this.dataDir, "hosts", id);
  }

  /** Writes the given credential files for a host, replacing any earlier ones. Each file is mode 600. */
  writeCredentials(id: string, files: Readonly<Partial<Record<keyof typeof CREDENTIAL_FILES, string>>>): void {
    const dir = this.credentialDir(id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    for (const [name, contents] of Object.entries(files)) {
      const file = CREDENTIAL_FILES[name as keyof typeof CREDENTIAL_FILES];
      writeFileAtomic(join(dir, file), `${contents.trim()}\n`, SECRET_FILE_MODE);
    }
  }

  /** The trimmed contents of one credential file, or `null` when it is missing. */
  readCredential(id: string, name: keyof typeof CREDENTIAL_FILES): string | null {
    return readSecretFile(join(this.credentialDir(id), CREDENTIAL_FILES[name]));
  }

  removeCredentials(id: string): void {
    rmSync(this.credentialDir(id), { recursive: true, force: true });
  }
}
