# Upgrades

Upgrading MiniBox replaces the server software. Your boxes, volumes, settings and tokens stay, because they live in the data directory and in Docker volumes.

Read the [changelog](../../CHANGELOG.md) before you upgrade. It lists what changed in each release.

## Compatibility before 1.0

MiniBox is not 1.0 yet. A minor version, such as 0.4 to 0.5, can contain breaking changes. Each breaking change is listed in the [changelog](../../CHANGELOG.md) and in the upgrade notes of its release. Read both before you move to a new minor version.

## Before you upgrade

1. Read the changelog for the versions you are skipping.
2. Make a backup. See [Backups](backups.md).
3. Note the image tag that you run now. If the new version causes problems, you can go back to it.

## Manual steps since 0.4

These are the manual steps for changes made in 0.4 and later. Read the ones that apply to the versions you are skipping. Some need action before you start the new version.

### MCP and the owner access key

- **Agents and the access key.** `/mcp` refuses the access key by default, with `401`, so an agent that still sends it stops working when you upgrade to this release. Before you upgrade, give each agent its own token, from **Settings** or with `minibox token create <name>`, and use that token as the agent's bearer key or `MINIBOX_ACCESS_KEY`. Agent tokens are not affected.
- **Warnings after the upgrade.** If an agent used the key on `/mcp` in the last seven days, MiniBox logs `mcp.owner_key_now_refused` when it starts, and the console shows a notice with the time of the last use. Both name the fix. `minibox mcp` also explains a refusal and suggests `minibox token create`.
- **Keeping the key for now.** Set `MCP_ALLOW_OWNER_KEY=true` in `.env`, or in the container environment, to accept the key again while you move the agents. MiniBox still records each use and warns about it. Remove the setting once no agent sends the key.

### Proxies, sign-in and scripts

- **Reverse proxies and tunnels.** Leave `TRUST_PROXY` off unless a proxy you control overwrites `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` on every request. MiniBox logs `proxy.headers_ignored` when those headers arrive while `TRUST_PROXY` is off. Turn it on only behind a proxy that sets them. OpenTunnel does not set them, so there it stays off. Set `ALLOWED_ORIGINS=https://your-address` when the proxy rewrites `Host`, which nginx does unless you set `proxy_set_header Host $host;`. Set `COOKIE_SECURE=1` only when the browser uses HTTPS but the proxy removes the `https://` origin. Writes from another origin return `403` unless `ALLOWED_ORIGINS` lists it.
- **HTTPS.** Over HTTPS, the console sends `Strict-Transport-Security` for one year, so browsers refuse plain HTTP for that host name for that long.
- **Injected scripts.** The console runs scripts only from its own origin. A proxy that injects scripts from elsewhere breaks the console.
- **Sign in again.** When you upgrade from a release before 0.4, each browser signs in once more, because the session cookie changed. The cookie is now `SameSite=Strict`, so a console link opened from another site can also ask for a sign-in.
- **JSON bodies.** Write requests must declare `Content-Type: application/json`. Other types, including the form type that `curl -d ''` sends, return `415`.
- **Terminal scripts.** A terminal WebSocket needs the session name, as in `/api/boxes/:id/terminal?session=main`. To type into a session with a bearer token, use `POST /api/boxes/:id/sessions/:name/input`, or the MCP tool `session_send`.
- **Bearer keys.** A wrong `Authorization: Bearer` key counts toward the login limit, and returns `429` after too many tries. A correct key is never limited.
- **Weak access key.** MiniBox logs `auth.weak_key` at start when the key is shorter than 20 characters or has too little variety. The server still starts. Replace the key with a random one, such as the output of `openssl rand -hex 32`, and restart.

### Secrets and data

- **Set secrets first.** A box can refer to a secret in its environment. Add each secret under **Settings → Secrets** before you rebuild or start that box. A missing secret stops a rebuild with `400` and a start with `409`.
- **Templates and snapshots with secrets.** Saving a template or a snapshot, or a checkpoint with a system image, from a box whose environment uses a secret returns `409` (`secret_in_image`). Remove the secret from the box first.
- **Back up `secrets/` and `sessions.json`.** Keep them with `DATA_DIR`. Without the checkpoint key in `secrets/`, checkpoints cannot be read. See [Backups](backups.md).
- **Old snapshots and checkpoints.** Those made before 0.4 still hold the environment values that their box had. Delete the ones with sensitive values. New ones do not keep these values.
- **Checkpoint repository.** The first checkpoint creates `DATA_DIR/secrets/checkpoint-repo.key` and pulls the `restic/restic:0.18.1` image, so Docker must reach the image registry.

### Boxes and tools

