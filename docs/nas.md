# Putting boxes on a NAS or NFS server

[中文](nas-zh.md) · Back to [README › Volumes and storage pools](../README.md#volumes-and-storage-pools)

This guide covers a setup where a NAS or a Linux storage server holds the box data and another machine runs MiniBox and Docker. MiniBox mounts NFS exports through Docker's `local` volume driver, so the NFS client is the Docker host's kernel. MiniBox itself never mounts anything. Tracking issue: [#30](https://github.com/ArnoChenFx/minibox/issues/30).

Every step marked **tested** was run against a real NFS server: NFS-Ganesha 6 (userspace, VFS backend) on Debian 13, mounted by a Linux 6.12 client through Docker 26. The mount options, ownership results and error messages in this guide come from those runs. The NAS vendor sections are general guidance: menu names differ between models and firmware versions, so check them against your device.

## When to use NFS

Use an NFS pool when:

- the compute machine has a small or fragile disk and you want box data on the NAS;
- you want to move boxes between compute machines later (only NFS pools are `crossHost`);
- the NAS already takes snapshots and backups that you want to cover box data.

Keep in mind:

- **Use a trusted network only.** NFS with `sec=sys` is not encrypted and trusts the uid the client sends. Run it on a LAN you control, or over WireGuard or Tailscale, and limit the export to the compute machine's IP.
- **Small files are slow.** Every create, `stat` and `fsync` is a network round trip. In the test, writing 500 small files took 262 ms on NFS and 18 ms on the local cache volume, over loopback with no real network in between. Big sequential reads and writes are fine on 1 GbE or faster; `git status`, `npm install` and builds with many small files are what you notice.
- **Keep `cache` on the local pool.** This is the default. `~/.cache` holds package caches and build artifacts that are cheap to rebuild and expensive over NFS. `node_modules` cannot be preassigned, because its path depends on the project; if one project is slow, mount an extra local volume at its `node_modules`.
- **SQLite, file locks and inotify.** SQLite works on NFSv4 (tested: a normal database and `journal_mode=wal`, `flock` also worked), but only one machine may use a database file at a time, and WAL needs shared memory that is local to one client. Do not let two boxes on different hosts write the same database. inotify only sees changes made through the same client, so file watchers do not notice edits made from another machine or on the NAS itself.
- **Never put Docker's `data-root` on NFS.** `overlay2` does not run on NFS. Images, container layers and `DATA_DIR` stay on the compute machine. Only volumes go to the NAS.
- **The checkpoint repository stays local.** Checkpoints of NFS-backed boxes work (tested: take and rollback), but the restic repository is the local Docker volume `<prefix>-checkpoints-<host>`. Back it up separately, together with `DATA_DIR/secrets/checkpoint-repo.key`.

What lives where:

| Data | Where |
|---|---|
| Workspace (`/workspace`) and home (`/home/dev`) | NFS pool (the default pool) |
| Shared tools volume (`/opt/minibox/tools`) | the default pool too, unless the **Tools** role is set to another pool. There is one shared tools volume per pool, so boxes on the NFS pool get their own, empty at first: install tools again from an NFS box's **Tools** page, or with `POST /api/boxes/:id/tools/reconcile` |
| Cache (`/home/dev/.cache`) | local pool, always, unless you override the **Cache** role |
| Independent volumes | the pool you choose when you create them |
| Docker images, container layers, `DATA_DIR`, checkpoint repository | compute machine |

## Ownership: the one thing to get right

Boxes run as `dev`, uid **1000**, gid **1000**. Every file a box writes must end up owned by 1000 on the server, and uid 1000 must be able to create directories in the export.

When MiniBox creates a volume on an NFS pool, a short-lived helper container runs as root on the compute machine and does this in the export:

1. `mkdir -p <export>/<volume id>` (for example `vol_hakder7qn0`);
2. `chown -R 1000:1000` on that directory. If chown fails, the helper prints `MINIBOX_CHOWN_SKIPPED`, MiniBox logs `volume.chown_skipped` and **the volume is still created**.

How the server maps the helper's root decides whether this works. Tested with each squash mode:

| Server export | Export directory owner | Result |
|---|---|---|
| `all_squash,anonuid=1000,anongid=1000` | 1000:1000 | **Works. Recommended.** Every file is 1000:1000 on the server, whoever writes it. A `chown` inside the box succeeds but changes nothing |
| `all_squash,anonuid=1000,anongid=1000` | root, mode 755 | Volume create fails with `502`, code `bad_gateway` and message key `storage_permission_denied`: `mkdir: cannot create directory '/mnt/vol_…': Permission denied` |
| `root_squash,anonuid=1000,anongid=1000` | 1000:1000 | Works. Root maps to 1000, `dev` stays 1000. Root inside the box also writes as 1000 |
| `no_root_squash` | any | Works. The helper's chown succeeds. Root inside a box is real root on the export, so use it only on a dedicated export |
| `root_squash` (anon uid is `nobody`) | 1000:1000, mode 755 | Volume create fails with `Permission denied` |
| `root_squash` (anon uid is `nobody`) | mode 777 | Volume create **succeeds**, but the directory belongs to `nobody`, chown is skipped (`volume.chown_skipped`), and `dev` gets `Permission denied` on every write. Avoid |

So: map everything to uid 1000, and make the export directory itself owned by 1000:1000.

## Server side

### Linux (`nfs-kernel-server`)

The test server was NFS-Ganesha, not kernel `nfsd`, so the commands below are standard `nfs-kernel-server` usage with the export options that were tested on Ganesha.

```bash
sudo apt install nfs-kernel-server
sudo mkdir -p /srv/minibox
sudo chown 1000:1000 /srv/minibox
```

`/etc/exports`, with the compute machine at `192.168.1.20`:

```
/srv/minibox  192.168.1.20(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000)
```

- `rw,sync`: `sync` makes the server commit writes before it answers. `async` is faster, but a server crash can lose data that a box believes was written.
- `no_subtree_check`: the usual default; avoids stale handles when files are renamed.
- `all_squash,anonuid=1000,anongid=1000`: see [Ownership](#ownership-the-one-thing-to-get-right). If other clients need their own uids on this export, use `root_squash,anonuid=1000,anongid=1000` instead and keep the box uid at 1000.
- Name the client by IP or subnet (`192.168.1.0/24`), never `*`. With Tailscale, use the compute machine's `100.x.y.z` address.
- Use a dedicated directory for MiniBox. MiniBox creates one subdirectory per volume (`vol_…`) and a probe mounts the export root.

Apply and check:

```bash
sudo exportfs -ra
sudo exportfs -v
```

**Firewall.** NFSv4 needs only TCP **2049** from the compute machine. NFSv3 also needs `rpcbind` (111) and `mountd`, `statd` and `lockd`, whose ports are dynamic unless you pin them, which is one more reason to use v4.

**NFSv4.1 vs v3.** Use 4.1 or 4.2. MiniBox's mounts go through Docker's `local` driver, which calls the `mount` syscall directly instead of `mount.nfs`. It does not negotiate the version, so always set `nfsvers=`. Without it the kernel tries v3. On the test client, whose kernel was built without NFSv3, that fails with `protocol not supported`. With v3, file locks also fail unless `rpc.statd` runs on the compute machine.

### Synology DSM (general guidance)

- Enable the NFS service and allow NFSv4.1 as the maximum protocol.
- Create a shared folder for MiniBox. Add an NFS rule on it for the compute machine's IP with read/write access.
- DSM's squash setting does not take an arbitrary uid: it maps root, or all users, to admin or to guest, or does no mapping. The closest to the recommended `all_squash,anonuid=1000` row is mapping all users to admin, with the shared folder writable by admin. DSM accounts usually start at uid 1024, not 1000, so check the uid (`id <user>` over SSH). Files then show that uid inside the box, not 1000. Writes still work, because the server checks permissions as that account, but tools that compare file owners with the current user, such as git's `safe.directory` check, may refuse the repository (not tested here).
- Leave asynchronous writes off unless you accept losing recent writes on a NAS crash.
- Enable snapshots on the shared folder as a disaster-recovery layer.

### QNAP QTS (general guidance)

- Enable the NFS service with NFSv4 (4.1 where offered).
- On the shared folder, set the NFS host access to the compute machine's IP with read/write.
- Choose a squash option that maps all users (or root) to one account, and use uid 1000 if your firmware lets you set the anonymous uid. As on DSM, check the actual uid of the account you map to.
- Snapshot the volume that holds the shared folder.

### TrueNAS SCALE (general guidance)

- Create a dataset for MiniBox and set its owner to uid 1000 and gid 1000 (create a local user with those ids, or set the numeric owner).
- Add an NFS share for the dataset, restricted to the compute machine's IP or network.
- In the share's advanced options, set the mapall user and group to that uid-1000 user and group. This is `all_squash,anonuid=1000,anongid=1000`. Setting the maproot user and group instead is the `root_squash,anonuid=1000` variant. New TrueNAS users start at uid 3000, so give this user uid 1000 explicitly.
- Enable NFSv4 in the NFS service settings.
- Schedule periodic snapshots of the dataset.

### Unraid (general guidance)

- Create a share for MiniBox and export it over NFS. The export path is `/mnt/user/<share>`. Restrict it with a rule like `192.168.1.20(rw,sync,all_squash,anonuid=1000,anongid=1000)` in the share's NFS security settings (private security), if your Unraid version offers rules. Without such a rule Unraid typically squashes everyone to `nobody`, uid 99 and gid 100: writes work, but files show uid 99 inside the box, with the same caveats as the DSM case above.
- Enable NFSv4 if your version supports it. Older releases only offered NFSv3.
- Make the share's directory owned by 1000:1000 from the Unraid shell.

## MiniBox side

### Compute machine

Install the NFS client tools (`sudo apt install nfs-common`) to test mounts by hand. Docker's own NFS mounts do not use them, but the kernel must support NFSv4 (`grep nfs4 /proc/filesystems`).

Check the export from the compute machine before you add it to MiniBox:

```bash
sudo mount -t nfs -o nfsvers=4.1 192.168.1.10:/srv/minibox /mnt && ls -ln /mnt && sudo umount /mnt
```

The server address must be reachable from the **Docker daemon's** network namespace, because the daemon does the mount. With Docker Desktop the daemon runs in a VM, and a remote daemon runs on another machine, so test from there.

### Adding the pool in the console

**Volumes → Add NFS** opens this dialog:

| Field | What to enter | Checked by |
|---|---|---|
| Pool name | A short name such as `nas`. Letters, digits, `.` `_` `-`, starting with a letter or digit, up to 63 characters. `local` is the built-in local pool and cannot be NFS | console and server |
| Server | IP address or hostname of the NFS server, for example `192.168.1.10`. Up to 254 characters of letters, digits, `.` `:` `-`, starting with a letter or digit. No `user@`, no port. The Docker daemon resolves hostnames | server |
| Export | Absolute path of the export on the server, for example `/srv/minibox` or `/volume1/minibox`. No `..`, no spaces. A trailing `/` is dropped. Each volume becomes `<export>/<volume id>` | server |
| Options | Comma-separated mount options, for example `nfsvers=4.1, hard, noatime`. Spaces around commas are trimmed. Up to 16 options, each up to 64 characters of letters, digits and `. _ = -`. Always include `nfsvers=4.1` (or `4.2`), see [Mount options](#mount-options) | server |
| Make this the default pool | New boxes put workspace, home and tools here | console |

Then click **Save pools** and confirm the preview. Until you save, the pool is only in the page. After saving, the pool row shows **Health** Reachable (API status `reachable`) and the free space reported by the NFS server. When it shows Storage unreachable, the mount error is in the next column.

The **Default** button on a pool row, and the **Role defaults** selects (Workspace, Home, Tools, Cache), also take effect only when you save. Leave the roles at "Use the rule" unless you need an exception: cache on the local pool, everything else on the default pool.

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

`PUT /api/pools` replaces the whole list, so send every pool you want to keep. Without `"confirm": true` it returns `409 confirmation_required` with a preview. It needs `pool:admin`. `GET /api/pools?refresh=true` probes every pool again; without `refresh` a result is cached for 15 seconds. MCP: `list_pools` and `replace_pools` in the `storage` toolset. The saved file is `DATA_DIR/pools.json`.

A pool that still has volumes cannot be removed or change backend (`409 pool_in_use`). Changing a pool's server, export or options, or the default pool, does not change volumes that already exist: each Docker volume keeps the options it was created with, and existing boxes stay on their volumes.

### Mount options

| Option | Recommendation |
|---|---|
| `nfsvers=4.1` (or `4.2`) | **Required in practice.** See [NFSv4.1 vs v3](#linux-nfs-kernel-server) |
| `hard` | Recommended. I/O waits for the server instead of failing. A server that goes away freezes processes that touch the mount until it comes back, and then they continue where they were. Tested: data written before and after an NFS server restart was intact, and no remount was needed |
| `soft` | Not recommended for data. I/O fails with `EIO` after `timeo`×`retrans`, which can leave half-written files that the program believes are written |
| `noatime` | Recommended. Saves a write for every read |
| `timeo=`, `retrans=` | Leave out. They only matter with `soft`, or for how often a `hard` mount logs "server not responding", and the defaults (`timeo=600`, i.e. 60 s, `retrans=2`) are fine. If you set them, they also replace the probe's short timeout (see below), so a dead server takes much longer to report |
| `nconnect=4` | Optional, NFSv4.1+, several TCP connections for more throughput. Tested to mount on Linux 6.12 |
| `rsize=`, `wsize=` | Leave out. The client and server negotiate them (1 MiB in the test) |

You do not need `addr=`: MiniBox adds `addr=<server>` itself. MiniBox's reachability probe does **not** use your `hard`/`soft`: it mounts the export root with `soft,timeo=10,retrans=1` followed by your other options, so a dead server cannot hang the probe. Your options come last and win, which is why `timeo=` and `retrans=` are best left out.

### Verify

1. **Volumes**: the pool is `reachable` and shows free space.
2. Create a box. On the Volumes page its workspace and home show the NFS pool, and its cache shows `local`.
3. In the box terminal:

   ```bash
   id                                  # uid=1000(dev) gid=1000(dev)
   mount | grep -E 'workspace|home/dev|tools|cache'
   echo ok > /workspace/nfs-test && ls -ln /workspace/nfs-test
   ```

   `/workspace` and `/home/dev` should be `type nfs4 (rw,noatime,vers=4.1,…,hard,…)`, `/opt/minibox/tools` the same but `ro`, and `/home/dev/.cache` a local filesystem.
4. On the server, the file is at `<export>/<workspace volume id>/nfs-test`, owned by 1000:1000. The volume id is the `vol_…` id shown under the volume's name on the Volumes page.
5. Restart the box and read the file again.

## When the NAS is down

Tested by stopping the NFS server, and separately by dropping its traffic in the firewall to imitate a NAS that is powered off:

- The probe reports `unreachable` with the mount error (`input/output error` when the server refuses, `connection timed out` when nothing answers). The box list and the box page mark affected boxes as Storage unreachable.
- Creating, starting and restarting a box on that pool returns `503` with code `docker_unavailable` and message key `storage_unreachable`, within a few seconds. Nothing is created: no container, no volume record, and no data under `/var/lib/docker/volumes/<volume>/_data` on the local disk.
- Stopping a box still works.
- A **running** box with a `hard` mount freezes any process that touches `/workspace` or `/home/dev` until the server is back, including MiniBox `exec` calls and terminals. An `exec` with `timeoutSec` does not return before the server is back, see [known issues](#known-issues).
- With several NFS pools on an unreachable server, a probe of the pools page takes a few seconds per pool, and the first probe after a blackhole took over a minute.
- When the server comes back, frozen processes continue, the next probe reports `reachable`, and stopped boxes start again. Nothing needs remounting.

Before NAS maintenance (reboot, firmware update), stop the boxes on its pools.

## Backups

- A NAS snapshot of the whole MiniBox export is your disaster-recovery layer. MiniBox checkpoints are per box and complement it; they are not a replacement.
- The storage system is not a backup. Copy the NAS snapshots, and the checkpoint repository with its key, to a second place.
- Deleting a box with **delete volumes** removes the Docker volumes. Removing a volume does not delete its directory on the export (MiniBox only removes an empty directory when a create fails), so data on the NAS stays until you delete `<export>/vol_…` yourself.

## Troubleshooting

All messages below were seen in the tests.

| Symptom | Message | Cause and fix |
|---|---|---|
| Pool `unreachable` | `… failed to mount local volume: … protocol not supported` | No `nfsvers=` in options, or `nfsvers=3` on a client kernel without NFSv3. Add `nfsvers=4.1` |
| Pool `unreachable` | `… input/output error` | The server is down, or nothing listens on TCP 2049. Start the NFS service, check the firewall |
| Pool `unreachable` | `… connection timed out` | Wrong server address, or the network or firewall drops the traffic |
| Pool `unreachable` | `… no such file or directory` | The export path does not exist, or this client is not allowed. NFSv4 hides exports the client may not use, so a client restriction can look like a wrong path. Linux `nfsd` may say `access denied by server` instead |
| Box create fails with `502` and code `bad_gateway` | `Storage pool nas denied permission to create the volume directory: mkdir: cannot create directory '/mnt/vol_…': Permission denied` (`storage_permission_denied`) | The squashed uid cannot write the export root. Use `all_squash,anonuid=1000,anongid=1000` (or `root_squash,anonuid=1000,anongid=1000`) and make the export directory 1000:1000. The response's `hint` names these options and links this guide |
| Box starts, but `dev` cannot write `/workspace`, and the server log has `volume.chown_skipped` | `Permission denied` inside the box; on the server the `vol_…` directory belongs to `nobody` (shown as 65534, or 4294967294 on Ganesha) | `root_squash` to `nobody`. Change the export to `all_squash,anonuid=1000,anongid=1000`, then on the server `chown -R 1000:1000 <export>/vol_…` |
| `chown` in the box "succeeds" but nothing changes | — | Expected with `all_squash`: every file belongs to the anon uid |
| `Stale file handle` inside the box; then `start` fails with `lstat …/_data: stale NFS file handle` | | The volume's directory was deleted or replaced on the server while mounted (for example restored from a snapshot into a new folder). Stop the box and put the data back in place. In the test, start kept failing until the client's cache was dropped (`sync; echo 2 \| sudo tee /proc/sys/vm/drop_caches` on the compute machine) |
| Commands in the box hang | — | `hard` mount and the server is unreachable. Bring the server back; the processes continue. Stop the box if you need it gone sooner |
| Start or create returns `503 storage_unreachable` | `Storage pool nas is unreachable: …` | MiniBox refuses to start on storage it cannot reach, so nothing is written to the local disk instead. Fix the pool, then retry |

## Known issues

Found while testing this guide:

- An `exec` (and the timeout of a foreground `exec`) cannot finish while a `hard` mount is frozen: the kill MiniBox runs inside the box starts in the box's working directory `/workspace` and blocks with it. The call returns once the server is back.
- With `root_squash` mapped to `nobody`, creating a volume succeeds although `dev` cannot write it; the only signal is the `volume.chown_skipped` log line.
- Pools are probed one after another, so the pools page slows down with several unreachable NFS pools.

## Path pools

If you would rather mount the NAS on the host yourself (for example with autofs, or SMB), use a `path` pool instead: mount the share at a fixed path, create the marker file (`.minibox-mounted`) on the mounted filesystem, and add the pool with **Volumes → Add path**. MiniBox refuses to write when the marker is missing, so an unmounted share is never filled from the local disk. On systemd, order Docker after the mount, for example with a drop-in for `docker.service`:

```ini
[Unit]
RequiresMountsFor=/mnt/nas/minibox
```

This guide did not test path pools on a NAS or the systemd ordering.
