# NFS and NAS storage

Use this guide to keep box data on a NAS or another NFS server. The compute machine runs MiniBox and Docker. The NFS server holds the data in NFS volumes.

MiniBox does not mount NFS itself. It creates Docker volumes with the `local` driver and the NFS options. The Docker host's kernel does the mount.

## When to use NFS

Use an NFS pool when:

- The compute machine has a small disk, and you want box data on the NAS.
- The NAS already takes snapshots and backups, and you want box data covered by them.

Keep these points in mind:

- **Use a trusted network only.** NFS is not encrypted by default. It trusts the user ID that the client sends. Run it on a LAN that you control, or over WireGuard or Tailscale. Allow only the compute machine's address to mount the export.
- **Small files are slow.** Every create, `stat` and `fsync` is a network round trip. Large sequential reads and writes are fine on a 1 GbE network or faster. Commands that touch many small files, such as `git status`, `npm install` and builds, feel slower.
- **Keep the cache on the local pool.** This is the default. The `~/.cache` folder holds package caches and build output. They are cheap to rebuild and slow over NFS. If one project is slow, mount a local volume at its `node_modules` folder.
- **Databases need one user at a time.** SQLite works on NFSv4. Only one machine may use a database file at a time. Do not let two boxes on different hosts write to the same database.
- **File watchers miss remote changes.** inotify sees only the changes that come through the same client. Edits made on another machine or directly on the NAS do not reach it.
- **Never put Docker's data root on NFS.** Images, container layers and the MiniBox data directory stay on the compute machine. Only volumes go to the NAS.
- **Checkpoints stay local.** The checkpoint repository is a local Docker volume. Back it up separately, together with its encryption key on the compute machine. See [Checkpoints](checkpoints.md).

Where each kind of data lives:

| Data | Where it lives |
|---|---|
| Workspace (`/workspace`) and home (`/home/dev`) | The NFS pool, if it is the default pool |
| Tools (`/opt/minibox/tools`) | The default pool, unless the **Tools** role is set to another pool. Each pool has its own shared tools volume, so a box on the NFS pool starts with an empty one. Install its tools again from the box's **Tools** tab |
| Cache (`/home/dev/.cache`) | The local pool. This is the default. |
| Independent volumes | The pool you choose when you create them |
| Images, container layers, data directory, checkpoint repository | The compute machine |

## Ownership: the one thing to get right

Boxes run as `dev`, user ID **1000**, and group ID **1000**. Every file that a box writes must belong to 1000 on the server. User 1000 must also be able to create folders in the export.

When MiniBox creates a volume on an NFS pool, a short-lived helper container runs as root on the compute machine. The helper does three things in the export:

1. It creates the folder `<export>/<volume id>`, for example `vol_hakder7qn0`.
2. It runs `chown -R 1000:1000` on that folder. If the chown fails, MiniBox continues and records that ownership could not be changed.
3. It checks that user 1000 can write to the folder. If the check fails, MiniBox removes the new folder and does not create the volume. The request returns `502` with the code `bad_gateway`.

How the server maps root decides whether this works:

| Server export | Owner of the export folder | Result |
|---|---|---|
| `all_squash,anonuid=1000,anongid=1000` | 1000:1000 | **Works. Recommended.** Every file belongs to 1000:1000. A `chown` inside a box succeeds, but changes nothing. |
| `all_squash,anonuid=1000,anongid=1000` | root, mode 755 | The volume create fails with `502`: `Storage pool … denied permission to create the volume directory: mkdir: cannot create directory '/mnt/vol_…': Permission denied` |
| `root_squash,anonuid=1000,anongid=1000` | 1000:1000 | Works. Root maps to 1000, and so does `dev`. |
| `no_root_squash` | Any | Works, but root in a box is real root on the export. Use it only for a dedicated export. |
| `root_squash` with the default anonymous user (`nobody`) | 1000:1000, mode 755 | The volume create fails with `502`, and the message says that the pool denied permission to create the volume directory |
| `root_squash` with the default anonymous user (`nobody`) | Mode 777 | The volume create fails with `502`, and the message says that uid 1000 cannot write the new volume directory. The folder belongs to `nobody`, so `dev` cannot write to it. Use `root_squash,anonuid=1000,anongid=1000` instead. |

