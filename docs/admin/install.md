# Install MiniBox

This page is for the person who runs MiniBox on a server. It covers the release image, running from source, and the first start.

## Requirements

- A Linux host with Docker Engine. MiniBox reads `/proc` for host metrics.
- Access to the Docker socket for the user that runs MiniBox. The socket is `/var/run/docker.sock` by default.
- For a source install, [Bun](https://bun.sh) 1.4.4 or later.

Docker access is root-equivalent. Read the [security guide](security.md) before you install.

## Option 1: Run the release image

Release images are published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`:

```bash
docker run -d --name minibox --restart unless-stopped \
  -p 127.0.0.1:3920:3920 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v minibox-data:/data \
  ghcr.io/arnochenfx/minibox:latest
```

- The Docker socket must be mounted. Boxes are created as sibling containers on the host's Docker engine, not inside the MiniBox container.
- The `minibox-data` volume holds the [data directory](data-directory.md), including the generated access key. Without it, that state is lost when the container is removed.
- The port is published on `127.0.0.1` only. Inside the container, MiniBox listens on `0.0.0.0:3920`. For remote access, use HTTPS. See [Remote access and TLS](remote-access.md).

### Direct SSH

To let SSH apps such as Termius connect to boxes without the command-line tool, set `SSH_PORT` and publish that port:

```bash
docker run -d --name minibox --restart unless-stopped \
  -p 127.0.0.1:3920:3920 \
  -p 2222:2222 -e SSH_PORT=2222 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v minibox-data:/data \
  ghcr.io/arnochenfx/minibox:latest
```

- `-p 2222:2222` makes the port reachable from other machines. Use `-p 127.0.0.1:2222:2222`, or the address of a private network such as Tailscale, to limit who can reach it.
- If the host port differs from `SSH_PORT`, set `SSH_PUBLIC_PORT` to the host port, so the SSH dialog shows the right one.
- An HTTPS tunnel or reverse proxy carries only the console. The SSH port needs a TCP route of its own, such as a published port, a private network, or a TCP tunnel. Set `SSH_PUBLIC_HOST` when clients reach it at another address than the console.
- Read [Direct SSH](security.md#direct-ssh) in the security notes before you open the port to the internet.

### The access key

If you do not pass `ACCESS_KEY`, MiniBox generates a 64-character key on first start. Read it with:

```bash
docker exec minibox cat /data/access_key
```

`docker logs` never prints the key.

To choose the key yourself, pass it when you create the container:

```bash
-e ACCESS_KEY="$(openssl rand -hex 32)"
```

Use at least 20 random characters. See [Security](security.md).

### Image tags

- `X.Y.Z`, `X.Y` and `latest` point to releases. Pre-releases such as `1.0.0-rc.1` get only their exact tag.
- To pin a version, use its full tag, such as `ghcr.io/arnochenfx/minibox:0.7.4`.

### The base template

The release image does not include the base template. MiniBox builds it on a host the first time something needs it there: a box created from it, or a helper that installs tools, prepares volumes or runs an egress proxy. To avoid that wait later, build it ahead from the **Templates** tab of **Library** in the console: click **Build base template**. A host reached through an agent cannot build images, so copy the template to it instead. See [Templates](../user-guide/templates.md).

### Build the image yourself

From a checkout of the repository:

```bash
docker build --build-arg MINIBOX_VERSION=0.7.4 -t minibox .
```

Use the `minibox` image in the `docker run` command above in place of the release image.

## Option 2: Run from source

```bash
git clone https://github.com/ArnoChenFx/minibox.git
cd minibox
bun install
cp .env.example .env          # optional; every value has a default
bun run build:template        # builds the base template; you can also build it in the console
bun start
```

The server listens on `127.0.0.1:3920`. Open <http://127.0.0.1:3920>, and sign in with the key in `data/access_key`.

If no `ACCESS_KEY` is set in the environment or in `.env`, MiniBox writes a generated key to `DATA_DIR/access_key`. The file has mode 600. MiniBox never writes `.env`.

To read the comments in Chinese, copy `.env.zh.example` instead of `.env.example`. The two files set the same options with the same defaults.

`bun run build:template` always tags the image `minibox-template:base`. If you change `LABEL_PREFIX` or `BASE_TEMPLATE`, build the base template from the **Templates** tab of **Library** instead.

### Run as a service

With systemd, run MiniBox as a service. Here is a minimal unit file. Replace the paths with your own:

```ini
[Unit]
Description=MiniBox
After=docker.service
Requires=docker.service

[Service]
WorkingDirectory=/opt/minibox
ExecStart=/home/minibox/.bun/bin/bun src/server.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### Hosts without systemd

On containers and cloud sandboxes without systemd, use the helper script in a checkout:

```bash
scripts/restart.sh              # starts dockerd if needed, then the server and, if installed, a tunnel
scripts/restart.sh --no-tunnel  # server only
```

The script writes the server output to `server.log` in the project root. It is meant for a single-user sandbox. After it runs, the Docker socket belongs to your primary group, with mode 660. Anyone in that group can control Docker, which means they can control the host. Do not use this script on a shared host.

## Troubleshooting

- **`/api/health` returns `503` with `"docker": false`.** MiniBox cannot reach the Docker socket. Check that the socket is mounted, and that the user that runs MiniBox can read and write it.
- **The log shows `auth.weak_key`.** The access key is shorter than 20 characters, or it has low entropy. MiniBox still starts. Replace the key, and restart.
- **The log shows `proxy.headers_ignored`.** MiniBox received forwarding headers while `TRUST_PROXY` was off. See [Remote access and TLS](remote-access.md).

For every setting, see [Configuration](../reference/configuration.md).
