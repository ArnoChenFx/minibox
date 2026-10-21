# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 升级必读（经隧道或反向代理访问的部署）
- 通过隧道或反向代理访问 MiniBox 的部署，升级后请先检查以下设置：
  - **OpenTunnel 或其他保留 `Host` / `Origin`、不添加 `X-Forwarded-*` 头的隧道：保持 `TRUST_PROXY` 关闭。** 所有请求都从 `127.0.0.1` 到达，访问者共享同一个登录限流计数，但正确的密钥总能登录。`ALLOWED_ORIGINS` 可选（`Host` 已与公网地址一致，设置也无害）。登录 Cookie 会因浏览器的 `https://` Origin 自动带上 `Secure`（#1 #3）。
  - **`TRUST_PROXY=true`**：只在你控制的反向代理之后开启，并且代理会在每个请求上覆盖（或剥离后重新添加）`X-Forwarded-For`、`X-Forwarded-Proto` 与 `X-Forwarded-Host`，MiniBox 只能经由该代理访问。开启后 MiniBox 信任这三个头，能直连 MiniBox 的客户端或原样透传客户端值的代理都可以伪造它们（#1）。
  - **`ALLOWED_ORIGINS=https://你的公网地址`**：代理改写了 `Host` 时需要设置。nginx 默认会改写 `Host`，除非配置 `proxy_set_header Host $host;`。未设置时，从公网地址发出的登录与终端请求返回 `403`，登录页会提示该请求的 Origin 不在 `ALLOWED_ORIGINS` 中（#3）。
  - **`COOKIE_SECURE=1`**：仅当浏览器通过 HTTPS 访问、但请求不带 `https://` Origin（例如代理剥离了它）时才需要。纯 HTTP 地址不要设置（#3）。
- 收到代理头而 `TRUST_PROXY` 未开启时，日志会输出一条 `proxy.headers_ignored` 警告（每个进程一次）。在会设置这些头的反向代理后面请按上面开启；OpenTunnel 不添加这些头，此时出现的头来自客户端，应保持关闭（#1）。
- 登录 Cookie 由 `SameSite=Lax` 改为 `SameSite=Strict`：从其他网站打开的控制台链接，可能需要重新登录一次（#3）。
- 写请求声明的 `Content-Type` 必须是 `application/json`，否则返回 `415`。既没有请求体也没有声明 `Content-Type` 的写请求不受影响；以前用 `curl -d ''` 发送的空表单请求现在会被拒绝，请去掉表单类型或改为 JSON（#3）。

