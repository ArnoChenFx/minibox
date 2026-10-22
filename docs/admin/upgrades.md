# Upgrades

Upgrading MiniBox replaces the server software. Your boxes, volumes, settings and tokens stay, because they live in the data directory and in Docker volumes.

Read the [changelog](../../CHANGELOG.md) before you upgrade. It lists what changed in each release.

## Before you upgrade

1. Read the changelog for the versions you are skipping.
2. Make a backup. See [Backups](backups.md).
3. Note the image tag that you run now. If the new version causes problems, you can go back to it.

## Upgrade the release image

1. Pull the new image:

   ```bash
   docker pull ghcr.io/arnochenfx/minibox:latest
   ```

   To pin a version, use its tag, such as `ghcr.io/arnochenfx/minibox:0.4.0`.

2. If you set `ACCESS_KEY` only in the container environment and not in the `minibox-data` volume, copy it before you remove the container. When the key lives in the volume, skip this step:

   ```bash
   docker exec minibox cat /data/access_key
   ```

   Pass the same value to the new container with `-e ACCESS_KEY=...`, or leave the volume mounted so MiniBox keeps using the file.

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
- **Rebuild the base template** from the **Templates** page when the changelog says the base template changed. New boxes use it.
- **Check the sign-in.** Browser sign-ins may end after an upgrade, if the access key changed.

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
