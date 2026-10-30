import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { DIR_MODE, readSecretFile, SECRET_FILE_MODE, writeFileAtomic } from "../data-dir";
import { log } from "../lib/logger";
import {
  type ContainerInfo,
  type NetworkSummary,
  RuntimeError,
  type Runtime,
  type RuntimeEvent,
  type VolumeInfo,
} from "../runtime";

/**
 * What an agent may touch. The engine on an agent host is shared with whatever else runs there, and a control plane that
 * has been taken over must not be able to stop, read, mount or remove any of it. So the agent works only on **MiniBox
 * resources**: containers, volumes and networks that carry this label, with this host's id as the value.
 *
 * The agent writes the label itself on everything it creates and overrides a label of that name in a request, and it
 * judges ownership from what the engine says about the resource, never from what a request claims. An engine does not
 * change the labels of a resource once it exists, so something on the host that was there before can never become a
 * MiniBox resource by being named in a request. The key is fixed and does not follow `LABEL_PREFIX`: it is the agent's
 * own, and the host id in the value keeps another MiniBox on the same engine out of this one's reach.
 */
export const OWNER_LABEL = "minibox-agent.host";

/** Where the agent keeps the MiniBox it serves, next to its identity in its data volume. */
export const SCOPE_FILE = "scope.json";

const ScopeSchema = z.object({
  version: z.literal(1),
  hostId: z.string().min(1).max(64),
  /** The prefix of the MiniBox this agent serves, from pairing. Null when not known. */
  labelPrefix: z.string().max(64).nullable(),
});
export type ScopeRecord = z.infer<typeof ScopeSchema>;

/** The scope of an agent paired with a MiniBox: the prefix is the one the pairing answer named, when it named one. */
export function freshScope(hostId: string, labelPrefix: string | null = null): ScopeRecord {
  return { version: 1, hostId, labelPrefix };
}

/**
 * The scope an agent kept, or null when it has none, which is an agent paired before scopes existed. A record that
 * belongs to another host is an error that names the fix: its host id is another engine's.
 */
export function loadScope(dataDir: string, hostId: string): ScopeRecord | null {
  const path = join(dataDir, SCOPE_FILE);
  const text = readSecretFile(path);
  if (text === null) {
    // A file that is there and empty is a scope that was cut short, not an agent that never had one: reading it as none
    // would hide a damaged record behind a welcome that writes a new one.
    if (existsSync(path))
      throw new Error(`${SCOPE_FILE} is empty. Restore it from a backup, or remove the data volume and pair again.`);
    return null;
  }
  const record = ScopeSchema.parse(JSON.parse(text));
  if (record.hostId !== hostId) {
    throw new Error(
      `${SCOPE_FILE} was written for host ${record.hostId}, not ${hostId}. Remove the data volume and pair again.`,
    );
  }
  return record;
}

export function saveScope(dataDir: string, record: ScopeRecord): void {
  mkdirSync(dataDir, { recursive: true, mode: DIR_MODE });
  writeFileAtomic(join(dataDir, SCOPE_FILE), `${JSON.stringify(record, null, 2)}\n`, SECRET_FILE_MODE);
}

/** The container the agent itself runs in, and the volumes mounted into it, which include the one that holds its key. */
export interface AgentSelf {
  readonly containerId: string;
  readonly volumes: ReadonlySet<string>;
}

export interface AgentScopeOptions {
  readonly hostId: string;
  readonly dataDir: string;
  /** The engine as it answers: what ownership is judged from. */
  readonly runtime: Pick<Runtime, "inspectContainer" | "inspectVolume" | "listNetworks">;
  /** What pairing wrote. Null for an agent paired before scopes existed, which writes one at its first welcome. */
  readonly record: ScopeRecord | null;
  /** Finds the container the agent runs in. Called once, when it is first needed. */
  readonly findSelf?: () => Promise<AgentSelf | null>;
}

/** The refusal for a resource the agent does not manage. It reads as not found, which is all a caller may learn of it. */
function notManaged(what: "container" | "volume" | "network", ref: string): RuntimeError {
  return new RuntimeError(
    "not_found",
    `${what} ${ref} is not managed by this agent`,
    `the ${what} ${ref} is not a MiniBox ${what} on this host, so the agent does not touch it`,
  );
}

/**
 * Decides what the agent manages: the resources that carry its label, and nothing else. The label is written on
 * everything the agent creates and is the only thing ownership is judged by, so a control plane that is taken over
 * cannot reach anything on the machine that MiniBox did not make. It also holds the MiniBox this agent serves
 * (`scope.json`), which pins the owner of the host's firewall rule and keeps a data volume from serving another host.
 *
 * The agent's own container and the volumes mounted into it, its key's volume among them, are never managed, whatever
 * they carry.
 */
