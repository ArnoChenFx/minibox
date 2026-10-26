# NFS 与 NAS 存储

本指南说明如何将 Box 数据放在 NAS 或其他 NFS 服务器上。计算节点运行 MiniBox 与 Docker。NFS 服务器通过 NFS 卷保存数据。

MiniBox 不会自行挂载 NFS。它使用 `local` 驱动及 NFS 选项创建 Docker 卷。由 Docker 宿主机内核完成挂载。

## 何时使用 NFS

在以下情况使用 NFS 存储池：

- 计算节点磁盘较小，希望 Box 数据放在 NAS 上。
- NAS 已有快照与备份，希望 Box 数据也纳入其中。

请注意：

- **仅使用可信网络。** NFS 默认不加密，并信任客户端发送的用户 ID。在你控制的 LAN 上运行，或通过 WireGuard 或 Tailscale。只允许计算节点的地址挂载该 NFS 导出。
- **小文件较慢。** 每次 create、`stat` 和 `fsync` 都是一次网络往返。在 1 GbE 或更快网络上，大块顺序读写没问题。会触及大量小文件的命令（如 `git status`、`npm install` 和构建）会感觉更慢。
- **缓存保留在本地池。** 这是默认行为。`~/.cache` 目录存放包缓存与构建输出。它们重建成本低，走 NFS 却很慢。若某个项目很慢，可在其 `node_modules` 目录挂载本地卷。
- **数据库需要单一使用者。** SQLite 可在 NFSv4 上使用。同一时刻只能有一台机器使用某个数据库文件。不要让不同宿主机上的两个 Box 写入同一数据库。
- **文件监视器看不到远程变更。** inotify 只能看到经同一客户端产生的变更。在另一台机器上或直接 NAS 上的编辑不会传过来。
- **切勿把 Docker 数据根目录放在 NFS 上。** 镜像、容器层与 MiniBox 数据目录留在计算节点上。只有卷放到 NAS。
- **检查点保留在本地。** 检查点仓库是本地 Docker 卷。请单独备份，并与计算节点上的加密密钥一并保存。参见[检查点](checkpoints.md)。

各类数据所在位置：

| 数据 | 所在位置 |
|---|---|
| 工作区（`/workspace`）与 home（`/home/dev`） | 若为默认池，则在 NFS 存储池 |
| 工具（`/opt/minibox/tools`） | 默认池，除非**工具**角色指定了其他池。每个池有各自的共享 tools 卷，因此在 NFS 池上的 Box 会从空卷开始。请在该 Box 的**设置**中、**工具**一组重新安装工具 |
| 缓存（`/home/dev/.cache`） | 本地池。这是默认行为。 |
| 独立卷 | 创建时选择的存储池 |
| 镜像、容器层、数据目录、检查点仓库 | 计算节点 |

## 所有权：唯一必须搞对的事情

Box 以 `dev` 运行，用户 ID 为 **1000**，组 ID 为 **1000**。Box 写入的每个文件在服务器上都必须属于 1000。用户 1000 还必须能在导出目录中创建文件夹。

MiniBox 在 NFS 存储池上创建卷时，计算机会以 root 运行一个短生命周期的辅助容器。该辅助程序在导出目录中做三件事：

1. 创建文件夹 `<export>/<volume id>`，例如 `vol_hakder7qn0`。
2. 对该文件夹执行 `chown -R 1000:1000`。若 chown 失败，MiniBox 仍会继续，并记录无法更改所有权。
3. 检查用户 1000 能否写入该文件夹。若检查失败，MiniBox 会删除新建文件夹且不创建卷。请求返回 `502`，错误码为 `bad_gateway`。

服务器如何映射 root 决定上述流程是否可行：

| 服务器导出选项 | 导出文件夹所有者 | 结果 |
|---|---|---|
| `all_squash,anonuid=1000,anongid=1000` | 1000:1000 | **可行。推荐。** 每个文件都属于 1000:1000。在 Box 内执行 `chown` 会成功，但不会改变任何内容。 |
| `all_squash,anonuid=1000,anongid=1000` | root，权限 755 | 创建卷失败，返回 `502`：`Storage pool … denied permission to create the volume directory: mkdir: cannot create directory '/mnt/vol_…': Permission denied` |
| `root_squash,anonuid=1000,anongid=1000` | 1000:1000 | 可行。root 映射为 1000，`dev` 亦然。 |
| `no_root_squash` | 任意 | 可行，但 Box 内的 root 在导出目录上是真正的 root。仅用于专用导出。 |
| `root_squash` 且默认匿名用户（`nobody`） | 1000:1000，权限 755 | 创建卷失败，返回 `502`，消息说明存储池拒绝创建卷目录 |
| `root_squash` 且默认匿名用户（`nobody`） | 权限 777 | 创建卷失败，返回 `502`，消息说明 uid 1000 无法写入新的卷目录。文件夹属于 `nobody`，`dev` 无法写入。请改用 `root_squash,anonuid=1000,anongid=1000`。 |