### 安全
- 错误的 `Authorization: Bearer` 密钥计入登录限流：`/api/`、`/mcp` 与终端 WebSocket 和登录共用同一计数，超限后返回 `429`。正确的密钥不计入，也不会被拒绝。此前 Bearer 密钥的错误不受限制。
- `/mcp` 仍使用主访问密钥认证（范围令牌 #13 未完成）。持有该密钥的 MCP 客户端拥有完全的所有者权限，包括以 `root` 执行 `exec`（非「严格」档位）、`delete_box` 与 `rebuild_box`。README、README-zh 与 `docs/agents.md` 已用警示块写明。
- exec 的进程树改为在箱内终止，宿主机不再对 Docker 报告的宿主机 pid 发送 `SIGKILL`。「标准」与「宽松」档位以 `root` 执行终止，使 `sudo` 等提权子进程也能被结束；「严格」档位以 exec 的用户执行，该档位无法提权。进程由包装 shell 命令行中的随机令牌找到；`/tmp` 中的标记文件只作线索，因为箱内任何进程都能改写或删除它。终止时先冻结每个进程再结束，并一并结束包装 shell 所在的会话与进程组。Docker 报告 exec 已结束后才算成功，否则返回 `502`，exec 保持 `running`。
- 审计来源由服务端决定：`X-Minibox-Client` 请求头不再把 CLI 调用记为 `cli`，REST 与 CLI 的调用都记为 `rest`，MCP 调用记为 `mcp`。
- 登录 Cookie 不再保存原始 `ACCESS_KEY`。登录后签发随机的 32 字节会话令牌（来自 CSPRNG），Cookie 只保存该令牌。服务端只在 `DATA_DIR/sessions.json` 中保存其 SHA-256 哈希，令牌与访问密钥都不写入日志（#2）。
- 会话可撤销：登出会立即在服务端作废会话。修改 `ACCESS_KEY` 后，下次启动时全部会话失效；文件中只保存用于检测变更的 scrypt 校验值。`Authorization: Bearer <ACCESS_KEY>` 不受影响（#2）。
- 终端 WebSocket 与所有 Cookie 校验都接受会话令牌。会话结束（撤销、登出或到期）后，已打开的终端以 WebSocket 关闭码 1008 关闭，已打开的事件流（`/api/events/stream`）随之结束；到期由定期清理发现，最迟约 10 秒（#2）。
- 登录限流不再信任请求头 `X-Forwarded-For`：默认按真实连接地址计数。新增配置 `TRUST_PROXY`（默认 `false`），仅在由你控制、会覆盖这些头的反向代理之后设置为 `true`；此时读取 `X-Forwarded-For` 的最后一项，并信任 `X-Forwarded-Proto` 与 `X-Forwarded-Host`（#1）。
- 登录限流只拒绝错误的密钥：正确的密钥总能登录，即使同一地址（或所有访问者）已被限流。同一地址 5 分钟内错误 10 次，或全部地址合计 50 次后，之后的错误密钥被拒绝（`429`），并延迟约 1 秒返回；IPv6 按 /64 归并。失败记录表设置容量上限并定期清理过期项（#1）。限流不会阻止猜测（每个密钥仍会被校验），抵抗暴力破解靠的是密钥的长度与随机性。
- 新增配置 `COOKIE_SECURE`（默认 `false`）：始终为会话 Cookie 加上 `Secure`。通过 HTTPS 访问，或请求带有 `https://` Origin 时，Cookie 已会带上 `Secure`，通常无需设置（#3）。
- WebSocket 终端升级请求，以及 `/api/` 下的 POST / PATCH / DELETE，要求浏览器的 `Origin` 与请求的 `Host` 同源（或列在新配置 `ALLOWED_ORIGINS` 中），否则返回 `403`。不带 `Origin` 的请求（如使用 `Authorization: Bearer` 的脚本）不受影响（#3）。
- API 写请求声明的 `Content-Type` 必须是 `application/json`，否则返回 `415`，HTML 表单提交无法触发写操作（#3）。
- 登录 Cookie 由 `SameSite=Lax` 改为 `SameSite=Strict`（#3）。
- 增加 `Content-Security-Policy`：脚本只从同源加载（`script-src 'self'`），页面不再使用内联脚本，且禁止被其他页面嵌入（`frame-ancestors 'none'`）（#4）。
- 通过 HTTPS 访问时（直接访问、请求带有 `https://` Origin，或 `TRUST_PROXY=true` 时经代理识别）发送 `Strict-Transport-Security`（一年，不含子域名）（#4）。
- 所有响应增加 `Cross-Origin-Opener-Policy` 与 `Cross-Origin-Resource-Policy: same-origin`（#4）。
- 文档补充容器以 root 运行的说明，以及缓解方案：Docker Socket 代理（只转发 MiniBox 所需的 API），或 rootless Docker / Podman。
- 启动时检查访问密钥强度。短于 20 位，或明显低熵（只用一类字符且不足 24 位，或只重复同一个字符）的密钥会记录 `auth.weak_key` 警告。警告不包含密钥或其长度，服务仍正常启动。
- `server.started` 启动日志不再输出 `keyPrefix`（访问密钥的前 4 位）。启动日志与 `docker logs` 中不会出现密钥的任何部分。
- 基础模板的 `dev` 用户拥有无密码 `sudo`，Box 内的 root 可以改动该 Box 及其工作区卷。默认的「标准」安全档位不设置 `no-new-privileges`，否则 `sudo` 会失效；「严格」档位设置它，`sudo` 仍已安装但无法提权（#5）。
- 新建 Box 默认加固：丢弃大部分 Linux capability（「标准」档位保留 Docker 默认能力集中的 11 项，去掉 `MKNOD`、`SETPCAP`、`SYS_CHROOT`），设置进程数上限与 ulimit（禁用 core dump，`nofile` 为 65536），并放在独立网络上，同一网络内的 Box 之间不能互相访问（#5）。
- 出站（egress）策略与磁盘配额暂缓实现，不随 #5 交付。Box 的出站流量不做过滤，磁盘用量也没有上限（#5）。
- `scripts/restart.sh` 不再对 Docker Socket 执行 `chmod 666`，此前任何本地用户都能以 root 等同权限访问 Docker。现在每次运行都把 Socket 的属组设为执行者的主组、权限设为 `660`，服务进程无需重新登录即可使用 Docker；主组以外的账户（包括 `docker` 组成员）在脚本运行后无法访问该 Socket。该脚本定位为单用户沙箱的便利脚本，README 已说明。
- 创建 Box 与重建时，挂载和网络都要经过检查，这是设计文档 §9.2 在 `volume:attach` 授权（#13）落地前的过渡规则。`minibox-data`（保存访问密钥与会话）一律拒绝挂载；新挂载的卷必须带 MiniBox 标签（即由 MiniBox 创建），或尚不存在；新挂载的卷不能已被其它 Box 挂载；重建时网络只能是宿主机的 Box 网络，或 Box 当前已在使用的网络，`host`、`none` 与 `container:*` 始终拒绝。不符合时返回 `403`（错误码 `forbidden`），容器与规格都不变。