export class AgentScope {
  private record: ScopeRecord | null;
  /** Who the agent is, once the engine has said so. A failure is not kept: the engine may answer the next time. */
  private selfFound: { readonly value: AgentSelf | null } | null = null;
  private selfPending: Promise<AgentSelf | null> | null = null;

  constructor(private readonly options: AgentScopeOptions) {
    this.record = options.record;
  }

  /** The label every resource the agent creates carries, whatever a request asked for under the same key. */
  labels(requested: Record<string, string> | undefined): Record<string, string> {
    return { ...requested, [OWNER_LABEL]: this.options.hostId };
  }

  /**
   * The control plane welcomed the agent, and may name the label prefix it uses. An agent that has a record only compares
   * it with it, and says in the log when they differ: the prefix is not something a later welcome can change. An agent
   * without one, paired before scopes existed, writes down what the welcome says, as a newly paired agent writes down
   * what its pairing answer said, and goes on managing only what it creates itself.
   */
  begin(labelPrefix: string | undefined): void {
    if (this.record !== null) {
      if (labelPrefix !== undefined && this.record.labelPrefix !== null && labelPrefix !== this.record.labelPrefix) {
        log.warn("agent.scope_prefix_differs", { kept: this.record.labelPrefix, reported: labelPrefix });
      }
      return;
    }
    const record = freshScope(this.options.hostId, labelPrefix ?? null);
    this.record = record;
    try {
      saveScope(this.options.dataDir, record);
      log.info("agent.scope_written", { hostId: record.hostId, labelPrefix: record.labelPrefix });
    } catch (e) {
      // The record is kept for this run, so the firewall owner is still pinned; the next welcome writes it again.
      log.error("agent.scope_unwritable", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** The container a reference names, if it is a MiniBox container. Anything else reads as not found. */
  async container(ref: string): Promise<ContainerInfo> {
    const info = await this.options.runtime.inspectContainer(ref);
    const self = await this.selfOf();
    if (this.ownsContainer(info) && info.id !== self?.containerId) return info;
    throw notManaged("container", ref);
  }

  /** The volume a name refers to, if it is a MiniBox volume the agent does not itself run on. */
  async volume(name: string): Promise<VolumeInfo> {
    const info = await this.options.runtime.inspectVolume(name);
    const self = await this.selfOf();
    if (this.ownsVolume(info) && !self?.volumes.has(info.name)) return info;
    throw notManaged("volume", name);
  }

  /** The network of that name, if it exists and is a MiniBox network. Null when there is none, anything else throws. */
  async network(name: string): Promise<NetworkSummary | null> {
    const found = (await this.options.runtime.listNetworks()).find((candidate) => candidate.name === name);
    if (!found) return null;
    if (this.ownsNetwork(found)) return found;
    throw notManaged("network", name);
  }

  ownsContainer(info: Pick<ContainerInfo, "labels">): boolean {
    return info.labels[OWNER_LABEL] === this.options.hostId;
  }

  ownsVolume(info: Pick<VolumeInfo, "labels">): boolean {
    return info.labels[OWNER_LABEL] === this.options.hostId;
  }

  ownsNetwork(info: Pick<NetworkSummary, "labels">): boolean {
    return info.labels[OWNER_LABEL] === this.options.hostId;
  }

  /** A container event, judged by what it carries: an engine puts a container's labels in the event's attributes. */
  ownsEvent(event: RuntimeEvent): boolean {
    if (event.type !== "container") return false;
    return event.attributes[OWNER_LABEL] === this.options.hostId;
  }

  /**
   * The container the agent runs in, found once it has been found. Null when it is not in one, and then it goes by labels
   * alone. An engine that cannot be asked fails the call and is asked again next time, since taking "cannot tell" for "not
   * in a container" would leave the agent free to manage itself.
   */
  async selfOf(): Promise<AgentSelf | null> {
    if (this.selfFound !== null) return this.selfFound.value;
    this.selfPending ??= (async () => {
      try {
        const value = (await this.options.findSelf?.()) ?? null;
        this.selfFound = { value };
        return value;
      } finally {
        this.selfPending = null;
      }
    })();
    return this.selfPending;
  }

  /** The label prefix of the MiniBox this agent serves, from its pairing, or null when it was never told. */
  ingressOwner(): string | null {
    return this.record?.labelPrefix ?? null;
  }
}
