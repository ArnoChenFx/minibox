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

Event and log readers buffer at most 1,024 items or 4 MiB per stream. If a consumer falls behind that budget, MiniBox cancels that stream and reports an `unavailable` buffer-limit error instead of silently dropping frames. Other streams and the host connection continue working. Retry the reader after resolving the slow consumer. Aborting a reader discards its pending items; an ordinary stream end still delivers buffered items before its final error, if any.

The agent opens a WebSocket to `/api/agent/connect` on the MiniBox address, using `wss://` for `https://` and `ws://` for `http://`. It proves its identity by signing a challenge that the server sends on each connection with its private key. The server must receive that hello within 5 seconds of the connection opening, or it closes the connection. The agent gives dialing (DNS, TCP, TLS and the upgrade) its own 30 seconds, so a slow link does not spend the hello's time.

A connection that is not yet authenticated holds one of a limited number of places, so a flood of sockets that never say hello is refused rather than kept open; an authenticated agent holds no such place. There are two limits, both constants rather than settings:

- **Per address, 8 sockets.** One caller cannot take every place there is. A socket past the limit is answered `429` **before** the upgrade, with the error key `agent_pending_limit`, so nothing is opened at all.
- **In total, 64 sockets.** This is the backstop, so a crowd spread over many addresses cannot take the door either. A socket past it is answered `429` the same way, with the error key `agent_pending_total_limit`.

A socket that gets through the upgrade but is past a limit as it opens is closed with `4411` instead. Either way the agent retries with backoff: it is a real agent, and the places are held only until the sockets holding them time out.

The address is the connection's TCP peer, or the client address in `X-Forwarded-For` when `TRUST_PROXY` is on. **With `TRUST_PROXY` off, a reverse proxy or tunnel in front of MiniBox makes every client share one address, and therefore one 8-socket limit.** If real agents are refused with `agent_pending_limit` behind such a proxy, turn `TRUST_PROXY` on (only behind a proxy you control that overwrites the header), or connect the agents directly.

A socket that has not sent its hello yet may not send a frame larger than 4 KiB; one that does is closed with `1009`. A hello is a few hundred bytes, so no real handshake is affected. After the hello, a frame may be up to 16 MiB, the limit every MiniBox socket shares. A one-shot log read returns at most 2 MiB of text: the newest whole lines, after a line that says how many bytes of older output were left out. Follow the log stream to see everything.

While connected, the agent sends a heartbeat every 10 seconds. The server closes a connection that stays silent for 30 seconds. After a disconnect, the agent reconnects with exponential backoff, starting at 1 second, doubling to at most 30 seconds, with about 20 percent of jitter either way.

The server closes a connection with one of these codes:

| Code | Meaning |
|---|---|
| `1009` | A frame arrived that was larger than the socket allows. |
| `4401` | The agent could not prove its identity. Pair it again. |
| `4403` | The agent was revoked. |
| `4408` | No valid hello arrived within 5 seconds. |
| `4409` | A newer connection from the same agent replaced this one. |
| `4410` | The connection was silent for 30 seconds. |
| `4411` | Too many connections were already waiting for a hello (8 from one address, or 64 in total), so this one was closed without being challenged. The agent retries. |
| `4426` | The agent speaks another protocol version. Update the image. |

A refusal before the upgrade is an HTTP status, not a close code: `429` with `agent_pending_limit` or `agent_pending_total_limit` means a pending limit was reached, and the agent logs it as `agent.saturated` and retries. The agent logs every close with its code (`agent.closed` at info for a normal `1000`/`1001`, such as a server restart), so a log line tells a saturation (`4411`) apart from a network drop (`1006`) or a revocation (`4403`).

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

Create requests are checked against a strict schema. Bind mounts are refused, so volumes are named only. The host network is refused. Added capabilities are limited to Docker's default set, so a container cannot be given `SYS_ADMIN`, `SYS_MODULE` or any other capability beyond it, and there is no privileged mode or device access. Any option outside the schema is refused.

These operations are refused with an `unsupported` error and never run: commit a container, put or get an archive, stat a path, remove, save, load or build an image, run a helper container, and read the engine's disk usage, either the host filesystem's (`diskUsage`) or what the engine itself holds (`diskBreakdown`, which is what `docker system df` reports).

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
