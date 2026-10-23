import type { AuthenticationType } from "ssh2";

import { isWeakAccessKey, safeEqual } from "../auth";
import { OWNER, type Principal } from "../operations/types";
import { scopeAllowed } from "../tokens/model";
import type { TokenStore } from "../tokens/store";
import type { SshKeyStore } from "./keys";

/** Longer than any agent token or access key. A longer password is refused before it is hashed or compared. */
export const SSH_PASSWORD_MAX = 512;

/** The methods a direct client is offered. keyboard-interactive asks one password prompt, for clients that need it. */
export const DIRECT_METHODS: AuthenticationType[] = ["publickey", "password", "keyboard-interactive"];

/** A box name or id as an SSH user name: what `getBox` would accept, and nothing that looks like a path or an option. */
const BOX_USER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function boxRefOfUser(username: string): string | null {
  return BOX_USER_RE.test(username) ? username : null;
}

/** What a direct client proved, before its box is known. */
export type DirectCredential =
  | { readonly method: "password" | "keyboard-interactive"; readonly password: string }
  | {
      readonly method: "publickey";
      readonly algorithm: string;
      readonly blob: Buffer;
      readonly data: Buffer;
      readonly signature: Buffer;
      readonly hashAlgo?: string;
    };

/** Who logged in, and with what, for the audit event. A token's name or a key's label and fingerprint, never a secret. */
export interface DirectIdentity {
  readonly principal: Principal;
  readonly credential: "access-key" | "token" | "key";
  readonly detail: Readonly<Record<string, string>>;
  readonly keyId?: string;
}

export interface DirectAuthDeps {
  readonly accessKey: string;
  readonly tokens: Pick<TokenStore, "authenticate">;
  readonly keys: Pick<SshKeyStore, "verify">;
}

/**
 * Checks a direct SSH credential, without looking at the box. A password is the access key, compared in constant time
 * and refused while it is weak, or an agent token with `box:ssh`. A box-self token is never accepted. A signature must
 * verify against one of the owner's SSH keys. Every refusal returns null, so the caller answers them all alike.
 */
export function identify(deps: DirectAuthDeps, credential: DirectCredential, ip: string): DirectIdentity | null {
  if (credential.method === "publickey") {
    const key = deps.keys.verify(
      credential.algorithm,
      credential.blob,
      credential.data,
      credential.signature,
      credential.hashAlgo,
    );
    if (!key) return null;
    return {
      principal: OWNER,
      credential: "key",
      detail: { key: key.label, fingerprint: key.fingerprint },
      keyId: key.id,
    };
  }
  const { password } = credential;
  if (password === "" || password.length > SSH_PASSWORD_MAX) return null;
  if (safeEqual(password, deps.accessKey)) {
    return isWeakAccessKey(deps.accessKey) ? null : { principal: OWNER, credential: "access-key", detail: {} };
  }
  let token;
  try {
    token = deps.tokens.authenticate(password, ip);
  } catch {
    // A token over its request rate is refused like a wrong one.
    return null;
  }
  if (!token || !scopeAllowed(token.grants, "box:ssh")) return null;
  return { principal: token, credential: "token", detail: { token: token.name } };
}
