import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { DIR_MODE, readSecretFile, SECRET_FILE_MODE, writeFileAtomic } from "../data-dir";

export const IDENTITY_FILE = "agent.json";
export const KEY_FILE = "agent-key.pem";

/** What an agent keeps once it is paired. The private key is a separate file, so this record holds no secret. */
const IdentitySchema = z.object({
  agentId: z.string().min(1).max(64),
  hostId: z.string().min(1).max(64),
  server: z.string().url().max(512),
  pairedAt: z.string().min(1).max(64),
});
export type AgentIdentity = z.infer<typeof IdentitySchema>;

export interface StoredIdentity {
  readonly identity: AgentIdentity;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
}

export interface KeyPairPem {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

/** A new Ed25519 key pair. The private key never leaves the agent's data volume. */
export function generateKeyPairPem(): KeyPairPem {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/**
 * The identity an agent was paired with, or null when it has not been paired. A record without its key cannot prove who it
 * is, so that case is an error that names the fix, not a silent re-pairing.
 */
export function loadIdentity(dataDir: string): StoredIdentity | null {
  const text = readSecretFile(join(dataDir, IDENTITY_FILE));
  if (text === null) return null;
  const identity = IdentitySchema.parse(JSON.parse(text));
  const pem = readSecretFile(join(dataDir, KEY_FILE));
  if (pem === null) {
    throw new Error(
      `${KEY_FILE} is missing, so this agent cannot prove its identity. Remove the data volume and pair again.`,
    );
  }
  const privateKey = createPrivateKey(pem);
  return {
    identity,
    privateKey,
    publicKeyPem: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Writes the key first and the identity last, so a crash in between leaves an unpaired agent rather than a broken one. */
export function saveIdentity(dataDir: string, identity: AgentIdentity, privateKeyPem: string): void {
  mkdirSync(dataDir, { recursive: true, mode: DIR_MODE });
  writeFileAtomic(join(dataDir, KEY_FILE), privateKeyPem, SECRET_FILE_MODE);
  writeFileAtomic(join(dataDir, IDENTITY_FILE), `${JSON.stringify(identity, null, 2)}\n`, SECRET_FILE_MODE);
}
