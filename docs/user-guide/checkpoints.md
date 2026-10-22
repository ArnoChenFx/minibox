# Checkpoints

A checkpoint is a copy of a box's data. You can fork a new box from a checkpoint, or roll a box back to one.

A checkpoint includes the box's `/workspace` folder and its home folder. A template includes only the system files, so a checkpoint is the way to keep your work.

Checkpoints are available in the console, and in the [REST API](../reference/api.md). The [MCP](../reference/mcp.md) storage toolset also exports, imports and schedules them, for the owner only. The command-line tool does not manage them.

Checkpoints are not a backup of the whole server. They are stored on the same host as the boxes. Keep an off-host copy of anything you cannot lose. [Export](#export-and-import) a checkpoint to make a copy you can carry elsewhere.

## Create a checkpoint

1. Open the box, and click the **Checkpoints** tab.
2. Click **Create checkpoint**.
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

## Checkpoint list

The list shows each checkpoint's **Taken** time, **Label**, **Kind** and **Contents**. The kinds are:

- **Manual**: a checkpoint that you took.
- **Automatic**: a checkpoint that MiniBox took. MiniBox takes one before each rollback, and on a [schedule](#scheduled-checkpoints) if you set one.
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

After a rollback, the old volumes are kept, so you can decide what to do with them. The **Checkpoints** tab shows **Old volumes are kept**, with two buttons:

- **Confirm and clean up** deletes the old volumes.
- **Undo rollback** mounts the old volumes again. Anything written since the rollback is lost.

## Pin and delete

- Click **Pin** to keep a checkpoint, even when automatic cleanup runs. Click **Unpin** to allow cleanup again.
- Click **Delete** to remove a checkpoint. The data is removed from the repository, and this cannot be undone. A pinned checkpoint must be unpinned before you delete it.

## Export and import

Export a checkpoint to get a portable package: a single `.mbckpt` file. Keep it off the host, or import it on this instance or on another MiniBox instance. Export and import are owner only.

To export a checkpoint:

1. On the checkpoint's row, click **Export**.
2. Type a **Passphrase**, and type it again in **Repeat the passphrase**. Use 12 to 1024 characters. The passphrase cannot start or end with a space, and it cannot contain a line break.
3. Click **Export**. The export runs as a task. When the package is ready, the browser downloads it.

The package holds the checkpoint's data, sealed with the passphrase. It holds no host secrets. MiniBox does not store the passphrase, so without it the package cannot be opened, not even by you. The package stays on the instance for a day, then the hourly cleanup removes it.

Some checkpoints cannot be exported. These are a snapshot from before checkpoints existed, a checkpoint that holds no volume data, and a checkpoint that includes its system layer, because a package does not carry the system layer yet. To export the last kind, take a checkpoint without the system layer.

To import a package:

1. On the **Checkpoints** tab of a box, click **Import**.
2. Choose the **Package file**, a `.mbckpt` file, and type the **Passphrase** it was sealed with. If this instance has more than one host, choose the **Host** to import onto.
3. Click **Import**. The import runs as a task. When it finishes, the checkpoint is in the list.

A wrong passphrase fails the import, and the package stays, so you can try again until it expires. A checkpoint whose id already exists on the instance is not imported, and nothing there changes.

An imported checkpoint keeps the id of the box it came from. It appears in that box's list only when a box with that id exists on this instance, and it always appears in `GET /api/checkpoints`. A checkpoint without a system layer forks from the template it was taken from, so the host needs that template's image.

The package size is limited by `CHECKPOINT_PACKAGE_MAX_MB`, which is 2048 MB by default. A larger export fails with `payload_too_large`. Over the REST API, export with `POST /api/checkpoints/{id}/export`, upload the file with `POST /api/packages` as `application/octet-stream`, and import it with `POST /api/packages/{id}/import`. See the [API reference](../reference/api.md).

## Scheduled checkpoints

A box can take checkpoints on a schedule: every few hours, or once a day at a time you choose. Schedules are off by default, so a box without one behaves as before.

To set a schedule, open the box's **Checkpoints** tab, and in **Schedule** click **Set a schedule**:

1. Under **When**, choose **Every few hours** and type the **Hours**, from 1 to 720. Or choose **Once a day** and type a **Time**, such as `02:30`. The time is on the server's clock.
2. Click **Save schedule**.

The tab then shows the schedule with its **Next run** and **Last run**. The last run says whether a checkpoint was taken, or why the run was skipped or failed. **Change schedule** edits the schedule, and **Turn off** removes it. Turning a schedule off keeps the checkpoints it already took.

A scheduled checkpoint is taken while the box keeps running, like a **Live** checkpoint. It is not pinned, and it counts as automatic, so the retention policy keeps or removes it in the same way as the checkpoints MiniBox takes before a rollback.

MiniBox never wakes or starts a box for a schedule. A stopped or sleeping box is skipped. A run is also skipped while the checkpoint repository is at its limit, until space is freed. If the box has been deleted, its schedule is removed. A failed run records its error. While a host is offline, its schedules wait for it to come back.

Schedules are checked every minute, and they are kept on the instance, so they survive a restart. A run that fell due while the server was down happens once after the server starts, within about a minute. An every-hours schedule keeps to its original times, so a late run does not move the later ones. A daily schedule runs at its next time.

Over the REST API, `PUT /api/boxes/{id}/checkpoint-schedule` sets a schedule and `DELETE` on the same path removes it. The MCP storage toolset does the same for the owner.

## How long checkpoints are kept

- Manual and pinned checkpoints are kept until you delete them.
- Automatic checkpoints are kept for each box, and scheduled checkpoints are automatic too. MiniBox keeps the newest 20, and removes any older than 30 days. The administrator can change these limits. See [Configuration](../reference/configuration.md).
- The administrator can also set a size limit for all checkpoints. When the limit is reached, MiniBox does not take new automatic checkpoints. Rollbacks are refused for the same reason, because they start with a safety checkpoint.
