# 网络出站

网络出站指 Box 可以访问宿主机之外的哪些地址。每个 Box 都有三种档位之一：`open`（默认）是 Box 一直以来的行为；`none` 切断 Box 的对外路由；`proxy-only` 只允许 Box 访问白名单中的主机，且所有连接都经由 MiniBox 的代理，并被记录下来。

档位只限制 Box 的对外连接。exec、SSH 与端口预览在各个档位下都可以访问 Box。

## 档位

| 档位 | Box 可以访问 | Box 不能访问 |
|---|---|---|
| `open`（默认） | 与普通容器一样可以访问互联网。宿主机桥接网关上的服务，除非开启了 [`BLOCK_HOST_GATEWAY`](#宿主机网关)。 | 不做任何限制。 |
| `none` | 仅 Box 自身。Box 位于一个没有对外路由的私有网络中。 | 互联网，以及宿主机上的服务。 |
| `proxy-only` | 白名单中的主机，仅限 80 与 443 端口，并且经由 MiniBox 的代理。 | 其他所有主机与端口，以及直接连接。 |

## 设置档位

- **创建对话框**：打开**高级**，选择**网络出站**：**开放**、**无**或**仅代理**。选择**仅代理**时，会出现预设与**额外允许的主机**输入框。
- **命令行**：`minibox box create <name> --egress none`。使用 `--egress proxy-only` 时，可以再加上 `--egress-preset 名称` 与 `--egress-domain 主机`，按需重复。预设与域名只适用于 `proxy-only`。
- **API 与 MCP**：在 `POST /api/boxes` 中传入 `egress` 对象，或使用 `create_box` 工具：

  ```json
  { "egress": { "mode": "proxy-only", "presets": ["agent-default"], "domains": ["example.com"] } }
  ```

Box 的**设置**标签页中，**安全**一组会显示档位、`proxy-only` Box 的允许主机，以及最近被拒绝的连接。其中的**编辑**按钮可以更改档位、预设与额外主机；保存会先暂存，只有你在设置上方的横幅中应用暂存变更时才会重建 Box。见[暂存更改并重建](../user-guide/boxes.md#暂存更改并重建)。

要通过 API 更改已有 Box 的档位，可向 `POST /api/boxes/{id}/rebuild` 发送带 `egress` 的请求，或调用 `rebuild_box` 工具。更改档位即是重建。未确认时，调用会返回这次更改的预览，只有带上 `confirm: true` 确认后才会执行重建。Box 保留名称、ID 与卷，容器与可写层则是新的。若新档位仍是私有网络，Box 会保留原有的私有子网。若想改为暂存，可向 `PUT /api/boxes/{id}/staged` 发送同样的 `egress` 对象，再用 `POST /api/boxes/{id}/staged/apply` 应用。

## 仅代理

### 白名单

主机即一个域名，例如 `pypi.org`。`*.example.com` 允许 `example.com` 的所有子域名，但不包括 `example.com` 本身。IP 地址与单标签名称（例如 `localhost`）会被拒绝。白名单最多包含 100 个主机，预设中的主机也计算在内。

预设如下：

| 预设 | 主机 |
|---|---|
| `agent-default` | `api.anthropic.com`、`api.openai.com`、`auth.openai.com`、`chatgpt.com`、`generativelanguage.googleapis.com`、`api2.cursor.sh` |
| `package-registries` | `registry.npmjs.org`、`registry.yarnpkg.com`、`pypi.org`、`files.pythonhosted.org`、`crates.io`、`index.crates.io`、`static.crates.io`、`proxy.golang.org`、`sum.golang.org`、`rubygems.org`、`repo.maven.apache.org`、`repo1.maven.org`、`deb.debian.org`、`security.debian.org` |

### 一次连接如何通过

1. MiniBox 在 Box 中把 `HTTP_PROXY` 与 `HTTPS_PROXY` 设为 `http://minibox-proxy:3128`。Box 唯一的路由就是这个代理。
2. 代理检查主机是否在白名单中。只允许 80 端口（明文 HTTP）与 443 端口（HTTPS，经由 `CONNECT`）。
3. 代理通过 IPv4 解析主机。若主机的地址全部是内网、回环、链路本地、共享或保留地址，则予以拒绝。
4. 代理连接到它解析出的地址并转发字节，不读取内容。

### 事件

代理为每一次连接记录一条事件：

- `egress.allowed`：主机、端口、协议、收发字节数与耗时。
- `egress.denied`：主机、端口与原因。原因包括：`not_allowed`（主机不在白名单中）、`port`（端口不是 80 或 443）、`dns_failed`（名称没有 IPv4 地址）与 `private_address`（名称只解析到被拒绝的地址）。
- `egress.failed`：主机、端口与原因 `upstream`，表示连接主机失败。

代理从不记录路径、查询字符串、请求头或内容。允许与失败的事件属于活动记录，保留 `EVENT_RETENTION_ACTIVITY_DAYS` 指定的天数（默认 30 天）。被拒绝的连接属于审计事件，保留 `EVENT_RETENTION_AUDIT_DAYS` 指定的天数（默认 365 天）。安装软件包会产生大量连接，每次连接都是一条事件。

Box 设置中**安全**一组的**网络出站**卡片列出最近被拒绝的连接，活动列表中有**出站**筛选。

## 宿主机网关

默认网络上的 Box 可以通过桥接网关访问宿主机监听的服务。要阻止这种访问，请在 `.env` 中设置 `BLOCK_HOST_GATEWAY=true`。见[配置（英文）](../../reference/configuration.md#boxes)。MiniBox 在启动时应用此规则，每次 Box 启动时也会再次应用。

`none` 与 `proxy-only` 档位的 Box 始终与宿主机隔离，与 `BLOCK_HOST_GATEWAY` 的设置无关。

该规则是宿主机防火墙中 `MINIBOX-EGRESS-<hash>` 链里的一条规则，`INPUT` 链会跳转到它。每个安装有自己的链，以其 `LABEL_PREFIX` 的哈希命名，因此同一宿主机上的多个安装互不影响对方的规则。规则由一个辅助容器设置，该容器使用 `alpine:3.20` 镜像，运行在宿主机网络上并具有 `NET_ADMIN` 能力。MiniBox 在第一次需要时拉取该镜像。若规则无法设置，需要该规则的 Box 将无法启动。

## 远程宿主机

运行在[远程宿主机](../user-guide/hosts.md)上的 Box 使用相同的档位。代理、私有网络与防火墙规则都在运行该 Box 的宿主机的引擎上创建。该宿主机同样需要基础模板镜像，供其代理使用。档位不是 `open` 的 Box 无法迁移到其他宿主机，因为它的网络与代理属于运行它的宿主机。

## 限制

这些档位不是防御刻意绕过的完整沙箱。它们阻止普通连接，并记录通过的连接。以下限制仍然适用。

- **按名称，而非按内容。** 白名单检查客户端请求的主机。对于 HTTPS，代理把加密连接转发到该名称解析出的地址，并不读取其中的服务器名称。与白名单主机共享地址的其他主机（例如位于同一 CDN 之后的主机），可能因此被访问。
- **允许的主机也能携带数据。** 没有任何机制阻止 Box 向白名单中的主机发送数据，例如向白名单允许的代码仓库推送内容。白名单限制的是流量能去往哪里，而不是流量携带什么。
- **仅 TCP 的两个端口。** 80 与 443 可以使用。SSH、经由 SSH 的 git、其他端口以及 UDP（包括 QUIC）都不能使用，依赖它们的工具会失败。
- **仅 IPv4。** 没有 IPv4 地址的主机无法通过代理访问。
- **客户端必须使用代理。** 忽略 `HTTP_PROXY` 与 `HTTPS_PROXY` 的程序无法建立连接。Box 没有其他路由，因此连接会失败，而不会绕过代理。
- **由代理解析名称。** Box 的 DNS 设置不会决定它能访问什么。
- **宿主机上必须有基础模板。** 代理基于它运行，因此没有它，`proxy-only` Box 无法启动。每个代理的内存上限为 256 MB。
- **端口预览需要通往 Box 的路由。** 预览连接的是 Box 在其网络上的地址，因此 MiniBox 必须能够路由到该网络，这对任何 Box 都一样。exec 与 SSH 不依赖这一点。
- **私有网络使用 `240.0.0.0/12`。** `none` 与 `proxy-only` 的 Box 私有网络取自这一保留地址段，因此不会与常见的私有地址段冲突。
- **需要 Docker Engine 26.0 或更高版本。** 更早的引擎会把内部网络的 DNS 查询转发给宿主机的解析器（CVE-2024-29018），`none` 的 Box 因而可经 DNS 向外发送数据。25.0.5 与 23.0.11 也包含该修复。

## 允许的主机超时

若允许的主机超时，且代理记录了 `upstream`，请检查宿主机的 `FORWARD` 策略。残留的 `iptables-legacy` 表若设置了 `-P FORWARD DROP`，会静默丢弃 Docker 自身规则允许的流量。使用 `sudo iptables-legacy -S FORWARD` 查看。只放行代理的上行网络：`sudo iptables-legacy -I FORWARD -i br-<id> -j ACCEPT`，并加一条对应的 `-o br-<id> -m conntrack --ctstate RELATED,ESTABLISHED` 规则，其中 `br-<id>` 是 `<prefix>-egress-uplink` 网络的网桥。或删除残留的旧规则。

## 试一试

```bash
minibox box create offline --egress none
minibox exec offline -- curl -sS -m 5 https://example.com/   # 失败：没有对外路由

minibox box create agent --egress proxy-only --egress-domain example.com
minibox exec agent -- curl -sS -m 8 -o /dev/null -w '%{http_code}\n' https://example.com/   # 输出 200
minibox exec agent -- curl -sS -m 8 -o /dev/null https://example.org/   # 被拒绝；egress.denied 事件会记录它
```
