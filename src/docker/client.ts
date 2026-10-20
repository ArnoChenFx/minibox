import Docker from "dockerode";
import type { Config } from "../config";
import { type LabelKeys, labelKeys } from "../labels";

export interface DockerCtx {
  docker: Docker;
  keys: LabelKeys;
  prefix: string;
  baseTemplateTag: string;
  templatesDir: string;
}

export function createDockerCtx(cfg: Config): DockerCtx {
  return {
    docker: new Docker({ socketPath: cfg.dockerSocket }),
    keys: labelKeys(cfg.labelPrefix),
    prefix: cfg.labelPrefix,
    baseTemplateTag: cfg.baseTemplateTag,
    templatesDir: cfg.templatesDir,
  };
}

/** Ignore "not modified" (304) responses, e.g. starting an already-running container. */
export async function ignore304<T>(p: Promise<T>): Promise<void> {
  try {
    await p;
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 304) throw e;
  }
}
