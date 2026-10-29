import { createHash } from "node:crypto";
import { join } from "node:path";

import { utils } from "ssh2";

import { createSecretFile, readSecretFile } from "../data-dir";

export interface HostKey {
  /** OpenSSH-format private key, as ssh2 reads it. Never leaves the server. */
  readonly privateKey: string;
  /** The public key in authorized_keys form, such as `ssh-ed25519 AAAA…`. */
  readonly publicKey: string;
  /** `SHA256:` and the unpadded base64 digest of the key blob, the form `ssh-keygen -l` prints. */
  readonly fingerprint: string;
}

const HOST_KEY_FILE = "ssh_host_ed25519_key";

function hostKeyPath(dataDir: string): string {
  return join(dataDir, HOST_KEY_FILE);
}

/**
 * ssh2's ed25519 generator writes a key its own parser rejects about one time in 300, so a key is kept only once it
 * parses. Node's PKCS#8 output is not an option, since ssh2 1.x cannot read ed25519 in that form.
 */
function generateKey(): string {
  for (;;) {
    const pem = utils.generateKeyPairSync("ed25519").private.trimEnd();
    if (!(utils.parseKey(pem) instanceof Error)) return pem;
  }
}

/** Reads the gateway's host key from DATA_DIR, generating it on first use. Clients pin it, so it must survive restarts. */
export function loadHostKey(dataDir: string): HostKey {
  const path = hostKeyPath(dataDir);
  let pem = readSecretFile(path);
  if (pem === null) {
    const generated = generateKey();
    if (createSecretFile(path, generated)) pem = generated;
    else pem = readSecretFile(path);
  }
  if (pem === null)
    throw new Error(`The SSH host key at ${path} is empty. Remove it and restart to generate a new one.`);
  return hostKeyFrom(pem);
}

function hostKeyFrom(pem: string): HostKey {
  const parsed = utils.parseKey(pem);
  if (parsed instanceof Error) {
    throw new Error(
      `The SSH host key cannot be read (${parsed.message}). Remove it and restart to generate a new one.`,
    );
  }
  const blob = parsed.getPublicSSH();
  return {
    privateKey: pem,
    publicKey: `${parsed.type} ${blob.toString("base64")}`,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}
