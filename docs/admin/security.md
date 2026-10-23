# Security

MiniBox is built for one trusted user, on a machine that the user controls. Read this page before you expose MiniBox to any network.

## The trust model

- **The Docker socket is root.** MiniBox controls Docker through its socket. Anyone with the access key can run anything on the host as root. Treat the key like a root password. Keep `.env` and `data/` out of git.
- **The container runs as root.** It needs the Docker socket, which is root-equivalent. To narrow this, put a socket proxy in front of the socket, that forwards only the Docker API calls MiniBox uses. Point `DOCKER_SOCKET` at the proxy. Or run MiniBox against a rootless Docker or Podman socket.
- **Boxes are not a security sandbox for untrusted code.** Boxes share the host's kernel. They are fine for your own agents. For untrusted third-party code, use a sandbox such as gVisor, or a microVM. Set `RUNTIME=runsc` to use gVisor, if it is installed in the Docker engine.
- **Do not mount the Docker socket or sensitive host paths into a box.**

## The access key

- The access key is the only guard. There are no user accounts, and a leaked key gives full access.
- The key is compared in constant time.
- Use at least 20 random characters. `openssl rand -hex 32` makes a 64-character key.
- At startup, a key shorter than 20 characters, or one with low entropy, logs an `auth.weak_key` warning. MiniBox still starts, so existing installs keep working.
- **Sign-in limits.** A wrong key is refused after 10 failures from one client address (for IPv6, one /64 network), or after 50 failures from all addresses together, within 5 minutes. A correct key always signs in. The limit slows guessing, but it does not prevent it. The length and randomness of the key are what protect it.
- **Rotating the key:** change `ACCESS_KEY` in `.env`, or delete `DATA_DIR/access_key` to generate a new one. Then restart MiniBox. Every browser sign-in ends when MiniBox starts with the new key.

## Browser sign-ins

- A sign-in does not store the key in the browser. The cookie holds a random 32-byte token.
- `DATA_DIR/sessions.json` stores only the SHA-256 hash of that token, so a copy of the file cannot be replayed as a cookie. The file also stores a scrypt check of the access key, so the strength of the key still matters.
- Sign-ins end on logout, when a user revokes them in **Settings**, when they expire (`SESSION_TTL_DAYS`, 30 days by default), or when the access key changes.

## Agent tokens

