# MiniBox documentation

[简体中文](zh-CN/README.md)

## Start here

- [Quick start](quick-start.md): install MiniBox, sign in, build the base template and run a command in your first box.

## User guide

For people who use MiniBox every day.

- [Boxes](user-guide/boxes.md): create, start, resize, rebuild and delete boxes.
- [Idle sleep and TTL](user-guide/idle-sleep.md): let idle boxes sleep, and give boxes a lifetime.
- [Port preview](user-guide/port-preview.md): open a web app running in a box.
- [Templates](user-guide/templates.md): the base template, templates you save from a box, and templates built from a Dockerfile or a repository.
- [Checkpoints](user-guide/checkpoints.md): copy a box's data, duplicate it or roll it back.
- [Tools and custom tools](user-guide/tools.md): install agent CLIs and runtimes into a box.
- [Environment variables and secrets](user-guide/environment-and-secrets.md): set variables and use host secrets.
- [Volumes and storage](user-guide/volumes-and-storage.md): volumes, storage pools and mounts.
- [Files](user-guide/files.md): browse, upload and download the files in a box's volumes.
- [NFS and NAS storage](user-guide/nfs.md): keep box data on a network file server.
- [Terminals and sessions](user-guide/terminal-and-sessions.md): browser terminals, tmux sessions and takeover.
- [SSH access and the CLI](user-guide/ssh-and-cli.md): use `ssh`, `scp` and `sftp`, and install the CLI, including on Windows.
- [Hosts](user-guide/hosts.md): run boxes on other Docker engines.
- [Access and tokens](user-guide/access-and-tokens.md): the access key, browser sessions and agent tokens.
- [Notifications](user-guide/notifications.md): send a message to a webhook, ntfy or Telegram when something needs attention.
- [Settings](user-guide/settings.md): the Settings page.
- [Connecting AI agents](user-guide/agents.md): MCP, the CLI proxy and the `AGENTS.md` snippet.

## Administration

For the person who installs and runs MiniBox.

- [Install](admin/install.md): run the release image or run from source.
- [Data directory](admin/data-directory.md): what MiniBox stores and where.
- [Remote access and TLS](admin/remote-access.md): reach MiniBox from other machines.
- [Subdomain previews](admin/preview-subdomains.md): give each port preview its own address, under a wildcard domain.
- [Upgrades](admin/upgrades.md): move to a newer release.
- [Backups](admin/backups.md): back up MiniBox while it runs, restore it, and keep copies off the host.
- [Security](admin/security.md): the trust model and the security settings.
- [Network egress](admin/network-egress.md): what a box can reach outside the host: open, none, or a proxy with an allowlist.

## Reference

- [REST API](reference/api.md): endpoints, errors and the OpenAPI document ([openapi.json](openapi.json)).
- [CLI](reference/cli.md): every command and flag.
- [MCP tools](reference/mcp.md): the MCP endpoint, toolsets and tools.
- [Configuration](reference/configuration.md): every environment variable and its default.
- [Agent](reference/agent.md): the host agent: its command, options, data volume, protocol and allowed operations.
- [MiniBox skill](../skills/minibox/SKILL.md): the agent-facing guide to driving MiniBox over MCP or the REST API.

## For developers

- [Architecture](architecture.md): the components and how a request flows through them.
- [Development](development.md): setup, checks, tests, CI and the project layout.
