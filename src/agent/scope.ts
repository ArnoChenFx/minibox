import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { DIR_MODE, readSecretFile, SECRET_FILE_MODE, writeFileAtomic } from "../data-dir";
import { boxNetworkName } from "../labels";
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
 * resources**: containers, volumes and networks that carry this label, with this host's id as the value, or that were
 * adopted once when the agent was upgraded (see `AgentScope.adopt`).
 *
 * The agent writes the label itself on everything it creates and overrides a label of that name in a request, and it
 * judges ownership from what the engine says about the resource, never from what a request claims. An engine does not
 * change the labels of a resource once it exists, so something on the host that was there before can never become a
 * MiniBox resource by being named in a request. The key is fixed and does not follow `LABEL_PREFIX`: it is the agent's
 * own, and the host id in the value keeps another MiniBox on the same engine out of this one's reach.
 */
export const OWNER_LABEL = "minibox-agent.host";

/** Where the agent keeps what it adopted, next to its identity in its data volume. */
export const SCOPE_FILE = "scope.json";

/** What the control plane may name as its label prefix. Container and network names are made from it, so it fits them. */
const LABEL_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

const ScopeSchema = z.object({
  version: z.literal(1),
  hostId: z.string().min(1).max(64),
  /** The prefix the control plane reported when this agent adopted what existed. Null when it adopted nothing. */
  labelPrefix: z.string().max(64).nullable(),
  adoptedAt: z.string().min(1).max(64),
  adopted: z.object({
    /** Full container ids. A container's name can be given to another container, its id cannot. */
    containers: z.array(z.string().max(128)).max(100_000),
    volumes: z.array(z.string().max(256)).max(100_000),
    networks: z.array(z.string().max(256)).max(100_000),
  }),
});
export type ScopeRecord = z.infer<typeof ScopeSchema>;

/** The scope of an agent paired by a version that labels what it creates: nothing came before, so nothing is adopted. */
export function freshScope(hostId: string, now: Date): ScopeRecord {
  return {
    version: 1,
    hostId,
    labelPrefix: null,
    adoptedAt: now.toISOString(),
    adopted: { containers: [], volumes: [], networks: [] },
  };
}

/**
 * The scope an agent kept, or null when it has none, which is an agent paired before scopes existed. A record that
 * belongs to another host is an error that names the fix: its adopted resources are another engine's.
 */
