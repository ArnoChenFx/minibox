# Agent

The MiniBox agent is a small program that runs in a container on a machine with Docker. It connects out to MiniBox over a WebSocket and runs a fixed set of Docker operations for MiniBox on that machine's engine. The machine opens no port. The image is `ghcr.io/arnochenfx/minibox-agent`, built for `linux/amd64` and `linux/arm64`. To add a machine, follow [Add an agent host](../user-guide/hosts.md#add-an-agent-host).

## Run it

The console generates this command when you add an agent host. The code and the address change for each host.

```sh
docker run -d --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v minibox-agent:/data \
  ghcr.io/arnochenfx/minibox-agent --server https://minibox.example.com --pair ABCDE-FGHJK
```

Keep `--pair` in the command. On later starts, when the agent already has credentials, it logs a warning and ignores the code. To stop the agent, run `docker stop` on its container. The agent exits cleanly on `SIGTERM`.

## Options

| Option | Meaning |
|---|---|
| `--server <url>` | The MiniBox address this machine can reach, such as `https://minibox.example.com`. Required with `--pair`. Later starts use the address the agent was paired with, unless this option is given. |
| `--pair <code>` | The one-time pairing code from the console. Used on the first start only. |
| `--help`, `-h` | Print the usage and exit. |

An unknown option, or an option without a value, is a usage error and exits with status 2.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/data` | Where the agent keeps its identity. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | The Docker socket the agent manages. |
| `MINIBOX_VERSION` | Set by the image | The version the agent reports to MiniBox. |

## Exit status

| Status | Meaning |
|---|---|
| `0` | Stopped by `SIGTERM` or `SIGINT`, or `--help` was given. |
| `1` | Pairing failed. The MiniBox address could not be reached, or MiniBox refused the code. |
| `2` | Usage error, or the agent is not paired and was started without `--pair`. |

A revoked agent does not exit. It stays running and idle, so a restart policy does not start it again and again.

## Data volume

The agent keeps two files in `/data`, both with mode `600`:

- `agent.json` holds the agent id, the host id, the MiniBox address and the time of pairing. It holds no secret.
- `agent-key.pem` holds the agent's Ed25519 private key. The key never leaves the volume.

Keep the volume to keep the agent's identity. If the key file is lost, the agent cannot prove who it is. Remove the volume and pair the agent again.

## Connection

The agent opens a WebSocket to `/api/agent/connect` on the MiniBox address, using `wss://` for `https://` and `ws://` for `http://`. It proves its identity by signing a challenge that the server sends on each connection with its private key. The server must receive that hello within 15 seconds, or it closes the connection.

While connected, the agent sends a heartbeat every 10 seconds. The server closes a connection that stays silent for 30 seconds. After a disconnect, the agent reconnects with exponential backoff, starting at 1 second, doubling to at most 30 seconds, with about 20 percent of jitter either way.

The server closes a connection with one of these codes:

| Code | Meaning |
|---|---|
| `4401` | The agent could not prove its identity. Pair it again. |
| `4403` | The agent was revoked. |
| `4408` | No valid hello arrived within 15 seconds. |
| `4409` | A newer connection from the same agent replaced this one. |
| `4410` | The connection was silent for 30 seconds. |
| `4426` | The agent speaks another protocol version. Update the image. |

## Protocol version

The agent and MiniBox exchange a protocol version, currently `1`. When they differ, MiniBox refuses the agent with code `4426`, and the host shows **Agent needs an upgrade**. Pull the latest image and recreate the container with the same data volume.

## Operations

An agent runs only the operations listed here, against its own Docker engine. A request for any other operation fails with an `invalid` error.

- **Containers:** list, inspect, create, start, stop, restart, pause, unpause, remove, rename and update limits, including CPU, memory, swap, process count and restart policy. Read logs, stats and filesystem diffs.
- **Exec:** start a process in a container, then resize, inspect or kill it. Its output streams back to MiniBox.
- **Images:** list, inspect and pull.
- **Volumes:** list, inspect, create and remove. Set the root owner of a volume.
- **Networks:** ensure a bridge network, and reattach a container to one.
- **Events:** follow the container logs and the Docker event stream.

Create requests are checked against a strict schema. Bind mounts are refused, so volumes are named only. The host network is refused. Any option outside the schema is refused.

These operations are refused with an `unsupported` error and never run: commit a container, put or get an archive, stat a path, remove, save, load or build an image, run a helper container, and read disk usage.

Failures are reported with one of these kinds: `not_found`, `conflict`, `invalid`, `unsupported`, `unavailable`, `engine` and `aborted`.

## Revoke, upgrade and re-pair

**Revoke** in the console disconnects the agent at once and blocks it from reconnecting. A revoked agent keeps running idle until its container is removed.

To upgrade, pull the newer image, remove the old container and run the command again with the same data volume. The agent keeps its identity, so the host and its boxes stay the same:

```sh
docker pull ghcr.io/arnochenfx/minibox-agent
docker rm -f <container id>
docker run -d --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v minibox-agent:/data \
  ghcr.io/arnochenfx/minibox-agent --server https://minibox.example.com
```

To put a revoked machine back in use, remove its host first. Then create a new pairing code, and run the command with a new data volume, such as `-v minibox-agent-2:/data`. The old volume still holds the revoked identity.

## Security

Mounting `/var/run/docker.sock` gives the agent control of that machine's Docker engine. Anyone who can use the agent can control the machine's containers, so run agents only on machines you control. Revoke an agent you no longer trust.

The activity log records creating a pairing code, revoking an agent and removing a host. The server log records each accepted connection and each disconnection with its reason.