将所有身份映射到用户 1000，并让导出文件夹归 1000:1000 所有。

## 服务器端

### Linux（`nfs-kernel-server`）

安装服务器，并为 MiniBox 创建文件夹：

```bash
sudo apt install nfs-kernel-server
sudo mkdir -p /srv/minibox
sudo chown 1000:1000 /srv/minibox
```

在 `/etc/exports` 中加入以下行。它允许位于 `192.168.1.20` 的计算节点挂载该文件夹：

```
/srv/minibox  192.168.1.20(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000)
```

- `rw,sync`：`sync` 使服务器在应答前落盘写入。`async` 更快，但服务器崩溃时可能丢失 Box 认为已保存的写入。
- `no_subtree_check`：常见默认项。重命名文件时可避免 stale handle。
- `all_squash,anonuid=1000,anongid=1000`：见[所有权](#所有权唯一必须搞对的事情)。若其他客户端在此导出上需要各自的用户 ID，请改用 `root_squash,anonuid=1000,anongid=1000`。
- 用地址或子网指定客户端，例如 `192.168.1.0/24`。不要使用 `*`。使用 Tailscale 时，用计算节点的 `100.x.y.z` 地址。
- 为 MiniBox 使用专用文件夹。MiniBox 会为每个卷创建一个名为 `vol_…` 的子文件夹。

应用更改并检查：

```bash
sudo exportfs -ra
sudo exportfs -v
```

**防火墙。** NFSv4 只需计算节点访问 TCP **2049** 端口。NFSv3 还需要 `rpcbind`（端口 111）、`mountd`、`statd` 和 `lockd`。除非固定端口，否则这些端口是动态的。这也是应使用 NFSv4 的原因之一。

**NFSv4.1 或 4.2，不要用 v3。** MiniBox 通过 Docker 的 `local` 驱动挂载，该驱动不会协商 NFS 版本。务必在存储池选项中设置 `nfsvers=`。未设置时内核会尝试 NFSv3。在内核不支持 NFSv3 时，挂载失败并报 `protocol not supported`。使用 NFSv3 时，除非计算节点运行 `rpc.statd`，否则文件锁也会失败。

### Synology DSM（一般说明）

不同型号与固件版本的菜单名称可能不同。请对照你的设备核对以下步骤。

- 启用 NFS 服务，并将最高协议设为允许 NFSv4.1。
- 为 MiniBox 创建共享文件夹。为计算节点地址添加 NFS 规则，授予读写权限。
- DSM 的 squash 设置不能指定任意用户 ID。它会把所有用户或 root 映射为 `admin` 或 `guest`，或不作映射。最接近 `all_squash,anonuid=1000` 的做法是将所有用户映射为 `admin`，并让共享文件夹对 `admin` 可写。
- DSM 账户的用户 ID 通常从 1024 起，而非 1000。通过 SSH 执行 `id <user>` 查看 ID。Box 内显示的文件所有者会是该 ID，而非 1000。写入仍可工作。会将文件所有者与当前用户比较的工具（如 git 的 `safe.directory` 检查）可能拒绝该仓库。
- 除非你能接受 NAS 崩溃后丢失最近写入，否则不要开启异步写入。
- 对共享文件夹做快照，作为灾难恢复层。

### QNAP QTS（一般说明）

- 启用 NFS 服务并选择 NFSv4，在提供 4.1 时选用 4.1。
- 在共享文件夹上，将 NFS 主机访问设为计算节点地址，并授予读写权限。
- 选择将所有用户或 root 映射到同一账户的 squash 选项。若固件允许，将匿名用户 ID 设为 1000。与 DSM 一样，请核对所映射账户的真实用户 ID。
- 对存放共享文件夹的卷做快照。

### TrueNAS SCALE（一般说明）

- 为 MiniBox 创建 dataset。将所有者设为用户 1000、组 1000。创建具有这些 ID 的本地用户，或直接设置数字所有者。
- 为该 dataset 添加 NFS 共享。限制为计算节点地址或网段。
- 在共享的高级选项中，将 map-all 用户与组设为该用户与组。这相当于 `all_squash,anonuid=1000,anongid=1000`。若改为设置 map-root 用户与组，则对应 `root_squash,anonuid=1000` 变体。TrueNAS 新用户默认从用户 ID 3000 起，请显式将该用户 ID 设为 1000。
- 在 NFS 服务设置中启用 NFSv4。
- 为 dataset 安排定期快照。

### Unraid（一般说明）

- 创建 MiniBox 共享并通过 NFS 导出。导出路径为 `/mnt/user/<share>`。
- 若你的版本提供 NFS 安全规则，将共享限制为计算节点，例如 `192.168.1.20(rw,sync,all_squash,anonuid=1000,anongid=1000)`。若无此类规则，Unraid 通常把所有人映射为 `nobody`（用户 99，组 100）。写入可用，但 Box 内文件显示为用户 99。与 DSM 相同的注意事项适用。
- 若版本支持，启用 NFSv4。旧版本仅提供 NFSv3。
- 在 Unraid shell 中，将共享文件夹设为 1000:1000 所有。

## MiniBox 端

### 从计算节点检查导出

安装 NFS 客户端工具，在添加到 MiniBox 之前手动挂载导出：

```bash
sudo apt install nfs-common
sudo mount -t nfs -o nfsvers=4.1 192.168.1.10:/srv/minibox /mnt && ls -ln /mnt && sudo umount /mnt
```

Docker 守护进程负责 NFS 挂载，因此服务器地址必须能从守护进程所在网络访问。使用 Docker Desktop 时，守护进程在虚拟机中运行。远程守护进程在另一台机器上。请从该环境运行测试。

### 在控制台中添加存储池

1. 在侧栏点击**存储**，然后打开**卷**标签页。
2. 点击**添加 NFS**。
3. 填写字段：

| 字段 | 填写内容 |
|---|---|
| **池名称** | 短名称，例如 `nas`。使用字母、数字、`.`、`_` 或 `-`，且以字母或数字开头，最多 63 个字符。`local` 是内置本地池，不能用作 NFS 池。 |
| **服务器** | NFS 服务器的 IP 地址或主机名，例如 `192.168.1.10`。不要包含 `user@` 或端口。Docker 守护进程会解析主机名。 |
| **导出目录** | 服务器上导出的绝对路径，例如 `/srv/minibox` 或 `/volume1/minibox`。不要使用 `..` 或空格。 |
| **选项** | 逗号分隔的挂载选项，例如 `nfsvers=4.1, hard, noatime`。务必包含 `nfsvers=4.1` 或 `nfsvers=4.2`。见[挂载选项](#挂载选项)。 |
| **设为默认池** | 新 Box 的 workspace、home 与 tools 卷将放在此池。 |

4. 点击**保存存储池**，并确认预览。

保存之前，存储池只存在于页面中。保存后，存储池行显示**可达**以及 NFS 服务器报告的剩余空间。若显示**存储不可达**，挂载错误会出现在下一列。

**默认**设置与**角色默认池**（**工作区**、**主目录**、**工具**、**缓存**）也仅在保存后生效。除非需要例外，否则角色保持**使用默认规则**。该规则将缓存放在本地池，其余放在默认池。

要修正已经添加的池，在其行上点击 **编辑**：见[编辑存储池](volumes-and-storage.md#编辑存储池)。修改存储池的服务器、导出目录或选项不会影响已存在的卷，而仍有卷的池不能改名或更换后端。

### 通过 API 做同样的事

```bash
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -X PUT -d '{"confirm":true,"pools":[
    {"name":"local","backend":"local"},
    {"name":"nas","backend":"nfs","server":"192.168.1.10","export":"/srv/minibox",
     "options":["nfsvers=4.1","hard","noatime"],"default":true}
  ],"roles":{"workspace":null,"home":null,"tools":null,"cache":null}}' \
  http://127.0.0.1:3920/api/pools
```

`PUT /api/pools` 会替换整个列表，因此请发送你要保留的每个存储池。见 [API 参考](../../reference/api.md)（英文）。

仍有关联卷的存储池不能移除、改名或更改后端。更改存储池的服务器、导出或选项不会影响已存在的卷：每个 Docker 卷保留创建时的选项。

### 挂载选项

| 选项 | 建议 |
|---|---|
| `nfsvers=4.1`（或 `4.2`） | **实际必需。** 见 [NFSv4.1 或 v3](#linuxnfs-kernel-server)。 |
| `hard` | 推荐。I/O 会等待服务器而不是失败。服务器不可达时，访问挂载的进程会挂起，恢复后继续。服务器重启前后写入的数据保持完整，无需重新挂载。 |
| `soft` | 不推荐用于数据。超时后 I/O 以 `EIO` 失败，可能留下程序认为已写完整的半写文件。 |
| `noatime` | 推荐。避免每次读取都触发写入。 |
| `timeo=`、`retrans=` | 不要设置。它们只对 `soft` 挂载有意义，或影响 `hard` 挂载记录「server not responding」的频率。默认值即可。若设置，也会改变多快报告服务器已死。 |
| `nconnect=4` | 可选，适用于 NFSv4.1 及更高版本。打开多条 TCP 连接以提高吞吐。 |
| `rsize=`、`wsize=` | 不要设置。客户端与服务器会协商。 |

不需要 `addr=`。MiniBox 会自行添加 `addr=<server>`。

MiniBox 的可达性检查不使用你的 `hard` 或 `soft` 设置。它先用 `soft,timeo=10,retrans=1` 挂载导出根目录，再应用你的其他选项。因此死服务器不会拖住检查。你的选项排在后面并优先生效，这也是最好不要设置 `timeo=` 和 `retrans=` 的原因。

### 验证存储池

1. 在**卷**标签页，存储池显示**可达**及其剩余空间。
2. 创建一个 Box。在**卷**标签页，其 workspace 与 home 卷使用 NFS 存储池，cache 使用 `local`。
3. 在该 Box 的**终端**标签页运行：

   ```bash
   id                                  # uid=1000(dev) gid=1000(dev)
   mount | grep -E 'workspace|home/dev|tools|cache'
   echo ok > /workspace/nfs-test && ls -ln /workspace/nfs-test
   ```

   `/workspace` 与 `/home/dev` 显示 `type nfs4`、`vers=4.1` 和 `hard`。`/opt/minibox/tools` 相同但为只读。`/home/dev/.cache` 是本地文件系统。
4. 在服务器上，文件位于 `<export>/<workspace volume id>/nfs-test`，归 1000:1000 所有。卷 ID 是**卷**标签页中该卷名称下显示的 `vol_…` 值。
5. 重启 Box，再次读取该文件。

## NAS 宕机时

- 存储池显示**存储不可达**及挂载错误。Box 列表与 Box 页面会标记受影响的 Box。
- 在该池上创建、启动或重启 Box 会失败，返回 `503`，错误码 `docker_unavailable`。约 5 秒内发生。不会创建任何内容，也不会写入本地磁盘。
- 停止 Box 仍可用。
- 使用 `hard` 挂载的**运行中** Box 会挂起任何访问 `/workspace` 或 `/home/dev` 的进程，直到服务器恢复。包括来自 `exec` 与终端的命令。带超时的前台 `exec` 仍会在超时后不久返回。见[已知问题](#已知问题)。
- 各存储池并行检查。5 秒内无响应的池显示不可达，消息为 `no answer within 5 s`。**卷**标签页无论有多少 NFS 服务器宕机，都会在约 5 秒内响应。
- 用量统计同样不会等待 NAS。共享的用量在 30 秒的截止时间内读取。超时的共享记为一次失败的采样并注明原因，其他卷仍按各自的计划采样。
- 服务器恢复后，被挂起的进程继续运行。下一次检查显示存储池**可达**，已停止的 Box 可再次启动。无需重新挂载。

NAS 维护（如重启或固件升级）前，请停止使用该 NAS 存储池的 Box。

## 用量与配额

MiniBox 用 `df` 统计 NFS 池根目录的用量。该数值是整个共享的用量，池中所有卷共用，控制台会将其标注为整个共享的用量。MiniBox 从不遍历共享中的目录，在 NAS 上这样做可能非常耗时。

NFS 池中的卷不能设置软上限或硬上限，因为对单个卷设置的上限无法约束整个共享。若要限制 Box 在 NAS 上占用的空间，请在 NAS 本身为共享文件夹设置配额（前提是 NAS 支持）。MiniBox 的软告警是尽力而为，不是配额。参见[用量、上限与剩余空间](volumes-and-storage.md#用量上限与剩余空间)。

## 备份

- 对 NAS 上整个 MiniBox 导出的快照是灾难恢复层。Box 检查点按 Box 划分，与快照互补，不能替代快照。
- 存储系统本身不是备份。请将 NAS 快照，以及带密钥的检查点仓库，复制到第二处。
- 勾选**同时删除这个 Box 自有的数据卷**删除 Box 时，会移除 Docker 卷。无论是否勾选，Box 的数据都会保留在[回收站](checkpoints.md#回收站)中。但不会删除导出目录上的对应文件夹。需自行删除 `<export>/vol_…`。

## 故障排查

| 现象 | 消息 | 原因与修复 |
|---|---|---|
| 存储池显示**存储不可达** | `… failed to mount local volume: … protocol not supported` | 选项未设 `nfsvers=`，或在不支持 NFSv3 的内核上设了 `nfsvers=3`。添加 `nfsvers=4.1`。 |
| **存储不可达** | `… input/output error` | 服务器宕机，或 TCP 2049 端口无监听。启动 NFS 服务并检查防火墙。 |
| **存储不可达** | `… connection timed out` | 服务器地址错误，或网络/防火墙丢弃流量。 |
| **存储不可达** | `no answer within 5 s` | 检查在 5 秒内未完成。服务器可能无响应。检查会继续，服务器应答后存储池显示**可达**。 |
| **存储不可达** | `… no such file or directory` | 导出路径不存在，或客户端无权使用。NFSv4 会隐藏客户端不可用的导出，因此客户端限制可能表现为路径错误。Linux `nfsd` 可能报 `access denied by server`。 |
| 创建 Box 失败，`502`，错误码 `bad_gateway` | `Storage pool nas denied permission to create the volume directory: mkdir: cannot create directory '/mnt/vol_…': Permission denied` | squash 后的用户无法写入导出根目录。使用 `all_squash,anonuid=1000,anongid=1000` 或 `root_squash,anonuid=1000,anongid=1000`，并将导出文件夹设为 1000:1000 所有。错误响应的 hint 会列出这些选项。 |
| 创建 Box 失败，`502`，错误码 `bad_gateway` | `Uid 1000, the box user, cannot write the new volume directory …, so the volume was not created` | 新文件夹属于 `nobody`，squash 后的 root 无法改所有者。将导出改为 `all_squash,anonuid=1000,anongid=1000`。若文件夹已存在，在服务器上执行 `chown -R 1000:1000 <export>/vol_…`。 |
| Box 内 `chown` 成功但无变化 | 无 | 使用 `all_squash` 时的预期行为。每个文件都属于匿名用户。 |
| Box 内 `Stale file handle`，`start` 失败并报 `lstat …/_data: stale NFS file handle` | 无 | 挂载期间服务器上删除了该卷的文件夹或替换为新文件夹，例如恢复到新文件夹后。停止 Box 并将数据放回原处。若 start 仍失败，在计算节点上用 `sync; echo 2 \| sudo tee /proc/sys/vm/drop_caches` 清除客户端缓存。 |
| Box 内命令挂起 | 无 | 挂载为 `hard` 且服务器不可达。恢复服务器后进程继续。若需更快停止 Box，请停止 Box。 |
| 启动或创建返回 `503`，`docker_unavailable` | `Storage pool nas is unreachable: …` | MiniBox 拒绝在无法访问的存储上启动 Box。不会写入本地磁盘。修复存储池后重试。 |

## 已知问题

- 带 `timeoutSec` 的前台 `exec` 最多在超时后 2 秒返回，即使 `hard` 挂载仍被挂起。若届时停止尚未完成，调用返回 `status: running` 且 `timedOut: true`。MiniBox 会在后台继续尝试停止进程。每次尝试等待更久，最长 30 秒。停止成功后命令记为 `killed`。若命令先自行结束，则记为 `exited` 及相应退出码。
- `timeoutSec` 不限制引擎启动 `exec` 所需时间。超时从进程启动后开始计时。会阻塞的启动会一直等待。
- 服务器无响应时，对某存储池的一次检查会等待其挂载。之后对同一存储池的检查共享该等待，而不会再起一次。

## 路径存储池

若你更希望在宿主机上自行挂载 NAS（例如用 `autofs` 或 SMB），可使用路径存储池：

1. 在计算节点上将共享挂载到固定路径。
2. 在已挂载文件系统上创建标记文件 `.minibox-mounted`：

   ```bash
   sudo touch /mnt/nas/minibox/.minibox-mounted
   ```

3. 在**卷**标签页点击**添加路径**，添加存储池。

缺少标记文件时 MiniBox 拒绝写入。未挂载的共享绝不会被本地磁盘填满。

在 systemd 上，让 Docker 在挂载之后启动。为 `docker.service` 创建 drop-in：

```ini
[Unit]
RequiresMountsFor=/mnt/nas/minibox
```
