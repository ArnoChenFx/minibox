# Checkpoints

A checkpoint is a copy of a box's data. You can fork a new box from a checkpoint, or roll a box back to one.

A checkpoint includes the box's `/workspace` folder and its home folder. A template includes only the system files, so a checkpoint is the way to keep your work.

Checkpoints are available in the console, and in the [REST API](../reference/api.md). The command-line tool does not manage them.

Checkpoints are not a backup of the whole server. They are stored on the same host as the boxes. Keep an off-host copy of anything you cannot lose.

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
- **Automatic**: a checkpoint that MiniBox took. MiniBox takes one before each rollback.
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

## How long checkpoints are kept

- Manual and pinned checkpoints are kept until you delete them.
- Automatic checkpoints are kept for each box. MiniBox keeps the newest 20, and removes any older than 30 days. The administrator can change these limits. See [Configuration](../reference/configuration.md).
- The administrator can also set a size limit for all checkpoints. When the limit is reached, MiniBox does not take new automatic checkpoints. Rollbacks are refused for the same reason, because they start with a safety checkpoint.
