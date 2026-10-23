# Configuration

MiniBox reads its settings from environment variables. The precedence is:

1. Variables in the process environment.
2. The `.env` file in the project root. MiniBox reads it, and never writes it.
3. The defaults in this page.

[`.env.example`](../../.env.example) lists the settings with comments. Every value has a default, so you can run MiniBox without a `.env` file.

## Access and network

| Variable | Default | Meaning |
|---|---|---|
| `ACCESS_KEY` | Generated into `DATA_DIR/access_key` | The access key for the console and the API. Use at least 20 random characters. A key that you set takes precedence over the generated one. MiniBox never writes this value to `.env`. See [Security](../admin/security.md). |
| `MCP_ALLOW_OWNER_KEY` | `false` | Whether the access key may call `/mcp`. Agent tokens always may. `false` refuses the key with `401`. `true` accepts it and records each use. See [Upgrades](../admin/upgrades.md). |
| `HOST` | `127.0.0.1` | The address that MiniBox listens on. The release image sets `0.0.0.0`. A box's agent reaches MiniBox at this address, so a self token needs the `minibox-boxes` gateway address or `0.0.0.0`. See [Connecting AI agents](../user-guide/agents.md#a-boxs-own-agent). |
| `PORT` | `3920` | The port that MiniBox listens on. A positive whole number. Other values use the default. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` from a reverse proxy. Turn it on only behind a proxy that overwrites these headers, and only when the proxy is the only way in. See [Remote access and TLS](../admin/remote-access.md). |
| `ALLOWED_ORIGINS` | Empty | Public origins of this server, comma-separated, such as `https://minibox.example.com`. Needed when a proxy rewrites `Host`. An invalid value stops startup. |
| `PREVIEW_BASE_DOMAIN` | Off | The base domain of subdomain port previews, such as `minibox-preview.net`. Each preview then runs on `<port>-<box>.<base>`, with an origin of its own. Blank keeps path previews under `/box/<name>/<port>/`. The domain must be outside the console's domain, and needs a wildcard DNS record and certificate that reach MiniBox. An invalid value stops startup. See [Subdomain previews](../admin/preview-subdomains.md). |
| `COOKIE_SECURE` | `false` | Always set the `Secure` flag on the session cookie. Use it only over HTTPS. |
| `SESSION_TTL_DAYS` | `30` | How long a sign-in lasts, counted from sign-in. A number of days above 0 and at most 3650. An invalid value stops startup. |
| `SESSION_IDLE_DAYS` | Off | Ends a sign-in after this many days without use. A number of days above 0 and at most 3650. Off when empty. |
| `STREAM_MAX_CONNECTIONS` | `256` | Live event, task and log streams open at once. A positive whole number. Further streams get `429`. |

## Data and Docker

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `./data` (`/data` in the image) | The data directory. See [Data directory](../admin/data-directory.md). |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | The path of the Docker Engine socket |
| `LABEL_PREFIX` | `minibox` | The prefix of labels, container names, image names and volume names. Build the base template again after you change it. See [Install MiniBox](../admin/install.md). |
| `BASE_TEMPLATE` | `<LABEL_PREFIX>-template:base` | The image that new boxes start from by default |
| `RUNTIME` | The engine's default | The OCI runtime for new boxes, such as `runsc` for gVisor. The runtime must already be installed in the Docker engine. An invalid name stops startup. |
| `STOP_TIMEOUT_SEC` | `3` | Seconds a box has to exit after `SIGTERM`, before it is killed. Used by stop and restart. A whole number from 0 to 300. |
| `MINIBOX_VERSION` | From git, or from `package.json` | The version MiniBox displays. When set, this value wins. Release images set it from the release tag. |

## Boxes

