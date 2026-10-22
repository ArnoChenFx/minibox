import { z } from "zod";

import { agentsPath, readSecretFile, SECRET_FILE_MODE, writeFileAtomic } from "../../data-dir";
import { AGENT_ID_RE } from "../endpoint";

export const AgentRecordSchema = z
  .object({
    agentId: z.string().regex(AGENT_ID_RE),
    hostId: z.string().min(1).max(32),
    publicKeyPem: z.string().min(1).max(2048),
    version: z.string().max(64),
    protocol: z.number().int(),
    pairedAt: z.string().min(1).max(64),
    lastSeenAt: z.string().max(64).nullable(),
    revokedAt: z.string().max(64).nullable(),
  })
  .strict();
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

const AgentsFileSchema = z.object({ version: z.literal(1), agents: z.array(AgentRecordSchema) }).strict();

/** The file cannot be used as it is. The message names the file so the operator can fix or remove it. */
export class AgentsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentsFileError";
  }
}

/**
 * The paired agents: their public keys, the host each one serves, and whether it was revoked. A private key never
 * reaches the control plane, so the file holds nothing that proves an identity on its own.
 */
export class AgentStore {
  private readonly records = new Map<string, AgentRecord>();

  constructor(private readonly dataDir: string) {
    const path = agentsPath(dataDir);
    const text = readSecretFile(path);
    if (text === null) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new AgentsFileError(`${path} is not valid JSON (${String(e)}). Fix or remove it.`);
    }
    const parsed = AgentsFileSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? issue.path.join(".") : "the file";
      throw new AgentsFileError(`${path} does not match the agents format at ${where}. Fix or remove it.`);
    }
    for (const record of parsed.data.agents) this.records.set(record.agentId, record);
  }

  get(agentId: string): AgentRecord | undefined {
    return this.records.get(agentId);
  }

  list(): AgentRecord[] {
    return [...this.records.values()];
  }

  put(record: AgentRecord): void {
    this.mutate(() => this.records.set(record.agentId, record));
  }

  update(agentId: string, patch: Partial<Omit<AgentRecord, "agentId">>): void {
    const current = this.records.get(agentId);
    if (!current) throw new Error(`unknown agent: ${agentId}`);
    this.mutate(() => this.records.set(agentId, { ...current, ...patch }));
  }

  remove(agentId: string): void {
    this.mutate(() => this.records.delete(agentId));
  }

  /** Applies a change and writes the file. A write that fails leaves the records as they were. */
  private mutate(change: () => void): void {
    const before = new Map(this.records);
    change();
    try {
      writeFileAtomic(
        agentsPath(this.dataDir),
        `${JSON.stringify({ version: 1, agents: this.list() }, null, 2)}\n`,
        SECRET_FILE_MODE,
      );
    } catch (e) {
      this.records.clear();
      for (const [id, record] of before) this.records.set(id, record);
      throw e;
    }
  }
}