Map everything to user 1000, and make the export folder owned by 1000:1000.

## Server side

### Linux (`nfs-kernel-server`)

Install the server, and create a folder for MiniBox:

```bash
sudo apt install nfs-kernel-server
sudo mkdir -p /srv/minibox
sudo chown 1000:1000 /srv/minibox
```

Add this line to `/etc/exports`. It allows the compute machine at `192.168.1.20` to mount the folder:

```
/srv/minibox  192.168.1.20(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000)
```

- `rw,sync`: `sync` makes the server save writes before it answers. `async` is faster, but a server crash can lose writes that a box believes are saved.
- `no_subtree_check`: the usual default. It avoids stale handles when files are renamed.
- `all_squash,anonuid=1000,anongid=1000`: see [Ownership](#ownership-the-one-thing-to-get-right). If other clients need their own user IDs on this export, use `root_squash,anonuid=1000,anongid=1000` instead.
- Name the client by its address or subnet, such as `192.168.1.0/24`. Do not use `*`. With Tailscale, use the compute machine's `100.x.y.z` address.
- Use a dedicated folder for MiniBox. MiniBox creates one subfolder per volume, named `vol_…`.

Apply the change, and check it:

```bash
sudo exportfs -ra
sudo exportfs -v
```

**Firewall.** NFSv4 needs only TCP port **2049** from the compute machine. NFSv3 also needs `rpcbind` (port 111), `mountd`, `statd` and `lockd`. Their ports are dynamic unless you fix them. That is one more reason to use NFSv4.

**NFSv4.1 or 4.2, not v3.** MiniBox mounts through Docker's `local` driver, which does not negotiate the NFS version. Always set `nfsvers=` in the pool options. Without it, the kernel tries NFSv3. On a kernel without NFSv3 support, the mount fails with `protocol not supported`. With NFSv3, file locks also fail unless `rpc.statd` runs on the compute machine.

### Synology DSM (general guidance)

Menu names differ between models and firmware versions. Check these steps against your device.

- Enable the NFS service, and allow NFSv4.1 as the highest protocol.
- Create a shared folder for MiniBox. Add an NFS rule for the compute machine's address with read and write access.
- DSM's squash setting does not accept any user ID. It maps all users, or root, to `admin` or `guest`, or it does no mapping. The closest option to `all_squash,anonuid=1000` is to map all users to `admin`, with the shared folder writable by `admin`.
- DSM accounts usually start at user ID 1024, not 1000. Check the ID with `id <user>` over SSH. Files then show that ID inside the box, not 1000. Writes still work. Tools that compare file owners with the current user, such as git's `safe.directory` check, may refuse the repository.
- Leave asynchronous writes off, unless you accept losing recent writes after a NAS crash.
- Take snapshots of the shared folder, as a disaster-recovery layer.

### QNAP QTS (general guidance)

- Enable the NFS service with NFSv4, and choose 4.1 where it is offered.
- On the shared folder, set the NFS host access to the compute machine's address, with read and write access.
- Choose a squash option that maps all users, or root, to one account. Use user ID 1000 if the firmware lets you set the anonymous user ID. As on DSM, check the real user ID of the account you map to.
- Take snapshots of the volume that holds the shared folder.

### TrueNAS SCALE (general guidance)

- Create a dataset for MiniBox. Set its owner to user 1000 and group 1000. Create a local user with those IDs, or set the numeric owner.
- Add an NFS share for the dataset. Restrict it to the compute machine's address or network.
- In the share's advanced options, set the map-all user and group to that user and group. This is `all_squash,anonuid=1000,anongid=1000`. Setting the map-root user and group instead gives the `root_squash,anonuid=1000` variant. New TrueNAS users start at user ID 3000, so give this user ID 1000 explicitly.
- Enable NFSv4 in the NFS service settings.
- Schedule periodic snapshots of the dataset.

### Unraid (general guidance)

- Create a share for MiniBox, and export it over NFS. The export path is `/mnt/user/<share>`.
- If your version offers NFS security rules, restrict the share to the compute machine, for example `192.168.1.20(rw,sync,all_squash,anonuid=1000,anongid=1000)`. Without such a rule, Unraid usually maps everyone to `nobody` (user 99, group 100). Writes work, but files show user 99 inside the box. The same caveat as for DSM applies.
- Enable NFSv4 if your version supports it. Older releases offer only NFSv3.
- From the Unraid shell, make the share's folder owned by 1000:1000.

## MiniBox side

### Check the export from the compute machine

Install the NFS client tools, and mount the export by hand before you add it to MiniBox:

```bash
sudo apt install nfs-common
sudo mount -t nfs -o nfsvers=4.1 192.168.1.10:/srv/minibox /mnt && ls -ln /mnt && sudo umount /mnt
```

The Docker daemon does the NFS mount, so the server address must be reachable from the daemon's network. With Docker Desktop, the daemon runs in a virtual machine. A remote daemon runs on another machine. Run the test from there.

### Add the pool in the console

1. Click **Storage** in the sidebar, then open the **Volumes** tab.
2. Click **Add NFS**.
3. Fill in the fields:

| Field | What to enter |
|---|---|
| **Pool name** | A short name, such as `nas`. Use letters, digits, `.`, `_` or `-`, starting with a letter or digit, up to 63 characters. `local` is the built-in local pool and cannot be an NFS pool. |
| **Server** | The IP address or hostname of the NFS server, such as `192.168.1.10`. Do not include `user@` or a port. The Docker daemon resolves hostnames. |
| **Export** | The absolute path of the export on the server, such as `/srv/minibox` or `/volume1/minibox`. Do not use `..` or spaces. |
| **Options** | Comma-separated mount options, such as `nfsvers=4.1, hard, noatime`. Always include `nfsvers=4.1` or `nfsvers=4.2`. See [Mount options](#mount-options). |
| **Make this the default pool** | New boxes put their workspace, home and tools volumes here. |

4. Click **Save pools**, and confirm the preview.

Until you save, the pool exists only in the page. After saving, the pool row shows **Reachable** and the free space that the NFS server reports. If it shows **Storage unreachable**, the mount error appears in the next column.

The **Default** setting and the **Role defaults** (**Workspace**, **Home**, **Tools**, **Cache**) also take effect only when you save. Leave the roles on **Use the rule** unless you need an exception. The rule puts the cache on the local pool and everything else on the default pool.

### The same through the API

```bash
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -X PUT -d '{"confirm":true,"pools":[
    {"name":"local","backend":"local"},
    {"name":"nas","backend":"nfs","server":"192.168.1.10","export":"/srv/minibox",
     "options":["nfsvers=4.1","hard","noatime"],"default":true}
  ],"roles":{"workspace":null,"home":null,"tools":null,"cache":null}}' \
  http://127.0.0.1:3920/api/pools
```

`PUT /api/pools` replaces the whole list, so send every pool that you want to keep. See the [API reference](../reference/api.md).

A pool that still has volumes cannot be removed or change its backend. Changing a pool's server, export or options does not change volumes that already exist. Each Docker volume keeps the options it was created with.

### Mount options

| Option | Recommendation |
|---|---|
| `nfsvers=4.1` (or `4.2`) | **Required in practice.** See [NFSv4.1 or v3](#linux-nfs-kernel-server). |
| `hard` | Recommended. I/O waits for the server instead of failing. When the server goes away, processes that touch the mount freeze, and then continue when it returns. Data written before and after a server restart stays intact, and no remount is needed. |
| `soft` | Not recommended for data. I/O fails with `EIO` after the timeout, which can leave half-written files that the program believes are complete. |
| `noatime` | Recommended. It avoids a write for every read. |
| `timeo=`, `retrans=` | Leave them out. They matter only for `soft` mounts, or for how often a `hard` mount logs "server not responding". The defaults are fine. If you set them, they also change how quickly a dead server is reported. |
| `nconnect=4` | Optional, with NFSv4.1 and later. It opens several TCP connections for more throughput. |
| `rsize=`, `wsize=` | Leave them out. The client and server negotiate them. |

You do not need `addr=`. MiniBox adds `addr=<server>` itself.

MiniBox's reachability check does not use your `hard` or `soft` setting. It mounts the export root with `soft,timeo=10,retrans=1`, followed by your other options. A dead server therefore cannot hang the check. Your options come last and win, which is why `timeo=` and `retrans=` are best left out.

### Verify the pool

1. On the **Volumes** tab, the pool shows **Reachable** and its free space.
2. Create a box. On the **Volumes** tab, its workspace and home volumes use the NFS pool, and its cache uses `local`.
3. In the box's **Terminal** tab, run:

   ```bash
   id                                  # uid=1000(dev) gid=1000(dev)
   mount | grep -E 'workspace|home/dev|tools|cache'
   echo ok > /workspace/nfs-test && ls -ln /workspace/nfs-test
   ```

   `/workspace` and `/home/dev` show `type nfs4` with `vers=4.1` and `hard`. `/opt/minibox/tools` shows the same, but read-only. `/home/dev/.cache` is a local filesystem.
4. On the server, the file is at `<export>/<workspace volume id>/nfs-test`, owned by 1000:1000. The volume ID is the `vol_…` value shown under the volume's name on the **Volumes** tab.
5. Restart the box, and read the file again.

## When the NAS is down

- The pool shows **Storage unreachable**, with the mount error. The box list and the box page mark the affected boxes.
- Creating, starting or restarting a box on that pool fails with `503` and the code `docker_unavailable`. This happens within about 5 seconds. Nothing is created, and nothing is written to the local disk.
- Stopping a box still works.
- A **running** box with a `hard` mount freezes any process that touches `/workspace` or `/home/dev` until the server returns. That includes commands from `exec` and terminals. A foreground `exec` with a timeout still returns soon after the timeout. See [Known issues](#known-issues).
- The pools are checked side by side. A pool that does not answer within 5 seconds shows as unreachable, with the message `no answer within 5 s`. The **Volumes** tab answers within about 5 seconds, however many NFS servers are down.
- Usage sampling does not wait for the NAS either. A share's usage is read with a 30-second deadline. A share that does not answer in time is recorded as a failed sample, with its reason, and the other volumes are still sampled on their own schedule.
- When the server returns, frozen processes continue. The next check shows the pool as **Reachable**, and stopped boxes can start again. Nothing needs to be remounted.

Before NAS maintenance, such as a reboot or a firmware update, stop the boxes that use its pools.

## Usage and quotas

MiniBox reads an NFS pool's usage with `df` on the pool's root. The figure is the usage of the whole share, shared by every volume on the pool, and the console marks it as a share figure. MiniBox never walks the folders of a share, which can be very large on a NAS.

Volumes on an NFS pool take no soft or hard limits, because a limit on one volume would not hold for the whole share. To cap the space that boxes use on the NAS, set a quota on the NAS itself, for the shared folder, where the NAS offers one. MiniBox's soft alerts are best effort, not a quota. See [Volumes and storage](volumes-and-storage.md#usage-limits-and-free-space).

## Backups

- A snapshot of the whole MiniBox export on the NAS is your disaster-recovery layer. Box checkpoints are per box, and they complement the snapshot. They do not replace it.
- A storage system is not a backup. Copy the NAS snapshots, and the checkpoint repository with its key, to a second place.
- Deleting a box with **Also delete the volumes this box owns** removes the Docker volumes. Either way, the box's data is kept in the [recycle bin](checkpoints.md#recycle-bin). It does not delete their folders on the export. Those stay until you delete `<export>/vol_…` yourself.

## Troubleshooting

| Symptom | Message | Cause and fix |
|---|---|---|
| The pool shows **Storage unreachable** | `… failed to mount local volume: … protocol not supported` | The options have no `nfsvers=`, or they set `nfsvers=3` on a kernel without NFSv3. Add `nfsvers=4.1`. |
| **Storage unreachable** | `… input/output error` | The server is down, or nothing listens on TCP port 2049. Start the NFS service, and check the firewall. |
| **Storage unreachable** | `… connection timed out` | The server address is wrong, or a network or firewall drops the traffic. |
| **Storage unreachable** | `no answer within 5 s` | The check did not finish within 5 seconds. The server may be frozen. The check keeps running, and the pool shows **Reachable** when the server answers. |
| **Storage unreachable** | `… no such file or directory` | The export path does not exist, or the client is not allowed to use it. NFSv4 hides exports that a client may not use, so a client restriction can look like a wrong path. Linux `nfsd` may say `access denied by server`. |
| Box create fails with `502` and code `bad_gateway` | `Storage pool nas denied permission to create the volume directory: mkdir: cannot create directory '/mnt/vol_…': Permission denied` | The squashed user cannot write to the export root. Use `all_squash,anonuid=1000,anongid=1000` or `root_squash,anonuid=1000,anongid=1000`, and make the export folder owned by 1000:1000. The error response's hint names these options. |
| Box create fails with `502` and code `bad_gateway` | `Uid 1000, the box user, cannot write the new volume directory …, so the volume was not created` | The new folder belongs to `nobody`, and the squashed root cannot change its owner. Change the export to `all_squash,anonuid=1000,anongid=1000`. To fix a folder that already exists, run `chown -R 1000:1000 <export>/vol_…` on the server. |
| `chown` in a box succeeds, but nothing changes | None | Expected with `all_squash`. Every file belongs to the anonymous user. |
| `Stale file handle` in a box, and `start` fails with `lstat …/_data: stale NFS file handle` | None | The volume's folder was deleted or replaced on the server while it was mounted, for example after a restore into a new folder. Stop the box, and put the data back in place. If start keeps failing, drop the client's cache on the compute machine with `sync; echo 2 \| sudo tee /proc/sys/vm/drop_caches`. |
| Commands in a box hang | None | The mount is `hard`, and the server is unreachable. Bring the server back, and the processes continue. Stop the box if you need it stopped sooner. |
| Start or create returns `503` with `docker_unavailable` | `Storage pool nas is unreachable: …` | MiniBox refuses to start a box on storage it cannot reach. Nothing is written to the local disk. Fix the pool, and try again. |

## Known issues

- A foreground `exec` with `timeoutSec` returns at most 2 seconds after its timeout, even while a `hard` mount is frozen. If the stop has not finished by then, the call returns `status: running` with `timedOut: true`. MiniBox keeps trying to stop the process in the background. Each attempt waits longer, up to 30 seconds. The command is recorded as `killed` once the stop succeeds. If the command finishes on its own first, it is recorded as `exited` with its own exit code.
- `timeoutSec` does not limit the time the engine needs to start an `exec`. The timeout starts when the process has started. A start that blocks is waited for.
- While a server does not answer, one check of the pool waits for its mount. Later checks of the same pool share that wait, instead of starting another.

## Path pools

If you prefer to mount the NAS on the host yourself, for example with `autofs` or SMB, use a path pool:

1. Mount the share at a fixed path on the compute machine.
2. Create the marker file `.minibox-mounted` on the mounted filesystem:

   ```bash
   sudo touch /mnt/nas/minibox/.minibox-mounted
   ```

3. On the **Volumes** tab, click **Add path**, and add the pool.

MiniBox refuses to write when the marker file is missing. An unmounted share is never filled from the local disk.

On systemd, order Docker after the mount. Create a drop-in for `docker.service`:

```ini
[Unit]
RequiresMountsFor=/mnt/nas/minibox
```
