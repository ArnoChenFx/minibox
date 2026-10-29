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

通过[代理（英文）](../../reference/agent.md)接入的宿主机不参与转发检查：代理不运行辅助容器，因此无法从这边读取其引擎的 `FORWARD` 规则，检查会带着这一原因跳过，并写一行 `egress.forward_skipped`。该宿主机上的 `proxy-only` Box 同样依赖 Docker 的转发，所以那里的 `proxy-only` Box 失去互联网时，仍然可以从代理的 `egress.failed … upstream` 事件中发现，并用下文的手动命令在那台机器上修复。其他所有宿主机（本地、socket、TCP 与 SSH）都会执行检查。

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

## 仅代理的 Box 无法上网时

`proxy-only` 的 Box 在自己的网络上没有对外路由。它唯一的对端是出站代理，代理位于 `<prefix>-egress-uplink` 网桥上，并通过宿主机的 `FORWARD` 链访问互联网。这条规则 MiniBox 从不写入，而是依赖 Docker 自己的规则。因此当宿主机的 `FORWARD` 策略为 `DROP`，或残留的 `iptables-legacy` 表丢弃了这些流量，或 MiniBox 运行期间防火墙被重新加载时，该宿主机上每个 `proxy-only` 的 Box 都会静默失去互联网。Box 仍能启动，exec 与 SSH 仍然可用，而代理日志只说 `egress.failed … upstream`，读起来像是目标主机挂了。

