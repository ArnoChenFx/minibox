import { classifyFailure } from "./errors";
import { openS3Session } from "./s3";
import type { TargetConnection, TargetSession } from "./session";
import { openSftpSession } from "./sftp";
import { openWebdavSession } from "./webdav";

/** Opens a session on the target a connection names. Whatever stops it is classified the same way as a failed call. */
export async function openSession(conn: TargetConnection): Promise<TargetSession> {
  try {
    switch (conn.kind) {
      case "s3":
        return openS3Session(conn);
      case "sftp":
        return await openSftpSession(conn);
      case "webdav":
        return openWebdavSession(conn);
    }
  } catch (e) {
    throw classifyFailure(e);
  }
}
