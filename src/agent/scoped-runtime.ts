import { RuntimeError, type Runtime } from "../runtime";
import type { AgentScope } from "./scope";

/**
 * The part of a runtime an agent serves: every operation its executor runs. The refused operations (archives, builds,
 * helpers, disk measurements) are not here, so nothing here can reach them.
 */
export type ServedRuntime = Pick<
  Runtime,
  | "ping"
  | "info"
  | "listContainers"
  | "inspectContainer"
  | "inspectEnv"
  | "createContainer"
  | "startContainer"
  | "stopContainer"
  | "restartContainer"
  | "pauseContainer"
  | "unpauseContainer"
  | "removeContainer"
  | "renameContainer"
  | "updateContainer"
  | "containerLogs"
  | "containerStats"
  | "containerDiff"
  | "listImages"
  | "inspectImage"
  | "pullImage"
  | "inspectVolume"
  | "listVolumes"
  | "createVolume"
  | "removeVolume"
  | "setVolumeRootOwner"
  | "ensureBridgeNetwork"
  | "removeNetwork"
  | "connectNetwork"
  | "listNetworks"
  | "reattachNetwork"
  | "setHostIngressBlock"
  | "startExec"
  | "followLogs"
  | "events"
>;

export interface ScopedRuntimeOptions {
  /**
   * The container runtimes a box may ask for. `runc` is the engine's default and always allowed; an operator adds the
   * others the host is set up for (`AGENT_ALLOWED_RUNTIMES`), so a console cannot pick a runtime of its own choosing.
   */
  readonly allowedRuntimes?: readonly string[];
}

/** The network every engine has, which a box may be on when MiniBox has not made one for it. */
const DEFAULT_NETWORK = "bridge";

/**
 * Wraps an engine so that it answers only for the MiniBox resources of this agent (see `OWNER_LABEL`). Every operation
 * that names a container, a volume or a network first asks the engine what it is and refuses one that is not managed, as
 * not found, before anything is done. Lists and events are cut down to what is managed, and what the agent creates is
 * labelled as managed, whatever the request said about labels. The target of an operation is the id the engine gave for
 * the reference, so a name that is given to another container between the check and the call cannot change what is acted on.
 */