### 新增
- 异步任务（#16）：模板构建与快照创建返回 `202` 和 `taskId`，进度经现有事件总线的 `task` 主题以 SSE（`GET /api/tasks/:id/events`）推送，不再把长请求挂在 `idleTimeout` 为 60 秒的连接上。任务状态和最近 64 KB 输出保存在 `DATA_DIR/tasks.db`；进程重启后，未完成的任务记为 `interrupted`。同一时间只能构建一个模板，每个 Box 同时只能提交一个快照。控制台顶栏有任务抽屉（中英文），可看实时日志并取消。Bun 的空闲计时从请求开始计算且不会被心跳延长，`server.timeout(req, 0)` 才会关掉它（见 `tests/long-work-routes.test.ts`）。
- 命令执行、MCP 与 CLI（Refs #9）。`POST /api/boxes/:id/exec` 在 Box 里运行命令：`argv` 直接执行，`cmd` 经 `/bin/sh -c`，默认用户 `dev`、目录 `/workspace`，可选 `cwd`、`env`（审计只记变量名）、`stdin`、`timeoutSec` 与 `user`。退出码来自 `exec.inspect`。超时会在箱内杀掉进程树，响应仍是成功，并带 `timedOut: true`（没有退出码时用 137）。终止失败时返回 `502`，exec 保持 `running`，可以用 `POST /api/execs/:execId/kill` 重试。前台 `timeoutSec` 最多 55 秒，更长的命令用 `background: true`（最多 3600 秒）；后台 exec 每个 Box 最多 8 个、全局 64 个，超限返回 `429`，且不唤醒 Box。「严格」档位只允许 `dev` 或 `1000` 作为用户，其他档位的 `root` 运行在审计中标记为 `privileged`。已停止的 Box 会先被启动，这会把期望状态改为运行，因此版本号加 1；空闲超时与 TTL 仍是 #12。结束后的 `durationMs` 不再增长。`background: true` 立即返回 `execId`，`GET /api/execs/:execId?waitMs=` 长轮询（最长 25000 毫秒），`POST /api/execs/:execId/kill` 结束进程树。内联输出保留每个流头尾各约 16 KiB；更长的内容给出 `outputRef`，`GET /api/execs/:execId/output` 读取保存的头尾窗口（各 64 KiB，`DATA_DIR/exec`）。`exec.start`、`exec.finish`、`exec.killed` 记在事件总线上，属于活动档且不合并，并用 `parentId` 挂到对应的 `exec.run`。`POST /mcp` 是带 Bearer 的 Streamable HTTP MCP（不接受浏览器 Cookie；`GET` 不提供 SSE）。`?toolsets=` 选择工具集，默认 `core,meta`。设计目录是 27 个工具、默认 15 个；当前实现是 6 个 Box 工具加上 `exec`、`exec_get`、`exec_kill`，默认工具集共 9 个。`rebuild_box` 不在默认工具集中，放在非默认的 `rebuild` 工具集（`/mcp?toolsets=rebuild`），共 10 个。`bun run build:cli` 用 `bun build --compile` 生成 `dist/minibox`，至少提供 `minibox box ls` 与 `minibox exec`。错误体包含 `retryable`，需要时还有 `hint`。`exec` 可以读写该 Box 上挂载的每一个卷。文件 API（归档、对已停止 Box 的辅助容器读写）不在这次交付中，留到 Volume（#24）之后。
- Box 规格写入 `DATA_DIR/boxes/<id>.json`（权限 600）。稳定 ID 形如 `bx_…`，与容器 ID 分开，名称全局唯一。已有 Box 在列出或读取时自动认领：不改容器名，也不改容器标签（D6，认领后的属主修正留给 #24）。`DATA_DIR` 丢失时从标签和 `inspect` 降级恢复；空闲超时、TTL、标签、工具、环境变量回到默认值，并在 `recovery.needsReset` 中标明需要重新设置。原地更新（CPU、内存、进程数、标签、空闲超时、TTL、重命名）走 `docker update` / `docker rename` 与规格文件，容器标签保持创建时的内容。请求须带 `If-Match: <revision>`；缺少该头返回 428，版本不一致返回 412。新建 Box 的重启策略为 `no`，启动时的协调器按期望状态 `running` 或 `stopped` 启动或停止，并把引擎上的重启策略改回 `no`（D8）。漂移比较 `inspect` 与规格，不自动改回资源或挂载。规格保留最近 20 个版本（Refs #23）。
- `POST /api/boxes/:id/rebuild`：未带 `confirm: true` 时返回 `409 confirmation_required`，`preview` 包含可写层的 `docker diff` 和计划变更。确认后创建新容器（不启动）并校验镜像与配置，停旧容器并改名为 `-old`，把新容器改成正式名称后启动；成功则删除旧容器，失败则恢复旧容器并把规格回滚到上一版。认领仍不改名；重建会把容器名改为 `<前缀>-<id>`（D6）。保留挂载卷、稳定 ID、名称和最近 20 个规格版本；丢失未写入卷的可写层、运行中的进程（含 tmux）和容器 IP。`PATCH /api/boxes/:id` 若带上与当前不同的模板、挂载、环境变量、网络或安全档位，返回同一预览，且不应用同一请求里的原地字段。`secretRef` 只存储、不注入。第一阶段仍只在创建时准备一个工作区卷；显式增删挂载才会重建，不引入卷池（#24）。重建前检查点不在这一步（#11）（Refs #23）。
- 事件与审计（#25）：每次操作执行后（目前经 REST，MCP 与 CLI 随 #9 接入），在 `DATA_DIR/events.db`（SQLite，WAL 模式）中记录一条事件，写入前脱敏（访问密钥、常见凭据格式，环境变量只记名称）。新增 `GET /api/events`（过滤与游标分页）与 `GET /api/events/stream`（SSE，支持 `Last-Event-ID` 续传），两者都经过现有的鉴权与同源检查。保留策略可配置并每小时清理：`EVENT_RETENTION_AUDIT_DAYS`（默认 365）、`EVENT_RETENTION_ACTIVITY_DAYS`（默认 30）、`EVENT_OUTPUT_RETENTION_DAYS`（默认 7）与 `EVENT_OUTPUT_MAX_MB`（默认 512）。`events.db` 需要可写的 `DATA_DIR`，否则启动失败。新增进程内事件总线，供后续的任务与状态采样复用。目前只有所有者可以读取事件，范围令牌（#13）未完成前不做细分；命令输出的保留策略已就位，待 exec（#9）写入。
- Box 安全档位 `standard`（默认）、`strict` 与 `relaxed`。创建对话框的「高级」区域可以选择；`POST /api/boxes` 与 `POST /api/snapshots/:ref/boxes` 接受 `profile` 字段；环境变量 `BOX_PROFILE` 设置默认值（#5）。
- 环境变量 `BOX_PIDS_LIMIT`（默认 `1024`）设置每个新建 Box 的进程数上限；`RUNTIME` 设置新建 Box 使用的 OCI 运行时，例如 gVisor 的 `runsc`（#5）。
- 独立网络 `<前缀>-boxes`（默认 `minibox-boxes`），关闭容器间通信。网络被删除后（例如 `docker network prune`），已停止的 Box 在下次启动时会接入重建后的网络（#5）。
- 基础模板安装 `iputils-ping`。`scripts/check-box-image.sh` 会以每个安全档位启动容器，检查能力集、`no-new-privileges`、`sudo` 与 `ping`（#5）。
- 设置页显示默认安全档位、容器运行时、每个 Box 的进程数上限与 Box 网络；Box 详情页显示安全档位与网络，中英文界面均已提供（#5）。
- 设置页新增「登录会话」列表：显示登录时间、最近活动与浏览器（User-Agent），并标明当前浏览器。可以撤销单个会话，也可以「退出其他会话」。中英文界面均已翻译（#2）。
- 新增接口 `GET /api/auth/sessions`、`DELETE /api/auth/sessions/{id}` 与 `POST /api/auth/sessions/revoke-others`（#2）。
- 新增配置 `SESSION_TTL_DAYS`（会话绝对有效期，默认 30 天，最长 3650 天）与 `SESSION_IDLE_DAYS`（可选的滑动续期，默认关闭）。README、README-zh 与 `.env.example` 均有说明（#2）。
- 数据目录 `DATA_DIR`（默认 `./data`，Docker 镜像中为 `/data`）。目录权限 700；启动时创建 `boxes/`、`exec/`、`secrets/` 子目录，供后续功能使用。
- Docker 镜像设置 `DATA_DIR=/data` 并创建该挂载点，README 中的示例使用 `-v minibox-data:/data` 持久化。
- REST 请求头 `X-Minibox-Run`（可选）：请求可以带上所属客户端会话的标识，同一会话的审计事件共享该值。取值为 1 到 64 位字母、数字、点、冒号、下划线或连字符，且以字母或数字开头；其他取值返回 `400`（`run_invalid`）（#22）。
- OpenAPI 3.1 文档 `docs/openapi.json`，由操作注册表生成，覆盖盒子及盒子快照的全部接口，并描述 `X-Minibox-Run` 请求头。运行 `bun run openapi` 重新生成（#22）。
- 操作执行器的鉴权钩子：未通过鉴权的操作返回 `403`，错误码为 `forbidden`，`key` 为 `operation_forbidden`。默认钩子只允许所有者，因此目前只有替换钩子的测试会触发该响应（#22）。
- 操作审计日志：每次执行写一行结构化日志，事件名为 `operation.ok`（读操作为 debug 级别）、`operation.denied` 或 `operation.failed`（5xx 为 error），字段包括操作名、种类、主体、`run`、结果与错误码（#22）。
- 基础模板以非 root 用户 `dev` 运行（uid/gid 为 1000，可用构建参数 `DEV_UID` / `DEV_GID` 调整）。网页终端与 `docker exec` 默认以 `dev` 进入，并提供无密码 `sudo`（仅限 Box 内）。
- 基础模板新增 `tmux`、`jq`、`ripgrep`、`openssh-client`、`unzip` 与 `sudo`，并保留 `git`、`curl`、`python3`、`build-essential`、`procps`、`vim-tiny` 与 `less`。
- 基础模板的挂载点约定：`/workspace`、`/home/dev`、`/opt/minibox/tools`（只读共享工具，其 `bin` 在 `PATH` 中）与 `/home/dev/.cache`。缓存变量 `XDG_CACHE_HOME`、`npm_config_cache`、`PIP_CACHE_DIR`、`YARN_CACHE_FOLDER` 指向 `/home/dev/.cache` 下，`NPM_CONFIG_PREFIX` 指向 `/home/dev/.npm-global`。卷挂载由 #24 落地。
- 基础模板标签 `minibox.template.user`、`minibox.template.uid` 与 `minibox.template.gid` 记录 uid 约定。
- `scripts/check-box-image.sh` 与 `bun run check:template`：用 Docker 检查基础模板镜像的用户、sudo、工具、挂载点、环境变量、登录 Shell 的 PATH，以及共享卷读写。
- `STOP_TIMEOUT_SEC`（默认 `3`，允许 0 到 300 的整数）：停止与重启 Box 时，发送 SIGTERM 后等待退出的秒数，超时则强制结束。空值或无效值回退为 3 秒（#19）。
- `DELETE /api/boxes/:id` 的响应新增 `volumeError` 字段：删除数据卷失败时返回引擎给出的原因。Box 本身仍会被删除（#19）。
- 新增「关于」页面（侧边栏「设置」之后，路由 `#/about`）：显示 logo、版本、服务启动时间、Bun 运行时版本与 Docker 引擎版本（不可用时显示「不可用」），并提供 README、文档、更新日志、问题反馈与许可证的链接。中英文界面均已翻译。