- Agent tokens are separate from the access key. Create them in **Settings**, or with `POST /api/tokens`. MiniBox shows the token (`mbx_…`) once. `DATA_DIR/tokens.json` stores only its SHA-256 hash.
- A token has scopes, a box selector, volumes, hosts and optional quotas. See [Access, sessions and tokens](../user-guide/access-and-tokens.md).
- Rotating `ACCESS_KEY` does not revoke tokens. Revoke them in **Settings**.
- `exec` and `box:ssh` can read and write every mount of the boxes that the token may use. Grant them only where needed.
- Only the owner can create tokens. No preset can create one.
- A box's self token is not an agent token. It is issued for one box and reaches only that box's `self` operations. MiniBox keeps only its hash and never logs it, and the file in the box is on a memory filesystem. See [A box's own agent](../user-guide/agents.md#a-boxs-own-agent).

**`/mcp` accepts the access key in this release, and the key grants full owner access over MCP.** A client with the key can run `exec` as root in any box that is not `strict`, delete boxes and rebuild them. MiniBox records each use. Set `MCP_ALLOW_OWNER_KEY=false` to refuse the key on `/mcp`. The next minor release refuses it by default. Give agents an agent token instead. A token's tool list and every call are held to its scopes. See [Connecting AI agents](../user-guide/agents.md).

## Host secrets

- A host secret is written once, to `DATA_DIR/secrets/env/<name>`, with mode 600. No API returns its value.
- A secret reaches a box only as that container's environment variable. Processes in the box, and anyone who can run commands in it, can read it.
- Only the owner can set or delete secrets. A token needs `secret:use` to refer to one. Only the `admin` preset has that scope.
- Events, the audit log, container labels and the server log show the secret's name, never its value.

## Notifications

A notification channel sends a message to an address that you give it.

- **Only the owner.** No token holds the `notify:manage` scope, so no token can list, change, test or delete a channel, or read its deliveries.
- **Secrets.** A channel's signing key, ntfy access token or Telegram bot token is written once, to `DATA_DIR/secrets/notify/<channel id>`, with mode 600. No API returns it, and events, the audit log and the server log never hold it. Known secrets are removed from notice text before it is sent. Some chat services put a token in the webhook URL, so the URL is stored the same way, in `secrets/notify/<channel id>.url`, and answers show only its origin. The other settings are in `DATA_DIR/notify.json`, also with mode 600.
- **What a notice carries.** A title and a body in plain text, with no command output and no secret. A change to a channel is audited with the server's origin only, never the path or the query. A delivery is recorded with its channel, notice, attempts, HTTP status and reason.
- **Addresses that are not public are refused.** A channel reaches only public addresses, unless `NOTIFY_ALLOW_PRIVATE` is turned on. Loopback, private, link-local, shared (`100.64.0.0/10`) and reserved IPv4 addresses are refused, and so are the IPv6 loopback, unique-local, link-local, site-local and multicast ranges, and IPv4-mapped or NAT64 (`64:ff9b::/96`) forms of a refused IPv4 address. `198.18.0.0/15` is allowed, because fake-IP DNS proxies such as Clash or Surge answer every name from it and connect to the real address themselves. MiniBox resolves the name once, checks the address, and connects to that address, so a second lookup cannot send the request elsewhere. Redirects are not followed. Unlike template builds and repository clones, notifications do not reach private addresses by default.
- **Bounded.** A send makes at most three attempts, and each attempt has a 10-second timeout that includes the name lookup. At most 256 notices can wait to be sent.

## Backups and off-site targets

- **Backup archives.** A backup is sealed with AES-256-GCM, under a key that scrypt derives from the passphrase. MiniBox never stores the passphrase. The CLI reads it from `MINIBOX_BACKUP_PASSPHRASE` or from standard input, never from an argument. An archive holds the access key and the secrets, so keep it as protected as `DATA_DIR`.
- **Target credentials.** They are written once, to `DATA_DIR/secrets/env/target.<id>.<field>`, with mode 600. No API returns them. Events, the audit log and the server log show only a target's name and address.
- **SFTP host keys.** The host key is pinned when a target is added. MiniBox sends nothing to a server that presents another key.
- **Plain HTTP.** An S3-compatible target accepts `http` only for loopback addresses.
- **Owner only.** Backups and targets need the access key. No token scope grants them.

## Template builds and repository clones

Building a template, rebuilding one and pulling an image are for the owner only. A repository clone at box create needs `box:write`, and `secret:use` when it names a secret. A box created from a template whose `devcontainer.json` sets a `postCreateCommand` needs `exec`, and one whose template forwards ports needs `port:expose`. Each of these makes MiniBox fetch content from an address that someone supplies, or run a command that the template's owner wrote.

- **The server makes the request.** MiniBox downloads a build context URL from its own process, and a clone runs in a helper container on the Docker network. Both follow redirects to any address. MiniBox does not block private, loopback or link-local addresses, or cloud metadata addresses. A build can therefore reach any service the host can reach, including MiniBox itself. This is server-side request forgery (SSRF). Give owner access only to people who should have that reach.
- **Limits.** A context download stops after 2 minutes and is limited to 256 MB. The unpacked context is limited to 256 MB and 20,000 entries. A clone stops after 5 minutes, and runs in a helper with a read-only root, no Linux capabilities and 512 MB of memory.
- **Paths.** MiniBox refuses an archive entry or repository file whose path has `..`, is absolute or contains a NUL byte. It also refuses hard links, devices and other special files. A symbolic link that resolves outside the build context is refused, and so is any write that would pass through a symbolic link.
- **SSH host keys.** Each clone starts with an empty known-hosts file and accepts the host key the first time it connects (`StrictHostKeyChecking=accept-new`). An attacker on the network could answer that first connection. HTTPS with a token checks the server's certificate, so prefer it when the host offers it.
- **Setup commands run in the box.** A template built from a `devcontainer.json` may set a `postCreateCommand`. It runs once, as `dev`, in every box created from that template, so the template's owner decides what those boxes run when they are created. Its output is shown in the box's setup task, and it is stopped after 30 minutes.
- **Secrets.** A token or deploy key goes to the helper as a file, never on a command line, and is used only for its own clone. The task log removes its value from the clone output. The audit log records the size of a pasted Dockerfile, not its text. A template's recipe in `DATA_DIR/template-recipes/` keeps the pasted Dockerfile as text, so keep secrets out of it. A copy of the template to another host carries the recipe too. The recipe keeps only the names of secrets.

## Requests and browsers

- **Cross-site requests are refused.** The terminal WebSocket and every write (`POST`, `PATCH`, `DELETE`) under `/api/` must come from MiniBox's own origin, or from an origin in `ALLOWED_ORIGINS`. Requests without an `Origin` header, such as scripts that send a bearer token, are accepted.
- **Writes need JSON.** A write must declare `Content-Type: application/json`, unless it has no body and no `Content-Type`. This also blocks HTML form posts.
- **The session cookie is `SameSite=Strict`.** A link from another website may ask you to sign in once more.
- **Content Security Policy.** Scripts load only from MiniBox itself. Pages have no inline scripts, and MiniBox cannot be framed (`frame-ancestors 'none'`).
- **HTTPS.** Requests that arrive over HTTPS get `Strict-Transport-Security` for one year.

## Port previews

A port preview shows a web app from a box in the browser. MiniBox serves previews in one of two modes.

- **Path mode** is the default. It serves a preview at `/box/<name>/<port>/`, on the console's own address. Its isolation relies on browser behaviour, not on a separate origin. The preview runs in a sandbox without `allow-same-origin`, so it has an opaque origin, and the console's sign-in cookie is `HttpOnly` and `SameSite=Strict`, so browsers send no sign-in with the preview's requests to the console. This needs no DNS or certificate, and it suits one trusted user.
- **Subdomain mode** serves each preview on its own origin, `<port>-<box>.<PREVIEW_BASE_DOMAIN>`, once `PREVIEW_BASE_DOMAIN` is set. It needs a wildcard DNS record and certificate. Choose it when the console is reachable from the internet, or when a box runs code you do not fully trust. While it is set, `/box/` addresses return `404`, so the weaker shared-origin preview is not offered beside it. See [Subdomain previews](preview-subdomains.md).

In subdomain mode:

- Opening a preview from the console mints a one-time ticket, valid for 60 seconds. The preview host spends the ticket and sets the grant cookie `__Host-minibox_preview`. The cookie is `HttpOnly`, `Secure` and `SameSite=Lax`, has no `Domain`, and so reaches only its own preview host. A grant opens one preview, for the box and port it was issued for, and it lasts up to 8 hours.
- A grant is not the sign-in. The console's `minibox_session` cookie is never sent to a box. A grant stops opening its preview when its sign-in ends, when its box is renamed or deleted, and when MiniBox restarts, because grants are kept in memory and not written to `DATA_DIR`. A WebSocket closes when its sign-in or grant ends, and when its connection to the box ends, such as when the box stops or is deleted.
- Only names that are `<port>-<box>.<PREVIEW_BASE_DOMAIN>` are served. The base domain itself and any other name under it get a `404`. Nothing under the base domain reaches the console.
- A write or a WebSocket on a preview must come from that preview's own origin. Previews under one base domain are same-site with each other, so this check stops one box's page from changing another box's preview. A page can still send a `GET` to a sibling preview with that preview's grant cookie. Its response is readable only if the sibling allows it. So apps must not change state on `GET`.
- A box receives only the cookies it set itself. A cookie the box sets in a response loses its `Domain` attribute, so it stays on that host. A script on the page can still set a cookie for the whole preview domain.
- The preview sandbox keeps `allow-same-origin`, so the app can use its own storage and cookies. The app's origin is still its own, separate from the console's.
- The preview self-check on **Settings** warns when the preview domain shares its last two labels with the console, and reports when a wildcard does not reach MiniBox.

Keep the preview domain under your control. Point its wildcard record only at MiniBox.

## Network exposure

- **Bind to `127.0.0.1`**, which is the default. Do not set `HOST=0.0.0.0` on a machine with a public address.
- **Use HTTPS for remote access.** The session cookie gets the `Secure` flag when the request is HTTPS, or when it carries an `https://` origin. See [Remote access and TLS](remote-access.md).
- **Public tunnels are discoverable.** Tunnel addresses can appear in public certificate logs, and the tunnel adds no sign-in of its own. Prefer a private network, or a reverse proxy that requires its own sign-in.
- **A box's agent needs the server on the box network.** Boxes reach MiniBox through the gateway of the `minibox-boxes` network, so a box's self token works only if `HOST` is that gateway's address (see `docker network inspect minibox-boxes`), or `0.0.0.0` as the release image sets. Every box can reach that address, but the self token reaches only its own box, and MiniBox never puts the access key in a box.

## Boxes

- **Passwordless `sudo`.** Under the default `standard` profile, the `dev` user can become root inside its box. Root in the box can change the box and its workspace volume. The box is not a privileged container, because `standard` drops most Linux capabilities.
- **Templates do not include workspace or home data.** A template keeps the container's system layer, such as `apt` installs and changes to system files. Keep your code in git, or back up the volumes.
- **Older snapshots and checkpoints may hold environment values.** `docker commit` copies a container's environment into its image. Images made before MiniBox blanked those values still contain them. Delete such images if the values are sensitive.

### Security profiles

The profile of a box is fixed when the box is created. Choose it in the create dialog under **Advanced**, with the `profile` field of `POST /api/boxes`, or set the default with `BOX_PROFILE`. Boxes created before profiles existed keep their settings.

| Profile | `sudo` | `no-new-privileges` | Linux capabilities | Trade-off |
|---|---|---|---|---|
| `standard` (default) | Passwordless, inside the box | Off | All dropped, then 11 added back for `sudo`, `apt` and `ping` | Root in the box can change the box and its workspace volume |
| `strict` | Installed, but cannot escalate | On | All dropped | `sudo` cannot elevate, so system packages cannot be installed. Add them to a template instead. `ping` fails too. |
| `relaxed` | Passwordless, inside the box | Off | Docker's default set, which is the `standard` set plus `MKNOD`, `SETPCAP` and `SYS_CHROOT` | Use it only for a tool that the other profiles block |

Every profile also:

- Limits each box to `BOX_PIDS_LIMIT` processes (1024 by default).
- Disables core dumps.
- Sets the open-file limit to 65536.
- Connects the box to the `<LABEL_PREFIX>-boxes` network (`minibox-boxes` by default). Boxes cannot reach each other on it.

### Network egress

A box on the `open` tier, the default, reaches the internet without filtering. A box on the `none` tier has no route out. A box on `proxy-only` reaches only the hosts on its allowlist, through a MiniBox proxy. Boxes on `none` and `proxy-only` each have a private network instead of the shared one. `BLOCK_HOST_GATEWAY` keeps boxes on the shared network off the host's services. See [Network egress](network-egress.md) for the tiers, the events and the limits.

### Limits

- **Open egress by default.** A box on the `open` tier leaves through Docker's normal NAT, without filtering. Unless `BLOCK_HOST_GATEWAY` is on, it can reach services on the host's bridge gateway. Use `none` or `proxy-only` to filter a box's outbound traffic. Those tiers have their own limits, listed in [Network egress](network-egress.md#limits).
- **No hard disk quotas.** Nothing stops a box from writing as much as the disk holds. MiniBox samples each volume's usage, can stop the boxes that mount a volume over its hard limit, and refuses new volumes and checkpoints while the host disk is below its free-space minimum. Soft alerts are best effort, not a quota, and they are checked between samples. Filesystem quotas are later work. See [Volumes and storage](../user-guide/volumes-and-storage.md#usage-limits-and-free-space).

### Host scripts

`scripts/restart.sh` is a convenience for a single-user sandbox. It may start `dockerd` with `sudo`, then gives the Docker socket to your primary group with mode 660. Only members of that group, normally only you, and root can use Docker then. Docker access is still root-equivalent, so read the script before you use it anywhere else.
