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

**`/mcp` accepts the access key, and the key grants full owner access over MCP.** A client with the key can run `exec` as root in any box that is not `strict`, delete boxes and rebuild them. Give agents an agent token instead. A token's tool list and every call are held to its scopes. See [Connecting AI agents](../user-guide/agents.md).

## Host secrets

- A host secret is written once, to `DATA_DIR/secrets/env/<name>`, with mode 600. No API returns its value.
- A secret reaches a box only as that container's environment variable. Processes in the box, and anyone who can run commands in it, can read it.
- Only the owner can set or delete secrets. A token needs `secret:use` to refer to one. Only the `admin` preset has that scope.
- Events, the audit log, container labels and the server log show the secret's name, never its value.

## Requests and browsers

- **Cross-site requests are refused.** The terminal WebSocket and every write (`POST`, `PATCH`, `DELETE`) under `/api/` must come from MiniBox's own origin, or from an origin in `ALLOWED_ORIGINS`. Requests without an `Origin` header, such as scripts that send a bearer token, are accepted.
- **Writes need JSON.** A write must declare `Content-Type: application/json`, unless it has no body and no `Content-Type`. This also blocks HTML form posts.
- **The session cookie is `SameSite=Strict`.** A link from another website may ask you to sign in once more.
- **Content Security Policy.** Scripts load only from MiniBox itself. Pages have no inline scripts, and MiniBox cannot be framed (`frame-ancestors 'none'`).
- **HTTPS.** Requests that arrive over HTTPS get `Strict-Transport-Security` for one year.

## Network exposure

- **Bind to `127.0.0.1`**, which is the default. Do not set `HOST=0.0.0.0` on a machine with a public address.
- **Use HTTPS for remote access.** The session cookie gets the `Secure` flag when the request is HTTPS, or when it carries an `https://` origin. See [Remote access and TLS](remote-access.md).
- **Public tunnels are discoverable.** Tunnel addresses can appear in public certificate logs, and the tunnel adds no sign-in of its own. Prefer a private network, or a reverse proxy that requires its own sign-in.

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

### Limits

- **No egress filtering.** Box traffic leaves through Docker's normal NAT, without filtering. Boxes can reach services on the host's bridge gateway.
- **No disk quotas.** Nothing limits how much disk a box uses.

### Host scripts

`scripts/restart.sh` is a convenience for a single-user sandbox. It may start `dockerd` with `sudo`, then gives the Docker socket to your primary group with mode 660. Only members of that group, normally only you, and root can use Docker then. Docker access is still root-equivalent, so read the script before you use it anywhere else.
