# Checkpoints

A checkpoint is a copy of a box's data. You can fork a new box from a checkpoint, or roll a box back to one.

A checkpoint includes the box's `/workspace` folder and its home folder. A template includes only the system files, so a checkpoint is the way to keep your work.

Checkpoints are available in the console, and in the [REST API](../reference/api.md). The [MCP](../reference/mcp.md) storage toolset also exports, imports, copies and schedules them, for the owner only. The command-line tool copies them to another host with `minibox checkpoint copy`.

Checkpoints are not a backup of the whole server. They are stored on the host the box was on when the checkpoint was taken, and they stay there when the box moves. With more than one host, a checkpoint's row names its host. A rollback uses the checkpoint from the box's own host, so to roll back to a checkpoint on another host, [copy](#copy-to-another-host) it there, or move the box there first. Keep an off-host copy of anything you cannot lose. [Export](#export-and-import) a checkpoint to make a copy you can carry elsewhere, or push the package to an [off-site target](#off-site-targets). To back up the whole server, see [Backups](../admin/backups.md).

## Create a checkpoint

1. Open the box, click **Settings**, and then **Checkpoints**.
2. Click **Create checkpoint**. The same button is in the title bar of the box, on every tab.
3. In **Label**, type a short name. Leave it empty to use the box's name.
4. Under **Consistency**, choose how the box is held while its files are copied:

   | Choice | What happens |
   |---|---|
   | **Live** | The copy runs while the box keeps running. This is the fastest choice. The copy is crash-consistent. |
   | **Pause** | The running box is paused during the copy, then resumes. Files do not change during the copy. |
   | **Stop** | The box stops for the copy, then starts again. |

   A box that is stopped or asleep is copied as it is, whichever choice you pick.

5. To include the system layer, tick **Include the system layer**. This saves the box's installed software, so a fork starts with it. It takes longer, and it uses more space.
6. Click **Create checkpoint**.

The checkpoint appears in the list when it is ready. Follow the progress in the **Tasks** panel.

While the host disk is below its free-space minimum, MiniBox refuses a checkpoint you create by hand, a box you make from a checkpoint, a rollback, a rebuild that takes a [safety checkpoint](#safety-checkpoints), and a delete that keeps a copy in the [recycle bin](#recycle-bin). Each returns `507` (`insufficient_storage`) at once. A scheduled checkpoint is skipped instead. See [Volumes and storage](volumes-and-storage.md#usage-limits-and-free-space).

## Checkpoint list

The list shows each checkpoint's **Taken** time, **Label**, **Kind** and **Contents**. The kinds are:

- **Manual**: a checkpoint that you took.
- **Automatic**: a checkpoint that MiniBox took. MiniBox takes one before each rollback, before a box is rebuilt or has a volume attached or detached (a [safety checkpoint](#safety-checkpoints)), and on a [schedule](#scheduled-checkpoints) if you set one.
- **Pinned**: a checkpoint that you pinned.
- **Legacy snapshot**: a snapshot from before checkpoints existed. You can fork it or delete it, but not roll back to it.

## Fork a checkpoint

Forking creates a new box from a checkpoint. The box that the checkpoint came from does not change.

1. On the checkpoint's row, click **Fork**.
2. In **New box name**, type a name for the new box.
3. To copy the home folder, tick **Copy home**. It is off by default, because the home folder can hold credentials and other sensitive files.
4. Click **Fork**.

## Roll back to a checkpoint

Rolling back replaces the box's current data with the data in a checkpoint.

1. On the checkpoint's row, click **Roll back**.
2. Read the dialog. It lists **Volumes that will be replaced**, **Stays the same**, and **Lost** (changed files in the container).
3. Click **Roll back**.

Before anything changes, MiniBox takes a safety checkpoint of the current data. The box is then rebuilt with the restored data.

After a rollback, the old volumes are kept, so you can decide what to do with them. The **Checkpoints** section of the box's **Settings** shows **Old volumes are kept**, with two buttons:

- **Confirm and clean up** deletes the old volumes.
- **Undo rollback** mounts the old volumes again. Anything written since the rollback is lost.

## Safety checkpoints

Before MiniBox rebuilds a box, it takes a safety checkpoint of the box's data, so the data can be recovered if the rebuild goes wrong. This covers a rebuild from the **Rebuild** button, a change to a box's template, environment, mounts or security profile, and attaching or detaching a volume. The safety checkpoint is labelled **Before rebuild**, and it is automatic.

It is taken by default. To skip it, clear **Take a safety checkpoint first** in the rebuild preview, or in the dialog that confirms an attach or a detach. The REST API takes `safetyCheckpoint: false` for the same purpose, and so do the MCP tools `rebuild_box`, `attach_volume` and `detach_volume`.

- If the rebuild fails and MiniBox restores the box, the safety checkpoint is discarded.
- If the box cannot be restored exactly, the safety checkpoint is kept, and the error names it. Fork it to get the data back.
- A box with no volumes of its own has no data to keep, so MiniBox takes no checkpoint for it.
- A repository at its limit refuses the checkpoint, as it refuses a rollback. A host disk below its free-space minimum refuses it with `507`.

## Pin and delete

- Click **Pin** to keep a checkpoint, even when automatic cleanup runs. Click **Unpin** to allow cleanup again.
- Click **Delete** to remove a checkpoint. The data is removed from the repository, and this cannot be undone. A pinned checkpoint must be unpinned before you delete it.

## Recycle bin

When you delete a box or a volume, MiniBox keeps a copy of its data in the recycle bin, so you can bring it back for a while. Open **Storage** in the sidebar and click **Recycle bin** to see the entries, newest deletion first, with their size and the time each one has left.

A delete keeps:

- **A box**: the data of its workspace and home volumes, which are the volumes it owns and that checkpoints include. The copy is taken before the box is removed, and it is kept whether or not you also delete the box's volumes. The cache volume, the shared tools volume and independent volumes are not kept.
- **A volume**: its data. A cache or tools volume keeps nothing.

To restore an entry, click **Restore**, and type a **Name**. The name must be free on its host. A box comes back as a new box, with its template, data, resources, security profile and network egress. It does not get back the environment variables, startup command, labels, TTL or shared mounts of the box it came from. A box that had `none` or `proxy-only` egress gets a new private network. See [Network egress](../admin/network-egress.md). A volume comes back as a new volume. The restore runs as a task, and the entry is removed when it has finished, so a failed restore leaves the entry in place.

Click **Purge now** to remove an entry and its data at once. You confirm first, and the data cannot be restored afterwards.

An entry is kept for `TRASH_RETENTION_DAYS` days, 7 by default. The administrator can set 1 to 365 days. An hourly cleanup removes the entries whose time is up. Entries do not count against the [limits for automatic checkpoints](#how-long-checkpoints-are-kept).

To delete without keeping a copy, tick **Delete without keeping a copy** in the delete dialog. The data is removed at once and cannot be restored. Only the owner, or a token with the `trash:skip` scope, may do this. Over the REST API, send `skipTrash=true` with `DELETE /api/boxes/{id}` or `DELETE /api/volumes/{id}`. The MCP tools `delete_box` and `delete_volume` take `skipTrash: true`.

Entries are kept in the checkpoint repository, so they count against the size limit, `CHECKPOINT_CAPACITY_MB`. When a delete would take the repository past that limit, MiniBox first purges the oldest entries. If that is not enough, the delete is refused, with the sizes in the message, and nothing is stopped or removed. While the host disk is below its free-space minimum, a delete that keeps a copy is refused with `507`.

Entries do not appear in the checkpoint list. Each host keeps its own recycle bin. The page lists the entries of every host, and a restore or purge runs on the host the entry is on. Each delete, restore and purge is recorded in the event log, as `box.trashed` or `volume.trashed`, `trash.restored` and `trash.purged`. The recycle bin is for the owner only.

On the command line, `minibox trash ls` lists the entries, `minibox trash restore <id>` restores one, with `--name`, `--cpus` and `--memory`, and `minibox trash purge <id>` purges one. The MCP tools are `list_trash`, `restore_trash` and `purge_trash`.

## Copy to another host

A copy makes a checkpoint available on another host, so you can fork a box from it there without moving the box. The original stays where it is. The copy is a new checkpoint with its own id on the target host. It keeps the original's label, pin, creation time and box settings.

To copy one, click **Copy to host** on the checkpoint's row, choose the host, and click **Copy**. The button shows only when there is more than one host. The copy runs as a task, and its log shows the transfer. On the command line, `minibox checkpoint copy <id> --host <host>` waits for the task and prints the copy's id. Over the REST API, `POST /api/checkpoints/{id}/copy` with `{ "host": "<id>" }` returns `202` with a task. Copying is for the owner only.

The data is packed on the source host into a sealed package, with a passphrase made for that one copy. The package passes through this control plane, and MiniBox removes it when the copy ends, whether it succeeds or not. If the target lacks the base template, or the template the checkpoint was taken from, the copy sends that template first, as a template copy does. A copy that fails leaves no checkpoint on the target.

A copy is refused for the same reasons as an export. These are a snapshot from before checkpoints, a checkpoint that holds no volume data, and a checkpoint that includes its system layer. It is also refused when the target is the host the checkpoint is already on, when that host already holds a copy of it, and when the checkpoint is being exported or copied. The package must fit in `CHECKPOINT_PACKAGE_MAX_MB`, as an export does.

`GET /api/checkpoints` lists the copy with its host. Forking from the copy creates the box on that host.

## Export and import

Export a checkpoint to get a portable package: a single `.mbckpt` file. Keep it off the host, or import it on this instance or on another MiniBox instance. Export and import are owner only.

To export a checkpoint:

1. On the checkpoint's row, click **Export**.
2. Type a **Passphrase**, and type it again in **Repeat the passphrase**. Use 12 to 1024 characters. The passphrase cannot start or end with a space, and it cannot contain a line break.
3. Click **Export**. The export runs as a task. When the package is ready, the browser downloads it.

The package holds the checkpoint's data, sealed with the passphrase. It holds no host secrets. MiniBox does not store the passphrase, so without it the package cannot be opened, not even by you. The package stays on the instance for a day, then the hourly cleanup removes it.

Some checkpoints cannot be exported. These are a snapshot from before checkpoints existed, a checkpoint that holds no volume data, and a checkpoint that includes its system layer, because a package does not carry the system layer yet. To export the last kind, take a checkpoint without the system layer.

To import a package:

1. In the box's **Settings**, under **Checkpoints**, click **Import**.
2. Choose the **Package file**, a `.mbckpt` file, and type the **Passphrase** it was sealed with. If this instance has more than one host, choose the **Host** to import onto.
3. Click **Import**. The import runs as a task. When it finishes, the checkpoint can be forked. It is listed in this section only when this box is the one it was taken from, as described below.

A wrong passphrase fails the import, and the package stays, so you can try again until it expires. A checkpoint whose id already exists on the instance is not imported, and nothing there changes.

An imported checkpoint keeps the id of the box it came from. It appears in that box's list only when a box with that id exists on this instance, and it always appears in `GET /api/checkpoints`. A checkpoint without a system layer forks from the template it was taken from, so the host needs that template's image.

The package size is limited by `CHECKPOINT_PACKAGE_MAX_MB`, which is 2048 MB by default. A larger export fails with `payload_too_large`. Over the REST API, export with `POST /api/checkpoints/{id}/export`, upload the file with `POST /api/packages` as `application/octet-stream`, and import it with `POST /api/packages/{id}/import`. See the [API reference](../reference/api.md).

## Off-site targets

An off-site target is an S3-compatible bucket or an SFTP folder outside this host. Targets are listed in **Settings**, under **Off-site targets**. Pushing and pulling packages is an owner operation of the [REST API](../reference/api.md) and the [MCP](../reference/mcp.md) storage toolset, and each one runs as a task.

Push an exported package before it expires, 24 hours after the export. A package that you pull from a target can be imported as described above, within 24 hours of the pull. See [Backups](../admin/backups.md#off-site-targets) for how to add a target.

## Scheduled checkpoints

A box can take checkpoints on a schedule: every few hours, or once a day at a time you choose. Schedules are off by default, so a box without one behaves as before.

To set a schedule, open the box's **Settings**, go to **Checkpoints**, and in **Schedule** click **Set a schedule**:

1. Under **When**, choose **Every few hours** and type the **Hours**, from 1 to 720. Or choose **Once a day** and type a **Time**, such as `02:30`. The time is in your browser's time zone, which the dialog names.
2. Click **Save schedule**.

The section then shows the schedule, such as `Every day at 03:00 (Asia/Shanghai)`, with its **Next run** and **Last run** in your local time, followed by your time zone. The last run says whether a checkpoint was taken, or why the run was skipped or failed. **Change schedule** edits the schedule, and **Turn off** removes it. Turning a schedule off keeps the checkpoints it already took.

A scheduled checkpoint is taken while the box keeps running, like a **Live** checkpoint. It is not pinned, and it counts as automatic, so the retention policy keeps or removes it in the same way as the checkpoints MiniBox takes before a rollback.

MiniBox never wakes or starts a box for a schedule. A stopped or sleeping box is skipped, and a scheduled checkpoint does not count as activity, so it never keeps an idle box from sleeping. A box moved to another host keeps its schedule, and the next run is taken on the new host. A run is also skipped while the checkpoint repository is at its limit, or while the host disk is below its free-space minimum, until space is freed. If the box has been deleted, its schedule is removed. A failed run records its error. While a host is offline, its schedules wait for it to come back.

Schedules are checked every minute, and they are kept on the instance, so they survive a restart. A run that fell due while the server was down happens once after the server starts, within about a minute. An every-hours schedule keeps to its original times, so a late run does not move the later ones. A daily schedule runs at its next time, and keeps to the clock of its zone when daylight saving time starts or ends. A time the clocks skip runs an hour later, and a time that happens twice runs once.

Over the REST API, `PUT /api/boxes/{id}/checkpoint-schedule` sets a schedule and `DELETE` on the same path removes it. A daily time takes `timezone`, an IANA name such as `Asia/Shanghai`; without it the time is UTC. A UTC offset such as `+08:00` is not accepted. If the server no longer knows a saved zone, the schedule keeps running in UTC, the response has `timezoneUnknown: true`, and the section asks you to set the schedule again. The MCP storage toolset does the same for the owner.

## How long checkpoints are kept

- Manual and pinned checkpoints are kept until you delete them.
- Automatic checkpoints are kept for each box. Scheduled checkpoints and safety checkpoints are automatic too. MiniBox keeps the newest 20, and removes any older than 30 days. The administrator can change these limits. See [Configuration](../reference/configuration.md).
- Recycle bin entries are not checkpoints. Each is kept for its own period, as described in [Recycle bin](#recycle-bin).
- The administrator can also set a size limit for all checkpoints. When the limit is reached, MiniBox does not take new automatic checkpoints. Rollbacks and rebuilds that take a safety checkpoint are refused for the same reason. The recycle bin counts against the same limit: a delete that keeps a copy purges the oldest entries first, and is refused only when that is not enough.
