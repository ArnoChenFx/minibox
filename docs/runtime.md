# Runtime 与 Host

本文说明 MiniBox 与容器引擎之间的边界：`Runtime` 接口、错误契约、Host 模型、如何新增后端，以及测试中 fake 与真实引擎的用法。对应 [#32](https://github.com/ArnoChenFx/minibox/issues/32)，多宿主机的连接与路由见下文「多宿主机」一节（[#21](https://github.com/ArnoChenFx/minibox/issues/21) 第一部分），整体设计见 [design.md](design.md)。

单机部署只注册一台隐式的 `local` 主机。卷与存储池（#24）在这个接口上增加了 `listVolumes`、带驱动选项的 `createVolume`、`runHelper` 和 `diskUsage`。业务代码仍然只通过 `Runtime` 与 `HostCtx` 访问引擎。

## 分层

| 路径 | 职责 |
| --- | --- |
| `src/runtime/index.ts` | `Runtime` 接口、数据类型与 `RuntimeError`，不依赖任何 SDK |
| `src/docker/` | Docker 适配器（`runtime.ts`、`errors.ts`、`logs.ts`、`stats.ts`），唯一使用 dockerode 的代码 |
| `src/services/` | 业务逻辑：boxes、volumes、images、snapshots、templates，只通过 `Runtime` 与 `HostCtx` 访问引擎 |
| `src/volumes/` | 卷记录、存储池、探测与引擎卷认领。文件在 `DATA_DIR`，不在引擎里 |
| `src/host/` | `registry.ts`（Host、HostCtx、HostRegistry）、`sampler.ts`（HostSampler：盒子缓存与资源采样）、`live.ts`（实时帧类型）、`metrics.ts`（HostMonitor）、`procfs.ts` |
| `src/routes/`、`src/ws/` | HTTP 与 WebSocket 入口 |
| `src/lib/errors.ts` | 把 `RuntimeError` 映射为 HTTP 响应 |
| `src/app.ts` | 组合根：选择 Runtime，注册 `local` 主机 |

`tests/architecture.test.ts` 检查两条规则：只有 `src/docker/` 可以 import `dockerode`；只有 `src/docker/` 与组合根 `src/app.ts` 可以引用 Docker 适配器。业务代码因此无法绕过接口直接调用引擎。

## Runtime 接口

`Runtime` 覆盖 MiniBox 需要的全部引擎能力：

- 连通性：`ping`、`info`
- 容器：`listContainers`、`inspectContainer`、`createContainer`、`startContainer`、`stopContainer`、`restartContainer`、`pauseContainer`、`unpauseContainer`、`removeContainer`、`renameContainer`、`updateContainer`、`containerLogs`、`containerDiff`、`containerStats`、`commitContainer`、`putArchive`、`getArchive`、`statPath`
- exec：`startExec` 返回会话。未设置 `tty` 时是交互终端（Web 终端走这条路径）：`stream` 同时承载输入和输出，并带 `resize()` 与 `inspect()`。`tty: false` 时标准输出与标准错误分开，会话还提供 `stdout`、`stderr` 与 `kill()`。`user` 缺省时沿用容器自己的用户；命令 exec 传入 `dev`。所有 exec（包括交互终端）都经一层 `/bin/sh` 包装运行，包装 shell 的参数中，`minibox-exec` 之后紧跟一个随机令牌。`kill()` 在容器内执行一段 POSIX `sh` 脚本：「标准」与「宽松」档位以 `root` 执行，使 `sudo` 等提权子进程也能被结束；「严格」档位以 exec 的用户执行，该档位无法提权。脚本通过 `/proc/*/cmdline` 找到包装 shell。`/tmp/.minibox-exec-<令牌>.<pid>` 形式的标记文件只提供候选 pid，每个候选同样要核对命令行。之后沿 `/proc/<pid>/stat` 的父进程号收集进程；包装 shell 自己是会话或进程组首进程时，同一会话与进程组中的进程也一并收集。每个进程先用 `SIGSTOP` 冻结，并等待其停止后才继续扫描，直到一次扫描不再发现新进程（最多 5 轮）。然后逐个 `SIGKILL`，包装 shell 最后结束。脚本退出码：0 表示全部结束；1 表示有进程无法发信号（脚本恢复其余进程并退出），或有进程存活（其余进程保持冻结，以便重试）；2 表示找不到包装 shell。`kill()` 只有在 Docker 报告 exec 已结束后才算成功，否则抛出 `engine` 错误，exec 仍在运行，可以再次调用。exec 已结束时 `kill()` 直接返回。交互终端的 `kill()` 同样可用，以 exec 的用户（`dev`）执行：Web 终端断开时用它结束其中的 tmux attach 进程；tmux 服务器不在这棵进程树里，会话因此保留。这一层要求容器里有 `/bin/sh`、`cat`、`rm` 与 `sleep`（`sleep` 需支持小数秒）。
- 事件：`events`，按标签与类型过滤；`since`（Unix 秒）让引擎补发该时间之后记录的事件，订阅者因此可以在订阅之后再列出容器而不漏掉变化；消费者停止迭代或 `signal` 中止时结束
- 镜像：`listImages`、`inspectImage`、`pullImage`、`removeImage`、`buildImage`
- 卷：`inspectVolume`、`listVolumes`、`createVolume`、`removeVolume`、`volumeRootOwner`、`setVolumeRootOwner`
- 辅助容器与磁盘：`runHelper`、`diskUsage`
- 网络：`ensureBridgeNetwork`、`reattachNetwork`

实现需要满足以下语义，业务代码依赖这些约定：

- `startContainer` 对运行中的容器成功，`stopContainer` 对已停止的容器成功。
- `pauseContainer` 冻结运行中容器的全部进程，容器仍报告为运行中（`running: true`，`state: paused`）。对已暂停或已停止的容器返回 `conflict`；`unpauseContainer` 对未暂停的容器不做任何事，与 `startContainer` 一样可以重复调用。
- `pullImage(ref)` 只在镜像不在本地时拉取，本地已有时不访问镜像仓库。引擎返回 404（仓库或标签不存在）时为 `not_found`；拉取过程中报告的错误为 `engine`。
- 运行中的容器只有 `removeContainer(id, { force: true })` 才能删除。
- 仍被容器挂载的卷不能删除，`removeVolume` 返回 `conflict`。
- `createVolume` 对已存在的卷成功，并保留原有标签和驱动选项。第三个参数选择驱动，例如本地驱动配上 NFS 或 bind 选项。
- `inspectVolume` 与 `listVolumes` 返回驱动名和驱动选项；引擎没有报告选项时 `options` 缺省。
- 挂载的 `mode: "ro"` 会写成绑定串末尾的 `:ro`。`kind: "bind"` 表示宿主机路径，缺省表示命名卷。
- `runHelper` 把短生命周期容器跑到结束，返回时容器已被删除。容器不接入网络（`NetworkMode: none`），根文件系统只读，`/tmp` 是 tmpfs，默认 16 MiB，`tmpfsBytes` 可以按字节指定大小，丢掉全部能力，只加上调用方在 `capAdd` 里列出的能力，禁止提权，内存默认 256 MiB，进程数默认 64；`memoryBytes`、`pidsLimit` 与 `timeoutSec` 按调用指定，超时未指定时为 30 秒。容器带 `AutoRemove`，引擎在它退出后删除。超时会杀掉容器并返回退出码 124。日志去掉流帧头。镜像是基础模板。各用途只请求所需的权限：卷 chown（`0:0`，`CHOWN`）、NFS 与路径池的子目录（`0:0`，`CHOWN`、`DAC_OVERRIDE`）、删除空目录（`0:0`，`DAC_OVERRIDE`）、测量（`0:0`，`DAC_READ_SEARCH`）、池探测（`1000:1000`，无能力）。
- `runHelper` 的 `secrets` 把小型密钥以 `/run/secrets/<名字>` 只读地交给辅助容器，密钥不进入 `env` 也不进入容器配置，因为 `docker inspect` 会显示它们。适配器先把密钥写进一个只存在于本次运行的卷：用创建但不启动的容器、以 Docker 归档接口写入（只读根文件系统的容器不接受 `docker cp`），再以只读方式挂到辅助容器，运行结束后删除该卷，无论成功与否。该卷带辅助容器自己的标签和 `minibox.helper-secrets=true`，进程若在删除前崩溃，下次启动的对帐会删除本实例（同一内部标签）残留的这类卷。检查点仓库的密码就是这样传给 restic 的（`RESTIC_PASSWORD_FILE`）。
- 辅助容器的命名卷挂载带 `NoCopy`。没有它，Docker 会把镜像里挂载点的目录复制进空卷，并覆盖卷根的属主和权限：基础模板的 `/mnt` 是 `root:root 755`，已 chown 为 `1000:1000` 的空卷挂到 `/mnt` 上就会变回 root。箱子容器的挂载不带 `NoCopy`，首次使用时仍从镜像复制初始内容。
- `diskUsage(path)` 返回该路径所在文件系统的总字节和空闲字节。Docker 适配器用 `statfs`。路径不存在时为 `not_found`。
- `statPath(id, path)` 用 `HEAD /containers/{id}/archive` 读取 `path` 的元数据（类型、大小、mode、引擎解析后的链接目标），不传输归档内容，所以对任意大小的目录开销相同；最后一级符号链接不跟随，容器可以是已创建但未启动的。`path` 不存在时返回 `not_found`。
- `volumeRootOwner(id, path)` 读取容器内 `path` 目录的属主，经由 archive 接口完成，容器可以是已创建但未启动的。`path` 不存在时返回 `not_found`。
- `setVolumeRootOwner(volume, owner, image)` 用 `runHelper` 运行一个辅助容器，只把卷的根目录 `chown` 为 `uid:gid`，不递归。辅助容器以 `0:0` 运行，只加上 `CHOWN`，不联网，结束后删除。卷不存在时返回 `not_found`，且不运行辅助容器：挂载缺失的命名卷会让引擎创建它，所以先检查卷。镜像不存在、辅助容器无法启动或 `chown` 失败时返回 `engine`。
- 卷的根目录属主由 Docker 决定：卷为空时，挂载会把镜像中挂载点的内容与属主复制进卷；卷已有内容后，之后的挂载不再改变根目录的属主。
- 创建容器时，镜像标签与请求中的标签合并，请求中的标签优先。
- 创建同名容器返回 `conflict`。调用方不先查询再创建，重名由引擎判定。
- 提交容器时，容器标签与 `LABEL` 指令合并，指令优先。
- `containerLogs` 返回去掉流帧头后的文本。
- `containerDiff` 返回可写层变更。引擎的 `null`（没有变更）变成空列表。`added` 对应 kind 1，`deleted` 对应 kind 2，其余记为 `modified`。
- `createContainer` 的 `env` 是 `NAME=value`，由引擎合并到镜像环境变量之上。挂载 `mode: "ro"` 会在绑定后追加 `:ro`；可写挂载不追加模式。
- `buildImage` 可以带 `onLog`（每段输出回调一次）和 `signal`。取消时在引擎连接关闭后抛出 `AbortError`，而不是 `RuntimeError`，因此不会被映射成 502。引擎可能在连接关闭前一直构建，所以调用返回时，调用方才能认为这次构建已经结束。`commitContainer` 的 `signal` 只在提交前和提交返回后检查；已经生成的镜像不回滚。
- `listContainers` 跳过在列出与检查之间消失的容器。
- `createContainer` 的 `hardening`（能力、`no-new-privileges`、进程数上限、ulimit、运行时）只覆盖请求中出现的字段，其余保持引擎默认值。
- `ensureBridgeNetwork(name, { interContainerComm })` 在网络不存在时创建桥接网络。同名网络已存在但不是桥接网络，或容器间通信的设置不同，返回 `conflict`。
- `reattachNetwork(id, name)` 把容器接入同名的当前网络。引擎把容器固定在它上次运行时的网络 ID 上，网络被删除并重建后，不先调用它，已停止的容器无法启动。容器已在当前网络上时不做任何事；容器不在 `name` 上时返回 `invalid`。

## 错误契约

引擎失败必须以 `RuntimeError` 抛出：

- `kind` 决定 HTTP 结果。
- `detail` 是引擎返回的原始消息，取不到时为传输层消息，展示给用户。
- `message` 是完整文本，用于日志。

其它异常都是意外错误，`toAppError()` 把它们映射为 500 `internal`。

| kind | 含义 | HTTP 结果 |
| --- | --- | --- |
| `not_found` | 对象不存在 | 404，`not_found`，key `docker_not_found` |
| `conflict` | 名称或镜像冲突、运行中的容器不能删除、卷正在使用 | 409，`conflict`，key `docker_conflict` |
| `invalid` | 引擎认为请求无效（其它 4xx） | 400，`docker_error`，消息为引擎原文 |
| `unavailable` | 连接失败（socket 不存在、被拒绝、无权限） | 503，`docker_unavailable` |
| `engine` | 其它引擎错误（5xx 等） | 502，`docker_error`，key `docker_error`，参数 `detail` |

`src/docker/errors.ts` 的映射规则：连接错误码 `ENOENT`、`ECONNREFUSED`、`EACCES` 为 `unavailable`；HTTP 404 为 `not_found`，409 为 `conflict`，其它 4xx 为 `invalid`，其余为 `engine`。

## Host 模型

- `Host` 为 `{ id, name, kind, endpoint, labels, status, transport }`。`transport` 为 `local`、`unix`、`tcp` 或 `ssh`，`endpoint` 是不含凭据的文本。`probeHost()` 调用 `ping` 后把 `status` 记为 `online` 或 `offline`，`/api/health` 使用它。
- `HostCtx` 是业务代码拿到的上下文：`{ host, runtime, prefix, keys, baseTemplateTag, stopTimeoutSec, readTimeoutMs, templatesDir, security, monitor, sampler, specs, volumes, pulse, checkpoints, checkpointEngine, checkpointPolicy, power, capacity(), multiHost() }`。`readTimeoutMs` 是远端引擎一次读取的上限（`ENGINE_READ_TIMEOUT_MS`，5 秒）。`monitor` 只在本机运行并读取 `/proc`，远端的 `capacity()` 来自 `docker info`。`multiHost()` 在控制面有多于一台宿主机时为真，箱子的响应只在此时带 `hostId`。services 的函数接收 `HostCtx`，而不是 host id。`stopTimeoutSec` 来自 `STOP_TIMEOUT_SEC`（默认 3，允许 0 到 300），停止与重启 Box 时传给 `stopContainer` 与 `restartContainer`。`specs`、`volumes` 与 `checkpoints` 都是控制面共享的一份存储（`DATA_DIR/boxes`、`DATA_DIR/volumes`、`DATA_DIR/pools.json` 与 `DATA_DIR/checkpoints`），不是每个引擎一份；`pulse` 是共享的内存心跳。每条卷与检查点记录自己带 `hostId`。检查点的 restic 仓库则是每台宿主机一个（见「多宿主机」）。
- `ContainerInfo` 还包含 `imageId`、`pidsLimit`、`restart` 与 `mounts`。`updateContainer` 可以改 CPU、内存、swap、进程数上限和重启策略，且不会重建容器，也不会改标签。
- `HostRegistry` 的 `add()` 对重复 id 抛错；`get(hostId = "local")` 对未知 id 抛错。

## 多宿主机

第一部分（[#21](https://github.com/ArnoChenFx/minibox/issues/21)）加入直连的远端宿主机，以及控制台中的宿主机管理。Agent、`host: "auto"` 调度、跨机迁移与远端端口预览留到后续部分。

- **登记**：`HostManager`（`src/host/manager.ts`）在应用创建时读取 `DATA_DIR/hosts.json`（`HostStore`，权限 600）。每台远端宿主机在 `HostRegistry` 中有一个 `HostCtx`，登记时调用 `attach()` 开启它的采样器与容器监视。连接方式由端点决定：`unix://` 直接使用套接字，`tcp://` 使用双向 TLS，`ssh://` 由 `SshTunnel` 在本地开一个 Unix 套接字，每条连接经 SSH 转发到远端的引擎套接字。`local` 由 `createLocalHost()` 创建，不能删除。
- **凭据**：TLS 与 SSH 的凭据写入 `DATA_DIR/hosts/<id>/`，目录权限 700，文件权限 600。它们不在 `hosts.json` 中，也不出现在任何响应、日志或审计中。读取时权限过宽的文件会收紧为 600。凭据文件缺失时宿主机仍然登记，但它的运行时对每次调用都返回 `unavailable`（`unreachableRuntime()`），其箱子显示为不可达，而不是消失。
- **路由**：箱子的操作经由 `hostOfBox()` 到达规格中 `host` 指定的宿主机。卷、检查点与 exec 分别经由 `hostOfVolume()`、`hostOfCheckpoint()` 与 `hostOfExec()` 找到自己的宿主机。不存在 `/api/hosts/:host/...` 形式的路由。创建箱子时 `host` 缺省为 `local`，指定未登记的宿主机返回 `404`。
- **读取超时**：远端宿主机的每次引擎读取最多等待 `ENGINE_READ_TIMEOUT_MS`（5 秒）。列表（`fromEveryHost()`、`listAllBoxes()`）并行读取所有宿主机。超时、失败或已离线的远端宿主机不阻塞其它宿主机：其箱子以 `unreachable` 状态列出，卷与检查点则从结果中略去。本机的失败仍使整个列表失败。
- **探测**：`HostManager.refresh()` 每 30 秒（`PROBE_INTERVAL_MS`）对每台宿主机调用 `ping` 与 `info`，记录延迟、引擎版本与容量。`GET /api/hosts` 返回这些结果，离线宿主机保留条目，并给出最近一次失败的原因。
- **管理接口**：`/api/hosts` 的列表、添加、测试与删除只允许所有者（scope `host:manage`），令牌无论持有什么 `hosts` 授权都不能使用。`POST /api/hosts/test` 不保存任何东西。添加 SSH 宿主机时，请求必须带上核对过的 `hostKeyFingerprint`（见 [design.md](design.md) 决策 69）。
- **已知限制**：远端的端口预览（`src/preview/proxy.ts`）与快照接口返回 `501`。宿主机级的 CPU 与内存占用只统计本机，远端只显示 `docker info` 报告的核数与内存容量；箱子自己的占用仍来自各自的容器统计。模板与检查点不复制到其它宿主机，所选宿主机缺少模板镜像时，创建返回 `400`（`template_image_missing`）。`host: "auto"` 调度与跨机迁移尚未实现。

## 盒子缓存与采样器

每台主机有一个 `HostSampler`（`src/host/sampler.ts`）。它是该主机唯一的容器事件订阅，也是唯一维护盒子缓存、资源采样与日志跟随的组件。`ContainerWatch` 经由 `subscribeEvents()` 接收同一份事件。组合根在服务启动时（`boot()`）调用 `start()`，关闭时调用 `stop()`；`startServer` 不启动它，测试需要时显式调用。

- **缓存**：订阅容器事件（`events`，标签 `<前缀>=true`，类型 `container`），并带上 `since`，使订阅与随后的列表之间发生的变化不会丢失。每次连接都先订阅，再调用 `listContainers` 建立初始状态。`start`、`die`、`stop`、`update`、`rename` 等状态变化事件让对应容器重新 `inspectContainer`，`destroy` 将其移出缓存。没有规格的容器在此时认领，与列表的行为一致。
- **串行**：所有引擎读取与缓存更新都在同一个队列中，按到达的顺序执行。`inspect` 因此不会覆盖排在它之后的事件所报告的变化。服务层修改盒子后调用 `observe()` 并等待其完成，响应返回时缓存已经反映该修改。
- **超时**：队列中的读取不会无限等待。`inspect` 超过 5 秒（`INSPECT_TIMEOUT_MS`）未返回时，请求经由信号取消，该容器保留缓存中的旧状态，并在下一轮采样时重读，而不在同一次处理中立即重试，以免再占用队列 5 秒。同一批中的容器八个一组并发读取（`INSPECT_CONCURRENCY`），因此 N 个挂起的容器合计占用队列最多 ⌈N ÷ 8⌉ × 5 秒。订阅后的首次列出超过 30 秒（`LIST_TIMEOUT_MS`）未返回时，本次订阅失败，按断线的退避重试，此间读取退回引擎。`observe()` 最多等待 5 秒（`OBSERVE_WAIT_MS`），超时后调用方照常返回，写入仍在队列中按顺序执行：另一个盒子的修改因此最多延迟 5 秒返回，它在缓存中的结果则要等挂起的读取结束后才出现。
- **采样**：有实时流打开时，每隔 `METRICS_INTERVAL_MS` 对每个运行中的盒子调用一次 `containerStats`。没有实时流时，只有租约有效才按 30 秒（且不短于 `METRICS_INTERVAL_MS`）采样。租约由 `need()` 续期，时长为 `DEMAND_LEASE_MS`（5 分钟），过期后不再调用引擎。读取用量的路径都会续期：带 `stats` 的盒子列表与详情、统计接口，以及空闲自动休眠对空闲候选的盒子在检查 CPU 之前的读取。读取时若最近一轮结束已超过 `STALE_AFTER_MS`（60 秒），`sampleSoon()` 先等待一轮（最多 5 秒），同时到达的读取共用这一轮。两者都没有时，不调用 `containerStats`。从没有实时流变为有实时流时，采样器立即采样一轮；最后一个实时流关闭后，租约有效则转为空闲间隔，否则停止。统计调用并发 8，每个调用的超时为 `min(METRICS_INTERVAL_MS, 5 秒)`，经由 `containerStats(id, { signal })` 把信号交给引擎请求；超时的调用记为一次缺失的采样，不影响其它盒子。统计调用在队列之外执行，队列中只排队写入环形缓冲（长度为 `METRICS_HISTORY`）的一步。一轮结束后才安排下一轮，两轮不会重叠。调用频率只取决于是否有实时流打开或租约是否有效，与打开的流数量无关。
- **发布**：盒子视图变化时发布 `box`，每轮采样发布 `sample`，连接状态变化发布 `link`。`HostMonitor` 在有实时订阅者时，每个间隔发布 `host`。它们经由 `LiveSink` 进入应用的事件总线（`AppTopics`），与审计事件共用这一条总线。实时帧只在总线上流动，从不写入 `events.db`。`box` 帧中的环境变量只含名称（`liveBox`），REST 接口仍返回值。`sample` 与 `host` 帧带有主机 id 作为键：实时流的待发队列里，同一键只保留最新一帧（`src/events/frames.ts`）。
- **断线**：事件流结束或出错时状态变为 `down`，之后按 1 秒、2 秒、4 秒……的间隔重连，最长 30 秒。重新订阅并完成列表后，计数清零。首次列出超过 30 秒未返回时同样视为断线（见上文「超时」）。
- **重新列出**：链路处于就绪状态时，每 60 秒（`relistMs`）重新列出一次容器，替换缓存并发布其中的变化。事件流静默停止（没有错误，也不结束）时，缓存因此最多滞后约 60 秒。重新列出不改变链路状态，链路断开时也不运行。列出在队列之外进行，并带有取消信号：超过 30 秒（`relistTimeoutMs`）未返回即放弃，并取消引擎请求。同一时间只有一次重新列出在进行，直到该次列出结束（返回、失败或被取消）才开始下一次，因此挂起的引擎调用既不阻塞写操作，也不会在后台堆积列出。列出期间若缓存有过变化（事件、写操作或重新订阅），结果被丢弃，等待下一次。

- **日志跟随**：每台主机上，每个盒子至多一条容器日志跟随（`LogFollows`，`src/host/log-follow.ts`），由该盒子的所有日志流共享，与订阅者数量无关。只有缓存就绪且盒子有容器时才跟随。跟随请求带时间戳的容器日志，`tail` 为 5000。环形缓冲保留最近 5000 行或 2 MiB，先到者为准。新订阅者立即取得缓冲中最新的 `tail` 行，之后每行只送达一次。最后一个订阅者离开后，跟随再保留 30 秒（`LOG_LEASE_MS`）。容器停止时引擎端的跟随结束，缓存显示它重新运行后再接续；停止期间缓存的其它变化不会再次读取它。引擎断开跟随时，从缓冲中最新一行之前 1 秒（`RESUME_WINDOW_MS`）续读，并按文本计数丢弃已送出的行。重试间隔为 1 秒起、翻倍、最长 30 秒。跟随不占用采样的队列。

`ready()` 为真，表示缓存是最新的（已订阅且已列出）。此时 `src/services/boxes.ts` 中的读取不调用引擎：`listBoxes` 与 `readBox` 读取缓存，`statsOf` 先按需采样（见「采样」），再返回不超过 60 秒的最近一次样本，`getStatsWithHistory` 返回环形缓冲。缓存未就绪时，读取退回引擎；统计只读取运行中的盒子。`GET /api/boxes/:id/logs` 不经过缓存，但同一盒子与 tail 的引擎读取在 2 秒窗口内共享。日志流由上文的日志跟随提供，缓存未就绪时不启动跟随。

## 新增后端

1. 在 `src/<backend>/` 下实现 `Runtime`，只在该目录中引入 SDK。SDK 的错误在适配器内转换为 `RuntimeError`，参考 `src/docker/errors.ts`。
2. 连接失败映射为 `unavailable`。否则用户看到的是 502 而不是 503。
3. 在组合根 `src/app.ts` 中创建 `HostCtx` 并调用 `hosts.add()`。远端的 Docker 宿主机不在组合根中登记，而由 `HostManager` 在运行时添加（见「多宿主机」）。新的连接方式还需要同时扩展 `parseEndpoint()` 与 `openLink()`。
4. 更新 `tests/architecture.test.ts` 中的规则，允许新目录引入其 SDK。
5. 为新后端编写与 `tests/docker-runtime.test.ts` 同类的真实引擎测试。

## 测试

- `FakeRuntime`（`tests/support/fake-runtime.ts`）是内存实现，遵循服务层依赖的语义：名称与镜像冲突、`not_found`、被挂载的卷不能删除、标签合并。仍被容器使用的镜像，移除最后一个标签需要 `force`，强制移除后镜像成为悬空镜像。`createVolume` 保留已有卷的标签和驱动选项。`disk` 提供 `diskUsage` 的默认值。`helperHandler` 决定 `runHelper` 的退出码和日志；默认对 `du` 返回 `0`，对 `df` 和 `test -f` 返回可解析的一行。镜像不存在时 `runHelper` 为 `not_found`。缺失的命名卷像引擎一样，在创建、启动、重启和运行辅助容器时自动创建。只读挂载在 `inspect` 里仍是 `ro`。
  - 它记录每次调用（`calls`、`callsTo(op)`、`ops()`）。
  - `fail(op, error)` 让下一次该操作失败，`down = true` 模拟引擎不可达。
  - 网络有 ID，容器第一次启动时固定在当前网络的 ID 上。网络被删除并重建后，启动该容器返回 `not_found`，直到调用 `reattachNetwork`，与真实引擎一致。
  - `seedImage()` 与 `seedContainer()` 预置状态，不记录调用。
  - 卷根目录的属主记在 `volumeOwners` 中。卷第一次挂载时，若挂载点是 `/workspace` 且镜像标签给出 `minibox.template.uid` 与 `minibox.template.gid`，卷取该属主，否则为 root；之后的挂载不再改变它，与真实引擎的复制行为一致。`seedVolumeOwner()` 预置属主，不记录调用。`setVolumeRootOwner` 要求卷与辅助镜像存在，并直接设置属主，不模拟辅助容器。
  - 非 TTY exec（`spec.tty === false`）使用 `execScript`（默认空输出、退出码 0）。设为 `null` 时一直运行，直到 `kill()`，退出码 137。TTY 路径仍在返回前打印 `$ `。
- tmux 会话的模拟：`tests/support/fake-tmux.ts` 实现会话服务用到的 tmux 命令（`new-session`、`has-session`、`list-sessions`、`set-option`、`display-message`、`capture-pane`、`send-keys`、`kill-session`，以及读取版本的 `-V`，版本号由 `version` 设置）。命令为 `tmux` 的 exec 由 `startTmux`（`tests/support/fake-runtime.ts`）处理，`tmux attach-session` 的 exec 接到其中的会话上，附着的客户端收到会话的输出。模拟只保存屏幕文本：不解释终端转义序列，也不重现 tmux 的重绘。真实行为由 `tests/docker-sessions.test.ts` 在真实引擎上验证。`failExecKill(error)` 让下一次 exec 的 `kill()` 失败，`holdExecKill()` 阻塞 `kill()` 直到 `release()`，用于测试终止失败后的重试，以及并发的终止。
- `tests/support/app.ts` 的 `createTestApp(overrides, runtime)` 创建使用 fake 的应用：端口 0，不访问真实 socket，标签前缀为 `mbtest`。`silenceLogs()` 静默日志输出，`rejectionOf()` 取得 rejected 的错误。
- 假引擎适配器测试：`tests/docker-adapter.test.ts` 在一个 unix socket 上启动最小的 Engine API（不需要 daemon），经由真实的 `createDockerRuntime()` 检查状态码到 `kind` 的映射、列出时跳过已消失的容器、`stopContainer` 发送的 `t` 参数等，并检查列表的 `inspect` 缓存：复用、按状态失效、变更后失效、过期，以及变更期间尚未返回的 `inspect` 不会被缓存。挂起的统计调用、`inspect` 与列出在信号中止后以 `AbortError` 结束，引擎一侧看到连接关闭。
- exec 终止脚本的宿主机测试：`tests/kill-tree.test.ts` 在宿主机的 `/proc` 上直接运行终止脚本（仅 Linux），覆盖包装 shell 与子进程、只由标记文件指出的无关进程、删除自身标记的命令、同一会话中的孤儿进程，以及退出码。
- 真实引擎测试：运行 `bun run test:docker`（`scripts/docker-integration.ts`）。脚本检查引擎，缺少镜像时拉取 `MINIBOX_TEST_IMAGE`（默认 `alpine:3.20`）与检查点仓库的 `restic/restic:0.18.1`，用新的 `mbit` 前缀逐个文件运行 `tests/docker-runtime.test.ts`、`tests/docker-checkpoint.test.ts`、`tests/docker-sessions.test.ts`、`tests/docker-ssh.test.ts`、`tests/docker-tools.test.ts` 与 `tests/docker-hosts.test.ts`（每个文件一个进程），结束后按前缀删除容器、模板与快照镜像、卷（包括名称以前缀开头的检查点仓库卷）与网络。测试失败时会再清理一次，以覆盖仍在进行中的快照提交。可选环境变量为 `DOCKER_SOCKET`（默认 `/var/run/docker.sock`）。`MINIBOX_TEST_IMAGE` 须包含 `/bin/busybox`，sudo 测试借它模拟 setuid 的 `su`；默认的 `alpine:3.20` 满足此条件，Debian 镜像不满足。
- 直接运行测试文件：`MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-runtime.test.ts`。`MINIBOX_TEST_PREFIX` 必须以 `mbit` 开头，清理只作用于该前缀，因此不会误删真实安装的资源。直接运行时没有脚本的兜底清理，中断后可用 `docker ps -a --filter label=<前缀>` 检查残留。未设置 `MINIBOX_TEST_DOCKER=1` 时跳过。
- 检查点（单元）：`tests/checkpoint-store.test.ts` 检查记录的读写、ID 格式、文件权限与并发变更的排队；`tests/restic-engine.test.ts` 用假的辅助容器检查 restic 的备份、还原与 forget 的参数、退出码、仓库的初始化与密码的使用；`tests/checkpoints.test.ts` 与 `tests/checkpoint-operations.test.ts` 检查拍摄、派生、回滚、置顶与删除的服务和 REST 行为，快照引擎为 `FakeCheckpointEngine`（`tests/support/fake-snapshots.ts`）；`tests/restored-volumes.test.ts` 检查还原卷的属主与命名，以及为派生预留的 Box id。`tests/checkpoint-retention.test.ts` 检查保留策略与容量上限，包括被待定回滚持有的安全检查点不被清理；`tests/checkpoint-recovery.test.ts` 检查启动对帐解冻暂停的容器、启动停止式拍摄留下的 Box；`tests/rollback-pending.test.ts` 检查回滚的确认、撤销与待定状态；`tests/web-checkpoints.test.ts` 检查控制台检查点页的规则与渲染。
- 检查点（真实引擎）：`tests/docker-checkpoint.test.ts` 用真实的 restic 仓库检查：经派生与经回滚恢复的 `/workspace` 与拍摄时一致（路径、属主、模式与内容哈希）；停止式拍摄的数据完好且 Box 会再次启动；容量超限时拒绝自动检查点，手动拍摄仍可进行；保留策略只删除自动检查点；确认删除旧卷，撤销重新挂载旧卷；启动对帐解冻暂停的容器；restic 辅助容器以文件读取密码，密码不出现在容器配置中。
- 盒子缓存与采样器：`tests/host-sampler.test.ts` 检查缓存的更新与发布、同一队列中的串行执行、断线后的退避重连与重新列出、采样的节奏（有无实时流，租约的续期与到期，过期的样本不返回）、挂起的统计调用不阻塞停止、挂起的 `inspect` 只使该容器的读取超时（另一盒子的停止照常返回，超时后的旧状态在下一轮采样时更新）、挂起的首次列出使链路断开并在退避后恢复、定期重新列出（挂起的列出不阻塞写操作，列出期间有变化则丢弃结果，超时后取消请求，且在它结束前不再开始列出），以及环形缓冲的长度；`tests/box-cache-api.test.ts` 以计数的 fake 运行时检查列表、详情、统计与日志的引擎调用，以及主机汇总不再列出引擎。
- 日志跟随与日志流：`tests/log-follow.test.ts` 检查每盒子一条跟随、新订阅者的快照、续读时按文本去重、容器替换与停止（停止的盒子只读一次）、租约与环形缓冲的边界；`tests/sampler-logs.test.ts` 检查采样器的跟随在链路断开时暂停并恢复、盒子删除时发送 `closed`、主机停止时发送 `stopped`；`tests/log-stream.test.ts` 检查帧格式、慢客户端溢出时的 `sync`、容器替换、心跳与结束；`tests/box-logs-stream.test.ts` 检查 `GET /api/boxes/:id/logs/stream` 的 `401`、`403`、`404` 与 `429`、令牌范围与吊销、审计，以及两条流共享一条跟随；`tests/container-watch.test.ts` 检查经由采样器订阅的容器事件只记录一次。`tests/docker-adapter.test.ts` 检查 `followLogs` 的请求参数与中止；`tests/docker-runtime.test.ts` 在真实引擎上的三个 `followed log` 用例需要 `MINIBOX_TEST_DOCKER=1`。
- 实时流与前端：`tests/frame-buffer.test.ts` 检查队列的字节上限、按键替换与 `raiseByteLimit`；`tests/stream-slots.test.ts` 与 `tests/stream-limit.test.ts` 检查并发上限、`429` 响应与名额释放，包括读取出错的流会释放名额；`tests/event-stream.test.ts`、`tests/task-stream.test.ts` 与 `tests/events-live.test.ts` 检查帧格式、`sync` 与 `reset`、超过字节上限的 `sync` 整帧发送且其后的帧不被重置、读取出错时运行一次 `onEnd` 并释放订阅、实时帧不带 `id`、过滤条件对实时状态的限制，以及实时帧不写入事件库；`tests/web-live.test.ts` 检查前端的单一连接、断线时的轮询回退与重连退避，以及日志流客户端的帧处理、重连与无 `EventSource` 时的状态。
- 真实引擎：`tests/docker-runtime.test.ts` 中的 `the box cache against a real engine` 检查列表不调用引擎，以及在 MiniBox 外部停止的盒子经由事件进入缓存。同一文件中的 `a stats call gives up when its signal aborts, so a sampler's timeout ends the engine request` 检查采样超时所用的 signal 确实结束引擎请求；`an inspect and a listing give up when their signal is already aborted...` 检查 `inspect` 与列出接受取消信号（设置 `MINIBOX_TEST_DOCKER=1` 时运行）。
- 多宿主机（进程内）：`tests/host-endpoint.test.ts` 检查端点的解析与拒绝；`tests/host-store.test.ts` 检查 `hosts.json` 的严格解析与凭据文件的权限；`tests/host-credentials.test.ts` 检查凭据不出现在响应、文件、错误、审计与日志中；`tests/host-tls.test.ts` 用 `tests/support/pki.ts` 生成的证书检查双向 TLS 的接受与拒绝；`tests/host-ssh.test.ts` 用 `startSshHost()`（进程内的 ssh2 服务）检查主机密钥的确认、不符时不登录，以及私钥文件的权限；`tests/host-routing.test.ts` 检查按 `host` 路由、名称全局唯一、容量在目标宿主机上校验，以及删除前的占用检查；`tests/host-aggregation.test.ts` 检查超时、离线与本机失败；`tests/host.test.ts` 检查登记表与 `probeHost()`。`tests/token-routes.test.ts` 检查令牌不能使用宿主机管理，`tests/parity.test.ts` 的 HTTP 录制包含宿主机的操作。
- 第二台宿主机（真实引擎）：`tests/docker-hosts.test.ts` 经 SSH 添加宿主机，SSH 一侧是进程内的 ssh2 服务，把通道转到真实的 Docker 套接字（需要 `MINIBOX_TEST_DOCKER=1`，`bun run test:docker` 会运行它）。它检查未确认的密钥被拒绝且不登录；确认后宿主机在线，报告的版本与容量与真实引擎一致；两台宿主机上各有一个真实容器；停止与启动在远端生效；有箱子时删除被拒绝（`host_in_use`），箱子删除后可以删除。
- CI 中的 `Integration tests (real Docker engine)` 任务运行 `bun run test:docker`，不是必需检查。

## 已知限制

- exec 的 `kill()` 能结束包装 shell 的进程树，以及仍在包装 shell 的会话或进程组里的进程，包括已被 init 收养但会话未变的后台进程。以下情形不在保证范围内：（1）调用 `setsid` 换了会话、且父进程已先退出的进程，既不在进程树上，也不在会话里；（2）命令结束后仍留在容器里的后台进程：包装 shell 已退出、exec 已结束，`kill()` 不再有入口（返回 `409`）；（3）处于不可中断睡眠（D 状态）的进程：`SIGKILL` 不能立即生效，`kill()` 返回 `engine` 错误，exec 保持运行，之后可以重试；（4）进程被冻结之前的极短窗口：理论上 pid 可能在此期间被复用，但这需要在同一瞬间完成退出、回收与重新分配，实际上很难触发。令牌对箱内所有进程可见（`/proc/<pid>/cmdline` 对所有用户可读），因此箱内进程可以复制它，让自己的进程与这次终止一并结束；这只影响同一个箱内的进程，不跨越箱的边界。
- 没有同时运行于 fake 与真实后端的契约测试套件。两者的一致性分别由 `tests/fake-runtime.test.ts` 的断言与真实引擎测试保证。
- 镜像构建时，引擎在输出流中报告的错误仍是普通 `Error`，因此映射为 500。这与改动前一致，统一为 `engine` 错误留待后续处理。
- `listContainers` 的 `inspect` 结果在适配器内缓存。引擎的列表接口不返回 CPU 与内存限制，也不返回启动时间，因此每个容器首次列出时仍需一次 `inspect`。之后只有以下情况才会再次 `inspect`：列表显示的状态与缓存时不同、缓存超过 30 秒，或经由该适配器做过任何容器变更（创建、启动、停止、重启、删除、重命名、更新资源、网络重连）。容器不再出现在列表中时，缓存项会被删除。代价是：`listContainers` 的结果可能滞后，引擎外部的变更（例如手动 `docker update` 或 `docker rename`）在状态变化或 30 秒后才会出现在其中。盒子缓存不受此影响：采样器收到 `update` 或 `rename` 事件后会直接 `inspectContainer`。`inspectContainer` 本身不使用缓存，详情页与各操作前的检查总是读取引擎的最新状态。`HostMonitor` 的指标快照先读取采样器的汇总，采样器未就绪时才调用一次 `listContainers`，结果另外缓存 2.5 秒。
- `deleteBox` 先删除容器，再删除工作区卷。卷删除失败时 Box 已经不存在：API 在响应中返回 `volumeError`，界面提示用 `docker volume rm` 手动删除该卷。
- `/api/health` 的返回内容未改动（#19 第 5 项）。路由层的测试等待 #22 落地后补充，本次不改动 `src/routes/`。
- 日志流断开期间，日志面板每 4 秒请求一次 `GET /api/boxes/:id/logs`，每个断线的面板各自请求，连上后停止。同一盒子与 tail 的引擎读取在 2 秒内共享，因此引擎调用量有上限，但仍随断线的日志面板数量增加。
- 终端会话列表（`GET /api/boxes/:id/sessions`）仍每 10 秒轮询一次。会话没有实时帧，未纳入实时流（#14）。
- 采样器每个间隔对每个运行中的盒子各读取一次统计。盒子很多时一轮可能超过一个间隔，采样随之变稀疏，而不是并发地堆积请求。
- 采样器按主机各有一份。远端宿主机的采样器在登记时启动，链路状态经 `link` 帧报告。`sync`、`box`、`sample`、`link` 与 `host` 帧都带有 `hostId`。`host` 帧（宿主机的 CPU 与内存占用）只由本机发出，且只发给所有者。
- 事件流静默停止（没有错误，也不结束）时，采样器不会重新订阅，只靠每 60 秒的重新列出追平缓存，因此变化最多滞后约 60 秒。没有实时流时，只要有人读取统计，样本最多滞后 60 秒（`STALE_AFTER_MS`），更旧的样本不返回：读取时先等待一轮采样，最多 5 秒，超时则 `stats` 为 `null`。
- 一次性统计调用（`containerStats`，`stream=false`）在本项目测试所用的引擎（Docker 29.1.3，API 1.52，Linux）上需要 1 到 2 秒。`METRICS_INTERVAL_MS` 低于约 2 秒时，几乎每次调用都在超时（`min(METRICS_INTERVAL_MS, 5 秒)`）前未返回，记为缺失的采样，盒子的资源图表没有数据。默认值 3000 毫秒留有余量。
- 周期性重新列出在 30 秒后放弃等待并取消请求。Docker 适配器把信号交给引擎请求，请求因此结束。`Runtime` 的其它实现若忽略信号，挂起的列出会一直保持，直到它返回；在此期间不会开始新的列出。
- 队列中的 `inspectContainer` 超时为 5 秒，首次列出为 30 秒（见「盒子缓存与采样器」的「超时」）。挂起的 `inspect` 期间，`listBoxes` 与 `readBox` 对该容器返回旧状态，直到下一轮采样重读它。N 个挂起的容器使队列占用合计最多 ⌈N ÷ 8⌉ × 5 秒。写操作的 `observe()` 最多等待 5 秒，因此写操作的响应可能延迟最多 5 秒；它在缓存中的结果，要等挂起的读取结束后才出现。`getBox` 等直接读取引擎的请求不经过队列。其中的 `inspect` 每次最多等待 5 秒（`ENGINE_READ_TIMEOUT_MS`，即 `readTimeoutMs`），超时后取消引擎请求，并以 `unavailable` 返回（HTTP 503，`docker_unavailable`）。
- 检查点的 restic 辅助容器的内存（1 GiB）、进程数（256）与超时（3600 秒）尚未用大数据量测量。
