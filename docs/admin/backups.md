# Backups

MiniBox can back up its data while it runs. A backup is one file, sealed with a passphrase that MiniBox never stores. It holds the data directory: box specs, tokens, secrets, host, notification and off-site target settings, and the event log and task history. Restore it with the command-line tool, offline, into an empty data directory.

A backup does not hold Docker volumes. Box files live in volumes, and checkpoint data lives in the checkpoint repository volume, so back those up separately. See [Back up a volume](#back-up-a-volume).

To keep copies off this host, add an [off-site target](#off-site-targets): an S3-compatible bucket or an SFTP server.

Code belongs in git. Push your code to a remote repository, so you do not depend on the box volumes.

## What a backup holds

A backup contains every file in the data directory, except these:

- `backups/`: the backups kept on the server.
- `packages/`: checkpoint packages. They expire 24 hours after they are made. Push one to an off-site target to keep it.
- `exec/`: the saved output of `exec` commands.
- `cli/`: cached command-line binaries. MiniBox builds them again when they are needed.
- Paths whose names start with a dot, such as the temporary files of a write in progress.

The databases, `events.db` and `tasks.db`, are copied from a snapshot that SQLite makes with `VACUUM INTO`. A copy holds only complete changes.

A backup holds secrets: the access key, the SSH host key, host and notification secrets, the checkpoint repository key, and the credentials of off-site targets. Keep it as protected as the data directory itself. Keep the passphrase apart from the backup. Without it, the archive cannot be opened, not even by MiniBox.

## Create a backup

You do not need to stop MiniBox. Set `MINIBOX_URL` and `MINIBOX_ACCESS_KEY` as for any other command, then run:

```bash
read -rs -p "Backup passphrase: " MINIBOX_BACKUP_PASSPHRASE && export MINIBOX_BACKUP_PASSPHRASE
minibox backup --out minibox-backup.mbbak
```

The passphrase is 12 to 1024 characters, with no leading or trailing spaces and no line breaks or NUL characters.

- `--out FILE` saves the archive to `FILE` on this machine. The download is kept only when its size and checksum match the server's record.
- `--overwrite` replaces `FILE` when it exists. It works only with `--out`.
- `--passphrase-stdin` reads the passphrase from the first line of standard input instead of `MINIBOX_BACKUP_PASSPHRASE`. A passphrase is never a command argument, so it stays out of your shell history.

Without `--out`, the backup stays on the server, and the command prints its id. Use `minibox backup ls` to list the backups kept on the server, and `minibox backup rm <id>` to delete one.

Over the REST API, send `POST /api/backups` with `{ "passphrase": "…" }`. It returns `202` and a `taskId`. When the task succeeds, its result holds the backup. Download the archive with `GET /api/backups/{id}/download`. The [MCP](../reference/mcp.md) storage toolset offers `create_backup`, `list_backups` and `delete_backup`. These operations are for the owner only. The console has no backup button. The **Tasks** panel shows the progress of a backup that the API or the CLI started.

### How a backup stays consistent

A backup runs while MiniBox serves requests. Each database is copied from a snapshot that SQLite takes, so the copy holds whole changes only. MiniBox replaces its files instead of rewriting them in place, so a file that is replaced during the backup is archived as the version the backup opened, whole. A file that is removed during the backup is left out. The other files are read one after another, so two files that change together can end up on either side of the change.

For a copy in which every file matches one moment, stop MiniBox first, and copy the data directory as shown under [Copy the data directory by hand](#copy-the-data-directory-by-hand).

A backup that fails leaves no archive behind.

## Restore a backup

Restore runs offline, with MiniBox stopped. It writes into an empty data directory, and it never merges into a directory that holds any file. A wrong passphrase, a damaged file, or a file that is not a backup is refused, and nothing is restored.

1. Stop MiniBox on the host, if it runs there.
2. Restore the archive into an empty data directory:

   ```bash
   read -rs -p "Backup passphrase: " MINIBOX_BACKUP_PASSPHRASE && export MINIBOX_BACKUP_PASSPHRASE
   minibox restore minibox-backup.mbbak --data-dir /srv/minibox-data
   ```

3. Start MiniBox with `DATA_DIR` set to that folder.
4. Restore the Docker volumes that your boxes and checkpoints need, as described under [Restore a volume](#restore-a-volume). Do this before you start the boxes.

After the restore, MiniBox uses the access key from the backup, unless `ACCESS_KEY` is set in the environment or in `.env`.

### Restore into the release image

The release image contains the command-line tool as `src/cli.ts`. Restore into a volume that is empty, such as a new one:

```bash
read -rs -p "Backup passphrase: " MINIBOX_BACKUP_PASSPHRASE && export MINIBOX_BACKUP_PASSPHRASE
docker run --rm -e MINIBOX_BACKUP_PASSPHRASE \
  -v minibox-data:/data \
  -v "$PWD":/backup:ro \
  ghcr.io/arnochenfx/minibox:latest \
  bun src/cli.ts restore /backup/minibox-backup.mbbak --data-dir /data
```

Then start MiniBox with the `minibox-data` volume, as in the [install guide](install.md).

### Restore a pulled backup

A backup pulled from an off-site target is stored in `DATA_DIR/backups/` on the instance that pulled it. Restore its archive as described above, from that file or from a copy of it. Its id is listed by `minibox backup ls`, and `GET /api/backups/{id}/download` returns the archive.

### Restore a volume

Restore each volume under its original name, before you start the box or the checkpoint repository that uses it. For a volume named `vol_abc123`, with an archive made as shown under [Back up a volume](#back-up-a-volume):

```bash
docker volume create vol_abc123
docker run --rm -v vol_abc123:/dst -v "$PWD":/backup:ro alpine \
  tar xzf /backup/vol_abc123.tar.gz -C /dst
```

The volume must be empty before you extract into it.

## Off-site targets

A target is a place outside this host that holds copies of checkpoint packages and backups. There are two kinds:

| Kind | Address | Credentials |
|---|---|---|
| S3-compatible | An `https` endpoint, a region and a bucket. Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`. | An access key ID and a secret access key |
| SFTP | A host, a port and a user. The port defaults to 22. | A private key without a passphrase, and the server's host key |

Add a target in **Settings**, under **Off-site targets**:

1. Click **Add target**, and choose the **Type**, S3-compatible or SFTP.
2. Fill in the **Target name** and the fields for that type. The **Folder** is optional. It is relative to the bucket or to the login folder, and objects go in its root when it is empty.
3. Click **Test** to reach the target without saving it. For an SFTP server, MiniBox shows the host key the server presents, as `SHA256:…`. Compare it with the key on the server, for example with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the server. If it matches, click **Trust and test** in the dialog.
4. Click **Save target**. For SFTP, saving first runs the same check if you have not confirmed the key. The target is stored with the confirmed key, and nothing is sent to a server that presents another key.

Credentials are stored as secrets named `target.<id>.access-key`, `target.<id>.secret-key` or `target.<id>.private-key`. MiniBox never shows their values again. Names that start with `target.` are reserved: no one can create a secret with that prefix, and a box cannot use one. These secrets do not appear in the **Secrets** list.

The card lists each target with its address and folder, its last sync (when it ran, its direction, the object, and any error), and the size of that sync. **Check** reaches the target with its stored credentials and reports whether it answers. **Remove** deletes the target and its credentials from this host. Objects already on the target are not deleted.

### Push and pull

Push and pull run over the REST API and the MCP storage toolset, for the owner only. Each one runs as a task.

- `POST /api/targets/{id}/push` with `{ "object": "bk_…" }` or `{ "object": "pk_…" }` copies a backup or a checkpoint package to the target.
- `POST /api/targets/{id}/pull` with the same body copies one from the target to this instance.
- `GET /api/targets/{id}/objects` lists the complete packages and backups on a target, newest first.

Each object is stored as its archive and a JSON record beside it, in a `backups` or `packages` folder of the target:

```
<folder>/backups/bk_….mbbak
<folder>/backups/bk_….json
<folder>/packages/pk_….mbckpt
<folder>/packages/pk_….json
```

- The archive is written first, and its record last. A target lists an object only when its record is there and matches the archive's size, so an interrupted upload never appears in the list.
- A push skips an object that the target already holds with the same size and checksum. An object that the target holds with other contents is refused, and nothing is replaced.
- A pull stores the archive only when its size and checksum match the record. A pulled backup appears in `GET /api/backups` with origin `target`. A pulled package expires 24 hours after the pull, like an exported one, so import it within that time.
- A target runs one transfer at a time. A second transfer to the same target is refused until the first one finishes.

The credentials need these permissions:

- S3-compatible: list, read, write and delete objects in the bucket or folder. MiniBox deletes a partial upload that fails.
- SFTP: create folders, and write, rename and delete files in the folder. MiniBox removes a partial upload that fails.

MiniBox does not delete a complete object on a target. It replaces a file that an interrupted upload left under the name it writes. Remove old objects with the tools of the bucket or the server.

## Retention and schedules

- Backups stay until you delete them, and they use space in `DATA_DIR/backups/` until then. MiniBox does not create backups on a schedule, and it does not expire them. To back up on a schedule, run `minibox backup --out` from cron or a task scheduler, and delete the archives you no longer need. Keep the passphrase where only that scheduler can read it.
- A pulled package expires 24 hours after the pull. Objects on targets stay until you remove them.

## Copy the data directory by hand

If you cannot use the command-line tool, stop MiniBox and copy its data directory. A copy made this way is not sealed, so keep it as protected as the data directory itself. Do not copy `events.db` or `tasks.db` while MiniBox runs.

For the release image, copy the `minibox-data` volume with a temporary container:

```bash
docker stop minibox
docker run --rm -v minibox-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/minibox-data-$(date +%F).tar.gz -C /data .
docker start minibox
```

For a source install, copy the `data/` folder of the checkout, or the folder that `DATA_DIR` points to, while MiniBox is stopped. Stopping MiniBox does not stop your boxes. To stop a box, use the console, or `docker stop minibox-<name>`.

## Back up a volume

Box files live in Docker volumes named `vol_…`. Boxes created before volumes existed use `minibox-ws-<name>`. The checkpoint repository is the volume `minibox-checkpoints-local`, or `minibox-checkpoints-<host id>` on another host. The **Volumes** page shows the ID of each box volume under its name.

Stop the box that uses a volume first, so that its files do not change during the copy. Stop MiniBox before you copy the checkpoint repository, so that no checkpoint is written during the copy.

```bash
docker run --rm -v vol_abc123:/src:ro -v "$PWD":/backup alpine \
  tar czf /backup/vol_abc123.tar.gz -C /src .
```

Replace `vol_abc123` with the volume's ID. To restore the archive, see [Restore a volume](#restore-a-volume).

## Checkpoints and backups

Checkpoints are copies of one box's data, and they are stored on the same host as the boxes. A backup holds the checkpoint records and schedules, but not the checkpoint data, which is in the repository volume. The recycle bin keeps the data of deleted boxes and volumes in the same repository volume, so a backup does not hold it either. To keep a checkpoint elsewhere, [export](../user-guide/checkpoints.md#export-and-import) it and download the package, or push the package to an [off-site target](#off-site-targets).
