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

The box's **Settings** tab, under **Security**, shows the tier, the allowed hosts of a `proxy-only` box, and its recent denials. Its **Edit** button changes the tier, the presets and the extra hosts; saving stages them, so the box is rebuilt only when you apply the staged changes from the banner above the settings. See [Stage a change and rebuild](../user-guide/boxes.md#stage-a-change-and-rebuild).

To change the tier of an existing box over the API, send an `egress` object to `POST /api/boxes/{id}/rebuild`, or call the `rebuild_box` tool. A change of tier is a rebuild. Without confirmation, the call returns a preview of the change, and the rebuild runs only when you confirm it with `confirm: true`. The box keeps its name, its ID and its volumes. Its container and its writable layer are new. A box keeps its private subnet when the new tier is still private. To stage the change instead, `PUT /api/boxes/{id}/staged` with the same `egress` object and apply it with `POST /api/boxes/{id}/staged/apply`.

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
3. The proxy resolves the host over IPv4. It refuses a host whose addresses are all private, loopback, link-local, shared or reserved, unless the address falls in a range named in [`EGRESS_ALLOW_RANGES`](#fake-ip-dns-proxies).
4. The proxy connects to the address it resolved and relays the bytes. It does not read the content.

### Fake-IP DNS proxies

A DNS proxy in fake-IP mode, such as Clash, Surge or sing-box, answers every name with an address from a range it keeps for itself, and takes the real connection when a client connects to that address. Clash answers from `198.18.0.1/16` by default, and `198.18.0.0/15` is common. When the host runs one of these for its own traffic, the egress proxy resolves an allowlisted name to an address in that range, refuses it as a private address, and the box's denial says `private_address` even though the host is allowed.

`EGRESS_ALLOW_RANGES` names the range to let through. It is one setting for the whole MiniBox instance, in `.env`, and it applies to every host, including the proxies of boxes on remote hosts:

```dotenv
EGRESS_ALLOW_RANGES=198.18.0.0/15
```

Entries are IPv4 addresses or networks, separated by commas. An address with no `/n` is one host, `/32`. Host bits are cleared, so Clash's `198.18.0.1/16` is accepted and becomes `198.18.0.0/16`. The prefix must be from 8 to 32; a shorter one would open more than 16 million addresses with a single entry. Repeats are dropped and the list is sorted by address. Leave it empty, the default, and the proxy refuses private addresses exactly as it did before.

These ranges never pass, whatever this setting says, and an entry that overlaps one of them stops startup:

| Range | Why it stays refused |
|---|---|
| `0.0.0.0/8` | This host. |
| `127.0.0.0/8` | Loopback. |
| `169.254.0.0/16` | Link-local, which holds the cloud metadata address. |
| `224.0.0.0/3` | Multicast and reserved. |

A value that reads as anything else, such as an IPv6 network or a typo, also stops startup. The error names the variable and the entry, so a mistake cannot quietly open a range the operator did not mean. For example:

```
EGRESS_ALLOW_RANGES: “198.18.0.1/7” is wider than /8; name the fake-IP range with a prefix from 8 to 32
EGRESS_ALLOW_RANGES: “169.254.169.254” overlaps 169.254.0.0/16, which stays refused (this host, loopback, link-local and multicast or reserved addresses are never reached)
```

`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and `100.64.0.0/10` are accepted, because an operator can mean them. **Be careful:** a host on the allowlist that resolves into one of those ranges is then reached from the proxy, which runs on the host's network. Naming `10.0.0.0/8` or `192.168.0.0/16` lets a `proxy-only` box reach the devices on your LAN, and `100.64.0.0/10` does the same for a Tailnet, as far as the allowlist and ports 80 and 443 reach. Name the fake-IP range only, and nothing wider.

The proxy reaches the fake addresses itself, so the fake-IP proxy must also be the one that takes the proxy container's traffic (a TUN device or a redirect on the host). If it is not, the connection fails and the event is `egress.failed … upstream`, not `private_address`.

### When a change takes effect

The ranges reach a proxy when it is created: when a `proxy-only` box is created, started, restarted or rebuilt. A proxy that is already running keeps the settings it was created with, so a change never interrupts a connection in progress. Restarting MiniBox does not replace the proxies of boxes that are already running: reconciliation starts the boxes that should run, follows the logs of the proxies that do, and leaves them as they are. To apply a change to such a box, start it again with `POST /api/boxes/{id}/start`: a start of a running box leaves its container alone and replaces the proxy. A restart or rebuild picks the setting up too, and restarts the box.

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

A host reached through an [agent](../reference/agent.md) does not run the forwarding check: an agent runs no helper containers, so there is no way to read its engine's `FORWARD` rules from here, and the check is skipped with that reason, logged once as `egress.forward_skipped`. Its `proxy-only` boxes have the same dependency on Docker's forwarding, so a `proxy-only` box that loses the internet there is still found the same way, in the proxy's `egress.failed … upstream` events, and fixed with the manual commands below on that machine. Every other host — local, socket, TCP and SSH — runs the check.

## Limits

These tiers are not a full sandbox against code that is written to get around them. They stop ordinary connections, and they record the ones that pass. The limits below still apply.

- **Names, not content.** The allowlist checks the host that a client asks for. For HTTPS, the proxy relays an encrypted connection to the address that the name resolves to, and it does not read the server name inside. A host that shares an address with an allowed host, such as one behind the same CDN, can be reached through that allowance.
- **An allowed host can carry data.** Nothing stops a box from sending data to a host on its allowlist, for example by pushing to a repository on an allowed host. The allowlist limits where traffic can go, not what it carries.
- **Two TCP ports.** Ports 80 and 443 work. SSH, git over SSH, other ports and UDP, including QUIC, do not. A tool that needs them fails.
- **IPv4 only.** A host with no IPv4 address cannot be reached through the proxy.
- **Clients must use the proxy.** A program that ignores `HTTP_PROXY` and `HTTPS_PROXY` gets no connection. The box has no other route, so the connection fails instead of going around the proxy.
- **The proxy resolves names.** The box's DNS settings do not decide what it can reach.
- **The proxy runs from the base template.** MiniBox builds it on the host when it is missing. A host reached through an agent cannot build it, so a `proxy-only` box there does not start until the template is copied to it. Each proxy is capped at 256 MB of memory.
- **Port previews need a route to the box.** A preview connects to the box's address on its network, so MiniBox must be able to route to that network, as it must for any box. Exec and SSH do not depend on this.
- **Private networks use `240.0.0.0/12`.** The private networks of `none` and `proxy-only` boxes are taken from this reserved range, so they stay clear of the usual private ranges.
- **Docker Engine 26.0 or later.** Older engines forward DNS queries from internal networks to the host's resolvers (CVE-2024-29018), which lets a `none` box send data out through DNS. 25.0.5 and 23.0.11 carry the fix too.

## When a `proxy-only` box has no internet

A `proxy-only` box has no route out of its own network. Its only peer is the egress proxy, which sits on the `<prefix>-egress-uplink` bridge and reaches the internet through the host's `FORWARD` chain. MiniBox never writes that rule: it relies on Docker's own. So when a host's `FORWARD` policy is `DROP`, or a leftover `iptables-legacy` table drops the traffic, or something reloads the firewall while MiniBox runs, every `proxy-only` box on that host silently loses the internet. The box still starts, `exec` and SSH still work, and the proxy log only says `egress.failed … upstream`, which reads like the destination being down.

MiniBox checks for this every ten minutes (`EGRESS_FORWARD_CHECK_INTERVAL_SEC`, between 60 and 86400 seconds, see [Configuration](../reference/configuration.md#boxes)), soon after it starts, when a `proxy-only` box starts and when a host comes back online. The check runs a short-lived helper container with `NET_ADMIN` on the host network and reads `iptables -S` there, so it costs a container start and nothing on the host changes. A host with no `proxy-only` box is not read at all, and every host with proxy-only boxes is read on every pass, because a firewall reload can remove the rule while nobody is looking. The helper runs in `alpine:3.20` with the iptables binaries added, an image MiniBox builds on each host the first time it needs it (`<prefix>-host-firewall:alpine3.20`), so a pass downloads nothing. Once the image is seven days old it is built again at the next check, from a fresh Alpine and without the build cache, so the iptables in it follows Alpine's updates; the image it replaces is removed. A host that cannot build it falls back to plain Alpine, or keeps the image it has, and tries the build again an hour later. A host that cannot be read, because it is offline or has no internet for that build, is logged when it starts failing (`egress.forward_pass_failed`) and again for each different error that follows before it can be read, but not for an error the log already has; one line says when it can be read again (`egress.forward_pass_recovered`). A host where one of the two backends could not be read counts as unread too when the other lets the uplink through, because the table nobody looked at may be the one that drops; a drop found on the readable one is still reported, with no button. An offline host is not read at all until it comes back.

When the rules drop the uplink, **Needs attention** on the overview shows **Proxy-only boxes have no internet**, naming the host, the number of `proxy-only` boxes it affects and the bridge. One `error` line goes to MiniBox's log at the same moment (`egress.forward_blocked`), and no line repeats while the condition stays, so a headless operator sees it once. A pass that finds the rules right again logs `egress.forward_restored` and clears the item.

### What the check proves, and what it does not

The check reads what the host's `FORWARD` chain would do with a **new TCP connection** that arrives on the uplink bridge and leaves through the host's default route. It follows Docker's own chains to the rule that decides, and it reads what the `iptables` command shows (on a modern host the nft-backed one, which lists only rules written through iptables; see the last section) and `iptables-legacy` when that table already exists — reading it does not create it — because a stale legacy table is exactly one of the ways this breaks. So:

- It proves that a `proxy-only` box on that host cannot reach the outside **because of the host's forwarding rules**. That is the failure the warning is about, and it is one MiniBox can fix.
- It does **not** prove that the internet is reachable. A host whose rules are right but whose uplink cannot resolve or route is not reported: the proxy's `egress.failed … upstream` events are the place to look for that, and it is not something a `FORWARD` rule would fix.
- It says nothing about `open` boxes, which use the default network and Docker's usual rules. They are unaffected by the condition and by the fix.
- It reads the rules, not the traffic. A connection that was already established when the rule changed keeps its conntrack entry until it closes, so a box can appear to work for a moment after the warning appears.

### Fix it

Under the item, a line says which of the cases below it is and what to do about it, in full. The item has an **Add the rule** button, but **only when the drop is a chain falling off its end and taking its policy** (`cause: "policy"`). Three other readings are reported without a button. A drop made by a `DROP` or `REJECT` rule of the host's own (`rule`): the host is doing what it was told, and MiniBox's rule would undo that decision. A reading that left a rule MiniBox cannot evaluate (no cause). And a policy drop that a `RETURN`, or a `-g` that sends the uplink's traffic to another chain for good, reaches first (`unreachable`): the walk ends there, so a rule appended at the end of `FORWARD` would never be reached, and the allowance has to go into that chain or above that rule, by hand.

The button opens a confirmation that names the host and the bridge, and **nothing is written until you confirm**. After you confirm, MiniBox runs one short-lived helper on the host and adds its own chain, `MINIBOX-FWD-<hash>`, with the jump **appended at the end of `FORWARD`**. Appending rather than inserting at the top is deliberate: Docker's own isolation chains and anything you put in `DOCKER-USER` have already decided before the packet reaches MiniBox's rule, so they still win. The chain accepts new connections that arrive on the uplink bridge and leave through the host's default route, and the replies that come back into it; other bridge interfaces are not allowed by this rule; destination restrictions on the default-route interface still require explicit rules above the jump. Nothing else on the host's firewall changes: the `FORWARD` policy stays as it is, and other installs' chains are left alone. When this install no longer needs the rule — the last `proxy-only` box is deleted, or the host is removed — MiniBox removes it. It remembers that it added the rule only while it runs: after a restart it does not know about a rule it added before, and will not remove it, and shutting MiniBox down removes nothing. A removal that fails, because the host cannot be reached at that moment, is tried again at the next check for as long as MiniBox runs. To remove one by hand, find the chain in `sudo iptables -S` (`MINIBOX-FWD-<hash>`), then run `sudo iptables -D FORWARD -j <chain>`, `sudo iptables -F <chain>` and `sudo iptables -X <chain>`, with `iptables-legacy` for a legacy table. A host with no IPv4 default route refuses the repair, since there is no interface to allow.

That is one click, and the same thing over the API is one call:

```bash
curl -sS -X POST -H "Authorization: Bearer $MINIBOX_KEY" https://minibox.example.com/api/hosts/local/forward
```

The item stays until the next check finds the rules right, so a repair that did not work is still visible. This is the path to prefer.

Doing it by hand is fiddly, and the docs say so rather than pretending otherwise: you have to find the bridge name, decide which iptables backend the host actually uses, and get the two rules right. It is worth it only if you would rather not let MiniBox touch the host's firewall at all. The bridge is `br-` and the first 12 characters of the `<prefix>-egress-uplink` network's id, or the name the network was created with:

```bash
docker network inspect minibox-egress-uplink --format '{{.Id}}'
# br-<first 12 characters of that id>
sudo iptables -S FORWARD        # the nft-backed command on a modern host
sudo iptables-legacy -S FORWARD # a leftover legacy table, if this prints rules
```

Then, for each backend that has a `FORWARD` chain (run both blocks if both print rules), allow the uplink only:

```bash
BR=br-1a2b3c4d5e6f   # the bridge from above
OUT=eth0             # the host's default-route interface: ip -4 route show default
sudo iptables -A FORWARD -i "$BR" -o "$OUT" -j ACCEPT
sudo iptables -A FORWARD -i "$OUT" -o "$BR" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
```

Both rules are appended, like MiniBox's own jump, so whatever is above them in `FORWARD` still decides first, and each names both interfaces, so neither allows more than the uplink. Use `iptables-legacy` in place of `iptables` for the legacy table. These rules are not persisted by MiniBox: a reboot or a firewall reload removes them, and the next check reports the condition again. If you would rather undo a stale legacy table than add rules to it, remove the `DROP` policy or the rules that cause it, which is the other hand-written path, and MiniBox's check then finds the rules right by itself.

### What the check does not cover

These are the reading's blind spots. Most only hide a real break; the nftables one can also raise a warning that MiniBox's rule cannot clear:

- **IPv6.** Only IPv4 rules are read, and a `proxy-only` box's proxy reaches the internet over IPv4 today, so this is not the failure the warning is about. A host that allows IPv4 and blocks IPv6 is not reported.
- **Rules it cannot read.** A rule whose match the check does not evaluate (`-m set`, `-m mark`, a port range) is neither an acceptance nor a drop. One that accepts changes nothing when a rule the check can read accepts the uplink right below it, as the chain Tailscale puts above Docker's does; one that drops makes the reading unclear, reported with no button. The one case it does not see is an `ACCEPT` policy with such a rule above that drops the uplink's traffic: that host reads as forwarding.
- **A native nftables ruleset.** The check reads what the `iptables` command shows. On a modern host that command is nft-backed, but it lists only rules written through iptables, not rules written to nftables directly, as a firewalld with its `nftables` backend does, or an engine configured to write nftables rules. Such a host can read as forwarding when it is not, or, if its iptables view holds a `DROP` policy and nothing else, as dropped by policy, where **Add the rule** adds an iptables rule that does not override a native nftables drop. If the warning stays after a repair on such a host, the firewall that decides is not the one this check reads: judge it by that firewall instead.
- **Traffic that is already established.** A conntrack entry outlives the rule that allowed it, so a box can keep working for a while after the rules change.
- **Anything other than the rules.** A host whose rules are right but whose uplink cannot resolve or route is not reported here.

When the rules went missing because something reloaded the firewall, restarting the Docker daemon is another way back: Docker writes its own rules again, and the next check clears the item without MiniBox adding anything. It stops every container on the host unless `live-restore` is on, so it belongs in a maintenance window, not behind a click.

## If an allowed host times out

If an allowed host times out and the overview shows no forwarding warning, the host's rules are fine and the destination or the network in between is the problem. The proxy's `egress.failed` events name the host and the port it could not reach.

## Try it

```bash
minibox box create offline --egress none
minibox exec offline -- curl -sS -m 5 https://example.com/   # fails: no route out

minibox box create agent --egress proxy-only --egress-domain example.com
minibox exec agent -- curl -sS -m 8 -o /dev/null -w '%{http_code}\n' https://example.com/   # prints 200
minibox exec agent -- curl -sS -m 8 -o /dev/null https://example.org/   # refused; an egress.denied event records it
```
