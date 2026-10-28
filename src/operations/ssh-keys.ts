import { z } from "zod";

import { AppError, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { SSH_KEY_LABEL_MAX, SSH_KEY_TEXT_MAX, type SshKeyInfo, type SshKeyStore } from "../ssh/keys";
import { defineOperation } from "./define";

/**
 * The owner's public keys for direct SSH. A key logs in to every box as the owner.
 * SSH keys are the owner's alone: no token holds this scope, so an agent never adds a key that logs in to every box. */
const SSH_KEY_SCOPE = "sshkey:manage";

const SshKeySchema = z.object({
  id: z.string(),
  label: z.string(),
  algorithm: z.string().meta({ description: "Key type, such as ssh-ed25519." }),
  fingerprint: z.string().meta({ description: "SHA256 fingerprint, as `ssh-keygen -lf` prints it." }),
  publicKey: z.string().meta({ description: "The key in authorized_keys form, without its comment." }),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable().meta({ description: "Last direct SSH login with this key, to the minute." }),
});

function view(key: SshKeyInfo) {
  return {
    ...key,
    createdAt: new Date(key.createdAt).toISOString(),
    lastUsedAt: key.lastUsedAt === null ? null : new Date(key.lastUsedAt).toISOString(),
  };
}

function storeOf(keys: SshKeyStore | undefined): SshKeyStore {
  if (!keys) throw new AppError(500, "internal", "SSH key store is not available");
  return keys;
}

export const sshKeyList = defineOperation({
  name: "sshkey.list",
  tag: "ssh",
  summary: "List SSH keys",
  kind: "read",
  scope: SSH_KEY_SCOPE,
  async: false,
  input: z.object({}),
  output: z.object({ keys: z.array(SshKeySchema) }),
  rest: [{ method: "GET", path: "/api/ssh-keys" }],
  run: async ({ sshKeys }) => ({ keys: storeOf(sshKeys).list().map(view) }),
});

export const sshKeyAdd = defineOperation({
  name: "sshkey.add",
  tag: "ssh",
  summary: "Add an SSH key",
  kind: "write",
  scope: SSH_KEY_SCOPE,
  async: false,
  input: z.object({
    publicKey: z
      .string()
      .min(1)
      .max(SSH_KEY_TEXT_MAX)
      .meta({ description: "One line such as `ssh-ed25519 AAAA… me@laptop`. Never a private key." }),
    label: z
      .string()
      .trim()
      .max(SSH_KEY_LABEL_MAX)
      .optional()
      .meta({ description: "A name to tell keys apart. Defaults to the key's comment, then its type." }),
  }),
  output: z.object({ key: SshKeySchema }),
  rest: [{ method: "POST", path: "/api/ssh-keys", body: true }],
  conflicts: true,
  activity: { action: () => "sshkey.add", target: (input) => input.label || "SSH key" },
  audit: {
    target: (_input, _resolved, result) => ({ kind: "sshkey", id: result?.key.id, name: result?.key.label ?? "" }),
    detail: (_input, _resolved, result) => ({ fingerprint: result?.key.fingerprint ?? null }),
  },
  run: async ({ sshKeys }, input) => ({ key: view(storeOf(sshKeys).add(input.publicKey, input.label)) }),
});

export const sshKeyDelete = defineOperation({
  name: "sshkey.delete",
  tag: "ssh",
  summary: "Delete an SSH key",
  kind: "destructive",
  scope: SSH_KEY_SCOPE,
  async: false,
  input: z.object({ id: z.string().regex(/^sk_[0-9a-f]{16}$/) }),
  output: z.object({ key: SshKeySchema }),
  rest: [{ method: "DELETE", path: "/api/ssh-keys/:id" }],
  resolve: async ({ sshKeys }, input) => {
    const key = storeOf(sshKeys)
      .list()
      .find((entry) => entry.id === input.id);
    if (!key) throw notFound(msg("ssh_key_not_found"));
    return key;
  },
  activity: { action: () => "sshkey.delete", target: (_input, key) => key.label },
  audit: {
    target: ({ id }, key) => ({ kind: "sshkey", id, name: key?.label ?? id }),
    detail: (_input, key) => ({ fingerprint: key?.fingerprint ?? null }),
  },
  run: async ({ sshKeys }, input) => ({ key: view(storeOf(sshKeys).remove(input.id)) }),
});

export const sshKeyOperations = [sshKeyList, sshKeyAdd, sshKeyDelete];
