import { join } from "node:path";

import type { HostCtx } from "../host/registry";

/**
 * The official templates: Dockerfiles that ship in templates/official. Each is built on a host the first time a box
 * needs it there, or when the console or the API asks, and never at startup. Its base image is pinned to a version and a
 * suite, so no build moves to a newer line. A build uses the base image the host already holds, so a newer patch of that
 * line reaches a host once the base is pulled there. `base` must equal the Dockerfile's FROM line, which the tests check.
 */
export const OFFICIAL_TEMPLATES = [
  {
    name: "node",
    base: "node:26-bookworm-slim",
    description: "Debian 12 · Node.js 26 · pnpm · yarn · git · tmux · build-essential · non-root dev user",
  },
  {
    name: "python",
    base: "python:3.14-slim-bookworm",
    description: "Debian 12 · Python 3.14 · uv · git · tmux · build-essential · non-root dev user",
  },
  {
    name: "go",
    base: "golang:1.27-bookworm",
    description: "Debian 12 · Go 1.27 · gopls · git · tmux · build-essential · non-root dev user",
  },
  {
    name: "minimal",
    base: "debian:bookworm-slim",
    description: "Debian 12 · git · tmux · jq · ripgrep · python3 · non-root dev user",
  },
] as const;

export type OfficialTemplate = (typeof OFFICIAL_TEMPLATES)[number];
export type OfficialName = OfficialTemplate["name"];

export const OFFICIAL_NAMES: readonly OfficialName[] = OFFICIAL_TEMPLATES.map((template) => template.name);

export function officialTemplate(name: string): OfficialTemplate | undefined {
  return OFFICIAL_TEMPLATES.find((template) => template.name === name);
}

/** The official template that `ref` names on this host, or undefined when the ref names another template. */
export function officialOfRef(host: HostCtx, ref: string): OfficialTemplate | undefined {
  const prefix = `${host.prefix}-template:`;
  return ref.startsWith(prefix) ? officialTemplate(ref.slice(prefix.length)) : undefined;
}

/** The directory whose Dockerfile builds the official template. */
export function officialContextDir(host: HostCtx, name: OfficialName): string {
  return join(host.templatesDir, "official", name);
}
