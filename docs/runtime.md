# Runtime 与 Host

本文说明 MiniBox 与容器引擎之间的边界：`Runtime` 接口、错误契约、Host 模型、如何新增后端，以及测试中 fake 与真实引擎的用法。对应 [#32](https://github.com/ArnoChenFx/minibox/issues/32)，多宿主机的其余部分见 [#21](https://github.com/ArnoChenFx/minibox/issues/21)，整体设计见 [design.md](design.md)。

这一阶段不改变行为：单机部署只注册一台隐式的 `local` 主机，API、响应与界面与之前相同。

## 分层

| 路径 | 职责 |
| --- | --- |
| `src/runtime/index.ts` | `Runtime` 接口、数据类型与 `RuntimeError`，不依赖任何 SDK |
| `src/docker/` | Docker 适配器（`runtime.ts`、`errors.ts`、`logs.ts`、`stats.ts`），唯一使用 dockerode 的代码 |
| `src/services/` | 业务逻辑：boxes、images、snapshots、templates，只通过 `Runtime` 与 `HostCtx` 访问引擎 |
| `src/host/` | `registry.ts`（Host、HostCtx、HostRegistry）、`sampler.ts`（HostSampler：盒子缓存与资源采样）、`live.ts`（实时帧类型）、`metrics.ts`（HostMonitor）、`procfs.ts` |
| `src/routes/`、`src/ws/` | HTTP 与 WebSocket 入口 |
| `src/lib/errors.ts` | 把 `RuntimeError` 映射为 HTTP 响应 |
| `src/app.ts` | 组合根：选择 Runtime，注册 `local` 主机 |

`tests/architecture.test.ts` 检查两条规则：只有 `src/docker/` 可以 import `dockerode`；只有 `src/docker/` 与组合根 `src/app.ts` 可以引用 Docker 适配器。业务代码因此无法绕过接口直接调用引擎。

## Runtime 接口

`Runtime` 覆盖 MiniBox 需要的全部引擎能力：

- 连通性：`ping`、`info`
- 容器：`listContainers`、`inspectContainer`、`createContainer`、`startContainer`、`stopContainer`、`restartContainer`、`removeContainer`、`renameContainer`、`updateContainer`、`containerLogs`、`containerDiff`、`containerStats`、`commitContainer`、`putArchive`、`getArchive`
- exec：`startExec` 返回会话。未设置 `tty` 时是交互终端（Web 终端走这条路径）：`stream` 同时承载输入和输出，并带 `resize()` 与 `inspect()`。`tty: false` 时标准输出与标准错误分开，会话还提供 `stdout`、`stderr` 与 `kill()`。`user` 缺省时沿用容器自己的用户；命令 exec 传入 `dev`。非 TTY 命令经一层 `/bin/sh` 包装运行，包装 shell 的参数中，`minibox-exec` 之后紧跟一个随机令牌。`kill()` 在容器内执行一段 POSIX `sh` 脚本：「标准」与「宽松」档位以 `root` 执行，使 `sudo` 等提权子进程也能被结束；「严格」档位以 exec 的用户执行，该档位无法提权。脚本通过 `/proc/*/cmdline` 找到包装 shell。`/tmp/.minibox-exec-<令牌>.<pid>` 形式的标记文件只提供候选 pid，每个候选同样要核对命令行。之后沿 `/proc/<pid>/stat` 的父进程号收集进程；包装 shell 自己是会话或进程组首进程时，同一会话与进程组中的进程也一并收集。每个进程先用 `SIGSTOP` 冻结，并等待其停止后才继续扫描，直到一次扫描不再发现新进程（最多 5 轮）。然后逐个 `SIGKILL`，包装 shell 最后结束。脚本退出码：0 表示全部结束；1 表示有进程无法发信号（脚本恢复其余进程并退出），或有进程存活（其余进程保持冻结，以便重试）；2 表示找不到包装 shell。`kill()` 只有在 Docker 报告 exec 已结束后才算成功，否则抛出 `engine` 错误，exec 仍在运行，可以再次调用。exec 已结束时 `kill()` 直接返回。交互终端没有令牌，`kill()` 会被拒绝。这一层要求容器里有 `/bin/sh`、`cat`、`rm` 与 `sleep`（`sleep` 需支持小数秒）。
- 事件：`events`，按标签与类型过滤；`since`（Unix 秒）让引擎补发该时间之后记录的事件，订阅者因此可以在订阅之后再列出容器而不漏掉变化；消费者停止迭代或 `signal` 中止时结束
- 镜像：`listImages`、`inspectImage`、`removeImage`、`buildImage`
- 卷：`inspectVolume`、`createVolume`、`removeVolume`
- 网络：`ensureBridgeNetwork`、`reattachNetwork`

实现需要满足以下语义，业务代码依赖这些约定：

- `startContainer` 对运行中的容器成功，`stopContainer` 对已停止的容器成功。
- 运行中的容器只有 `removeContainer(id, { force: true })` 才能删除。
- 仍被容器挂载的卷不能删除，`removeVolume` 返回 `conflict`。
- `createVolume` 对已存在的卷成功，并保留原有标签。
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

- `Host` 为 `{ id, name, kind, endpoint, labels, status }`。`probeHost()` 调用 `ping` 后把 `status` 记为 `online` 或 `offline`，`/api/health` 使用它。
- `HostCtx` 是业务代码拿到的上下文：`{ host, runtime, prefix, keys, baseTemplateTag, stopTimeoutSec, templatesDir, security, monitor, sampler, specs }`。services 的函数接收 `HostCtx`，而不是 host id。`stopTimeoutSec` 来自 `STOP_TIMEOUT_SEC`（默认 3，允许 0 到 300），停止与重启 Box 时传给 `stopContainer` 与 `restartContainer`。`specs` 是控制面共享的一份规格存储（`DATA_DIR/boxes`），不是每个引擎一份。
- `ContainerInfo` 还包含 `imageId`、`pidsLimit`、`restart` 与 `mounts`。`updateContainer` 可以改 CPU、内存、swap、进程数上限和重启策略，且不会重建容器，也不会改标签。
- `HostRegistry` 的 `add()` 对重复 id 抛错；`get(hostId = "local")` 对未知 id 抛错。

路由目前通过 `app.hosts.get()` 取得 `local`，不接受 host id，`/api/hosts/...` 尚未提供。

## 盒子缓存与采样器

每台主机有一个 `HostSampler`（`src/host/sampler.ts`）。它是该主机唯一的容器事件订阅，也是唯一维护盒子缓存和资源采样的组件。组合根在服务启动时（`boot()`）调用 `start()`，关闭时调用 `stop()`；`startServer` 不启动它，测试需要时显式调用。

- **缓存**：订阅容器事件（`events`，标签 `<前缀>=true`，类型 `container`），并带上 `since`，使订阅与随后的列表之间发生的变化不会丢失。每次连接都先订阅，再调用 `listContainers` 建立初始状态。`start`、`die`、`stop`、`update`、`rename` 等状态变化事件让对应容器重新 `inspectContainer`，`destroy` 将其移出缓存。没有规格的容器在此时认领，与列表的行为一致。
- **串行**：所有引擎读取与缓存更新都在同一个队列中，按到达的顺序执行。`inspect` 因此不会覆盖排在它之后的事件所报告的变化。服务层修改盒子后调用 `observe()` 并等待其完成，响应返回时缓存已经反映该修改。
- **采样**：每隔 `METRICS_INTERVAL_MS` 对每个运行中的盒子调用一次 `containerStats`（并发 8），结果写入该盒子长度为 `METRICS_HISTORY` 的环形缓冲。一轮结束后才安排下一轮，两轮不会重叠。引擎的统计调用量随运行中的盒子数量增长，与打开的标签页数无关。
- **发布**：盒子视图变化时发布 `box`，每轮采样发布 `sample`，连接状态变化发布 `link`。`HostMonitor` 每个间隔发布 `host`。它们经由 `LiveSink` 进入应用的事件总线（`AppTopics`），与审计事件共用这一条总线。实时帧只在总线上流动，从不写入 `events.db`。
- **断线**：事件流结束或出错时状态变为 `down`，之后按 1 秒、2 秒、4 秒……的间隔重连，最长 30 秒。重新订阅并完成列表后，计数清零。

`ready()` 为真，表示缓存是最新的（已订阅且已列出）。此时 `src/services/boxes.ts` 中的读取不调用引擎：`listBoxes` 与 `readBox` 读取缓存，`statsOf` 返回最近一次采样，`getStatsWithHistory` 返回环形缓冲。缓存未就绪时，读取退回引擎；统计只读取运行中的盒子。日志读取不经过缓存，但同一盒子与 tail 的引擎读取在 2 秒窗口内共享。

## 新增后端

1. 在 `src/<backend>/` 下实现 `Runtime`，只在该目录中引入 SDK。SDK 的错误在适配器内转换为 `RuntimeError`，参考 `src/docker/errors.ts`。
2. 连接失败映射为 `unavailable`。否则用户看到的是 502 而不是 503。
3. 在组合根 `src/app.ts` 中创建 `HostCtx` 并调用 `hosts.add()`。目前只注册 `local`，添加其它主机还需要路由与界面，见 #21。
4. 更新 `tests/architecture.test.ts` 中的规则，允许新目录引入其 SDK。
5. 为新后端编写与 `tests/docker-runtime.test.ts` 同类的真实引擎测试。

## 测试

- `FakeRuntime`（`tests/support/fake-runtime.ts`）是内存实现，遵循服务层依赖的语义：名称与镜像冲突、`not_found`、被挂载的卷不能删除、标签合并。仍被容器使用的镜像，移除最后一个标签需要 `force`，强制移除后镜像成为悬空镜像。
  - 它记录每次调用（`calls`、`callsTo(op)`、`ops()`）。
  - `fail(op, error)` 让下一次该操作失败，`down = true` 模拟引擎不可达。
  - 网络有 ID，容器第一次启动时固定在当前网络的 ID 上。网络被删除并重建后，启动该容器返回 `not_found`，直到调用 `reattachNetwork`，与真实引擎一致。
  - `seedImage()` 与 `seedContainer()` 预置状态，不记录调用。
  - 非 TTY exec（`spec.tty === false`）使用 `execScript`（默认空输出、退出码 0）。设为 `null` 时一直运行，直到 `kill()`，退出码 137。TTY 路径仍在返回前打印 `$ `。
- `tests/support/app.ts` 的 `createTestApp(overrides, runtime)` 创建使用 fake 的应用：端口 0，不访问真实 socket，标签前缀为 `mbtest`。`silenceLogs()` 静默日志输出，`rejectionOf()` 取得 rejected 的错误。
- 假引擎适配器测试：`tests/docker-adapter.test.ts` 在一个 unix socket 上启动最小的 Engine API（不需要 daemon），经由真实的 `createDockerRuntime()` 检查状态码到 `kind` 的映射、列出时跳过已消失的容器、`stopContainer` 发送的 `t` 参数等，并检查列表的 `inspect` 缓存：复用、按状态失效、变更后失效、过期，以及变更期间尚未返回的 `inspect` 不会被缓存。
- exec 终止脚本的宿主机测试：`tests/kill-tree.test.ts` 在宿主机的 `/proc` 上直接运行终止脚本（仅 Linux），覆盖包装 shell 与子进程、只由标记文件指出的无关进程、删除自身标记的命令、同一会话中的孤儿进程，以及退出码。
- 真实引擎测试：运行 `bun run test:docker`（`scripts/docker-integration.ts`）。脚本检查引擎，缺少镜像时拉取 `MINIBOX_TEST_IMAGE`（默认 `alpine:3.20`），用新的 `mbit` 前缀运行 `tests/docker-runtime.test.ts`，结束后按前缀删除容器、模板与快照镜像和卷。测试失败时会再清理一次，以覆盖仍在进行中的快照提交。可选环境变量为 `DOCKER_SOCKET`（默认 `/var/run/docker.sock`）。`MINIBOX_TEST_IMAGE` 须包含 `/bin/busybox`，sudo 测试借它模拟 setuid 的 `su`；默认的 `alpine:3.20` 满足此条件，Debian 镜像不满足。
- 直接运行测试文件：`MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-runtime.test.ts`。`MINIBOX_TEST_PREFIX` 必须以 `mbit` 开头，清理只作用于该前缀，因此不会误删真实安装的资源。直接运行时没有脚本的兜底清理，中断后可用 `docker ps -a --filter label=<前缀>` 检查残留。未设置 `MINIBOX_TEST_DOCKER=1` 时跳过。
- 盒子缓存与采样器：`tests/host-sampler.test.ts` 检查缓存的更新与发布、同一队列中的串行执行、断线后的退避重连与重新列出，以及环形缓冲的长度；`tests/box-cache-api.test.ts` 以计数的 fake 运行时检查列表、详情、统计与日志的引擎调用，以及主机汇总不再列出引擎。
- 实时流与前端：`tests/event-stream.test.ts` 与 `tests/events-live.test.ts` 检查帧格式、`sync` 与 `reset`、实时帧不带 `id`、过滤条件对实时状态的限制，以及实时帧不写入事件库；`tests/web-live.test.ts` 检查前端的单一连接、断线时的轮询回退与重连退避。
- 真实引擎：`tests/docker-runtime.test.ts` 中的 `the box cache against a real engine` 检查列表不调用引擎，以及在 MiniBox 外部停止的盒子经由事件进入缓存（设置 `MINIBOX_TEST_DOCKER=1` 时运行）。
- CI 中的 `Integration tests (real Docker engine)` 任务运行 `bun run test:docker`，不是必需检查。

## 已知限制

- exec 的 `kill()` 能结束包装 shell 的进程树，以及仍在包装 shell 的会话或进程组里的进程，包括已被 init 收养但会话未变的后台进程。以下情形不在保证范围内：（1）调用 `setsid` 换了会话、且父进程已先退出的进程，既不在进程树上，也不在会话里；（2）命令结束后仍留在容器里的后台进程：包装 shell 已退出、exec 已结束，`kill()` 不再有入口（返回 `409`）；（3）处于不可中断睡眠（D 状态）的进程：`SIGKILL` 不能立即生效，`kill()` 返回 `engine` 错误，exec 保持运行，之后可以重试；（4）进程被冻结之前的极短窗口：理论上 pid 可能在此期间被复用，但这需要在同一瞬间完成退出、回收与重新分配，实际上很难触发。令牌对箱内所有进程可见（`/proc/<pid>/cmdline` 对所有用户可读），因此箱内进程可以复制它，让自己的进程与这次终止一并结束；这只影响同一个箱内的进程，不跨越箱的边界。
- 没有同时运行于 fake 与真实后端的契约测试套件。两者的一致性分别由 `tests/fake-runtime.test.ts` 的断言与真实引擎测试保证。
- 镜像构建时，引擎在输出流中报告的错误仍是普通 `Error`，因此映射为 500。这与改动前一致，统一为 `engine` 错误留待后续处理。
- `listContainers` 的 `inspect` 结果在适配器内缓存。引擎的列表接口不返回 CPU 与内存限制，也不返回启动时间，因此每个容器首次列出时仍需一次 `inspect`。之后只有以下情况才会再次 `inspect`：列表显示的状态与缓存时不同、缓存超过 30 秒，或经由该适配器做过任何容器变更（创建、启动、停止、重启、删除、重命名、更新资源、网络重连）。容器不再出现在列表中时，缓存项会被删除。代价是：`listContainers` 的结果可能滞后，引擎外部的变更（例如手动 `docker update` 或 `docker rename`）在状态变化或 30 秒后才会出现在其中。盒子缓存不受此影响：采样器收到 `update` 或 `rename` 事件后会直接 `inspectContainer`。`inspectContainer` 本身不使用缓存，详情页与各操作前的检查总是读取引擎的最新状态。`HostMonitor` 的指标快照先读取采样器的汇总，采样器未就绪时才调用一次 `listContainers`，结果另外缓存 2.5 秒。
- `deleteBox` 先删除容器，再删除工作区卷。卷删除失败时 Box 已经不存在：API 在响应中返回 `volumeError`，界面提示用 `docker volume rm` 手动删除该卷。
- `/api/health` 的返回内容未改动（#19 第 5 项）。路由层的测试等待 #22 落地后补充，本次不改动 `src/routes/`。
- 日志面板在自动刷新开启时每 4 秒请求一次 `GET /api/boxes/:id/logs`，每个打开的面板各自请求。同一盒子与 tail 的引擎读取在 2 秒内共享，因此引擎调用量有上限，但仍随打开的日志面板数量增加。日志还没有进入实时流。
- 采样器每个间隔对每个运行中的盒子各读取一次统计。盒子很多时一轮可能超过一个间隔，采样随之变稀疏，而不是并发地堆积请求。
- 采样器按主机各有一份，但目前只注册了 `local`。`sync`、`box`、`sample`、`link` 与 `host` 帧都带有 `hostId`，多主机的界面与接口留给 #21。