| Variable | Default | Meaning |
|---|---|---|
| `BOX_PROFILE` | `standard` | The security profile for new boxes: `standard`, `strict` or `relaxed`. See [Security profiles](../admin/security.md#security-profiles). An unknown name stops startup. |
| `BOX_PIDS_LIMIT` | `1024` | The most processes that each new box can run. A positive whole number. An invalid value stops startup. |
| `BLOCK_HOST_GATEWAY` | `false` | Keeps boxes on the default network from reaching services on the host through the bridge gateway. Boxes with network egress `none` or `proxy-only` are always kept off the host. `1`, `true`, `yes` and `on` turn it on, and any other value leaves it off. See [Network egress](../admin/network-egress.md#the-host-gateway). |
| `BOX_IDLE_TIMEOUT_SEC` | `0` | The default idle timeout for boxes, in seconds. `0` turns idle sleep off. A whole number from 0 to 31536000. Each box can set its own timeout. See [Idle sleep and TTL](../user-guide/idle-sleep.md). |
| `BOX_IDLE_CPU_PERCENT` | `5` | A box counts as idle only when its recent CPU use is below this percentage. From 0 to 100. |
| `LIFECYCLE_INTERVAL_MS` | `30000` | How often MiniBox checks idle sleep and TTLs, in milliseconds. A positive whole number. |
| `METRICS_INTERVAL_MS` | `3000` | How often MiniBox samples host and box resource use, in milliseconds. A positive whole number. Keep it above 2000. |
| `METRICS_HISTORY` | `120` | The number of samples kept for each host and each box. A positive whole number. |
| `HOST_OVERCOMMIT` | `1` | How far the CPU and memory that running boxes reserve on a host may exceed its capacity, as a ratio from 1 to 10. `1` reserves no more than the host has. Checked only when there is more than one host. See [Hosts](../user-guide/hosts.md#capacity). |

## Sessions and tokens

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_TAKEOVER_IDLE_SEC` | `300` | Seconds without input from a person, after which a takeover of an agent's session returns it to the agent. `0` keeps the takeover until it is returned by hand. A whole number from 0 to 86400. |

## Checkpoints

| Variable | Default | Meaning |
|---|---|---|
| `CHECKPOINT_KEEP_LAST` | `20` | Automatic checkpoints kept for each box, newest first. A whole number from 1 to 10000. Manual and pinned checkpoints are never removed. |
| `CHECKPOINT_KEEP_DAYS` | `30` | Automatic checkpoints older than this many days are removed. A whole number from 0 to 3650. `0` keeps them whatever their age. |
| `CHECKPOINT_CAPACITY_MB` | `0` | The size limit of the checkpoint repository, in MB. A whole number from 0 to 1000000000. `0` sets no limit. At the limit, MiniBox refuses new automatic checkpoints. |
| `TRASH_RETENTION_DAYS` | `7` | How many days the data of a deleted box or volume is kept in the [recycle bin](../user-guide/checkpoints.md#recycle-bin) before it is purged. A whole number from 1 to 365. Recycle bin entries count against `CHECKPOINT_CAPACITY_MB`. |
| `CHECKPOINT_PACKAGE_MAX_MB` | `2048` | The largest checkpoint package, in MB. A whole number from 1 to 65536. An export, a copy to another host or an upload of a larger package fails. The package upload (`POST /api/packages`) accepts a body up to this size plus 1 MB. Only that upload and the volume file upload may exceed 128 MB; every other request, including JSON bodies and previews, stays capped at 128 MB. See [Export and import](../user-guide/checkpoints.md#export-and-import). |

## Volumes and storage

| Variable | Default | Meaning |
|---|---|---|
| `VOLUME_USAGE_INTERVAL_SEC` | `600` | How often each volume's usage is sampled, in seconds. A whole number from 60 to 86400; any other value falls back to 600. Every sample is checked against the volume's soft and hard limits. Soft alerts are best effort, not a quota. See [Volumes and storage](../user-guide/volumes-and-storage.md#usage-limits-and-free-space). |
| `HOST_DISK_MIN_FREE_PERCENT` | `10` | The free space, as a percentage of the disk that the engine uses, below which MiniBox alerts once and refuses new volumes and checkpoints. A whole number from 0 to 100; any other value falls back to 10. `0` turns the check off. |

## Files

| Variable | Default | Meaning |
|---|---|---|
| `FILE_UPLOAD_MAX_MB` | `1024` | The largest file that can be uploaded to a volume, in MB. A whole number from 1 to 65536; any other value falls back to 1024. A larger upload is refused with `413` before its bytes are read. Only the volume file upload (`PUT /api/volumes/{id}/files/stream`) and the package upload may exceed 128 MB. See [Files](../user-guide/files.md). |

## Notifications

| Variable | Default | Meaning |
|---|---|---|
| `NOTIFY_ALLOW_PRIVATE` | `false` | Lets notification channels send to addresses that are not public: loopback, private network, link-local, shared and reserved addresses. Use it for a self-hosted ntfy server or a webhook on your network. `1`, `true`, `yes` and `on` turn it on, and any other value leaves it off. See [Notifications](../user-guide/notifications.md#private-addresses). |

## Events and logs

| Variable | Default | Meaning |
|---|---|---|
| `EVENT_RETENTION_AUDIT_DAYS` | `365` | Days to keep audit events: writes, deletes and refused calls. A positive whole number. |
| `EVENT_RETENTION_ACTIVITY_DAYS` | `30` | Days to keep activity events, such as commands, terminal sessions and reads. A positive whole number. |
| `EVENT_OUTPUT_RETENTION_DAYS` | `7` | Days to keep the saved output of commands in `DATA_DIR/exec`. A positive whole number. |
| `EVENT_OUTPUT_MAX_MB` | `512` | The total size of saved command output, in MB. The oldest output goes first. A positive whole number. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Other values mean `info`. |

Values that are out of range, or not numbers, use the default, unless the table says that they stop startup.
