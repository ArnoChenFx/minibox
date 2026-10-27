# Volumes and storage

A volume is a place where files are kept. Volumes are separate from boxes. A box uses zero or more volumes. Its files survive when the box is stopped, rebuilt or deleted, as long as the volume stays.

Click **Storage** in the sidebar to see your volumes and storage pools on the **Volumes** tab.

## Volume roles

A new box gets four volumes by default:

| Role | Default pool | Mounted at | Mode |
|---|---|---|---|
| **Workspace** | Default pool | `/workspace` | Read-write |
| **Home** | Default pool | `/home/dev` | Read-write. Treat it as sensitive, because it can hold credentials. |
| **Tools** | Default pool | `/opt/minibox/tools` | Read-only. One shared volume per pool holds the installed tools. |
| **Cache** | Local pool | `/home/dev/.cache` | Read-write. Left out of checkpoints and the recycle bin. |

To use different volumes, click **Customize** in the create dialog. Each row there mounts a volume that already exists, or has MiniBox create one of the box's role volumes for it. The dialog starts with one row per role, so the box gets the same four volumes as the default mode, and a row you remove means that role's volume is not created. That is how a box gets the shared tools volume without the other three, or only a workspace.

The tools row mounts the host's shared tools volume, and creates it when the host has none. One tools volume serves every box on the host.

A role mount creates a new volume, so it needs the `volume:write` scope, and so does mounting an existing volume read-write. The tools row also needs `volume:attach` when the shared tools volume already exists.

To add a volume to a box that already exists, attach it on the box's page.

## Storage pools

A storage pool is a place where MiniBox creates volumes. There are three kinds:

- **Local** pool: volumes on the Docker host's disk. This pool always exists, and it is the default for cache.
- **NFS** pool: volumes on an NFS server, such as a NAS. See [NFS and NAS storage](nfs.md).
- **Path** pool: volumes in a folder that you mount on the host yourself.

To add an NFS pool, click **Add NFS**. To add a path pool, click **Add path**. Click **Save pools** to save your changes.

The pool table shows **Reachable** for a pool that works, and **Storage unreachable** for one that does not. It also shows the free space.

One pool is the default. To change the default, click **Make this the default pool** in the pool's dialog, or the **Default** setting on its row.

A pool that still has volumes cannot be removed.

### Edit a storage pool

Click **Edit** on a pool's row to change the pool you already have, instead of removing it and adding it again. The form is the one that adds a pool, filled in with the pool's values:

- An **NFS** pool has **Pool name**, **Server**, **Export**, **Options** and **Make this the default pool**.
- A **Path** pool has **Pool name**, **Root**, **Marker file** and **Make this the default pool**.

The local pool has no **Edit** button: it is the built-in pool and cannot be changed.

Saving an edit works like adding a pool: the dialog's **Confirm** sends the change, the preview lists what changes, and the pools are saved once you confirm the preview. Two things the server decides:

- **Renaming is allowed, but a pool that still has volumes keeps its name.** Volumes record the pool they were created on, so the server refuses the rename with `pool_in_use` and nothing is saved. The dialog shows that reason, and the form stays open so you can correct the name. The same goes for **Backend**: the form shows the pool's backend but does not offer another one, because a pool that still has volumes cannot change it.
- **Changing the server, export, options, root or marker does not change volumes that already exist.** Each Docker volume keeps the mount parameters it was created with, because Docker cannot remount a volume in place. New volumes use the new parameters. The dialog says so, and the preview shows the parameters before and after, so you can see what an edit changes. To move an existing volume to new parameters, copy its data into a new volume.

## Create and attach volumes

- To create a volume, click **Create volume**, and choose a pool. The volume is independent, which means it is not tied to a box.
- To attach a volume to a box, open the box's page, and use **Attach**. Attaching a volume is a change of the box's mounts, so it is staged, and the box is rebuilt when the staged changes are applied.
- To detach a volume, click **Detach**. Detaching is staged the same way, and the row is marked **To detach** until you apply the change or click **Undo**.