### 变更
- 设置页移除了品牌卡片（已移到「关于」页），改为单栏：运行配置（分两列展示）、外观、登录会话。「关于」页重新显示 Bun 版本（`/api/system` 的 `runtime` 字段），即 0.3.0 中去掉的那一项。
- Box 的加固只在创建时生效。已有 Box 保留创建时的设置，不会被强制重建；早于本版本创建的 Box 没有记录档位，仍在默认的 `bridge` 网络上（#5）。
- 登录 Cookie 改名为 `minibox_session`，存放会话令牌。不再读取旧的 `minibox_key` Cookie，登录、登出与登录页都会将其清除。`HttpOnly`、`SameSite=Strict` 与 HTTPS 下的 `Secure` 规则不变（#2）。
- `POST /api/auth/logout` 会立即作废服务端会话，而不只是清除浏览器中的 Cookie。登录时会结束该浏览器原有的会话（#2）。
- 未设置 `ACCESS_KEY` 时，自动生成的密钥写入 `DATA_DIR/access_key`（权限 600），重启后保持不变。访问密钥的优先级为：进程环境变量 > `.env` > `DATA_DIR/access_key` > 自动生成。空值视为未设置。
- `scripts/restart.sh` 改为通过服务自身的配置加载逻辑读取 `PORT` 与密钥位置（此前只读取 `.env` 中的 `PORT`），启动后提示密钥保存位置，但不输出密钥本身。
- 登录页说明访问密钥的来源（`.env` 或 `DATA_DIR/access_key`）。
- xterm.js 与 addon-fit 改为随仓库提供（`web/vendor/`，附 SHA-256 校验测试），不再从 jsDelivr CDN 加载；网页终端可在离线或内网环境中使用（#4）。
- 内部重构：业务代码通过窄的 `Runtime` 接口访问容器引擎，Docker 实现集中在 `src/docker/`；单机部署注册为隐式的 `local` 主机。API、响应与界面不变。
- 内部重构：盒子接口（`/api/boxes` 下的列表、详情、创建、删除、启动 / 停止 / 重启、资源、日志与统计，以及 `POST /api/boxes/:id/snapshots` 和 `POST /api/snapshots/:ref/boxes`）改由操作注册表统一定义，REST、OpenAPI 与审计从同一处生成。API、响应体与错误结构不变，HTTP 转录测试的 97 次请求逐条一致（#22）。
- 活动记录改由执行器统一写入，取代路由中手动调用的 `tracked()`（#22）。
- 新增运行时依赖 `zod` 4，用于操作的输入校验与 JSON Schema 生成；新增开发依赖 `@readme/openapi-parser` 与 `openapi-types`，仅用于校验 OpenAPI 文档，不进入运行时镜像（#22）。
- 基础模板不再保留镜像自带的 `node` 用户（uid 1000），由 `dev` 使用该 uid。
- 基础模板描述改为「Debian 12 · Node.js 26 · Python 3 · git · tmux · build-essential · 非 root 用户 dev」，网页端构建与 `bun run build:template` 使用同一描述。
- Box 详情页的终端标题栏不再固定显示 `root@`，改为 `<名称>: /workspace`，因为新建 Box 以 `dev` 运行，旧 Box 仍为 root。
- `scripts/restart.sh` 启动 `dockerd` 与 OpenTunnel 时改为追加写入 `/tmp/dockerd.log` 与 `/tmp/opentunnel.log`，每次启动写入一行 `---` 分隔标记，不再清空上一次的诊断信息。
- 在容器内运行 MiniBox 时，磁盘标签显示为「容器磁盘」（`container`）或「容器磁盘（含 Docker 数据）」，不再把容器自己的文件系统标为「系统盘」（#19）。

