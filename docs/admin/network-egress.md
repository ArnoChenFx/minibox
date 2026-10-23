# Network egress

Network egress is what a box can reach outside the host. Every box has one of three tiers. `open`, the default, is how boxes have always behaved. `none` gives the box no route out. `proxy-only` lets the box reach only the hosts on its allowlist, through a MiniBox proxy that records each connection.

The tier limits a box's outbound connections. Exec, SSH and port previews reach a box on every tier.

## Tiers

| Tier | The box reaches | The box cannot reach |
|---|---|---|
| `open` (default) | Anything on the internet, like any container. Services on the host's bridge gateway, unless [`BLOCK_HOST_GATEWAY`](#the-host-gateway) is on. | Nothing is blocked. |
| `none` | Nothing outside the box. It has a private network with no route out. | The internet, and services on the host. |
| `proxy-only` | Hosts on its allowlist, on ports 80 and 443, through MiniBox's proxy. | Every other host and port, and direct connections. |

## Set the tier

- **Create dialog:** open **Advanced** and choose **Network egress**: **Open**, **None** or **Proxy only**. Proxy only adds the presets and an **Extra allowed hosts** field.
- **CLI:** `minibox box create <name> --egress none`. With `--egress proxy-only`, add `--egress-preset NAME` and `--egress-domain HOST`, and repeat them as needed. Presets and domains apply to `proxy-only` only.
- **API and MCP:** an `egress` object on `POST /api/boxes`, or the `create_box` tool:

  ```json
  { "egress": { "mode": "proxy-only", "presets": ["agent-default"], "domains": ["example.com"] } }
  ```

The box's **Settings** tab, under **Security**, shows the tier, the allowed hosts of a `proxy-only` box, and its recent denials. The console sets the tier only when a box is created.

To change the tier of an existing box, send an `egress` object to `POST /api/boxes/{id}/rebuild`, or call the `rebuild_box` tool. A change of tier is a rebuild. Without confirmation, the call returns a preview of the change, and the rebuild runs only when you confirm it with `confirm: true`. The box keeps its name, its ID and its volumes. Its container and its writable layer are new. A box keeps its private subnet when the new tier is still private.

## Proxy only

### The allowlist

A host is a name such as `pypi.org`. `*.example.com` allows the subdomains of `example.com`, but not `example.com` itself. IP addresses and single-label names such as `localhost` are refused. The allowlist holds at most 100 hosts, presets included.

The presets are:

| Preset | Hosts |
|---|---|
| `agent-default` | `api.anthropic.com`, `api.openai.com`, `auth.openai.com`, `chatgpt.com`, `generativelanguage.googleapis.com`, `api2.cursor.sh` |
| `package-registries` | `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`, `crates.io`, `index.crates.io`, `static.crates.io`, `proxy.golang.org`, `sum.golang.org`, `rubygems.org`, `repo.maven.apache.org`, `repo1.maven.org`, `deb.debian.org`, `security.debian.org` |

### How a connection passes

1. MiniBox sets `HTTP_PROXY` and `HTTPS_PROXY` in the box to `http://minibox-proxy:3128`. The box's only route is to that proxy.
2. The proxy checks the host against the allowlist. Only port 80 (plain HTTP) and port 443 (HTTPS, through `CONNECT`) are allowed.
3. The proxy resolves the host over IPv4. It refuses a host whose addresses are all private, loopback, link-local, shared or reserved.
4. The proxy connects to the address it resolved and relays the bytes. It does not read the content.

### Events

The proxy records one event for each connection:

- `egress.allowed`: the host, the port, the scheme, the bytes sent and received, and the duration.
- `egress.denied`: the host, the port and a reason. The reasons are `not_allowed` (the host is not on the allowlist), `port` (the port is not 80 or 443), `dns_failed` (the name has no IPv4 address) and `private_address` (the name resolves only to refused addresses).
- `egress.failed`: the host, the port and the reason `upstream`, which means the connection to the host failed.

The proxy never records a path, a query string, a header or a body. Allowed and failed events are activity, kept for `EVENT_RETENTION_ACTIVITY_DAYS` (30 days by default). Denials are audit events, kept for `EVENT_RETENTION_AUDIT_DAYS` (365 days by default). A package install makes many connections, and each one is an event.

