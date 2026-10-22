# Backups

A complete backup of MiniBox has three parts: the data directory, the Docker volumes, and the checkpoint repository key. Keep an off-host copy of all of them.

## What to back up

| What | Where it lives | Why it matters |
|---|---|---|
| The data directory | `DATA_DIR` (`/data` in the `minibox-data` volume in the release image) | Box settings, tokens, sessions, host and pool settings, secrets, the access key and the SSH host key |
| Box volumes | Docker volumes named `vol_…`, and `minibox-ws-<name>` for older boxes | Your work in `/workspace`, home folders and other data |
| Checkpoint repository | Docker volume `minibox-checkpoints-local` (or `minibox-checkpoints-<host>` on another host) | The data of your checkpoints |
| Checkpoint key | `DATA_DIR/secrets/checkpoint-repo.key` | Without this key, the checkpoints cannot be read |
| NFS data | On your NAS | Volumes on NFS pools. See [NFS and NAS storage](../user-guide/nfs.md). |

Code belongs in git. Push your code to a remote repository, so you do not depend on the box volumes.

## Stop MiniBox first

For a consistent copy, stop MiniBox before you copy the data directory, and stop any box whose volume you copy:

```bash
docker stop minibox
```

Stopping MiniBox does not stop your boxes. To stop a box, use the console, or `docker stop minibox-<name>`.

## Back up the data directory

For the release image, the data is in the `minibox-data` volume. Copy it with a temporary container:

```bash
docker run --rm -v minibox-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/minibox-data-$(date +%F).tar.gz -C /data .
```

For a source install, copy the `data/` folder in the checkout, or the folder that `DATA_DIR` points to.

## Back up a volume

A volume is a Docker volume. Stop the box that uses it first, so that its files are not changing:

```bash
docker run --rm -v vol_abc123:/src:ro -v "$PWD":/backup alpine \
  tar czf /backup/vol_abc123.tar.gz -C /src .
```

Replace `vol_abc123` with the volume's name. The name is shown on the **Volumes** page.

## Checkpoints are not a backup of the server

Checkpoints are copies of one box's data. They are stored in the same Docker engine, on the same disk as the boxes. If that disk fails, the checkpoints and the boxes are lost together. To keep a copy somewhere else, copy the checkpoint repository volume and the key together. To keep one checkpoint, [export](../user-guide/checkpoints.md#export-and-import) it and download the package. A package is sealed with its passphrase, and it expires a day after the export.

## Restore

1. Stop MiniBox.
2. Restore the data directory. Keep the modes of `access_key`, `secrets/` and the other files, which must not be readable by others.
3. Restore the volumes that you need.
4. Start MiniBox, and check that boxes start.

If you lost `access_key` and did not set `ACCESS_KEY`, MiniBox generates a new key at the next start, and you must sign in with it.