### 工程化
- `Runtime` 接口新增 `ensureBridgeNetwork` 与 `reattachNetwork`，`createContainer` 支持网络与加固字段。`FakeRuntime` 模拟引擎的网络固定行为，新增 `tests/box-profile.test.ts` 检查各档位映射出的容器配置；真实引擎测试 `tests/docker-runtime.test.ts` 覆盖网络与各档位（设置 `MINIBOX_TEST_DOCKER=1` 时运行）（#5）。
- 新增会话测试（`tests/sessions.test.ts`，并扩展 `tests/auth.test.ts`、`tests/server.test.ts`、`tests/terminal.test.ts`）：令牌与密钥不同、登出与撤销、修改密钥后失效、过期与滑动续期、重启后保持、Bearer 仍可用、终端与事件流随会话结束而关闭，以及日志中不含令牌或密钥（#2）。
- 新增 `.github/dependabot.yml`：每周检查 npm 依赖（Bun）、GitHub Actions 与 Docker 基础镜像（根目录 `Dockerfile` 与 `templates/base`）的更新；GitHub Actions 的小版本与补丁版本更新合并为一个 PR。
- `package.json` 的 `engines.bun` 最低版本要求由 `>=1.2.0` 提高为 `>=1.4.3`，README 中的版本要求同步。
- 所有 GitHub Actions 引用固定到完整 commit SHA，并以注释保留版本号，升级由 Dependabot 提出。
- 发布工作流的镜像构建与 GitHub Release 步骤显式依赖 CI 检查（`checks`），检查不通过时不会推送镜像，也不会创建 Release。
- 新增 `FakeRuntime` 与基于它的单元测试，覆盖 Box 创建 / 删除、快照与模板提升、路由校验与错误映射、终端升级和主机指标。新增架构测试：只有 `src/docker/` 可以引入 Docker SDK，只有 `src/docker/` 与组合根可以引用 Docker 适配器。
- 新增可选的真实引擎集成测试 `tests/docker-runtime.test.ts`，设置 `MINIBOX_TEST_DOCKER=1` 时运行。它覆盖删除自身标记文件的命令仍会被终止、标记被改写为其他进程的 pid 时只结束 exec 自己的进程树、以 `root` 运行的 sudo 式子进程被终止（exec 用户做不到），以及超时终止在引擎暂停期间失败后重试。`tests/kill-tree.test.ts` 在宿主机的 `/proc` 上直接运行终止脚本，覆盖同一会话中的孤儿进程。删除了宿主机侧的进程探测 `src/docker/proc.ts` 与 `tests/proc.test.ts`。
- 新增 `bun run openapi`（`scripts/export-openapi.ts`），`scripts/` 纳入 TypeScript 类型检查（#22）。
- 新增 HTTP 等价性测试 `tests/parity.test.ts`：以重构前录制的 `tests/fixtures/parity-transcript.json` 为基线，逐条比对 97 次请求的状态码、内容类型与响应体（时间、ID 与镜像摘要已规范化）（#22）。
- 新增 OpenAPI 测试：校验生成的文档与 `docs/openapi.json`；检查路径、方法与 operationId 和注册表一致；要求录制的每个响应都符合对应操作的输出结构或错误结构（#22）。
- 架构测试新增两条规则：`src/operations/` 不得依赖 HTTP 层或组合根；REST 适配层只能通过操作访问服务与引擎（#22）。
- 新增 `bun run test:docker`（`scripts/docker-integration.ts`），在独立的 `mbit` 标签前缀下运行真实引擎测试，结束后清理本次运行创建的容器、镜像与卷。CI 新增非必需的 `Integration tests (real Docker engine)` 任务（#19）。
- 新增假引擎 socket 上的 Docker 适配器测试（`tests/docker-adapter.test.ts`），以及终端 WebSocket 的鉴权、Origin 检查、非运行状态拒绝和 `parseControl` 测试，并为 `format.js` 与 i18n 加载补充前端纯逻辑测试（#19）。
- `tsconfig.json` 的类型检查范围包含 `scripts/`（#19）。
- CI 的 `Docker build (smoke)` 任务新增基础模板的多架构构建（`linux/amd64`、`linux/arm64`），并对 amd64 镜像及模拟的 arm64 镜像运行 `scripts/check-box-image.sh`。新增的 `docker/setup-qemu-action` 同样固定到完整 commit SHA。
- 以路由测试取代依赖 Bun 空闲计时与固定时长阈值的 `tests/idle-timeout.test.ts`，后者在 CI 中不稳定。新的 `tests/long-work-routes.test.ts` 检查 MiniBox 自身的约定：模板构建与快照提交立即返回 `202`，任务进度流与事件流对自身请求调用 `server.timeout(req, 0)`。

