import { classifyFailure } from "./errors";
import { openS3Session } from "./s3";
import type { TargetConnection, TargetSession } from "./session";
import { openSftpSession } from "./sftp";

/** Opens a session on the target a connection names. Whatever stops it is classified the same way as a failed call. */
export async function openSession(conn: TargetConnection): Promise<TargetSession> {
  try {
    return conn.kind === "s3" ? openS3Session(conn) : await openSftpSession(conn);
  } catch (e) {
    throw classifyFailure(e);
  }
}
