import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { BoxProfile } from "../box-profile";
import { DIR_MODE, ensureDataDir, SECRET_FILE_MODE, writeFileAtomic } from "../data-dir";
import type { EgressPolicy } from "../egress/policy";
import { log } from "../lib/logger";
import { isBoxId } from "./revision";
import type { BoxEnv, BoxMount } from "./types";

/** The fields a change can stage: the ones a box only takes through a rebuild. */
export const STAGED_FIELDS = ["template", "mounts", "env", "network", "egress", "profile"] as const;
export type StagedField = (typeof STAGED_FIELDS)[number];

/** Values a rebuild would apply. A field that is absent stays as the box has it. */
export interface StagedFields {
  template?: string;
  mounts?: BoxMount[];
  env?: BoxEnv[];
  network?: string;
  egress?: EgressPolicy;
  profile?: BoxProfile | null;
}

/** One box's staged changes. A secret is staged by reference only, as the spec holds it. */
export interface StagedRecord {
  version: 1;
  boxId: string;
  fields: StagedFields;
  /** The box revision the latest change was staged against. */
  baseRevision: number;
  updatedAt: string;
  /** The principal that staged the latest change. */
  updatedBy: string;
}

const isEnoent = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";

function isRecord(value: unknown): value is StagedRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StagedRecord>;
  return (
    record.version === 1 &&
    typeof record.boxId === "string" &&
    typeof record.fields === "object" &&
    record.fields !== null &&
    typeof record.baseRevision === "number"
  );
}

/** The fields a record stages, in the order the API lists them. */
export function stagedFieldsOf(fields: StagedFields): StagedField[] {
  return STAGED_FIELDS.filter((field) => fields[field] !== undefined);
}

/**
 * Stages `fields` on top of what is staged already. A field passed again replaces the staged value, and a field that is
 * left out keeps the one it holds. An empty result means the request staged nothing.
 */
export function mergeStaged(before: StagedFields | null, fields: StagedFields): StagedFields {
  const merged: StagedFields = { ...before };
  for (const field of stagedFieldsOf(fields)) Object.assign(merged, { [field]: fields[field] });
  return merged;
}

/**
 * `DATA_DIR/boxes/staged/<id>.json`: the rebuild changes staged for a box, kept until they are applied or discarded, so
 * they survive a restart. Mode 600, like the spec, because a plain env value may be staged. The spec store removes a
 * box's file when it removes the box.
 */
export class StagedStore {
  constructor(private readonly dataDir: string) {}

  dir(): string {
    return join(this.dataDir, "boxes", "staged");
  }

  private pathFor(id: string): string {
    if (!isBoxId(id)) throw new Error(`refusing a staged change path for ${id}`);
    return join(this.dir(), `${id}.json`);
  }

  /** `null` when nothing is staged. A file that is not a record is logged and treated as missing. */
  read(id: string): StagedRecord | null {
    if (!isBoxId(id)) return null;
    let text: string;
    try {
      text = readFileSync(this.pathFor(id), "utf8");
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed) && parsed.boxId === id) return parsed;
    } catch {
      // Logged below, like a file of the wrong shape.
    }
    log.warn("box.staged_unreadable", { id });
    return null;
  }

  write(record: StagedRecord): void {
    ensureDataDir(this.dataDir);
    mkdirSync(this.dir(), { recursive: true, mode: DIR_MODE });
    writeFileAtomic(this.pathFor(record.boxId), `${JSON.stringify(record, null, 2)}\n`, SECRET_FILE_MODE);
  }

  remove(id: string): void {
    if (!isBoxId(id)) return;
    try {
      unlinkSync(this.pathFor(id));
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }
}
