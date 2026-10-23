import Docker from "dockerode";

import type { EngineTarget, Runtime } from "../runtime";
import { containerArchiveMethods } from "./container-archive";
import { containerMethods } from "./containers";
import { createEngine } from "./engine";
import { eventMethods } from "./events";
import { execMethods } from "./exec";
import { helperMethods } from "./helpers";
import { imageMethods } from "./images";
import { networkMethods } from "./networks";
import { systemMethods } from "./system";
import { volumeMethods } from "./volumes";

export { KILL_TREE_SCRIPT, RUN_WRAPPER } from "./exec";
export { parseChanges, toContainerInfo, toCreateOptions, toUpdateOptions } from "./containers";
export { toHelperOptions } from "./helpers";

/** Longest a TLS engine may take to answer the connection before the request fails as unavailable. */
const TLS_CONNECT_TIMEOUT_MS = 10_000;

/** `connectionTimeout` is read by docker-modem but missing from dockerode's typings. */
type DockerConnectOptions = Docker.DockerOptions & { connectionTimeout?: number };

function dockerOptionsOf(target: string | EngineTarget): DockerConnectOptions {
  if (typeof target === "string") return { socketPath: target };
  if ("socketPath" in target) return { socketPath: target.socketPath };
  return {
    host: target.host,
    port: target.port,
    protocol: "https",
    ca: target.ca,
    cert: target.cert,
    key: target.key,
    connectionTimeout: TLS_CONNECT_TIMEOUT_MS,
  };
}

/** The only module that talks to the Docker Engine API. */
export function createDockerRuntime(target: string | EngineTarget): Runtime {
  const engine = createEngine(new Docker(dockerOptionsOf(target)));
  return {
    ...systemMethods(engine),
    ...containerMethods(engine),
    ...containerArchiveMethods(engine),
    ...execMethods(engine),
    ...eventMethods(engine),
    ...imageMethods(engine),
    ...volumeMethods(engine),
    ...networkMethods(engine),
    ...helperMethods(engine),
  };
}