MiniBox 每十分钟检查一次（`EGRESS_FORWARD_CHECK_INTERVAL_SEC`，可在 60 到 86400 秒之间调整，见[配置（英文）](../../reference/configuration.md#boxes)），启动后不久也会检查，另外在 `proxy-only` 的 Box 启动时、宿主机重新上线时各检查一次。检查会运行一个在宿主机网络上带 `NET_ADMIN` 的短生命周期辅助容器，在其中读取 `iptables -S`，因此代价是一次容器启动，宿主机上什么都不改。没有 `proxy-only` Box 的宿主机完全不会被读取；有 `proxy-only` Box 的宿主机每轮都会重新读取，因为防火墙重新加载可能在没人注意时把规则清掉。辅助容器用的是在 `alpine:3.20` 上装好 iptables 的镜像，MiniBox 在每台宿主机上第一次需要时构建（`<prefix>-host-firewall:alpine3.20`），之后每轮检查不再下载任何东西。镜像满七天后，会在下一次检查时重新构建，用最新的 Alpine 且不用构建缓存，所以里面的 iptables 会跟着 Alpine 的更新走；被替换的旧镜像会被删除。构建不成功的宿主机回退到纯 Alpine，或继续用手上已有的镜像，一小时后再试。读不到的宿主机（离线，或没有网络可供构建）开始失败时记一行日志（`egress.forward_pass_failed`），之后每出现一种不同的错误再各记一行，但不会重复记日志里已有的错误；能再读到时记一行（`egress.forward_pass_recovered`）。两个后端里有一个读不到、另一个放行上行网桥时，同样算作没读到，因为没被看过的那张表可能正是在丢包的那张；在能读的那张里找到的丢包仍会报告，只是不带按钮。离线的宿主机在回来之前完全不会被读取。

规则丢弃上行网络时，概览页的**需要关注**会显示**仅代理的 Box 无法上网**，其中给出宿主机、受影响的 `proxy-only` Box 数量与网桥名。同一时刻 MiniBox 日志会写一行 `error`（`egress.forward_blocked`），条件持续期间不会重复写，所以无人值守的运维只会看到一次。之后某次检查发现规则恢复，会写 `egress.forward_restored` 并清掉该条目。

### 检查证明了什么，没证明什么

检查读取的是宿主机的 `FORWARD` 链对一个**新的 TCP 连接**会怎么做：该连接从上行网桥进来，从宿主机的默认路由（通常是网卡 `eth0`）出去。它会顺着 Docker 自己的链走到做决定的那条规则，并且同时读取 `iptables` 命令看到的内容（现代宿主机上是基于 nft 的那个，它只列出通过 iptables 写入的规则，见最后一节）和 `iptables-legacy`（仅当旧表已经存在时才读，读它本身不会把旧表加载起来），因为残留的旧表正是这个问题的一种成因。因此：

- 它证明的是：该宿主机上的 `proxy-only` Box 无法访问外部，**原因在于宿主机的转发规则**。这正是警告要说的故障，也是 MiniBox 能修的那种。
- 它**不能**证明互联网可达。规则正常但上行网络无法解析或无法路由的宿主机不会被报告：那种情况要去看代理的 `egress.failed … upstream` 事件，也不是一条 `FORWARD` 规则能修的。
- 它与 `open` 的 Box 无关：那些 Box 用默认网络和 Docker 常规规则，既不受该条件影响，也不受修复影响。
- 它读的是规则，不是流量。规则改动时已经建立的连接会保留 conntrack 条目直到关闭，所以警告出现后，Box 可能看起来还能用一小会儿。

### 修复

条目下面有一行完整写明属于下面哪种情况、该怎么办。条目上有**添加规则**按钮，但**只在丢包是因为链走到末尾、按策略丢弃时才出现**（`cause: "policy"`）。另外三种读数只报告、不给按钮。丢包来自宿主机自己写的 `DROP`/`REJECT` 规则（`rule`）：宿主机是在按写好的规则办事，MiniBox 的规则会把那个决定推翻。这次读取里有 MiniBox 读不懂的规则（没有原因）。以及按策略丢弃、但 `FORWARD` 里先走到了一条 `RETURN`，或一条用 `-g` 把上行网络的流量永久交给另一条链的规则（`unreachable`）：遍历在那里就结束了，追加在 `FORWARD` 末尾的规则永远走不到，放行规则只能手动加到那条链里，或加在那条规则之前。

点按钮会打开一个确认框，写明宿主机与网桥，**在你确认之前什么都不写入**。确认后，MiniBox 会在宿主机上运行一个短生命周期辅助容器，添加自己的链 `MINIBOX-FWD-<hash>`，并把跳转**追加在 `FORWARD` 末尾**。追加而不是插到最前面是有意的：包走到 MiniBox 的规则之前，Docker 自己的隔离链和你写在 `DOCKER-USER` 里的规则都已经做过决定，所以它们仍然优先。该链只接受从上行网桥进入、从宿主机默认路由出去的新连接，以及回到该网桥的回程；该规则不放行其它网桥接口；对默认出口网卡所通向的局域网与私网段的限制，仍需写在该跳转之前。宿主机防火墙的其它部分都不动：`FORWARD` 策略保持原样，别的安装的链也不受影响。这个安装不再需要这条规则时（最后一个 `proxy-only` 的 Box 被删除，或宿主机被移除），MiniBox 会把它删掉。MiniBox 只在运行期间记得自己加过这条规则：重启之后它不知道此前加过，也不会再删除它；关闭 MiniBox 本身不会删除任何东西。删除失败（比如那一刻连不上宿主机）会在之后的每次检查里重试，只要 MiniBox 还在运行。要手动删除，先在 `sudo iptables -S` 里找到那条链（`MINIBOX-FWD-<hash>`），再依次执行 `sudo iptables -D FORWARD -j <链>`、`sudo iptables -F <链>`、`sudo iptables -X <链>`；旧表请换成 `iptables-legacy`。宿主机没有 IPv4 默认路由时修复会被拒绝，因为没有可以放行的出口。

这是一次点击，通过 API 也就是一次调用：

```bash
curl -sS -X POST -H "Authorization: Bearer $MINIBOX_KEY" https://minibox.example.com/api/hosts/local/forward
```

条目会保留到下一次检查确认规则正确为止，所以没修好的修复仍然看得见。推荐走这条路径。

手动处理是**麻烦的**，文档不假装它简单：你需要找到网桥名、判断宿主机实际在用哪个 iptables 后端，并把两条规则写对。只有在你完全不想让 MiniBox 碰宿主机防火墙时才值得这么做。网桥是 `br-` 加 `<prefix>-egress-uplink` 网络 id 的前 12 个字符，或者创建该网络时指定的名字：

```bash
docker network inspect minibox-egress-uplink --format '{{.Id}}'
# br-<该 id 的前 12 个字符>
sudo iptables -S FORWARD        # 现代宿主机上基于 nft 的命令
sudo iptables-legacy -S FORWARD # 残留的旧表，若打印出规则则存在
```

然后对每个有 `FORWARD` 链的后端（若两者都打印规则就各跑一遍），只放行上行网络：

```bash
BR=br-1a2b3c4d5e6f   # 上面得到的网桥
OUT=eth0             # 宿主机的默认路由网卡：ip -4 route show default
sudo iptables -A FORWARD -i "$BR" -o "$OUT" -j ACCEPT
sudo iptables -A FORWARD -i "$OUT" -o "$BR" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
```

两条规则都是追加，与 MiniBox 自己的跳转一样，所以 `FORWARD` 里排在它们前面的规则仍然先做决定；每条都同时写明了两个网卡，因此放行的范围不超过上行网络。旧表请把 `iptables` 换成 `iptables-legacy`。MiniBox 不会持久化这些规则：重启或重新加载防火墙会清掉它们，下一次检查会再次报告该条件。如果你更愿意清掉残留的旧表而不是往里加规则，那就删掉 `DROP` 策略或造成它的规则，这是另一条手写路径，之后 MiniBox 的检查会自行判定规则正常。

### 检查覆盖不到的地方

以下是这次读取的盲区。大多数只会藏住真实的故障；nftables 那一条还可能产生 MiniBox 的规则清不掉的警告：

- **IPv6。** 只读 IPv4 规则；`proxy-only` Box 的代理目前是通过 IPv4 访问互联网的，所以这不是本警告要说的那种故障。一台放行 IPv4、拦住 IPv6 的宿主机不会被报告。
- **读不懂的规则。** 匹配条件检查不去求值的规则（`-m set`、`-m mark`、端口范围）既不算放行也不算丢弃。放行型的那种，在它正下方有一条检查读得懂的放行规则时不改变结果，Tailscale 放在 Docker 规则之上的那条链就是这样；丢弃型的会让读数变成「不明确」，只报告、不带按钮。检查看不到的一种情况是：`FORWARD` 策略为 `ACCEPT`，而上面有一条这样的规则丢掉了上行流量，这台宿主机会被读成正常转发。
- **原生 nftables 规则集。** 检查读的是 `iptables` 命令看到的内容。现代宿主机上这个命令基于 nft，但它只列出通过 iptables 写入的规则，看不到直接写进 nftables 的规则，比如 firewalld 用 `nftables` 后端、或引擎被配置为直接写 nftables 规则时。这样的宿主机可能在实际不通时被读成能转发；如果它的 iptables 视图里只有一个 `DROP` 策略、别的什么都没有，就会被读成按策略丢弃，这时**添加规则**加的是 iptables 规则，压不过原生 nftables 的丢弃。如果在这样的宿主机上修复后警告依然存在，说明真正做决定的不是这个检查所读的防火墙：请按那个防火墙自己来判断。
- **已经建立的流量。** conntrack 条目会比放行它的规则活得更久，所以规则改动后 Box 可能还会正常工作一会儿。
- **规则之外的原因。** 规则正常但上行网络无法解析或无法路由的宿主机，不会在这里被报告。

如果规则是因为防火墙被重新加载而丢失的，重启 Docker 守护进程是另一条出路：Docker 会重新写入它自己的规则，下一次检查就会清掉这个条目，MiniBox 什么都不用加。除非开启了 `live-restore`，否则这会停掉宿主机上的所有容器，所以应当放进维护窗口，而不是点一下就做。

## 允许的主机超时

若允许的主机超时，而概览页没有显示转发警告，说明宿主机的规则没问题，问题在目标主机或中间的网络。代理的 `egress.failed` 事件会给出它连不上的主机与端口。

## 试一试

```bash
minibox box create offline --egress none
minibox exec offline -- curl -sS -m 5 https://example.com/   # 失败：没有对外路由

minibox box create agent --egress proxy-only --egress-domain example.com
minibox exec agent -- curl -sS -m 8 -o /dev/null -w '%{http_code}\n' https://example.com/   # 输出 200
minibox exec agent -- curl -sS -m 8 -o /dev/null https://example.org/   # 被拒绝；egress.denied 事件会记录它
```
