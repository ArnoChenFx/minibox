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
| `DATA_DIR` | `/data` | Where the agent keeps its identity and its scope. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | The Docker socket the agent manages. |
| `AGENT_ALLOWED_RUNTIMES` | Empty | Container runtimes besides `runc` that a box on this machine may ask for, comma separated, such as `runsc`. See [What the agent manages](#what-the-agent-manages). |
| `MINIBOX_VERSION` | Set by the image | The version the agent reports to MiniBox. |

## Exit status

| Status | Meaning |
|---|---|
| `0` | Stopped by `SIGTERM` or `SIGINT`, or `--help` was given. |
| `1` | Pairing failed. The MiniBox address could not be reached, or MiniBox refused the code. Or `scope.json` cannot be read, or was written for another host: the agent serves nothing until it is fixed. |
| `2` | Usage error, or the agent is not paired and was started without `--pair`. |

A revoked agent does not exit. It stays running and idle, so a restart policy does not start it again and again.

## Data volume

The agent keeps up to three files in `/data`, all with mode `600`:

- `agent.json` holds the agent id, the host id, the MiniBox address and the time of pairing. It holds no secret.
- `agent-key.pem` holds the agent's Ed25519 private key. The key never leaves the volume.
- `scope.json` holds the host id and the label prefix of the MiniBox the agent serves. It holds no secret. The agent writes it when it pairs, with the prefix the control plane names in its answer, and an agent that has none, because it was paired before scopes existed, writes one at its first welcome. One that is empty is an error: reading it as none would hide a damaged record behind a welcome that writes a new one.

Keep the volume to keep the agent's identity. If the key file is lost, the agent cannot prove who it is. Remove the volume and pair the agent again. A `scope.json` that was written for another host stops the agent with status 1 and a message saying so: it belongs to another engine.

## Connection

Event and log readers buffer at most 1,024 items or 4 MiB per stream. If a consumer falls behind that budget, MiniBox cancels that stream and reports an `unavailable` buffer-limit error instead of silently dropping frames. Other streams and the host connection continue working. Retry the reader after resolving the slow consumer. Aborting a reader discards its pending items; an ordinary stream end still delivers buffered items before its final error, if any.

The agent opens a WebSocket to `/api/agent/connect` on the MiniBox address, using `wss://` for `https://` and `ws://` for `http://`. It proves its identity by signing a challenge that the server sends on each connection with its private key. The server must receive that hello within 5 seconds of the connection opening, or it closes the connection. The agent gives dialing (DNS, TCP, TLS and the upgrade) its own 30 seconds, so a slow link does not spend the hello's time.

A connection that is not yet authenticated holds one of a limited number of places, so a flood of sockets that never say hello is refused rather than kept open; an authenticated agent holds no such place. There are two limits, both constants rather than settings:

- **Per address, 8 sockets.** One caller cannot take every place there is. A socket past the limit is answered `429` **before** the upgrade, with the error key `agent_pending_limit`, so nothing is opened at all.
- **In total, 64 sockets.** This is the backstop, so a crowd spread over many addresses cannot take the door either. A socket past it is answered `429` the same way, with the error key `agent_pending_total_limit`.

A socket that gets through the upgrade but is past a limit as it opens is closed with `4411` instead. Either way the agent retries with backoff: it is a real agent, and the places are held only until the sockets holding them time out.

The address is the connection's TCP peer, or the client address in `X-Forwarded-For` when `TRUST_PROXY` is on. **With `TRUST_PROXY` off, a reverse proxy or tunnel in front of MiniBox makes every client share one address, and therefore one 8-socket limit.** If real agents are refused with `agent_pending_limit` behind such a proxy, turn `TRUST_PROXY` on (only behind a proxy you control that overwrites the header), or connect the agents directly.

A socket that has not sent its hello yet may not send a frame larger than 4 KiB; one that does is closed with `1009`. A hello is a few hundred bytes, so no real handshake is affected. The length is checked before the frame is parsed, so a large frame costs no parsing, but the server has received it by then: what bounds that is the 16 MiB every MiniBox socket may send, which is also the limit after the hello. A frame that size from each of the 64 sockets that may be waiting is about a gigabyte of memory for as long as it takes to close them. A one-shot log read returns at most 2 MiB of text: the newest whole lines, after a line that says how many bytes of older output were left out. Follow the log stream to see everything.

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

A refusal before the upgrade is an HTTP status, not a close code: `429` with `agent_pending_limit` or `agent_pending_total_limit` means a pending limit was reached, and the agent logs it as `agent.saturated` and retries. The agent logs every close once, from its code: `agent.saturated` for `4411`, `agent.closed` at info for a normal `1000`/`1001`, such as a server restart, and `agent.disconnected` for any other, so a log line tells a saturation apart from a network drop (`1006`). A refusal is the exception: `4401`, `4403` and `4426` come after a `refused` frame, which the agent logs as `agent.refused` with its code (`auth_failed`, `revoked` or `protocol_mismatch`), and the close that follows is not logged again. When the agent gives up itself, because dialing took longer than 30 seconds or the hello was not answered in 5, it logs `agent.connect_timeout` or `agent.hello_timeout` before it closes the socket, since that close carries no code of its own.

## Protocol version

The agent and MiniBox exchange a protocol version, currently `1`. When they differ, MiniBox refuses the agent with code `4426`, and the host shows **Agent needs an upgrade**. Pull the latest image and recreate the container with the same data volume.

## Operations

An agent runs only the operations listed here, against its own Docker engine. A request for any other operation fails with an `invalid` error.

- **Containers:** list, inspect, create, start, stop, restart, pause, unpause, remove, rename and update limits, including CPU, memory, swap, process count and restart policy. Read logs, stats and filesystem diffs.
- **Exec:** start a process in a container, then resize, inspect or kill it. Its output streams back to MiniBox.
- **Images:** list, inspect and pull.
- **Volumes:** list, inspect, create and remove. Set the root owner of a volume.
- **Networks:** list, ensure a bridge network, remove one, connect or reattach a container to one, and keep new connections from MiniBox's networks out of the host.
- **Events:** follow the container logs and the Docker event stream.

Every operation that names a container, a volume or a network works only on what is MiniBox's, as the next section says.

Create requests are checked against a strict schema. Bind mounts are refused, so volumes are named only. The host network is refused. Added capabilities are limited to Docker's default set, so a container cannot be given `SYS_ADMIN`, `SYS_MODULE` or any other capability beyond it, and there is no privileged mode or device access. Any option outside the schema is refused.

These operations are refused with an `unsupported` error and never run: commit a container, put or get an archive, stat a path, remove, save, load or build an image, run a helper container, and read the engine's disk usage, either the host filesystem's (`diskUsage`) or what the engine itself holds (`diskBreakdown`, which is what `docker system df` reports).

A box therefore cannot be moved to or from an agent host, by either the direct path or the checkpoint path: both need an image, an archive or a helper container, and the checkpoint path additionally reads the owner of every volume it restores. MiniBox answers `501 unsupported` with `move_agent_unsupported` before the move starts. Create the box on the agent host instead.

Failures are reported with one of these kinds: `not_found`, `conflict`, `invalid`, `unsupported`, `unavailable`, `engine` and `aborted`.

## What the agent manages

The engine on an agent host is often shared with other things: containers you run yourself, other tools, another MiniBox. A MiniBox that has been taken over must not be able to stop, read, mount or remove any of them. So the agent works only on **MiniBox resources**: the containers, volumes and networks that carry the label `minibox-agent.host`, with the id of this agent's host as the value.

The agent writes that label on everything it creates, in place of a label of that name in the request, and it decides what is MiniBox's from what the engine says about the resource, never from what a request claims. An engine does not change the labels of something that exists, so a container that was there before cannot become MiniBox's by being named in a request. The key is fixed and does not follow `LABEL_PREFIX`, and the host id in the value keeps another MiniBox on the same engine out of reach. Anything that is not MiniBox's is answered `not_found`, as if it were not there, and nothing is done to it:

- **Containers.** A container that is not MiniBox's cannot be inspected, started, stopped, restarted, paused, renamed, updated or removed. Its logs, stats, filesystem diff and environment cannot be read, and no command can be run in it. The agent asks the engine what a name or an id refers to before it acts, and acts on the id the engine gave.
- **Volumes.** A volume that is not MiniBox's cannot be inspected, removed or have its owner set, and no box can mount it. A box that mounts a volume that does not exist is refused too, because the engine would make that volume on the spot, with no label. Creating a volume under a name that a volume which is not MiniBox's already holds is a `conflict`.
- **Networks.** A network that is not MiniBox's cannot be removed, joined or re-attached, and no box can be created on it. A box is put on one of MiniBox's networks and never on the engine's default `bridge`, which whatever else runs on the machine is on too, so a request that names no network is refused as well. Ensuring a network under a name that another network holds is a `conflict`.
- **The host's firewall rule.** The rule that keeps new connections from boxes out of the host is set only for MiniBox's own networks, and in the chain of the MiniBox the agent serves: a request that names another owner is refused, so a MiniBox that has been taken over cannot replace or remove the rule of another install on the same machine. An agent paired by a control plane that did not name its prefix, and one welcomed by a control plane that names none, leave the owner as the control plane gives it.
- **Lists and events.** The lists of containers, volumes and networks hold only what is MiniBox's, and the event stream carries only the events of MiniBox's containers. MiniBox therefore picks the private subnet of a new box without seeing the other networks on the engine, so it can overlap one of them. The engine refuses an overlapping subnet by itself, and the box is not created.
- **The agent itself.** The container the agent runs in, and every volume mounted into it, including the one that holds its key, are never managed and are in no list or event, whatever labels they carry. The agent finds its own container from its mount table, then from its hostname. An engine that cannot answer fails the request, and the agent asks again next time; an agent that is not in a container the engine knows goes by labels alone.
- **Images** are not scoped. The engine keeps one copy of an image for everything that uses it, so the agent lists, inspects and pulls images as before. A MiniBox that has been taken over can therefore read the metadata of any image on the engine, including environment variables baked into it, and can make the agent pull an image.
- **Runtimes.** A box may ask for the container runtime `runc` and for no other, unless you allow it. `AGENT_ALLOWED_RUNTIMES=runsc` lets boxes on this machine use gVisor, which is what `RUNTIME=runsc` on MiniBox asks for. A box that asks for another runtime is refused with an `invalid` error that names this setting.

## Remove, revoke, upgrade and re-pair

In the console, an agent host has only **Remove**. Removing it revokes the agent first: the agent is disconnected at once, is blocked from reconnecting, and MiniBox forgets its record. A host that still holds boxes, volumes or checkpoints cannot be removed. The host's shared tools volumes, one for each storage pool, do not count: MiniBox deletes them on the machine, through the agent, before it revokes the agent and forgets the host, and deletes nothing else there. If the agent is connected and the machine refuses the delete, the removal stops with that error and changes nothing: the agent stays connected and the host stays listed, so you can try again. If the agent is not connected, because the machine is off or lost or the agent was revoked, nothing can be deleted through it: the removal goes on, the log line `host.tools_volume_left` names the volumes that stay on the machine, and you delete them there with `docker volume rm` if you use it again. To cut off its agent at once anyway, call `POST /api/hosts/{id}/revoke`. A removed or revoked agent keeps running idle until its container is removed.

To upgrade, pull the newer image, remove the old container and run the command again with the same data volume. The agent keeps its identity, so the host and its boxes stay the same. If the boxes on this machine use another container runtime than `runc`, add `-e AGENT_ALLOWED_RUNTIMES=<runtime>`, or new boxes are refused:

```sh
docker pull ghcr.io/arnochenfx/minibox-agent
docker rm -f <container id>
docker run -d --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v minibox-agent:/data \
  ghcr.io/arnochenfx/minibox-agent --server https://minibox.example.com
```

To put the machine back in use, remove its host first if it is still listed. Then create a new pairing code, and run the command with a new data volume, such as `-v minibox-agent-2:/data`. The old volume still holds the revoked identity.

## Security

Mounting `/var/run/docker.sock` gives the agent control of that machine's Docker engine. The agent limits itself to what is MiniBox's, as [above](#what-the-agent-manages), and refuses bind mounts, the host network, privileged mode and devices, so a MiniBox that has been taken over reaches what its own boxes reach, the images on the engine (to read, and to pull) and the host's ingress rule for its own networks, and no further. The limit is the agent's own code, though: whoever can run code inside the agent's container, or on the machine, still controls every container on it. Run agents only on machines you control. Remove the host of an agent you no longer trust, or revoke the agent through the REST API while its host still holds boxes.

The activity log records creating a pairing code, revoking an agent and removing a host. The server log records each accepted connection and each disconnection with its reason.