### 修复
- 自动生成访问密钥时不再整体重写 `.env`。此前会把 `.env` 改写为只剩 `ACCESS_KEY`、`PORT`、`HOST` 三项，其他配置随之丢失。现在任何情况下都不修改 `.env`。
- 模板描述与快照标签的值统一转义（反斜杠、双引号、美元符号按字面保存），并拒绝控制字符。此前 `$VAR` 会从镜像环境展开进标签，反斜杠后接换行会把后续文字并入标签。`POST /api/snapshots/:ref/promote` 的 `description` 含换行或其他控制字符时返回 400（`description_invalid`）；描述去除首尾空格，只含空格的描述视为未填写。
- 创建 Box 的重名检查改为依赖引擎的 409 冲突。此前先查询全部 Box 再创建，两个同名请求可能同时通过检查（#19）。
- 引擎不可达或返回其它错误时，创建 Box、提升快照、删除快照与模板不再误报为「模板镜像不存在」或「快照 / 模板不存在」，而是返回引擎的真实错误类别（#19）。
- 删除 Box 时若数据卷未能删除，界面仍显示删除成功。现在会弹出错误提示，说明数据卷仍然保留及原因（#19）。
- `listBoxes` 不再每次对每个容器请求引擎：容器的 `inspect` 结果在适配器内缓存，只在状态变化、超过 30 秒或经由 MiniBox 修改该容器后重新读取。列出时只跳过已消失的容器，其它引擎错误原样返回，不再被静默忽略（#19）。见 `docs/runtime.md` 的已知限制。
- 任务进度的 SSE 流（`GET /api/tasks/:id/events`）在浏览器会话被撤销、登出或到期时结束，与事件流和终端一致。此前它会一直推送，直到下次重连。
- 取消任务后，快照提交或模板构建在引擎中真正结束之前仍占用锁。同一 Box 或模板的新任务会收到 `409`，并在 `error.details.taskId` 中给出占用它的任务，不会与仍在运行的引擎调用重叠。进程启动时释放所有锁。
- 进程启动时，单个 Box 启动失败（例如其镜像已被删除）不再中止其后 Box 的自动启动。失败的 Box 记入启动报告，并以 `box.reconcile_box_failed` 记录。
- 重建读取可写层差异时，只有引擎返回 JSON `null` 或空响应体才视为无变更；其它响应报错，不再显示为空差异。
- 重建停止旧容器时使用 `STOP_TIMEOUT_SEC` 的配置值，此前固定为 3 秒。规格文件改用原子写入并刷盘，断电后不会恢复到已被替换的旧版本。
- 基础模板的描述（模板标签、界面、两份 README 与 `bun run build:template`）此前写作 Node.js 24，而镜像一直基于 Node.js 26。现已统一，并有测试保证各处的版本与 Dockerfile 一致。
- 控制台内容区不再限制为 1320px 宽。在宽屏显示器上，概览、Box、快照与关于页现在会填满侧边栏右侧的可用宽度，不再在右侧留出大片空白。模板卡片改为按可用宽度自动排列列数，只有一个模板时也会撑满一行。设置页保持 960px 的可读宽度并居中显示。
- exec 超时后的终止失败时，改为按 1 秒、2 秒、4 秒……（最长 30 秒）的间隔重试，直到 exec 被终止，不再放弃。超时与 `POST /api/execs/:execId/kill` 同时发生时共用同一次终止。所有 `403` 拒绝（包括「严格」档位的用户检查，以及创建与重建时的挂载和网络检查）现在审计为 `denied`，不再记为 `error`。

