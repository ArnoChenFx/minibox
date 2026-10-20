# Runtime 与 Host

本文说明 MiniBox 与容器引擎之间的边界：`Runtime` 接口、错误契约、Host 模型、如何新增后端，以及测试中 fake 与真实引擎的用法。对应 [#32](https://github.com/ArnoChenFx/minibox/issues/32)，多宿主机的其余部分见 [#21](https://github.com/ArnoChenFx/minibox/issues/21)，整体设计见 [design.md](design.md)。

这一阶段不改变行为：单机部署只注册一台隐式的 `local` 主机，API、响应与界面与之前相同。

## 分层

| 路径 | 职责 |
| --- | --- |
| `src/runtime/index.ts` | `Runtime` 接口、数据类型与 `RuntimeError`，不依赖任何 SDK |
| `src/docker/` | Docker 适配器（`runtime.ts`、`errors.ts`、`logs.ts`、`stats.ts`），唯一使用 dockerode 的代码 |
| `src/services/` | 业务逻辑：boxes、images、snapshots、templates，只通过 `Runtime` 与 `HostCtx` 访问引擎 |
| `src/host/` | `registry.ts`（Host、HostCtx、HostRegistry）、`metrics.ts`（HostMonitor）、`procfs.ts` |
| `src/routes/`、`src/ws/` | HTTP 与 WebSocket 入口 |
| `src/lib/errors.ts` | 把 `RuntimeError` 映射为 HTTP 响应 |
| `src/app.ts` | 组合根：选择 Runtime，注册 `local` 主机 |

`tests/architecture.test.ts` 检查两条规则：只有 `src/docker/` 可以 import `dockerode`；只有 `src/docker/` 与组合根 `src/app.ts` 可以引用 Docker 适配器。业务代码因此无法绕过接口直接调用引擎。

## Runtime 接口

`Runtime` 覆盖 MiniBox 需要的全部引擎能力：

- 连通性：`ping`、`info`
- 容器：`listContainers`、`inspectContainer`、`createContainer`、`startContainer`、`stopContainer`、`restartContainer`、`removeContainer`、`renameContainer`、`updateContainer`、`containerLogs`、`containerStats`、`commitContainer`、`putArchive`、`getArchive`
- exec：`startExec` 返回带 TTY 的会话，包含 `stream`、`resize()` 与 `inspect()`
- 事件：`events`，按标签与类型过滤；消费者停止迭代或 `signal` 中止时结束
- 镜像：`listImages`、`inspectImage`、`removeImage`、`buildImage`
- 卷：`inspectVolume`、`createVolume`、`removeVolume`

实现需要满足以下语义，业务代码依赖这些约定：

- `startContainer` 对运行中的容器成功，`stopContainer` 对已停止的容器成功。
- 运行中的容器只有 `removeContainer(id, { force: true })` 才能删除。
- 仍被容器挂载的卷不能删除，`removeVolume` 返回 `conflict`。
- `createVolume` 对已存在的卷成功，并保留原有标签。
- 创建容器时，镜像标签与请求中的标签合并，请求中的标签优先。
- 提交容器时，容器标签与 `LABEL` 指令合并，指令优先。
- `containerLogs` 返回去掉流帧头后的文本。
- `listContainers` 跳过在列出与检查之间消失的容器。

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
- `HostCtx` 是业务代码拿到的上下文：`{ host, runtime, prefix, keys, baseTemplateTag, templatesDir }`。services 的函数接收 `HostCtx`，而不是 host id。
- `HostRegistry` 的 `add()` 对重复 id 抛错；`get(hostId = "local")` 对未知 id 抛错。

路由目前通过 `app.hosts.get()` 取得 `local`，不接受 host id，`/api/hosts/...` 尚未提供。

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
  - `seedImage()` 与 `seedContainer()` 预置状态，不记录调用。
- `tests/support/app.ts` 的 `createTestApp(overrides, runtime)` 创建使用 fake 的应用：端口 0，不访问真实 socket，标签前缀为 `mbtest`。`silenceLogs()` 静默日志输出，`rejectionOf()` 取得 rejected 的错误。
- 真实引擎测试：`MINIBOX_TEST_DOCKER=1 bun test tests/docker-runtime.test.ts`。可选环境变量为 `DOCKER_SOCKET`（默认 `/var/run/docker.sock`）与 `MINIBOX_TEST_IMAGE`（默认 `alpine:3.20`，需要本地已有）。每次运行使用随机标签前缀，结束后删除自己创建的容器、镜像与卷。未设置 `MINIBOX_TEST_DOCKER=1` 时跳过。

## 已知限制

- 没有同时运行于 fake 与真实后端的契约测试套件。两者的一致性分别由 `tests/fake-runtime.test.ts` 的断言与真实引擎测试保证。
- 镜像构建时，引擎在输出流中报告的错误仍是普通 `Error`，因此映射为 500。这与改动前一致，统一为 `engine` 错误留待后续处理。
- `createBox` 中的模板镜像检查会把任何错误都报告为 `template_image_missing`（400），包括引擎不可达。卷检查的任何错误都会触发创建卷。这些 `catch` 应只处理 `not_found`，属于 #19 的小问题，本阶段保持行为不变。
- #19 中的其它问题（`createBox` 的重名竞态、`listBoxes` 的 N+1 查询、磁盘标签、`/api/health` 的返回内容、可配置的停止超时）未在本阶段处理。
