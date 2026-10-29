# Backups

MiniBox can back up its data while it runs. A backup is one file, sealed with a passphrase that MiniBox never stores. It holds the data directory: box specs, tokens, secrets, host, notification and off-site target settings, and the event log and task history. Restore it with the command-line tool, offline, into an empty data directory.

A backup does not hold Docker volumes. Box files live in volumes, and checkpoint data lives in the checkpoint repository volume, so back those up separately. See [Back up a volume](#back-up-a-volume).

To keep copies off this host, add an [off-site target](#off-site-targets): an S3-compatible bucket or an SFTP server.

Code belongs in git. Push your code to a remote repository, so you do not depend on the box volumes.

## What a backup holds

A backup contains every file in the data directory, except these:

- The folder that holds the server's backups: `DATA_DIR/backups/`, or `BACKUP_DIR` when that is set and sits inside the data directory. See [Where backups are kept](#where-backups-are-kept).
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

## Where backups are kept

Without a setting, the server keeps its archives in `DATA_DIR/backups/`, one `<id>.mbbak` per backup with a `<id>.json` record beside it. Set `BACKUP_DIR` to keep them somewhere else, such as a disk that is not the one `DATA_DIR` lives on:

```bash
BACKUP_DIR=/mnt/backups
```

- An absolute path is used as it is. A relative path resolves from the project root, the folder that holds `src/`, exactly as `DATA_DIR` does, so `BACKUP_DIR=archives` is `<project>/archives`. A leading `~/` expands to the home directory of the user that runs MiniBox.
- New backup directories use mode `700`, and the default `DATA_DIR/backups` directory is kept at `700`. An existing custom `BACKUP_DIR` retains its permissions; a shared directory produces a warning. Archives and records use mode `600`.
- The user that runs MiniBox must be able to write the folder. A folder it cannot create or write makes the backup fail, and the failure leaves no archive and no record behind. Nothing is created at startup, so an unset or unusable `BACKUP_DIR` does not stop MiniBox from starting.
- Use a dedicated backup folder that untrusted users cannot write. MiniBox maintains its own archives, records and staging files, and leaves unrelated files alone.
- Symlinks use their actual targets for containment and exclusion. A `BACKUP_DIR` inside `DATA_DIR` is left out of the archive, as `DATA_DIR/backups/` always is, so a backup never contains backups. A `BACKUP_DIR` outside `DATA_DIR` is not part of the data directory at all.
- `BACKUP_DIR` cannot be `DATA_DIR` itself, nor a folder above it such as `/mnt` or the project root. Those would exclude the whole data directory from the archive, leaving a backup that reports success but holds nothing, so MiniBox refuses to start and names the problem.
- `minibox backup ls`, `minibox backup rm`, `GET /api/backups`, the download route and the off-site targets read and write the archives in this folder. A backup pulled from a target lands there too.
- Backups downloaded with `--out` are written where you say, not in this folder.

Changing `BACKUP_DIR` does not move archives. Listings show only the configured folder. Move both the archive and its record manually when changing folders.

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

A backup pulled from an off-site target is stored in the server's backup folder: `DATA_DIR/backups/`, or `BACKUP_DIR` when it is set. Restore its archive as described above, from that file or from a copy of it. Its id is listed by `minibox backup ls`, and `GET /api/backups/{id}/download` returns the archive.

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

### Keep only the newest backups

`BACKUP_KEEP=N` keeps the newest `N` backups and deletes the older ones:

```bash
BACKUP_KEEP=7
```

What counts, and what does not:

- The backups are the archives in the server's backup folder, `DATA_DIR/backups/` or `BACKUP_DIR`. Only the ones MiniBox wrote count: a `<id>.mbbak` with its `<id>.json` record beside it, whose size matches the record. A record whose archive is missing or short, a partial archive left by a crash, and any other file in the folder are left alone, so a folder that holds other things keeps them.
- Off-site targets are not touched. MiniBox never deletes a complete object on an S3-compatible bucket or an SFTP server, whatever `BACKUP_KEEP` says. Remove old objects with the tools of the bucket or the server, or with `DELETE /api/backups/{id}` before pushing fewer.
- Archives downloaded with `minibox backup --out` are on your machine, not in this folder, so they are yours to delete.

Order and timing:

- Newest first, by the time the backup was made, then by id. Two backups made in the same millisecond are ordered by id, so a pass always picks the same ones, and the backup that just finished is always among the newest.
- A pass runs after every backup that succeeds, and once at startup. Lowering `BACKUP_KEEP` and restarting therefore prunes at once, without waiting for the next backup. A backup that fails does not run a pass, so a failing backup never removes a good archive.
- `BACKUP_KEEP=0`, a blank value and an unset value all keep every backup. That is the default. A value that is not a whole number, or is negative, also keeps every backup instead of guessing: a typo must never delete archives. A number above 10000 is treated the same way.

A backup that `BACKUP_KEEP` removes is gone for good. Push the ones you want to keep to an [off-site target](#off-site-targets) first.

Bad or unreadable records are logged and skipped; healthy records remain visible. Retention failures are logged and preserve completed archives. Startup maintenance failures do not stop the server. If the whole archive directory is unreadable, listing and creating backups fail; check its permissions.

### Scheduled backups

MiniBox can back itself up on a schedule, so you do not need cron. A schedule is one rule for the whole instance: every few hours, or once a day at a time you choose. It is off by default, and a set schedule survives a restart because it is a file in the data directory.

A scheduled run needs a passphrase, and nobody is there to type one, so MiniBox reads it from `BACKUP_PASSPHRASE` in `.env`:

```bash
BACKUP_PASSPHRASE=correct horse battery staple
```

The rules are the same as a passphrase you type: 12 to 1024 characters, with no leading or trailing spaces and no line breaks. Blank leaves the passphrase unset: MiniBox then refuses to save a schedule, and says why, instead of saving one that would fail at its first slot. A schedule saved before the passphrase went missing fails once at its next slot, with the same message. An invalid value stops MiniBox at startup rather than leaving every run failed.

The console says so before you try, not after: with no passphrase on the server, the card on **Settings → Backups** shows a warning, and **Set a schedule** is disabled (so is **Change schedule** for a schedule saved earlier; **Turn off** stays open). `minibox backup schedule get` prints the same note, and `GET /api/backups/schedule` reports it as `passphraseSet`.

Keep `$` out of a passphrase in `.env`. Bun expands `$` in `.env` values even inside quotes, so `'ab$cd'` reaches MiniBox as `ab`, and a `#` cuts an unquoted value there too, so quote a passphrase that has one. If the passphrase needs a `$`, leave it out of `.env` and set `BACKUP_PASSPHRASE` in the process environment instead, such as the `environment:` of a compose file or a systemd `Environment=`. MiniBox reads `.env` on its own as well and refuses to start when the two readings differ, because it will not seal archives with a passphrase you did not write. Escaping the `$` as `\$` does not get around that: Bun understands it, but the two readings still differ.

Set the schedule in **Settings → Backups**, under **Schedule**, with **Set a schedule**:

1. Choose **Every few hours** and a whole number of hours from 1 to 720, or **Once a day** and a time of day. The daily time is in your browser's time zone, which the dialog names.
2. Click **Save schedule**.

The card then shows the rule, its **Next run** and its **Last run**, in your local time and with the zone. **Change schedule** edits it, and **Turn off** removes it. Turning a schedule off keeps the backups it already made.

The same rule is available over the REST API and the command-line tool:

```bash
minibox backup schedule set --every-hours 6
minibox backup schedule set --at 02:30 --timezone Asia/Shanghai
minibox backup schedule get
minibox backup schedule clear
```

`PUT /api/backups/schedule` sets it with `{ "everyHours": 6 }`, or with `{ "at": "02:30", "timezone": "Asia/Shanghai" }`, not both. `GET` on the same path reads it, `DELETE` removes it, and a `null` schedule means none is set. `GET` also says whether the server has a `BACKUP_PASSPHRASE` (`passphraseSet`), and `PUT` answers `409` when it has none. In `lastRun`, `status` is `ok`, `skipped` with a `reason` (`busy`: another backup held the folder), or `failed` with an `error`. A daily time takes an IANA zone such as `Asia/Shanghai`; without one it is UTC, and a UTC offset such as `+08:00` is refused. The MCP storage toolset offers `get_backup_schedule`, `set_backup_schedule` and `clear_backup_schedule`. These operations are for the owner only.

What a run does:

- A due run makes one backup, through the same service that `minibox backup` uses. It lands in the server's backup folder, `DATA_DIR/backups/` or `BACKUP_DIR`, so a scheduled backup and a manual one are the same kind of archive.
- `BACKUP_KEEP` applies afterwards, exactly as it does to a manual backup. A schedule therefore cannot fill the disk on its own: with `BACKUP_KEEP=7` it keeps the newest seven and removes the older ones. See [Keep only the newest backups](#keep-only-the-newest-backups).
- A failed run is recorded on the schedule and logged once, and nothing runs again until the next slot. It does not retry in a loop.
- A run that is due while another backup holds the folder, such as a manual backup that is still running, makes no backup and is recorded as **skipped**, not failed: **Last run** says why, the log has one `backup.scheduled_skipped` line, and there is no audit event, because nothing went wrong. The schedule runs again at its next time.
- A run that fell due while MiniBox was down happens once when it comes back, not once per missed slot. An every-hours schedule keeps to its original times, so a late run does not move the later ones; a daily schedule runs at its next time.
- Schedules are checked every minute. A backup made on a schedule appears in `GET /api/backups` and records the audit event `backup.scheduled`.

Scheduled backups are sealed with the passphrase in `BACKUP_PASSPHRASE`, which stays in `.env` on the server. Keep it apart from the archives: it is what opens them.

Keep the exact passphrase somewhere other than this server, and try a restore before you rely on the schedule. If `BACKUP_PASSPHRASE` differs between the process environment and `.env`, startup refuses it (see above) rather than seal archives with a passphrase you did not type.

### Cron, if you prefer it

A schedule inside MiniBox covers the usual case, and cron is still fine for people who prefer it. Running `minibox backup` from cron or a task scheduler also works, and it can download the archive to another machine with `--out`, which an in-app schedule does not do:

```
30 3 * * * MINIBOX_URL=http://127.0.0.1:3920 MINIBOX_ACCESS_KEY=… MINIBOX_BACKUP_PASSPHRASE=… minibox backup
```

Without `--out`, each run adds an archive to the server's backup folder, and `BACKUP_KEEP` decides how many stay. With `--out`, the archive is downloaded to the machine that runs the job, and the copy on the server counts against `BACKUP_KEEP` like any other. Keep the passphrase where only that scheduler can read it. A cron job and a schedule both set would each make their own backups, so pick one.

A pulled checkpoint package expires 24 hours after the pull. Objects on targets stay until you remove them.

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

Box files live in Docker volumes named `vol_…`. Boxes created before volumes existed use `minibox-ws-<name>`. The checkpoint repository is the volume `minibox-checkpoints-local`, or `minibox-checkpoints-<host id>` on another host. The **Volumes** tab of **Storage** shows the ID of each box volume under its name.

Stop the box that uses a volume first, so that its files do not change during the copy. Stop MiniBox before you copy the checkpoint repository, so that no checkpoint is written during the copy.

```bash
docker run --rm -v vol_abc123:/src:ro -v "$PWD":/backup alpine \
  tar czf /backup/vol_abc123.tar.gz -C /src .
```

Replace `vol_abc123` with the volume's ID. To restore the archive, see [Restore a volume](#restore-a-volume).

## Checkpoints and backups

Checkpoints are copies of one box's data, and they are stored on the same host as the boxes. A backup holds the checkpoint records and schedules, but not the checkpoint data, which is in the repository volume. The recycle bin keeps the data of deleted boxes and volumes in the same repository volume, so a backup does not hold it either. To keep a checkpoint elsewhere, [export](../user-guide/checkpoints.md#export-and-import) it and download the package, or push the package to an [off-site target](#off-site-targets).