- **Templates without tmux.** A box made from a template without tmux cannot run sessions, and session calls return `409`. Its startup command does not run, but the box still starts. Rebuild the base template from **Templates**, then rebuild those boxes onto it. A read-only bearer terminal needs tmux 3.2 or later.
- **Standard profile.** New boxes use the standard profile by default. It drops the `MKNOD`, `SETPCAP` and `SYS_CHROOT` capabilities and sets a process limit. For a tool that needs them, create the box with the relaxed profile, or set `BOX_PROFILE=relaxed` for new boxes. Existing boxes keep their profile.
- **Mounts and networks.** Creating or rebuilding a box can return `403` (`forbidden`) when it mounts a volume without the MiniBox label, a volume of another box, or `minibox-data`, or when it uses a network that is neither the box network nor the one it already uses. Existing boxes keep their mounts and network until you change them.
- **The `node` user.** The base template no longer includes the image's `node` user. Its uid 1000 now belongs to `dev`, so scripts that run as `node` need `dev` in boxes made from the new base template.
- **`sftp` and `ssh -L` helpers.** The base template adds `openssh-sftp-server` and `socat`. Existing boxes do not get them. Rebuild the base template and create new boxes, or in a box with the standard profile run `sudo apt-get install -y openssh-sftp-server socat`.

### Storage, uploads and notifications

- **Recycle bin and safety checkpoints.** Deleting a box or a volume now keeps a copy of its data for `TRASH_RETENTION_DAYS` days (7 by default). A rebuild, an attach or a detach takes a safety checkpoint first. Both use space in the checkpoint repository, and they count against `CHECKPOINT_CAPACITY_MB`. To free the space at once, purge the entries on the **Recycle bin** page. Send `skipTrash=true` on a delete, or `safetyCheckpoint: false` on a rebuild, to keep no copy.
- **Upload limits behind a proxy.** Uploaded files (`FILE_UPLOAD_MAX_MB`, 1024 by default) and checkpoint packages (`CHECKPOINT_PACKAGE_MAX_MB`, 2048 by default) can be larger than 128 MiB. A reverse proxy has its own limit, such as nginx `client_max_body_size`, which is 1 MB by default. Raise it, or uploads fail at the proxy.
- **NFS volumes.** Creating a volume on an NFS export fails with `502` (`storage_unwritable` or `storage_permission_denied`) when the export uses `root_squash` with the default anonymous user, `nobody`. Set `all_squash,anonuid=1000,anongid=1000` or `root_squash,anonuid=1000,anongid=1000` on the export. See [NFS](../user-guide/nfs.md).
- **Notifications to private addresses.** MiniBox refuses to send notifications to loopback, private and other non-public addresses, unless `NOTIFY_ALLOW_PRIVATE=true`. The `198.18.0.0/15` range stays allowed, for DNS proxies that answer with fake IP addresses. Set it only for a channel that must reach your network.

### Hosts

- **Agent needs an upgrade.** When a host shows **Agent needs an upgrade**, pull the newer `minibox-agent` image and recreate its container with the same data volume. See the [agent reference](../reference/agent.md).
- **Docker socket after `scripts/restart.sh`.** The script gives the Docker socket to your primary group with mode 660. After it runs, only that group and root can use Docker. See [Security](security.md).

## Upgrade the release image

1. Pull the new image:

   ```bash
   docker pull ghcr.io/arnochenfx/minibox:latest
   ```

   To pin a version, use its tag, such as `ghcr.io/arnochenfx/minibox:0.5.1`.

2. If you set `ACCESS_KEY` only in the container environment and not in the `minibox-data` volume, copy it before you remove the container. When the key lives in the volume, skip this step:

   ```bash
   docker exec minibox cat /data/access_key
   ```

   Pass the same value to the new container with `-e ACCESS_KEY=...`, or leave the volume mounted so MiniBox keeps using the file.

   Releases before 0.4 that ran without `-e ACCESS_KEY` kept the key in `/app/.env` inside the container. Read it before you remove the container:

   ```bash
   docker exec minibox grep '^ACCESS_KEY=' /app/.env
   ```

3. Stop and remove the old container. The data volume stays:

   ```bash
   docker stop minibox && docker rm minibox
   ```

4. Start the new container with the same `docker run` command you used before. It must have the same `-v minibox-data:/data` and Docker socket mounts.

## Upgrade a source install

From your checkout:

```bash
git pull
bun install
```

Then restart the server. If you run it with systemd, restart the service. Check the new version in the console's **About** page.

## After an upgrade

- **Boxes keep their existing image.** Rebuild a box to use a newer template. Rebuilding keeps the volumes. See [Boxes](../user-guide/boxes.md).
- **Rebuild the base template** from the **Templates** page, or run `bun run build:template` in a source checkout, when the changelog says the base template changed. New boxes use it.
- **Check the sign-in.** Browser sign-ins can end after an upgrade, for example when the access key changed. Upgrading from before 0.4 signs every browser out once. See [Manual steps since 0.4](#manual-steps-since-04).

## Boxes from before the `dev` user

Early versions of MiniBox ran boxes as root. Those boxes keep running as root. Nothing is renamed or rebuilt during an upgrade.

- A new local volume is set to owner 1000:1000 when it is created.
- The root of an existing `/workspace` volume is set to 1000:1000 when a box is created or rebuilt from a template that names its owner. Files already in the volume keep their owners.
- If the `/workspace` of an older box is still owned by root, fix it once, while the box runs:

  ```bash
  docker exec -u root minibox-<name> chown -R 1000:1000 /workspace
  ```

  Or, while the volume is not in use:

  ```bash
  docker run --rm --user root -v minibox-ws-<name>:/workspace minibox-template:base chown -R 1000:1000 /workspace
  ```

A rebuild does not change the files in a volume. A recursive `chown` on a large volume is a one-time task that you run yourself.