Applying the staged changes takes a [safety checkpoint](checkpoints.md#safety-checkpoints) of the box first, unless you clear **Take a safety checkpoint first** in the confirmation.

Changing the mounts of a box rebuilds it. The box keeps its name and its volumes. The writable layer and the running processes are lost. See [Stage a change and rebuild](boxes.md#stage-a-change-and-rebuild).

## Read-write and read-only

- A **Read-write** mount lets the box change the files.
- A **Read-only** mount lets the box read the files only.

The same volume can be mounted by several boxes. When you mount a volume read-write in a second box, the console asks you to confirm. Docker does not lock files between boxes, so two boxes that write the same file can overwrite each other's work.

## Snapshot a volume

Click **Snapshot** on a volume to keep a copy of its data as a checkpoint.

- An **independent** volume is snapshotted on its own, whether or not a box mounts it. The checkpoint's record names no box, and holds that one volume. The **Checkpoints** tab groups it under the volume's name, with the badge **Volume**, and the row's **Contents** names the volume. A box that mounts the volume keeps running while the copy is taken.
- A volume that a box **owns** goes with its owner box, so its **Snapshot** button takes a checkpoint of that box. That box's checkpoint always includes its workspace and home volumes.

The snapshot is a manual checkpoint, so [retention](checkpoints.md#checkpoint-list) never expires it on its own, and it can be pinned and deleted like any other checkpoint. It holds no box settings, so it cannot be forked into a box, exported, copied or rolled back to: those buttons are off, and the API refuses each with its reason. To take a box's settings and data together, take a checkpoint of the box instead.

A cache volume and the shared tools volume are never part of a checkpoint, so their **Snapshot** button is off. A volume the engine has lost cannot be snapshotted either, since a copy would only create it again empty.

The command line snapshots a volume too: `minibox volume snapshot <id|name> [--label TEXT] [--pin]`, which prints the checkpoint's id.

## Delete a volume

Click **Delete** on the volume. MiniBox does not delete a volume that a box still mounts.

Deleting a volume keeps a copy of its data in the [recycle bin](checkpoints.md#recycle-bin) for `TRASH_RETENTION_DAYS` days, 7 by default. Restore the entry from the **Recycle bin**, which you open from **Storage**, to get it back as a new volume. A cache or tools volume keeps nothing. To delete without keeping a copy, tick **Delete without keeping a copy**. Only the owner, or a token with the `trash:skip` scope, can do that.

When you delete a box, you can also delete the volumes that the box owns. See [Boxes](boxes.md#delete-a-box).

## When the engine loses a volume

MiniBox records each volume, and the engine keeps its data. If the engine loses a volume that MiniBox still has a record for, the **Volumes** tab shows **Engine volume missing** on that volume.

The shared **Tools** volume is recreated for you. When a box is created, started, rebuilt or moved to a host, when a tool is installed or listed, and at startup, MiniBox recreates the tools volume under the same name. The activity list shows **Recreated volume**. On a local pool the volume comes back empty, so the tools that were on it are gone and show as not installed. To install them again, click **Install missing** on a box's **Tools** tab. On an NFS or path pool the volume reuses its directory on the share, so the tools on it are still there.

The workspace, home and cache volumes hold your data, so MiniBox does not recreate them. A box that mounts one of them does not start until you restore the engine volume. If you no longer need that data, delete the box and keep its volumes, then delete the volume. Deleting a volume the engine lost keeps no copy, because the engine no longer has its data.

When you delete a box and keep its volumes, those volumes show **Owner box deleted**. Their data is still there. Delete a volume you no longer need to free its space. MiniBox does not delete a volume that a box still mounts.

## Delete several volumes, or clean up orphans

On the **Volumes** tab, tick the volumes to delete. The header box selects every volume that the search shows. A volume that a box mounts, and the shared tools volume, cannot be selected. Click **Delete selected**. The dialog shows what happens to each volume before you confirm, and **Delete without keeping a copy** applies to the whole selection. A cache volume keeps no copy, so once deleted it cannot be restored. MiniBox checks each volume again as it deletes it: one that a box or container started using in the meantime, the shared tools volume and MiniBox's system volumes are never deleted.

**Clean up orphaned volumes** lists the volumes that MiniBox made and that nothing uses: no box spec mounts or owns them, and no container mounts them. A volume left behind by a deleted box is an orphan. The dialog shows each orphan's size, when it was last used, and its former box. The shared tools volume, MiniBox's internal volumes, and any volume created or used in the last five minutes are never listed. On several hosts, an offline or failing host is skipped, and the dialog says so. Confirming removes only the volumes the dialog listed. Each is checked again first, and one that is no longer an orphan is kept and reported. Each orphan's data is kept in the recycle bin, except a cache volume's, which cannot be restored. Only the owner can clean up orphans.

Each deletion is recorded in the activity feed. On the command line, use `minibox volume delete` and `minibox volume prune`. See the [CLI reference](../reference/cli.md#volumes).

## Usage, limits and free space

MiniBox measures every volume's usage every 10 minutes by default. You can set a soft and a hard limit on each volume, and the host keeps a free-space floor. **Soft alerts are best effort, not a quota.** They tell you early that a volume is growing, but nothing stops the volume from growing past them.

### How usage is measured

- A volume on the local pool or on a path pool is measured with `du` over its own folder tree. The figure is that volume's size.
- A volume on an NFS pool is measured with `df` on the pool's root. The figure is the usage of the whole share, so every volume on that pool shows the same figure, and the console marks it as a share figure. MiniBox never walks the folders of a share.
- Each measurement has its own deadline: 2 minutes for a volume tree and 30 seconds for an NFS share. A mount that does not answer in time is recorded as a failed sample, with the reason, and the last good figure stays on the volume. The other volumes are still measured on their own schedule.
- Each host measures at most 4 volumes at a time, so a host with many volumes does not start a helper for each of them at once.
- The trend keeps the last 24 samples. A restart clears the trend, and the last figure stays.
- The interval is set with `VOLUME_USAGE_INTERVAL_SEC`, from 60 to 86400 seconds. See [Configuration](../reference/configuration.md#volumes-and-storage).

To measure a volume now, click **Measure** on the **Volumes** tab, or call `POST /api/volumes/{id}/usage`. The new figure counts at once for starting boxes. The alerts and the stop action come from the background sampling, at its next pass.

### Soft and hard limits

Click **Limits** on a volume to set its limits. Each limit is in GB, and an empty field means no limit. The soft limit must not be above the hard limit. Limits are also set with `PUT /api/volumes/{id}/limits`, in bytes, and with the MCP tool `set_volume_limits`. Only the owner can set them.

| Limit reached | What MiniBox does |
|---|---|
| **Soft limit** | Records a `volume.usage_high` event, which a notification channel can send, and highlights the volume on the **Volumes** tab. The event is recorded once for each crossing, and again only after the volume drops below the soft limit. |
| **Hard limit**, action **warn** (the default) | Records a `volume.usage_limit` event and sends a notice. Boxes keep running. |
| **Hard limit**, action **stop** | As for **warn**, and it also stops each running box that mounts the volume. A stopped box stays stopped, and its page shows the reason, **volume over its hard limit**. |

- The event and the notice both say why: the limit, the usage, the action, and the boxes that were stopped.
- **Warn is the default** because stopping a box can interrupt its work. Choose **stop** for a volume that must not grow past its hard limit.
- Alerts and the stop action are decided at each sample, so a box can write past a limit between two samples. A new limit is saved at once, and starts are checked against it straight away.
- While a volume stays over a hard limit with the **stop** action, MiniBox refuses to create, start, restart or rebuild a box that mounts it, and refuses to attach it to a box. The refusal is `volume_over_limit` (409). Raise or clear the hard limit, or free space in the volume, and then start the box.
- **NFS volumes take no limits.** Their usage is the whole share's, so a limit on one volume would not hold. The **Limits** button is disabled for them. See [NFS and NAS storage](nfs.md#usage-and-quotas).

### Host free space

MiniBox checks the free space on the disk that the engine uses. When it falls below `HOST_DISK_MIN_FREE_PERCENT`, 10% by default:

- MiniBox records a `host.disk_low` event and sends a notice, once for that low spell.
- MiniBox refuses at once, with `507` (`insufficient_storage`), a request that would create a volume or a checkpoint. That covers a new volume, the volumes of a new box or of a box made from a checkpoint, a checkpoint you take, the safety checkpoint that a rollback or a rebuild takes first, a rollback, a checkpoint import, a move to this host, and a delete that keeps a copy in the [recycle bin](checkpoints.md#recycle-bin). A scheduled checkpoint is skipped instead, and shows as skipped because the disk is low.

The refusal ends when free space is back above the floor. Set `HOST_DISK_MIN_FREE_PERCENT=0` to turn the floor off. If MiniBox cannot read the disk, it refuses nothing.

The floor only stops new volumes and checkpoints. It does not stop a box that is already writing to the disk.

### Quotas

Limits are not quotas. MiniBox does not set filesystem quotas yet, so a volume can use more space than its limits between two samples. Filesystem quotas, such as XFS project quotas or btrfs and ZFS quotas on a local pool, are later work. For an NFS pool, set the quota on the NAS export. See [NFS and NAS storage](nfs.md#usage-and-quotas).

## Files in a volume

You can read and write the files in a volume with the command-line tool, even when no box is using it:

```bash
minibox files ls my-volume --path /
minibox files read my-volume notes.txt
minibox files write my-volume notes.txt --content "hello"
```

See the [CLI reference](../reference/cli.md) for all `minibox files` commands. To browse, upload and download files from the box page, see [Files](files.md).
