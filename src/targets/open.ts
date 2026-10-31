import { classifyFailure } from "./errors";
import { openS3Session } from "./s3";
import type { TargetConnection, TargetSession } from "./session";
import { openSftpSession } from "./sftp";
import { openWebdavSession } from "./webdav";

/**
 * Opens a session on the target a connection names. Whatever stops it is classified the same way as a failed call.
 * `idleMs` shortens the time a stalled transfer waits for its first byte, which only a test has reason to do.
 */
export async function openSession(conn: TargetConnection, options: { idleMs?: number } = {}): Promise<TargetSession> {
  try {
    switch (conn.kind) {
      case "s3":
        return openS3Session(conn);
      case "sftp":
        return await openSftpSession(conn);
      case "webdav":
        return openWebdavSession(conn, options);
    }
  } catch (e) {
    throw classifyFailure(e);
  }
}
