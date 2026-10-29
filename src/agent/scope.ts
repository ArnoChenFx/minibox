import { existsSync, mkdirSync } from "node:fs";
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

/** What a label prefix may be. Container and network names are made from it, so it fits them. */
const LABEL_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** Whether `value` is a label prefix, such as `minibox`. */
export const isLabelPrefix = (value: string): boolean => LABEL_PREFIX.test(value);

const ScopeSchema = z.object({
  version: z.literal(1),
  hostId: z.string().min(1).max(64),
  /** The prefix of the MiniBox this agent serves: from pairing, or what its operator named when it adopted. Null when not known. */
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

/**
 * The scope of an agent paired by a version that labels what it creates: nothing came before, so nothing is adopted.
 * `labelPrefix` is the MiniBox it was paired with, when that MiniBox said so.
 */
export function freshScope(hostId: string, now: Date, labelPrefix: string | null = null): ScopeRecord {
  return {
    version: 1,
    hostId,
    labelPrefix,
    adoptedAt: now.toISOString(),
    adopted: { containers: [], volumes: [], networks: [] },
  };
}

/**
 * The scope an agent kept, or null when it has none, which is an agent paired before scopes existed. A record that
 * belongs to another host is an error that names the fix: its adopted resources are another engine's.
 */
export function loadScope(dataDir: string, hostId: string): ScopeRecord | null {
  const path = join(dataDir, SCOPE_FILE);
  const text = readSecretFile(path);
  if (text === null) {
    // A file that is there and empty is a scope that was cut short, not an agent that never had one: reading it as none
    // would make the agent adopt again.
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
  /** The engine as it answers: what ownership is judged from, and what adoption lists. */
  readonly runtime: Pick<
    Runtime,
    "inspectContainer" | "inspectVolume" | "listContainers" | "listVolumes" | "listNetworks"
  >;
  /** What an earlier run kept. Null for an agent paired before scopes existed, which can adopt once. */
  readonly record: ScopeRecord | null;
  /**
   * The label prefix whose resources an agent with no `record` takes as its own, once. It comes from the machine's
   * operator (`AGENT_ADOPT_PREFIX`) and not from the control plane: what the agent may touch is for the machine to say,
   * and a control plane that could name the prefix could name `com.docker.compose`.
   */
  readonly adoptPrefix?: string | null;
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
 * for an agent that was paired before this existed and so has resources the label never reached: when its operator has
 * named a label prefix (`adoptPrefix`) and the control plane has welcomed it, the agent takes the containers, volumes and
 * networks that carry that prefix at that moment, writes their ids down, and from then on goes by the label and that
 * list alone. The list never grows. The control plane's own idea of its prefix is never used to decide what is taken.
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
  /** Who the agent is, once the engine has said so. A failure is not kept: the engine may answer the next time. */
  private selfFound: { readonly value: AgentSelf | null } | null = null;
  private selfPending: Promise<AgentSelf | null> | null = null;

  constructor(private readonly options: AgentScopeOptions) {
    this.record = options.record;
    this.adopted = setsOf(options.record);
  }

  /** The label every resource the agent creates carries, whatever a request asked for under the same key. */
  labels(requested: Record<string, string> | undefined): Record<string, string> {
    return { ...requested, [OWNER_LABEL]: this.options.hostId };
  }

  /**
   * The control plane welcomed the agent, and may name the label prefix it uses. An agent that has not adopted yet takes
   * the prefix its operator named, if the operator named one, and adopts when it is next asked for something; what the
   * control plane says is only compared with it, and with nothing named it is the hint in the log. One that has a record
   * ignores the welcome: the prefix is not something a later welcome can change.
   */
  begin(labelPrefix: string | undefined): void {
    if (this.record !== null) {
      if (labelPrefix !== undefined && this.record.labelPrefix !== null && labelPrefix !== this.record.labelPrefix) {
        log.warn("agent.scope_prefix_differs", { kept: this.record.labelPrefix, reported: labelPrefix });
      }
      return;
    }
    const prefix = this.options.adoptPrefix ?? null;
    if (prefix === null) {
      this.pendingPrefix = null;
      log.warn("agent.scope_unadopted", {
        reported: labelPrefix ?? null,
        hint: "this agent was paired before scopes existed, and it manages only what it creates itself until its operator names the label prefix of the MiniBox it serves: recreate it with AGENT_ADOPT_PREFIX set to that MiniBox's LABEL_PREFIX",
      });
      return;
    }
    if (labelPrefix !== undefined && labelPrefix !== prefix) {
      log.warn("agent.scope_prefix_differs", {
        named: prefix,
        reported: labelPrefix,
        hint: "the prefix named at the agent is the one used",
      });
    }
    this.pendingPrefix = prefix;
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

  /** The label prefix of the MiniBox this agent serves, from its pairing or its adoption, or null when it was never told. */
  ingressOwner(): string | null {
    return this.record?.labelPrefix ?? null;
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
