/** What an S3-compatible target needs to be reached. The credentials come from the secret store, never from the record. */
export interface S3Connection {
  readonly kind: "s3";
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** The key prefix the target's objects live under, with no slashes at either end. Empty for the bucket root. */
  readonly path: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** What an SFTP target needs. The key is pinned: nothing is sent to a server that presents another one. */
export interface SftpConnection {
  readonly kind: "sftp";
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** The folder on the server the objects live in. Empty is the login folder, and a leading slash makes it absolute. */
  readonly path: string;
  readonly privateKey: string;
  /** Null while the key is being confirmed. Such a connection gets as far as the key exchange and no further. */
  readonly hostKeyFingerprint: string | null;
  /**
   * Called with the server's public key (`type base64`) once it matches the pinned fingerprint. It is what a known_hosts
   * line needs, and it is captured so a remote repository can be given the whole key rather than a hash.
   */
  readonly onHostKey?: (key: string) => void;
}

/**
 * What a WebDAV target needs. The password is a secret. The address names the collection the objects live under, and
 * may carry a path, as Nextcloud's `/remote.php/dav/files/USER` does.
 */
export interface WebdavConnection {
  readonly kind: "webdav";
  readonly url: string;
  readonly user: string;
  readonly password: string;
  /** The folder beneath the address the objects live in, with no slashes at either end. Empty for the collection. */
  readonly path: string;
}

export type TargetConnection = S3Connection | SftpConnection | WebdavConnection;

/** An object on a target, named from the target's root, such as `packages/pk_….mbckpt`. */
export interface RemoteObject {
  readonly name: string;
  readonly bytes: number;
  readonly modifiedAt: string | null;
}

/** One open connection to a target. Each method is one round trip, or one streamed transfer. */
export interface TargetSession {
  /** Confirms the target answers and its folder can be listed. Nothing is written. */
  probe(): Promise<void>;
  /** The objects directly inside `folder`. A folder that does not exist has none. */
  list(folder: string): Promise<RemoteObject[]>;
  stat(name: string): Promise<RemoteObject | null>;
  /** The bytes of an object, streamed. Refuses an object that is not there. */
  read(name: string): Promise<AsyncIterable<Uint8Array>>;
  /**
   * Stores an object whole or not at all: a reader never sees a partial one. `size`, when the caller knows the length of
   * the body, is passed on to a server that wants it in advance.
   */
  write(name: string, body: AsyncIterable<Uint8Array>, size?: number): Promise<void>;
  close(): Promise<void>;
}
