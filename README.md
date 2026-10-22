<p align="center">
  <img src="web/assets/logo-readme.svg" alt="MiniBox" height="56" />
</p>

<p align="center"><strong>A personal, self-hosted workspace for AI agents, built on Docker.</strong></p>

<p align="center">
  <a href="https://github.com/ArnoChenFx/minibox/actions/workflows/ci.yml"><img src="https://github.com/ArnoChenFx/minibox/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4.3-f9f1e1?logo=bun&amp;logoColor=black" alt="Runtime: Bun ≥ 1.4.3" /></a>
  <img src="https://img.shields.io/badge/sandbox-Docker-2496ED?logo=docker&amp;logoColor=white" alt="Sandbox: Docker" />
</p>

<p align="center"><b>English</b> | <a href="README-zh.md">简体中文</a></p>

![The MiniBox overview page](docs/screenshots/overview-light.png)

## What is MiniBox?

MiniBox runs isolated **boxes** on your own machine. A box is a long-running Docker container with its own filesystem and processes, and a persistent `/workspace` volume. You create, start, inspect and delete boxes from a web console, a REST API, a command-line tool, or MCP. AI coding agents such as Claude Code, Codex and OpenCode work inside a box, so their installs, builds and background processes stay off your host.

MiniBox is a single Bun process. It talks to Docker Engine through the Docker socket and needs no database server. Images and volumes live in Docker. Box specs, access keys, agent tokens and the event log live in a data directory on the host.

## Who it is for

- Developers who run coding agents and want a clean, reproducible workspace for each task.
- People who want their own hardware and network, rather than a per-minute hosted sandbox.
- Anyone who wants box data on a NAS or NFS server.

MiniBox is built for one trusted user. It has no user accounts, so anyone with the access key controls the server. Read the [security guide](docs/admin/security.md) before you expose it.

## Key capabilities

- **Boxes.** Create, start, stop, restart and delete boxes, and change their CPU and memory limits. Commands run as the non-root `dev` user by default. Idle boxes can sleep and wake on demand.
- **Storage.** Keep `/workspace` and `/home/dev` across rebuilds. Use Docker volumes, NFS exports or host paths as storage pools. Browse, upload and download a box's files from its **Files** tab, whether the box is running or stopped.
- **Templates.** Start new boxes from the bundled base template (Debian 12, Node.js 26, Python 3, git and tmux) or from a template you save from a box.
- **Checkpoints.** Copy a box's data into a restic repository, then fork a new box from it or roll the box back. Export a checkpoint as a passphrase-sealed package, import it on this or another instance, and schedule checkpoints.
- **Tools.** Install Agent CLIs and language runtimes from a catalog, or add your own entries.
- **Terminals and sessions.** Open a browser terminal, or let an agent drive a tmux session that you can take over.
- **Previews.** Open a web app that runs in a box, through MiniBox, without publishing a host port.
- **Agent access.** Give each agent its own scoped token, and connect it through MCP, the CLI, SSH or the REST API.
- **Multiple hosts.** Run boxes on other Docker engines, through SSH, mutual TLS or a Unix socket. Let MiniBox place a box on the freest host, and move a box to another host with its volumes.

![The boxes list in the MiniBox console](docs/screenshots/boxes-light.png)

## Install

Run the release image on a Linux machine with Docker:

```bash
docker run -d --name minibox --restart unless-stopped \
  -p 127.0.0.1:3920:3920 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v minibox-data:/data \
  ghcr.io/arnochenfx/minibox:latest
```

Read the generated access key, then open <http://127.0.0.1:3920> and sign in with it:

```bash
docker exec minibox cat /data/access_key
```

The [quick start](docs/quick-start.md) walks you through the first box.

## Documentation

| Guide | What it covers |
|---|---|
| [Quick start](docs/quick-start.md) | Install, sign in, build the base template and create your first box |
| [User guide](docs/user-guide/boxes.md) | Boxes, templates, checkpoints, tools, storage, terminals, agents and hosts |
| [Administration](docs/admin/install.md) | Installing, configuring, remote access, backups, upgrades and security |
| [Reference](docs/reference/api.md) | The REST API, the CLI, MCP tools and configuration keys |
| [Architecture](docs/architecture.md) | How the server, the console, the agents and Docker fit together |
| [Development](docs/development.md) | Building, testing and contributing |

The [documentation index](docs/README.md) lists every page. Chinese documents are in [`docs/zh-CN`](docs/zh-CN/README.md).

## Requirements

- A Linux host with Docker Engine. MiniBox reads `/proc` for host metrics.
- For a source install, [Bun](https://bun.sh) 1.4.3 or later.

## License

Apache-2.0. Copyright © 2026 Arno Chen. See [LICENSE](LICENSE).

Third-party components retain their own licenses; see [NOTICE](NOTICE).