### 文档
- README、README-zh 与 `docs/agents.md` 说明 exec 的 55 秒前台上限、后台上限与 `status` 字段、`rebuild` 工具集、「严格」档位的用户规则、`/mcp` 使用主访问密钥的警示，以及 `AGENTS.md` 片段（建议通过 `env` 传递密钥）。`docs/design.md` 更新 §4.2 至 §4.3 与 §9.2、§14，并新增决策 44 至 48。
- README、README-zh 与 `.env.example` 说明会话行为、`SESSION_TTL_DAYS` 与 `SESSION_IDLE_DAYS`、数据目录中的 `sessions.json` 以及新接口。`docs/design.md` §9.3 改为已实现（#2）。
- README 与 README-zh 说明数据目录、访问密钥的位置与优先级、Docker 数据卷的用法，以及 `.env.example` 中的 `DATA_DIR` 配置项。
- `docs/design.md` 记录两项决策：「标准」档位不开启 `no-new-privileges`、保留 `sudo`；「严格」档位开启它，`sudo` 无法提权。出站策略与磁盘配额暂缓（#5）。
- README 与 README-zh 新增「安全档位」章节，说明三个档位的取舍；`.env.example` 增加 `BOX_PROFILE`、`BOX_PIDS_LIMIT` 与 `RUNTIME`。
- 新增 `docs/runtime.md`，说明 `Runtime` 接口、错误分类与 HTTP 映射、Host 模型，以及如何新增后端。
- README 与 README-zh 的 API 参考新增 `X-Minibox-Run`、OpenAPI 文档与 `bun run openapi`；架构图与项目结构同步更新（#22）。
- README 与 README-zh 新增「基础模板」章节，说明用户与 uid 约定、挂载点、缓存、标签、检查方法，以及从 root 版模板升级的步骤。
- `docs/runtime.md` 补充真实引擎测试的运行方式（`bun run test:docker`、`MINIBOX_TEST_PREFIX`）与假引擎适配器测试，并更新已知限制。
- README 与 README-zh 的配置表新增 `STOP_TIMEOUT_SEC`，开发命令与 CI 说明新增 `bun run test:docker` 与非必需的集成任务（#19）。

### 升级说明
- 新建 Box 默认使用「标准」档位。与之前相比，它去掉了 `MKNOD`、`SETPCAP` 与 `SYS_CHROOT` 三项能力，并设置了进程数上限与 ulimit。需要这些能力的工具，请创建「宽松」档位的 Box，或设置 `BOX_PROFILE=relaxed`。已有 Box 不会被重建（#5）。
- 升级后，已登录的浏览器需要重新登录一次。旧版 Cookie 保存的是原始访问密钥，新版不再接受它，并会在登录页或登录时将其清除。使用 `Authorization: Bearer` 的脚本无需修改（#2）。
- 会话保存在 `DATA_DIR/sessions.json`（权限 600），首次登录时创建，随 `DATA_DIR` 一起备份，文件中不含令牌本身（#2）。
- 已有部署无需操作：`.env` 中的 `ACCESS_KEY` 照常生效，`.env` 不再被改写。
- Docker 部署且未传入 `-e ACCESS_KEY` 时，旧镜像生成的密钥位于容器内的 `/app/.env`，重建容器后会丢失。重建前请在旧容器运行时执行 `docker exec <容器名> grep '^ACCESS_KEY=' /app/.env` 取出密钥，再通过 `-e ACCESS_KEY=...` 传入，并挂载 `-v minibox-data:/data`。
- 首次启动会创建 `./data/`（已在 git 中忽略），其中只有空的子目录。
- 现有客户端无需修改：接口路径、请求参数、响应体与错误码均未变化。`X-Minibox-Run` 为可选请求头（#22）。
- 若现有访问密钥短于 20 位或强度不足，升级后启动日志会出现 `auth.weak_key` 警告。服务不受影响；建议换成至少 20 位的随机字符（例如 `openssl rand -hex 32`）并重启。
- 使用 `Authorization: Bearer` 的脚本：错误的密钥现在计入登录限流，超限后返回 `429`。正确的密钥不受影响（见「安全」）。
- 已构建的 `minibox-template:base` 仍是旧的 root 版本。在控制台「模板 → 构建基础模板」或运行 `bun run build:template` 重新构建后，新建 Box 才以 `dev` 运行。已有 Box 保持原样，不会改名或重建。
- 新 Box 复用旧 Box 保留下来的工作区卷时，卷内 `/workspace` 仍属于 root，`dev` 无法写入。在该 Box 运行时执行一次 `docker exec -u root minibox-<名称> chown -R 1000:1000 /workspace` 即可修复。MiniBox 暂不自动执行，详见 README「基础模板」。
- 创建与重建时的挂载和网络检查（见「安全」）可能让之前成功的请求返回 `403`（错误码 `forbidden`）：挂载非 MiniBox 创建的卷、挂载已被其它 Box 使用的卷、挂载 `minibox-data`，或把网络改为既不是 Box 网络、也不是 Box 当前网络的网络。已有 Box 保持现有挂载与网络，只有改动这些字段时才受影响。需要在 Box 之间共享卷，请等待 `volume:attach` 授权（#13）落地。

