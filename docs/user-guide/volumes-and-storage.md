# Volumes and storage

A volume is a place where files are kept. Volumes are separate from boxes. A box uses zero or more volumes. Its files survive when the box is stopped, rebuilt or deleted, as long as the volume stays.

Open the **Volumes** page in the sidebar to see your volumes and storage pools.

## Volume roles

A new box gets four volumes by default:

| Role | Default pool | Mounted at | Mode |
|---|---|---|---|
| **Workspace** | Default pool | `/workspace` | Read-write |
| **Home** | Default pool | `/home/dev` | Read-write. Treat it as sensitive, because it can hold credentials. |
| **Tools** | Default pool | `/opt/minibox/tools` | Read-only. One shared volume per pool holds the installed tools. |
| **Cache** | Local pool | `/home/dev/.cache` | Read-write. Left out of checkpoints. |

To use different volumes, click **Customize** in the create dialog. The box mounts only the volumes you list. To add a volume to a box that already exists, attach it on the box's page.

## Storage pools

A storage pool is a place where MiniBox creates volumes. There are three kinds:

- **Local** pool: volumes on the Docker host's disk. This pool always exists, and it is the default for cache.
- **NFS** pool: volumes on an NFS server, such as a NAS. See [NFS and NAS storage](nfs.md).
- **Path** pool: volumes in a folder that you mount on the host yourself.

To add an NFS pool, click **Add NFS**. To add a path pool, click **Add path**. Click **Save pools** to save your changes.

The pool table shows **Reachable** for a pool that works, and **Storage unreachable** for one that does not. It also shows the free space.

One pool is the default. To change the default, click **Make this the default pool** in the pool's dialog, or the **Default** setting on its row.

A pool that still has volumes cannot be removed.

## Create and attach volumes

- To create a volume, click **Create volume**, and choose a pool. The volume is independent, which means it is not tied to a box.
- To attach a volume to a box, open the box's page, and use **Attach**. Attaching a volume rebuilds the box, so MiniBox shows a preview first.
- To detach a volume, click **Detach**. Detaching also rebuilds the box.

Changing the mounts of a box rebuilds it. The box keeps its name and its volumes. The writable layer and the running processes are lost.

## Read-write and read-only

- A **Read-write** mount lets the box change the files.
- A **Read-only** mount lets the box read the files only.

The same volume can be mounted by several boxes. When you mount a volume read-write in a second box, the console asks you to confirm. Docker does not lock files between boxes, so two boxes that write the same file can overwrite each other's work.

## Delete a volume

Click **Delete** on the volume. MiniBox does not delete a volume that a box still mounts.

When you delete a box, you can also delete the volumes that the box owns. See [Boxes](boxes.md#delete-a-box).

## Files in a volume

You can read and write the files in a volume with the command-line tool, even when no box is using it:

```bash
minibox files ls my-volume --path /
minibox files read my-volume notes.txt
minibox files write my-volume notes.txt --content "hello"
```

See the [CLI reference](../reference/cli.md) for all `minibox files` commands.