## The host gateway

A box on the default network can reach the services that the host listens on, through the bridge gateway. To stop that, set `BLOCK_HOST_GATEWAY=true` in `.env`. See [Configuration](../reference/configuration.md#boxes). MiniBox applies the block when it starts, and again whenever a box starts.

A `none` or `proxy-only` box is always kept off the host, whatever `BLOCK_HOST_GATEWAY` says.

The block is a rule in a `MINIBOX-EGRESS-<hash>` chain, which the host's `INPUT` chain jumps to. Each install has its own chain, named after a hash of its `LABEL_PREFIX`, so installs on one host leave each other's rules alone. A helper container from `alpine:3.20` sets the rules. It runs on the host network with `NET_ADMIN`, and MiniBox pulls its image the first time it is needed. A box that needs a block does not start while the rules cannot be set.

## Remote hosts

Boxes on a [remote host](../user-guide/hosts.md) use the same tiers. The proxy, the private networks and the firewall rules are made on the engine of the host that runs the box. That host needs the base template image too, for its proxy. A box that is not `open` cannot be moved to another host, because its network and proxy belong to the host it runs on.

## Limits

These tiers are not a full sandbox against code that is written to get around them. They stop ordinary connections, and they record the ones that pass. The limits below still apply.

- **Names, not content.** The allowlist checks the host that a client asks for. For HTTPS, the proxy relays an encrypted connection to the address that the name resolves to, and it does not read the server name inside. A host that shares an address with an allowed host, such as one behind the same CDN, can be reached through that allowance.
- **An allowed host can carry data.** Nothing stops a box from sending data to a host on its allowlist, for example by pushing to a repository on an allowed host. The allowlist limits where traffic can go, not what it carries.
- **Two TCP ports.** Ports 80 and 443 work. SSH, git over SSH, other ports and UDP, including QUIC, do not. A tool that needs them fails.
- **IPv4 only.** A host with no IPv4 address cannot be reached through the proxy.
- **Clients must use the proxy.** A program that ignores `HTTP_PROXY` and `HTTPS_PROXY` gets no connection. The box has no other route, so the connection fails instead of going around the proxy.
- **The proxy resolves names.** The box's DNS settings do not decide what it can reach.
- **The base template must be on the host.** The proxy runs from it, so a `proxy-only` box does not start without it. Each proxy is capped at 256 MB of memory.
- **Port previews need a route to the box.** A preview connects to the box's address on its network, so MiniBox must be able to route to that network, as it must for any box. Exec and SSH do not depend on this.
- **Private networks use `240.0.0.0/12`.** The private networks of `none` and `proxy-only` boxes are taken from this reserved range, so they stay clear of the usual private ranges.
- **Docker Engine 26.0 or later.** Older engines forward DNS queries from internal networks to the host's resolvers (CVE-2024-29018), which lets a `none` box send data out through DNS. 25.0.5 and 23.0.11 carry the fix too.

## If an allowed host times out

If an allowed host times out, and the proxy logs `upstream`, check the host's `FORWARD` policy. A leftover `iptables-legacy` table with `-P FORWARD DROP` silently drops the traffic that Docker's own rules allow. Look with `sudo iptables-legacy -S FORWARD`. Allow the proxies' uplink only, with `sudo iptables-legacy -I FORWARD -i br-<id> -j ACCEPT` and a matching `-o br-<id> -m conntrack --ctstate RELATED,ESTABLISHED` rule, where `br-<id>` is the bridge of the `<prefix>-egress-uplink` network. Or remove the stale legacy rules.

## Try it

```bash
minibox box create offline --egress none
minibox exec offline -- curl -sS -m 5 https://example.com/   # fails: no route out

minibox box create agent --egress proxy-only --egress-domain example.com
minibox exec agent -- curl -sS -m 8 -o /dev/null -w '%{http_code}\n' https://example.com/   # prints 200
minibox exec agent -- curl -sS -m 8 -o /dev/null https://example.org/   # refused; an egress.denied event records it
```
