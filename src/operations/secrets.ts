import { z } from "zod";

import type { HostCtx } from "../host/registry";
import { AppError, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { boxesUsing } from "../secrets/env";
import type { SecretMeta } from "../secrets/store";
import { isTargetSecretName } from "../targets/types";
import { defineOperation } from "./define";
import { forceFlag, secretName, secretValue } from "./validation";

/** Secrets are the owner's alone: no token holds this scope, so an agent never reads or writes one. */
const SECRET_SCOPE = "secret:manage";

const SecretSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  boxes: z.array(z.string()).meta({ description: "Names of the boxes whose environment refers to this secret." }),
});

/** A secret as the API reports it. Its value is never part of the answer. */
function withBoxes(host: HostCtx, meta: SecretMeta) {
  return { ...meta, boxes: boxesUsing(host.specs.list(), meta.name) };
}

const secretList = defineOperation({
  name: "secret.list",
  tag: "secrets",
  summary: "List secrets",
  kind: "read",
  scope: SECRET_SCOPE,
  async: false,
  input: z.object({}),
  output: z.object({ secrets: z.array(SecretSchema) }),
  rest: [{ method: "GET", path: "/api/secrets" }],
  run: async ({ host }) => ({
    secrets: host.secrets
      .list()
      .filter((meta) => !isTargetSecretName(meta.name))
      .map((meta) => withBoxes(host, meta)),
  }),
});

const secretSet = defineOperation({
  name: "secret.set",
  tag: "secrets",
  summary: "Create or replace a secret",
  kind: "write",
  scope: SECRET_SCOPE,
  async: false,
  input: z.object({ name: secretName(), value: secretValue() }),
  output: z.object({
    secret: SecretSchema,
    created: z.boolean().meta({ description: "True when the secret is new, false when its value was replaced." }),
  }),
  rest: [{ method: "PUT", path: "/api/secrets/:name", body: true }],
  activity: { action: () => "secret.set", target: (input) => input.name },
  audit: {
    target: ({ name }) => ({ kind: "secret", name }),
    detail: ({ name }, _resolved, result) => ({ name, created: result?.created ?? null }),
  },
  run: async ({ host }, input) => {
    const { meta, created } = host.secrets.set(input.name, input.value, new Date().toISOString());
    return { secret: withBoxes(host, meta), created };
  },
});

const secretDelete = defineOperation({
  name: "secret.delete",
  tag: "secrets",
  summary: "Delete a secret",
  kind: "destructive",
  scope: SECRET_SCOPE,
  async: false,
  conflicts: true,
  input: z.object({ name: secretName(), force: forceFlag() }),
  output: z.object({
    name: z.string(),
    boxes: z.array(z.string()).meta({
      description:
        "Boxes that still refer to the deleted secret. Empty unless force was sent to delete a secret in use.",
    }),
  }),
  rest: [{ method: "DELETE", path: "/api/secrets/:name", query: ["force"] }],
  resolve: async ({ host }, input) => {
    const meta = host.secrets.meta(input.name);
    if (!meta) throw notFound(msg("secret_not_found", { name: input.name }));
    return meta;
  },
  activity: { action: () => "secret.delete", target: (input) => input.name },
  audit: {
    target: ({ name }) => ({ kind: "secret", name }),
    detail: ({ name, force }, _resolved, result) => ({ name, force, boxes: result?.boxes ?? [] }),
  },
  run: ({ host }, input) =>
    host.specs.exclusive(async () => {
      const boxes = boxesUsing(host.specs.list(), input.name);
      if (boxes.length > 0 && !input.force) {
        throw new AppError(409, "conflict", msg("secret_in_use", { name: input.name, boxes: boxes.join(", ") }), {
          boxes,
        });
      }
      if (!host.secrets.remove(input.name)) throw notFound(msg("secret_not_found", { name: input.name }));
      return { name: input.name, boxes };
    }),
});

export const secretOperations = [secretList, secretSet, secretDelete];
