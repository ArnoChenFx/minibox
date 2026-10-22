# 把 Box 数据放到 NAS / NFS 服务器上

[English](nas.md) · 返回 [README › 数据卷与存储池](../README-zh.md#数据卷与存储池)

本文针对这样的部署：NAS 或一台 Linux 存储服务器存放 Box 的数据，另一台机器运行 MiniBox 和 Docker。MiniBox 通过 Docker 的 `local` 卷驱动挂载 NFS 导出目录，真正的 NFS 客户端是 Docker 宿主机的内核，MiniBox 自己不挂载任何东西。跟踪 issue：[#30](https://github.com/ArnoChenFx/minibox/issues/30)。

标注**已测试**的步骤都在真实的 NFS 服务器上跑过：Debian 13 上的 NFS-Ganesha 6（用户态，VFS 后端），客户端是 Linux 6.12 内核，经 Docker 26 挂载。文中的挂载选项、文件属主结果和报错信息都来自这些测试。各家 NAS 的小节只是通用指引：不同型号和固件版本的菜单名称不一样，请以自己设备上的为准。

## 什么时候用 NFS

适合用 NFS 池的情况：

- 计算机器的磁盘小或不可靠，希望 Box 数据放在 NAS 上；
- 以后想在多台计算机器之间迁移 Box（只有 NFS 池是 `crossHost`）；
- NAS 已经有快照和备份，希望 Box 数据也被覆盖到。

需要注意：

- **只在可信网络里用。** `sec=sys` 的 NFS 不加密，并且直接信任客户端报上来的 uid。请在自己掌控的局域网里使用，或者走 WireGuard / Tailscale，并且把导出限制为计算机器的 IP。
- **小文件慢。** 每次创建、`stat`、`fsync` 都是一次网络往返。测试中写 500 个小文件，NFS 上用了 262 ms，本地缓存卷上 18 ms，而且这还是走回环、中间没有真实网络。大文件的顺序读写在千兆或更快的网络上没问题；`git status`、`npm install`、小文件多的构建会明显感觉到慢。
- **`cache` 留在本地池。** 这是默认行为。`~/.cache` 放的是包缓存和构建产物，重建很便宜，放在 NFS 上却很贵。`node_modules` 没法预先分配，因为它的路径取决于项目位置；某个项目慢的话，可以给它的 `node_modules` 单独挂一只本地卷。
- **SQLite、文件锁与 inotify。** SQLite 在 NFSv4 上能用（已测试：普通数据库和 `journal_mode=wal` 都正常，`flock` 也正常），但同一时间只能有一台机器使用一个数据库文件，WAL 依赖只在单个客户端本地有效的共享内存。不要让不同宿主机上的两个 Box 同时写同一个数据库。inotify 只能看到经同一客户端做的修改，所以从别的机器或在 NAS 上直接改文件，文件监听是察觉不到的。
- **绝不要把 Docker 的 `data-root` 放到 NFS 上。** `overlay2` 不能运行在 NFS 上。镜像、容器层和 `DATA_DIR` 都留在计算机器，只有卷放到 NAS。
- **检查点仓库留在本地。** NFS 上的 Box 可以正常做检查点（已测试：拍摄与回滚），但 restic 仓库是本地 Docker 卷 `<前缀>-checkpoints-<宿主机>`。请单独备份它，以及 `DATA_DIR/secrets/checkpoint-repo.key`。

各部分放在哪里：

| 数据 | 位置 |
|---|---|
| 工作区（`/workspace`）与主目录（`/home/dev`） | NFS 池（默认池） |
| 共享工具卷（`/opt/minibox/tools`） | 同样在默认池，除非把「工具」角色指定到别的池 |
| 缓存（`/home/dev/.cache`） | 始终在本地池，除非单独指定「缓存」角色 |
| 独立卷 | 创建时选的那个池 |
| Docker 镜像、容器层、`DATA_DIR`、检查点仓库 | 计算机器 |

## 属主：最关键的一点

Box 以 `dev` 用户运行，uid **1000**，gid **1000**。Box 写的每个文件在服务器上都必须属于 1000，而且 uid 1000 要能在导出目录里创建子目录。

MiniBox 在 NFS 池上创建卷时，会在计算机器上起一个短生命周期的辅助容器，以 root 身份在导出目录里执行：

1. `mkdir -p <导出目录>/<卷 id>`（例如 `vol_hakder7qn0`）；
2. 对这个目录执行 `chown -R 1000:1000`。chown 失败时，辅助容器输出 `MINIBOX_CHOWN_SKIPPED`，MiniBox 记录 `volume.chown_skipped`，**卷照样创建成功**。

能不能成功，取决于服务器怎样映射辅助容器的 root。各种 squash 方式的实测结果：

| 服务器导出设置 | 导出目录属主 | 结果 |
|---|---|---|
| `all_squash,anonuid=1000,anongid=1000` | 1000:1000 | **可用，推荐。** 不管谁写，服务器上的文件都是 1000:1000。在 Box 里 `chown` 会返回成功，但什么也不改 |
| `all_squash,anonuid=1000,anongid=1000` | root，权限 755 | 创建卷失败：`mkdir: cannot create directory '/mnt/vol_…': Permission denied`（`volume_prepare_failed`） |
| `root_squash,anonuid=1000,anongid=1000` | 1000:1000 | 可用。root 映射为 1000，`dev` 仍是 1000。Box 里的 root 写出来的文件也是 1000 |
| `no_root_squash` | 任意 | 可用，辅助容器的 chown 能成功。但 Box 里的 root 在导出目录上就是真正的 root，只应在专用导出上这样设置 |
| `root_squash`（匿名用户是 `nobody`） | 1000:1000，权限 755 | 创建卷失败，`Permission denied` |
| `root_squash`（匿名用户是 `nobody`） | 权限 777 | 创建卷**成功**，但目录属于 `nobody`，chown 被跳过（`volume.chown_skipped`），`dev` 每次写入都是 `Permission denied`。不要这样配 |

结论：把所有用户映射到 uid 1000，并且让导出目录本身属于 1000:1000。

## 存储端设置

### Linux（`nfs-kernel-server`）

```bash
sudo apt install nfs-kernel-server
sudo mkdir -p /srv/minibox
sudo chown 1000:1000 /srv/minibox
```

`/etc/exports`，假设计算机器是 `192.168.1.20`：

```
/srv/minibox  192.168.1.20(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000)
```

- `rw,sync`：`sync` 让服务器先落盘再应答。`async` 更快，但服务器崩溃时可能丢掉 Box 以为已经写好的数据。
- `no_subtree_check`：常用默认值，重命名文件时不容易出现 stale handle。
- `all_squash,anonuid=1000,anongid=1000`：见[属主](#属主最关键的一点)。如果这个导出还有别的客户端需要保留各自的 uid，可以改用 `root_squash,anonuid=1000,anongid=1000`，Box 的 uid 保持 1000。
- 客户端写 IP 或网段（`192.168.1.0/24`），不要写 `*`。用 Tailscale 时，写计算机器的 `100.x.y.z` 地址。
- 给 MiniBox 一个专用目录。MiniBox 会为每只卷建一个子目录（`vol_…`），探测时会挂载导出目录的根。

生效并检查：

```bash
sudo exportfs -ra
sudo exportfs -v
```

**防火墙。** NFSv4 只需要放行计算机器到 TCP **2049**。NFSv3 还需要 `rpcbind`（111）以及 `mountd`、`statd`、`lockd`，后几个端口不固定、需要额外配置，这也是推荐 v4 的原因之一。

**NFSv4.1 还是 v3。** 用 4.1 或 4.2。MiniBox 的挂载经过 Docker 的 `local` 驱动，它直接调用 `mount` 系统调用，而不是 `mount.nfs`，不会自动协商版本，所以一定要写 `nfsvers=`。不写的话内核会尝试 v3；测试用的客户端内核没有编译 NFSv3，结果是 `protocol not supported`。即便内核支持 v3，计算机器上不跑 `statd` 也用不了服务器端的锁。

### 群晖 DSM（通用指引）

- 开启 NFS 服务，最大协议选 NFSv4.1。
- 为 MiniBox 建一个共享文件夹，在它的 NFS 权限里为计算机器的 IP 加一条读写规则。
- Squash 选择把所有用户映射到 uid 为 1000 的账户，或者映射为 admin，并确保该账户对这个文件夹有写权限，目标是上表 `all_squash,anonuid=1000` 那一行的效果。DSM 上普通用户的 uid 通常从 1024 开始，不是 1000，请先通过 SSH 用 `id <用户名>` 查一下，并把文件夹属主设成规则映射到的那个账户。如果这个账户不是 uid 1000，Box 里看到的文件属主也是它的 uid。写入仍然可以，因为服务器按这个账户检查权限；但会比较文件属主和当前用户的工具，比如 git 的 `safe.directory` 检查，可能会拒绝这个仓库（本文未测试）。
- 「异步」只有在能接受 NAS 崩溃时丢失最近写入的情况下才开启。
- 给这个共享文件夹开启快照，作为灾备层。

### 威联通 QTS（通用指引）

- 开启 NFS 服务，选择 NFSv4（有 4.1 就选 4.1）。
- 在共享文件夹的 NFS 主机访问权限里，加入计算机器的 IP，读写。
- Squash 选项选择把所有用户（或 root）映射到 uid 为 1000 的账户。和 DSM 一样，先确认要映射的账户实际的 uid。
- 给共享文件夹所在的卷做快照。

### TrueNAS SCALE（通用指引）

- 为 MiniBox 建一个数据集，属主设为 uid 1000、gid 1000（建一个 id 对应的本地用户，或直接设数字属主）。
- 为这个数据集添加 NFS 共享，只允许计算机器的 IP 或所在网段。
- 在共享的高级选项里，把「Mapall User」和「Mapall Group」设为这个 uid 1000 的用户和组，相当于 `all_squash,anonuid=1000,anongid=1000`。只把「Maproot」设成同一个用户，则相当于 `root_squash,anonuid=1000`。
- 在 NFS 服务设置里启用 NFSv4。
- 为数据集设置定时快照。

### Unraid（通用指引）

- 为 MiniBox 建一个共享并通过 NFS 导出。如果你的版本支持在共享的 NFS 安全设置里写规则，用类似 `192.168.1.20(rw,sync,all_squash,anonuid=1000,anongid=1000)` 的规则来限制。Unraid 默认的 `nobody` 用户 uid 是 99，没有这条规则就会落到上表「root_squash 到 nobody」那一行。
- 版本支持的话启用 NFSv4，较老的版本只有 NFSv3。
- 在 Unraid 的终端里把共享目录的属主改成 1000:1000。

## MiniBox 端设置

### 计算机器

安装 NFS 客户端工具（`sudo apt install nfs-common`），方便手动测试挂载。Docker 自己挂 NFS 不用这些工具，但内核必须支持 NFSv4（`grep nfs4 /proc/filesystems`）。

在 MiniBox 里添加之前，先在计算机器上手动检查一下导出：

```bash
sudo mount -t nfs -o nfsvers=4.1 192.168.1.10:/srv/minibox /mnt && ls -ln /mnt && sudo umount /mnt
```

服务器地址必须能从 **Docker 守护进程**所在的网络命名空间访问到。用 Docker Desktop 或远程守护进程时，那台机器和 MiniBox 不是同一台。

### 在控制台添加存储池

**卷 → 添加 NFS** 会打开这个对话框：

| 字段 | 填什么 | 谁校验 |
|---|---|---|
| 池名称 | 简短的名字，比如 `nas`。字母、数字和 `.` `_` `-`，以字母或数字开头，最多 63 个字符。`local` 是保留名 | 控制台与服务端 |
| 服务器 | NFS 服务器的 IP 或主机名，例如 `192.168.1.10`。最多 254 个字符，只能是字母、数字和 `.` `:` `-`。不能带 `user@` 或端口。主机名由 Docker 守护进程解析 | 服务端 |
| 导出目录 | 服务器上导出的绝对路径，例如 `/srv/minibox` 或 `/volume1/minibox`。不能有 `..` 或空格，末尾的 `/` 会去掉。每只卷对应 `<导出目录>/<卷 id>` | 服务端 |
| 选项 | 逗号分隔的挂载选项，例如 `nfsvers=4.1, hard, noatime`。最多 16 项，每项只能包含字母、数字和 `. _ = -` | 服务端 |
| 设为默认池 | 新建 Box 的工作区、主目录和工具卷放在这里 | 控制台 |

然后点**保存存储池**并确认预览。保存之前，新池只存在于页面上。保存后，存储池表格的**健康**一栏显示 `reachable`，以及 NFS 服务器报告的剩余空间；`unreachable` 时旁边会显示挂载错误。

每行的**默认**按钮，以及**角色默认池**下的下拉框（工作区、主目录、工具、缓存），同样要保存后才生效。除非有特殊需要，角色保持「使用默认规则」即可：缓存在本地池，其余在默认池。

### 用 API 做同样的事

```bash
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -X PUT -d '{"confirm":true,"pools":[
    {"name":"local","backend":"local"},
    {"name":"nas","backend":"nfs","server":"192.168.1.10","export":"/srv/minibox",
     "options":["nfsvers=4.1","hard","noatime"],"default":true}
  ],"roles":{"workspace":null,"home":null,"tools":null,"cache":null}}' \
  http://127.0.0.1:3920/api/pools
```

`PUT /api/pools` 会替换整个列表，要保留的池都得写上。不带 `"confirm": true` 时返回 `409 confirmation_required` 和预览。需要 `pool:admin` 权限。`GET /api/pools?refresh=true` 会重新探测所有池；不带 `refresh` 时结果缓存 15 秒。MCP：`storage` 工具集里的 `list_pools` 与 `replace_pools`。保存的文件是 `DATA_DIR/pools.json`。

还有卷的池不能删除，也不能换后端（`409 pool_in_use`）。修改池的服务器、导出目录或选项，不会影响已有的卷：每只 Docker 卷保留它创建时的选项。

### 挂载选项

| 选项 | 建议 |
|---|---|
| `nfsvers=4.1`（或 `4.2`） | **实际上必填。** 见 [NFSv4.1 还是 v3](#linuxnfs-kernel-server) |
| `hard` | 推荐。I/O 会等服务器恢复，而不是直接报错。服务器不在时，访问挂载点的进程会卡住，服务器回来后从原处继续。已测试：NFS 服务器重启前后写入的数据都完好，也不需要重新挂载 |
| `soft` | 不建议用于数据。超过 `timeo`×`retrans` 后 I/O 返回 `EIO`，可能留下程序以为已经写完、实际只写了一半的文件 |
| `noatime` | 推荐，每次读取都少一次写 |
| `timeo=`、`retrans=` | 只在 `soft` 下有意义，或者决定 `hard` 挂载多久打印一次「server not responding」。默认值（`timeo=600` 即 60 秒，`retrans=2`）就够了 |
| `nconnect=4` | 可选，NFSv4.1 及以上，用多条 TCP 连接提高吞吐。已测试在 Linux 6.12 上可以挂载 |
| `rsize=`、`wsize=` | 不用写，客户端和服务器会自动协商（测试中是 1 MiB） |

不用写 `addr=`，MiniBox 会自己加上 `addr=<服务器>`。MiniBox 的可达性探测**不使用**你写的 `hard`/`soft`：它用 `soft,timeo=10,retrans=1` 加上你的其他选项挂载导出根目录，所以服务器挂了也不会把探测卡住。

### 验证

1. 在**卷**页面，这个池显示 `reachable` 和剩余空间。
2. 新建一个 Box。卷页面上它的工作区和主目录显示在 NFS 池，缓存显示 `local`。
3. 在 Box 终端里：

   ```bash
   id                                  # uid=1000(dev) gid=1000(dev)
   mount | grep -E 'workspace|home/dev|tools|cache'
   echo ok > /workspace/nfs-test && ls -ln /workspace/nfs-test
   ```

   `/workspace` 和 `/home/dev` 应该是 `type nfs4 (rw,noatime,vers=4.1,…,hard,…)`，`/opt/minibox/tools` 相同但是 `ro`，`/home/dev/.cache` 是本地文件系统。
4. 在服务器上，这个文件位于 `<导出目录>/<工作区卷 id>/nfs-test`，属主 1000:1000。卷 id 就是卷页面上 `vol_…` 形式的引擎名。
5. 重启 Box，再读一次这个文件。

## NAS 不可用时

测试方法：停掉 NFS 服务器；另外用防火墙丢弃它的流量，模拟 NAS 断电。

- 探测显示 `unreachable` 和挂载错误（服务器拒绝连接时是 `input/output error`，没有任何应答时是 `connection timed out`）。Box 列表会把受影响的 Box 标为存储 `unreachable`。
- 在这个池上创建、启动、重启 Box，几秒内返回 `503`，错误码 `docker_unavailable`，消息键 `storage_unreachable`。什么都不会创建：没有容器，没有卷记录，本地磁盘的 `/var/lib/docker/volumes/<卷>/_data` 下也没有数据。
- 停止 Box 仍然可以。
- **正在运行**的 Box 使用 `hard` 挂载时，任何访问 `/workspace` 或 `/home/dev` 的进程都会卡住直到服务器恢复，包括 MiniBox 的 `exec` 和终端。带 `timeoutSec` 的 `exec` 也要等服务器恢复才返回，见[已知问题](#已知问题)。
- 同一台不可达服务器上有多个 NFS 池时，存储池页面的探测每个池要几秒；断网后的第一次探测超过了一分钟。
- 服务器恢复后，卡住的进程继续运行，下一次探测显示 `reachable`，停止的 Box 可以重新启动，不需要重新挂载。

NAS 维护（重启、升级固件）之前，先停掉使用它的 Box。

## 备份

- NAS 对整个 MiniBox 导出目录做快照，是灾备层。MiniBox 的检查点按 Box 来做，是补充，不能替代它。
- 存储端本身不是备份。NAS 快照、检查点仓库及其密钥，都要另外复制一份到别处。
- 删除 Box 时勾选**删除卷**，会删掉 Docker 卷，但不会删除导出目录里对应的子目录（只有创建失败时，MiniBox 才会删除它刚建的空目录）。NAS 上的数据会一直保留，直到你自己删除 `<导出目录>/vol_…`。

## 故障排查

下表的报错信息都在测试中实际出现过。

| 现象 | 报错 | 原因与处理 |
|---|---|---|
| 池 `unreachable` | `… failed to mount local volume: … protocol not supported` | 选项里没写 `nfsvers=`，或者客户端内核不支持 NFSv3 却写了 `nfsvers=3`。加上 `nfsvers=4.1` |
| 池 `unreachable` | `… input/output error` | 服务器没运行，或者 TCP 2049 上没有服务。启动 NFS 服务，检查防火墙 |
| 池 `unreachable` | `… connection timed out` | 服务器地址错了，或者网络、防火墙丢弃了流量 |
| 池 `unreachable` | `… no such file or directory` | 导出路径不存在，或者这个客户端没有权限。NFSv4 会隐藏客户端无权访问的导出，所以客户端限制看起来像路径错误。Linux `nfsd` 可能会报 `access denied by server` |
| 创建 Box 失败 | `Could not prepare the volume directory: mkdir: cannot create directory '/mnt/vol_…': Permission denied` | 被映射后的 uid 无法写导出根目录。把导出目录 `chown 1000:1000`，并使用 `all_squash,anonuid=1000,anongid=1000` |
| Box 能启动，但 `dev` 无法写 `/workspace`，服务端日志里有 `volume.chown_skipped` | Box 里 `Permission denied`；服务器上 `vol_…` 目录属于 `nobody`（显示为 65534，Ganesha 上是 4294967294） | `root_squash` 映射到了 `nobody`。把导出改成 `all_squash,anonuid=1000,anongid=1000`，再在服务器上执行 `chown -R 1000:1000 <导出目录>/vol_…` |
| 在 Box 里 `chown` 显示成功，但属主没变 | — | `all_squash` 下的正常现象：所有文件都属于匿名 uid |
| Box 里报 `Stale file handle`，之后 `start` 失败并提示 `lstat …/_data: stale NFS file handle` | | 卷的目录在挂载期间被服务器端删除或替换了（例如从快照恢复到了新文件夹）。停掉 Box，把数据放回原位。测试中，直到在计算机器上清掉客户端缓存（`sync; echo 2 \| sudo tee /proc/sys/vm/drop_caches`）之后才能再次启动 |
| Box 里的命令卡住 | — | `hard` 挂载且服务器不可达。让服务器恢复，进程会继续；急着结束的话可以停掉 Box |
| 启动或创建返回 `503 storage_unreachable` | `Storage pool nas is unreachable: …` | MiniBox 不会在连不上的存储上启动 Box，因此也不会改写到本地磁盘。修好存储池后重试 |

## 已知问题

写这篇文档的测试中发现：

- `hard` 挂载卡住时，`exec`（以及前台 `exec` 的超时）无法结束：MiniBox 在 Box 里执行的终止命令以 Box 的工作目录 `/workspace` 启动，也会跟着卡住。服务器恢复后调用才返回。
- `root_squash` 映射到 `nobody` 时，卷能创建成功，但 `dev` 无法写入，唯一的提示是 `volume.chown_skipped` 这条日志。
- 导出目录上的权限错误会被报成 `400 validation_failed`，而不是存储错误。
- 存储池是逐个探测的，有多个不可达的 NFS 池时，存储池页面会变慢。

## path 池

如果你更想自己在宿主机上挂载 NAS（例如用 autofs，或者用 SMB），可以改用 `path` 池：把共享挂到一个固定路径，在挂载后的文件系统上创建标记文件（`.minibox-mounted`），再通过**卷 → 添加路径**添加。标记文件不存在时 MiniBox 拒绝写入，所以共享没挂上时，不会写到本地磁盘。使用 systemd 的话，让 Docker 在挂载之后启动，例如给 `docker.service` 加一个 drop-in：

```ini
[Unit]
RequiresMountsFor=/mnt/nas/minibox
```

本文没有在 NAS 上测试 path 池，也没有测试 systemd 的启动顺序。