## [0.3.0] - 2026-10-21

### 新增
- Docker 镜像：基于官方 `oven/bun`，支持 `linux/amd64` / `linux/arm64`，包含 OCI 标签与健康检查；发布到 `ghcr.io/arnochenfx/minibox`。
- 发布工作流（`.github/workflows/release.yml`）：推送 `vX.Y.Z` tag 后自动校验版本、运行检查与测试、构建并推送多架构镜像（`X.Y.Z` / `X.Y` / `latest`），并创建 GitHub Release。
- 环境变量 `MINIBOX_VERSION`：覆盖显示的版本号。
- 界面多语言：英文 / 简体中文，点击右上角（控制台顶栏与登录页）的语言图标按钮一键切换；默认跟随浏览器语言，选择保存在 localStorage。服务端错误返回英文消息及 `key` / `params`，由前端翻译。

### 变更
- 版本号在运行时解析：`MINIBOX_VERSION` → `git describe --tags` → `package.json`，不再写死。
- 侧边栏左下角显示当前版本（`MiniBox vX.Y.Z`）；导航「设置与关于」更名为「设置」。
- 设置页的关于卡片不再显示 Bun 版本。

### 工程化
- 代码格式化与检查从 Biome 换成 oxfmt + oxlint（`bun run fmt` / `fmt:check` / `lint`），`bun run check` 依次运行格式检查、lint、类型检查和测试。
- 新增 CI 工作流（`.github/workflows/ci.yml`）：推送到 main 和 Pull Request 时自动检查与测试，并做 Docker 构建冒烟测试；发布工作流复用同一套检查。
- 新增配置加载、i18n 词典与错误消息的单元测试。

### 修复
- Box 详情页标签栏右侧多出的竖向滚动条（标签负外边距导致容器溢出 1px）。

### 文档
- README 截图更新为英文界面（v0.3.0）。

### 移除
- 侧边栏标语；设置页的「安全须知」卡片（相关说明保留在 README 中）。
- 登录页底部的「基于 Docker 与 Bun 构建」文字。

## [0.2.0] - 2026-10-20

### 新增
- 宿主机监控：CPU 使用率（/proc/stat 差值）、负载、内存、磁盘（系统盘 / Docker 数据目录）、运行时长、Docker 版本与容器数量，以及 Box 配额与宿主机容量对比；CPU、内存保留最近数分钟历史并以迷你折线图展示。
- 全新控制台界面：侧边导航、顶部宿主机状态指示、浅色 / 深色主题（默认跟随系统）、状态徽标、空状态、骨架屏、消息提示与危险操作确认对话框，适配移动端。
- 概览页、Box 详情页（概览 / 终端 / 日志 / 资源 / 快照 五个标签页）。
- 创建 Box 对话框：模板选择、规格预设（小型 2 核 4 GB / 中型 4 核 8 GB / 大型 8 核 16 GB / 自定义）、滑块调整，并按宿主机容量校验。
- 最近操作记录（内存中保留，服务重启后清空）。
- 品牌标识：Logo、字标、favicon 与 Apple Touch 图标；全新登录页。
- `GET /api/health`、`GET /api/system`、`GET /api/host/metrics`、`GET /api/activity` 接口。
- 登录失败限流（同一 IP 5 分钟内最多 10 次）。
- 单元测试（`bun test`）、类型检查、Biome 代码检查与格式化。

### 变更
- 后端按职责拆分为 config / auth / docker / host / routes / ws 等模块，TypeScript 严格模式。
- 统一的错误响应格式 `{ "error": { "code", "message" } }` 与正确的 HTTP 状态码；输入校验集中处理。
- 结构化 JSON 日志；收到 SIGINT / SIGTERM 时优雅退出。
- 配置统一从环境变量 / `.env` 读取（`HOST`、`PORT`、`ACCESS_KEY`、`DOCKER_SOCKET`、`LABEL_PREFIX` 等）。
- 接口路径规范化：`/api/auth/*` 登录登出，`/api/boxes/:id/snapshots` 创建快照，`/api/boxes/:id/terminal` 终端，`/api/snapshots/:ref/boxes` 从快照创建 Box。
- 新建 Box 默认启用 `--init`，并将交换空间限制为与内存上限一致。
- 删除快照 / 模板时会校验 MiniBox 标签，不会误删其他镜像。

## [0.1.0] - 2026-10-20

### 新增
- 首个可用版本：Bun + dockerode 后端，Box 创建 / 启停 / 删除、快照、模板、资源热更新、日志、网页终端，访问密钥登录。