export function scopedRuntime(runtime: Runtime, scope: AgentScope, options: ScopedRuntimeOptions = {}): ServedRuntime {
  const allowed = new Set(["runc", ...(options.allowedRuntimes ?? [])]);

  /** A network a container may be created on or joined: one of MiniBox's, or the engine's default bridge. */
  async function usableNetwork(name: string): Promise<void> {
    if (name === DEFAULT_NETWORK) return;
    if ((await scope.network(name)) === null) {
      throw new RuntimeError(
        "not_found",
        `network ${name} not found`,
        `the network ${name} does not exist on this host`,
      );
    }
  }

  return {
    ping: () => runtime.ping(),
    info: () => runtime.info(),

    async listContainers(filter, opts) {
      await scope.ready();
      return (await runtime.listContainers(filter, opts)).filter((info) => scope.ownsContainer(info));
    },
    inspectContainer: async (id) => scope.container(id),
    async inspectEnv(id) {
      return runtime.inspectEnv((await scope.container(id)).id);
    },

    async createContainer(spec) {
      await scope.ready();
      const requested = spec.hardening?.runtime;
      if (requested !== undefined && !allowed.has(requested)) {
        throw new RuntimeError(
          "invalid",
          `createContainer: runtime ${requested} is not allowed on this agent`,
          `the container runtime ${requested} is not allowed on this agent host; set AGENT_ALLOWED_RUNTIMES on the agent to allow it`,
        );
      }
      // A named volume that is missing is made by the engine on the spot, unlabelled and so nobody's. The volumes a
      // container mounts must already exist and be MiniBox's.
      for (const mount of spec.mounts ?? []) await scope.volume(mount.source);
      if (spec.network !== undefined) await usableNetwork(spec.network);
      return runtime.createContainer({ ...spec, labels: scope.labels(spec.labels) });
    },
    async startContainer(id) {
      return runtime.startContainer((await scope.container(id)).id);
    },
    async stopContainer(id, opts) {
      return runtime.stopContainer((await scope.container(id)).id, opts);
    },
    async restartContainer(id, opts) {
      return runtime.restartContainer((await scope.container(id)).id, opts);
    },
    async pauseContainer(id) {
      return runtime.pauseContainer((await scope.container(id)).id);
    },
    async unpauseContainer(id) {
      return runtime.unpauseContainer((await scope.container(id)).id);
    },
    async removeContainer(id, opts) {
      return runtime.removeContainer((await scope.container(id)).id, opts);
    },
    async renameContainer(id, name) {
      return runtime.renameContainer((await scope.container(id)).id, name);
    },
    async updateContainer(id, limits) {
      return runtime.updateContainer((await scope.container(id)).id, limits);
    },
    async containerLogs(id, opts) {
      return runtime.containerLogs((await scope.container(id)).id, opts);
    },
    async containerStats(id, opts) {
      return runtime.containerStats((await scope.container(id)).id, opts);
    },
    async containerDiff(id) {
      return runtime.containerDiff((await scope.container(id)).id);
    },
    async startExec(containerId, spec) {
      return runtime.startExec((await scope.container(containerId)).id, spec);
    },
    async *followLogs(id, opts) {
      const info = await scope.container(id);
      yield* runtime.followLogs(info.id, opts);
    },
    async *events(filter, signal) {
      await scope.ready();
      for await (const event of runtime.events(filter, signal)) {
        if (scope.ownsEvent(event)) yield event;
      }
    },

    // Images belong to the engine, not to anyone's box: a box is made from an image the engine pulls, and the engine
    // keeps one copy for every user of it. They are not scoped.
    listImages: (filter) => runtime.listImages(filter),
    inspectImage: (ref) => runtime.inspectImage(ref),
    pullImage: (ref, opts) => runtime.pullImage(ref, opts),

    inspectVolume: async (name) => scope.volume(name),
    async listVolumes() {
      await scope.ready();
      return (await runtime.listVolumes()).filter((info) => scope.ownsVolume(info));
    },
    async createVolume(name, labels, opts) {
      await scope.ready();
      // Creating a volume that exists keeps it as it is, so a name that is somebody else's volume would come back as
      // success and then be mounted. It is refused here.
      const existing = await runtime.inspectVolume(name).catch((e: unknown) => {
        if (e instanceof RuntimeError && e.kind === "not_found") return null;
        throw e;
      });
      if (existing !== null && !scope.ownsVolume(existing)) {
        throw new RuntimeError(
          "conflict",
          `volume ${name} exists and is not managed by this agent`,
          `a volume named ${name} already exists on this host and is not a MiniBox volume`,
        );
      }
      return runtime.createVolume(name, scope.labels(labels), opts);
    },
    async removeVolume(name) {
      return runtime.removeVolume((await scope.volume(name)).name);
    },
    async setVolumeRootOwner(volume, owner, image) {
      return runtime.setVolumeRootOwner((await scope.volume(volume)).name, owner, image);
    },

    async ensureBridgeNetwork(name, opts) {
      await scope.ready();
      const existing = (await runtime.listNetworks()).find((candidate) => candidate.name === name);
      if (existing && !scope.ownsNetwork(existing)) {
        throw new RuntimeError(
          "conflict",
          `network ${name} exists and is not managed by this agent`,
          `a network named ${name} already exists on this host and is not a MiniBox network`,
        );
      }
      return runtime.ensureBridgeNetwork(name, { ...opts, labels: scope.labels(undefined) });
    },
    async removeNetwork(name) {
      // A network that is not there is left alone, as the engine does; one that is there must be MiniBox's.
      if ((await scope.network(name)) === null) return;
      return runtime.removeNetwork(name);
    },
    async connectNetwork(containerId, name, opts) {
      const info = await scope.container(containerId);
      await usableNetwork(name);
      return runtime.connectNetwork(info.id, name, opts);
    },
    async listNetworks() {
      await scope.ready();
      return (await runtime.listNetworks()).filter((info) => scope.ownsNetwork(info));
    },
    async reattachNetwork(containerId, name) {
      const info = await scope.container(containerId);
      await usableNetwork(name);
      return runtime.reattachNetwork(info.id, name);
    },
    setHostIngressBlock: (owner, sources) => runtime.setHostIngressBlock(owner, sources),
  };
}