export function loadScope(dataDir: string, hostId: string): ScopeRecord | null {
  const text = readSecretFile(join(dataDir, SCOPE_FILE));
  if (text === null) return null;
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
  /** The engine as it answers: what ownership is judged from, and what adoption lists. */
  readonly runtime: Pick<
    Runtime,
    "inspectContainer" | "inspectVolume" | "listContainers" | "listVolumes" | "listNetworks"
  >;
  /** What an earlier run kept. Null for an agent paired before scopes existed, which adopts once. */
  readonly record: ScopeRecord | null;
  /** Finds the container the agent runs in. Called once, when it is first needed. */
  readonly findSelf?: () => Promise<AgentSelf | null>;
  readonly now?: () => Date;
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
 * Decides what the agent manages: the resources that carry its label, and the ones it adopted. It adopts at most once,
 * for an agent that was paired before this existed and so has resources the label never reached: when the control plane
 * welcomes it and names its label prefix, the agent takes the containers, volumes and networks that carry that prefix at
 * that moment, writes their ids down, and from then on goes by the label and that list alone. The list never grows.
 *
 * An agent paired by this version starts with an empty list and never adopts, so a control plane that is taken over
 * later cannot talk it into adopting anything. The agent's own container and the volumes mounted into it, its key's
 * volume among them, are never managed, whatever they carry.
 */
export class AgentScope {
  private record: ScopeRecord | null;
  private adopted: { containers: Set<string>; volumes: Set<string>; networks: Set<string> };
  private pendingPrefix: string | null = null;
  private adopting: Promise<void> | null = null;
  private self: Promise<AgentSelf | null> | null = null;

  constructor(private readonly options: AgentScopeOptions) {
    this.record = options.record;
    this.adopted = setsOf(options.record);
  }

  /** The label every resource the agent creates carries, whatever a request asked for under the same key. */
  labels(requested: Record<string, string> | undefined): Record<string, string> {
    return { ...requested, [OWNER_LABEL]: this.options.hostId };
  }

  /**
   * The control plane welcomed the agent. An agent that has not adopted yet remembers the label prefix it named, and
   * adopts when it is next asked for something. One that has adopted, or was paired by this version, ignores it: the
   * prefix is not something a later welcome can change.
   */
  begin(labelPrefix: string | undefined): void {
    if (this.record !== null) {
      if (labelPrefix !== undefined && this.record.labelPrefix !== null && labelPrefix !== this.record.labelPrefix) {
        log.warn("agent.scope_prefix_ignored", { adopted: this.record.labelPrefix, reported: labelPrefix });
      }
      return;
    }
    if (labelPrefix === undefined || !LABEL_PREFIX.test(labelPrefix)) {
      this.pendingPrefix = null;
      log.warn("agent.scope_unadopted", {
        reason: labelPrefix === undefined ? "the control plane named no label prefix" : "the label prefix is not valid",
        hint: "this agent manages only what it creates itself until the control plane is upgraded",
      });
      return;
    }
    this.pendingPrefix = labelPrefix;
  }

  /** Settles once any adoption that is due has been made. Every call that needs the scope waits for it first. */
  async ready(): Promise<void> {
    if (this.record !== null || this.pendingPrefix === null) return;
    const prefix = this.pendingPrefix;
    this.adopting ??= this.adopt(prefix).finally(() => {
      this.adopting = null;
    });
    await this.adopting;
  }

  /** The container a reference names, if it is a MiniBox container. Anything else reads as not found. */
  async container(ref: string): Promise<ContainerInfo> {
    await this.ready();
    const info = await this.options.runtime.inspectContainer(ref);
    const self = await this.selfOf();
    if (this.ownsContainer(info) && info.id !== self?.containerId) return info;
    throw notManaged("container", ref);
  }

  /** The volume a name refers to, if it is a MiniBox volume the agent does not itself run on. */
  async volume(name: string): Promise<VolumeInfo> {
    await this.ready();
    const info = await this.options.runtime.inspectVolume(name);
    const self = await this.selfOf();
    if (this.ownsVolume(info) && !self?.volumes.has(info.name)) return info;
    throw notManaged("volume", name);
  }

  /** The network of that name, if it exists and is a MiniBox network. Null when there is none, anything else throws. */
  async network(name: string): Promise<NetworkSummary | null> {
    await this.ready();
    const found = (await this.options.runtime.listNetworks()).find((candidate) => candidate.name === name);
    if (!found) return null;
    if (this.ownsNetwork(found)) return found;
    throw notManaged("network", name);
  }

  ownsContainer(info: Pick<ContainerInfo, "id" | "labels">): boolean {
    return info.labels[OWNER_LABEL] === this.options.hostId || this.adopted.containers.has(info.id);
  }

  ownsVolume(info: Pick<VolumeInfo, "name" | "labels">): boolean {
    return info.labels[OWNER_LABEL] === this.options.hostId || this.adopted.volumes.has(info.name);
  }

  ownsNetwork(info: Pick<NetworkSummary, "name" | "labels">): boolean {
    return info.labels[OWNER_LABEL] === this.options.hostId || this.adopted.networks.has(info.name);
  }

  /** A container event, judged by what it carries: an engine puts a container's labels in the event's attributes. */
  ownsEvent(event: RuntimeEvent): boolean {
    if (event.type !== "container") return false;
    return event.attributes[OWNER_LABEL] === this.options.hostId || this.adopted.containers.has(event.id);
  }

  /** The container the agent runs in, found once. Null when it cannot tell, and then it goes by labels alone. */
  async selfOf(): Promise<AgentSelf | null> {
    this.self ??= (this.options.findSelf?.() ?? Promise.resolve(null)).catch((e: unknown) => {
      log.warn("agent.self_unknown", { error: String(e) });
      return null;
    });
    return this.self;
  }

  private async adopt(prefix: string): Promise<void> {
    const { runtime, hostId, dataDir } = this.options;
    const self = await this.selfOf();
    const carries = (labels: Record<string, string>): boolean =>
      Object.keys(labels).some((key) => key === prefix || key.startsWith(`${prefix}.`));
    const containers = (await runtime.listContainers({ labels: {} }))
      .filter((info) => carries(info.labels) && info.id !== self?.containerId)
      .map((info) => info.id);
    const volumes = (await runtime.listVolumes())
      .filter((info) => carries(info.labels) && !self?.volumes.has(info.name))
      .map((info) => info.name);
    // Networks were made without labels before this, so their names are what says whose they are. MiniBox names them
    // `<prefix>-boxes` and `<prefix>-egress-…`.
    const networks = (await runtime.listNetworks())
      .map((info) => info.name)
      .filter((name) => name === boxNetworkName(prefix) || name.startsWith(`${prefix}-egress-`));
    const record: ScopeRecord = {
      version: 1,
      hostId,
      labelPrefix: prefix,
      adoptedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      adopted: { containers, volumes, networks },
    };
    // Written before it is used, so a crash in between adopts again rather than half-way.
    saveScope(dataDir, record);
    this.record = record;
    this.adopted = setsOf(record);
    this.pendingPrefix = null;
    log.info("agent.scope_adopted", {
      prefix,
      containers: containers.length,
      volumes: volumes.length,
      networks: networks.length,
    });
  }
}

function setsOf(record: ScopeRecord | null): {
  containers: Set<string>;
  volumes: Set<string>;
  networks: Set<string>;
} {
  return {
    containers: new Set(record?.adopted.containers),
    volumes: new Set(record?.adopted.volumes),
    networks: new Set(record?.adopted.networks),
  };
}
