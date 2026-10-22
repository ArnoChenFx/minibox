# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- 检查点导出、导入与定时检查点（#11，第三部分）：`POST /api/checkpoints/:id/export`（202，任务）把一个检查点封装为 `.mbckpt` 包，口令 12 到 1024 个字符，首尾不能有空白，不能含换行或 NUL。口令只用于封装，不写入包、日志、审计或任务记录。包保存在 `DATA_DIR/packages/`（目录 700，文件 600），24 小时后自动清理；`GET /api/packages/:id/download` 下载，`POST /api/packages`（`application/octet-stream`）上传，`POST /api/packages/:id/import`（202，任务）导入到 `host` 指定的宿主机（缺省 `local`）。导入前重新校验包的字节与清单：口令不对返回 `400`（`package_passphrase_wrong`），包损坏或不是检查点包返回 `400`（`package_invalid`）。导入成功后删除包，失败则保留，以便再次尝试。包大小上限为 `CHECKPOINT_PACKAGE_MAX_MB`（默认 2048，范围 1 到 65536），超过返回 `413`。包只含这一个检查点的卷数据与清单，不含检查点仓库的密钥；带系统层、没有卷数据或早于检查点的快照不能导出（`409`）。密钥只以只读文件的形式交给辅助容器，从不进入环境变量。定时检查点：`GET`、`PUT` 与 `DELETE /api/boxes/:id/checkpoint-schedule` 为每个 Box 设置计划，每 1 到 720 个小时（`everyHours`）或每天 `HH:MM`（`at`）运行，二者只能选其一。每天定时按 `timezone` 时区运行（IANA 时区名，如 `Asia/Shanghai`，缺省 UTC；`+08:00` 这类偏移或未知时区返回 `400` `schedule_timezone_invalid`），夏令时切换时仍按当地钟点；控制台按浏览器时区设置，显示为「每天 03:00（Asia/Shanghai）」，下次与上次运行按本地时间并标出时区。已保存的时区若服务器不再识别，计划保留并暂按 UTC 运行，记录警告，响应带 `timezoneUnknown: true`，控制台提示重新设置。后台每分钟检查一次，到点时拍下自动检查点，并遵守保留策略与仓库容量上限（`CHECKPOINT_CAPACITY_MB`）。停止或休眠的 Box 跳过，且不会因此被唤醒；计划检查点不算作活动，不会让空闲 Box 无法休眠；Box 迁移到其他宿主机后计划随之在新宿主机上运行；仓库达到上限时同样跳过。计划保存在 `DATA_DIR/checkpoints/schedules/`，重启后继续执行；控制台显示上次与下次运行，未跳过的运行（成功或失败）写入审计 `checkpoint.scheduled`。缺省没有计划，单机行为不变。导出、导入与计划的 REST 与 MCP（`export_checkpoint`、`import_checkpoint`、`get_checkpoint_schedule`、`set_checkpoint_schedule`、`clear_checkpoint_schedule`，位于 `storage` 工具集）以及控制台 Box 详情页的「检查点」标签页都只对所有者开放，令牌不能获得这些权限；命令行暂无检查点命令。

### 变更
- 请求体上限：只有检查点包上传（`POST /api/packages`）可以超过 Bun 默认的 128 MiB，最大为 `CHECKPOINT_PACKAGE_MAX_MB` 加 1 MiB（#11）。其余请求（JSON 接口、MCP、预览）仍限 128 MiB：声明更大的请求体在路由之前即返回 `413`（`payload_too_large`），未声明长度的请求体读取或转发超过上限时停止。

## [0.4.0] - 2026-10-22

### 新增
- 多宿主机（[#21](https://github.com/ArnoChenFx/minibox/issues/21) 第一部分）：可以在控制台「设置 → 宿主机」或 API 中添加其它 Docker 引擎作为宿主机，创建箱子时选择宿主机（缺省 `local`）。三种连接方式：`unix://` 套接字、`tcp://`（必须双向 TLS）与 `ssh://user@host`（经 SSH 转发引擎套接字，添加前须确认主机密钥指纹）。
- 宿主机登记在 `DATA_DIR/hosts.json`（权限 600），凭据存放在 `DATA_DIR/hosts/<id>/`（目录 700，文件 600）。凭据不出现在任何 API 响应、日志或审计中。没有 `hosts.json` 时只有本机，既有数据无需迁移。
- 宿主机管理仅所有者可用：`GET /api/hosts`、`POST /api/hosts/test`、`POST /api/hosts`、`DELETE /api/hosts/:id`，对应 MCP 工具 `list_hosts`、`test_host`、`add_host`、`remove_host`（`meta` 工具集，默认开启）；CLI 暂无宿主机命令。添加、测试与删除都写入审计日志。仍有箱子、卷或检查点的宿主机不能删除（`409`），本机也不能删除。
- 令牌的 `hosts` 授权限定其可用的宿主机（`local`、一个列表或 `*`）。`admin` 预设可用全部宿主机，其它预设只可用 `local`。授权之外的宿主机返回 `403`（`host_not_granted`）。
- 宿主机多于一台时，箱子带有 `hostId`，控制台显示宿主机卡片、顶栏的宿主机筛选与「不可达」状态。远端宿主机离线或超过 5 秒未响应时，列表仍然返回，其箱子显示为不可达，不阻塞其它宿主机。
- 远端宿主机暂不支持端口预览、快照与存为模板（返回 `501`）。模板与检查点不复制到其它宿主机，缺少模板镜像时创建返回 `400`。
- 多宿主机第二部分（[#21](https://github.com/ArnoChenFx/minibox/issues/21)）：
  - 宿主机用量：`GET /api/hosts/usage`（仅所有者）按宿主机返回引擎报告的容器数（运行中与总数）、运行中 Box 预留的 CPU 与内存，以及它们当前的用量（由统计采样近似）。离线宿主机的预留与用量为 `null`。对应 MCP 工具 `get_host_usage`（`meta` 工具集）。概览页为每台宿主机显示在线状态、延迟、核数、内存、容器数、预留与用量。远端宿主机的核数与内存来自 `docker info`。
  - 容量预留：宿主机多于一台时，运行中 Box 的 CPU 与内存限额按宿主机登记。新的运行中 Box（含快照与检查点派生）、增加运行中 Box 的 CPU 或内存的调整，以及让 Box 在目标宿主机上运行的迁移，若使预留超过容量乘以 `HOST_OVERCOMMIT` 则返回 `422`（`insufficient_capacity`）。`HOST_OVERCOMMIT` 默认 `1`，取值 1 至 10。单机安装不做预留检查，启动已停止的 Box 也不做检查（已知限制）。
  - 自动放置：`POST /api/boxes` 的 `host` 可设为 `"auto"`。只考虑在线、已有模板镜像且有余量的宿主机（令牌只考虑其授权的宿主机），选择 CPU 与内存中较紧一项的剩余比例最大的一台，并列时保留靠前的宿主机（`local`）。无可用宿主机时分别返回 `503`、`400`（`template_image_missing`）或 `422`。
  - 跨机迁移：`POST /api/boxes/:id/move` 接受 `{ "host", "confirm"? }` 与 `If-Match`（缺失返回 `428`，过期返回 `412`）。未确认时返回 `409 confirmation_required` 与预览，且不做任何改动；确认后返回 `202` 与任务。迁移流式发送模板镜像（`docker save | docker load`，保留镜像 id）；运行中的 Box 在复制本地卷时暂停；本地卷复制到目标，NFS 卷在目标重新挂载而不复制，工具卷映射到目标的共享工具卷；在目标创建容器并在 Box 应当运行时启动；确认后才写入新宿主机的规格；最后删除源端的容器与复制的卷，删除失败时在结果的 `leftovers` 中列出。规格写入之前的任何失败都会撤销目标端的改动并恢复源端。Box 的 id、名称、卷、环境变量与规格历史保留，可写层、进程与容器 IP 丢失，检查点留在原宿主机。绑定挂载、未由 MiniBox 创建的卷与被同宿主机其它 Box 共享的卷会在改动前被拒绝。
  - 迁移的权限与入口：仅所有者或管理员预设（令牌须可使用全部宿主机与全部 Box，Box 使用了密钥时还需要 `secret:use`）可以迁移，其它令牌返回 `403`（`move_owner_only`）。迁移计入审计（`box.move`）。MCP 工具 `move_box` 位于 `move` 工具集（`/mcp?toolsets=move`）。控制台 Box 页在宿主机多于一台时显示「迁移到宿主机」，迁移任务显示在任务面板中，成功后页面打开 Box 的新容器 id。
- Box 的环境变量可以在创建时设置（创建对话框中默认折叠的「环境变量」），也可以在概览页编辑。保存通过重建完成，沿用预览与确认；普通值以掩码显示，可点击显示。`POST /api/boxes` 接受 `env`，最多 64 项。
- 宿主机密钥：`GET /api/secrets`、`PUT /api/secrets/:name` 与 `DELETE /api/secrets/:name`，以及「设置」中的「密钥」卡片。环境变量的 `secretRef` 在创建与重建时注入容器；缺少的密钥返回 `400`（`env_secret_missing`），不会以空值启动。删除正在使用的密钥返回 `409` 并列出 Box，`force=true` 可强制删除。替换密钥的值在下一次重建时生效，启动不会读取它。
- 盒子详情页新增「存为模板」：把 Box 的系统层（apt 与 sudo 安装的软件、系统文件的改动）保存为模板，并记录来源 Box。不包含 `/workspace` 与 home 卷，数据请使用检查点。接口为 `POST /api/boxes/:id/template`，MCP 工具为 `save_template`（`tools` 工具集），CLI 为 `template save`。权限与提升为模板相同；名称已存在时返回 `409`（#15）。

### 变更
- `secretRef` 不再只存储：创建与重建时注入容器。升级前已保存的 `secretRef` 若没有对应密钥，之后的重建会返回 `400`，启动已停止的 Box 会返回 `409`。请先在「设置」中设置这些密钥。
- 重建对话框的环境变量由 `NAME=value` 文本框改为逐行编辑。
- 工具目录已不只包含 Agent CLI：控制台、API 说明、MCP 说明与 README 中的「Agent CLI 工具」统一改称「工具」（Tools），接口与 id 不变（#8）。
- 侧边栏的「快照」并入「模板」：旧快照显示在模板页的「旧快照」折叠区域，可提升为模板、从它创建 Box 或删除。`#/snapshots` 会打开模板页。快照的 REST、MCP 与 CLI 接口保持不变，作为底层方式（#15）。
- 登录页与 README 的说明统一为：检查点保存数据，模板保存环境（#15）。
- 快照提升为模板时，若名称已被占用，`POST /api/snapshots/:ref/promote` 返回 `409`（`template_name_taken`），不再覆盖同名模板。
- 任务面板更易读：桌面端加宽到约 900px，左侧每项显示操作、工具或模板名、Box 与相对时间，右侧标题显示操作、对象与 Box、状态、开始时间与用时。命令收在可展开的「命令」一行中并可复制；输出为 12px 等宽字体的深色区域，默认不换行、可切换自动换行，运行中自动跟随到底部，手动向上滚动后停止跟随。ANSI 颜色与粗体安全渲染，其他控制序列与 `\r` 重绘不再显示为乱码。任务接口新增 `subject` 字段，记录工具 id、模板或快照名（旧任务为空）。

### 修复
- 按宿主机限定 Box 的查找：引擎回退不会解析到另一台宿主机上的同名容器（[#21](https://github.com/ArnoChenFx/minibox/issues/21) 第一部分的审查）。
- 远端宿主机拒绝某项功能时的提示，补充了中文的功能名称（`host_unsupported`）。
- 环境变量界面对齐：编辑行的「显示」按钮移到值输入框内，普通值与密钥行的四列（名称、类型、值、移除）等宽等高；概览卡片的名称与值垂直居中在同一行；窄屏下每个变量分两行排列。「设置 › 密钥」表格的字号与令牌表一致，替换与删除按钮之间留出间距，窄屏只显示图标；卡片内表格的左右边距与卡片标题对齐。
- 经 SSH 连接的宿主机上执行命令时丢失输出、以退出码 `126` 失败：SSH 隧道的本地连接改为半关闭，通道结束时不再提前断开（#101）。

### 文档
- 新增 NAS / NFS 部署指南（[`docs/nas.md`](docs/user-guide/nfs.md)、[`docs/nas-zh.md`](docs/zh-CN/user-guide/nfs.md)）：Linux `/etc/exports` 与群晖、威联通、TrueNAS SCALE、Unraid 的导出设置，squash 与 uid 1000 的映射，「添加 NFS」各字段与等价的 API，推荐挂载选项，服务器不可用时的行为，以及根据实测整理的故障排查表。步骤已在 NFS-Ganesha 上经 Docker 实际验证；README 的存储池一节加了入口（#30）。
- 文档重新整理：README 改为产品介绍，其余文档按类别放在 `docs/` 下（快速开始、用户手册、管理、参考），并提供简体中文版本与链接检查（#105）。
- 新增中英双语的项目主页（`site/`），由 `main` 发布到 GitHub Pages：<https://arnochenfx.github.io/minibox/>（#98、#102）。
- 许可证由 MIT 改为 Apache-2.0，新增 `NOTICE`（#103）。

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
- 宿主机密钥只保存在 `DATA_DIR/secrets/env/<名称>`（权限 `600`）中，任何接口都不返回其值，日志、事件、审计、容器标签与规格也不含值。管理密钥只限所有者；令牌引用密钥需要 `secret:use`，只有 `admin` 预设具有该 scope。快照、存为模板与带系统镜像的检查点在 Box 引用密钥时返回 `409`（`secret_in_image`），因为镜像会保存容器环境。
- 快照与检查点不再保存 Box 设置的环境变量值：`docker commit` 会把容器的环境变量复制进镜像，此前由快照或检查点创建的 Box 能读到这些值。之后的提交会为每个已设置的名称写入空值（镜像自带该变量时保留镜像的值）。升级前制作的快照与检查点仍含原值，若其中有敏感信息，请删除它们。
- 检查点仓库的密码以只读文件 `/run/secrets/repo.key` 交给 restic 辅助容器（`RESTIC_PASSWORD_FILE`），不进入环境变量或容器配置，`docker inspect` 看不到它（#11）。
- Agent API 令牌与访问密钥分开（#13）。明文（`mbx_…`）只在创建时返回一次，`DATA_DIR/tokens.json` 只保存 SHA-256。scope 包括 `box:read`、`box:write`、`box:delete`、`exec`、`box:ssh`、`files:read`、`files:write`、`port:expose`、`checkpoint:create`、`checkpoint:restore`、`volume:read`、`volume:write`、`volume:attach`、`tool:install`。资源范围默认是该令牌创建的 Box（`created-by-me`），也可以指定 id、标签或全部 Box；卷必须显式列出；宿主机默认只有 `local`。预设为 `readonly`、`operator`、`sandboxed-agent` 与 `admin`。`sandboxed-agent` 默认最多 5 个 Box、合计 8 个 CPU 与 16384 MB、TTL 最长 4 小时、每分钟 60 次请求。超出配额返回 `403`（`quota_*`），速率超限返回 `429`。吊销立即生效；`DELETE /api/tokens/:id?deleteCreated=true` 同时删除该令牌创建的 Box。`exec` 可以读写该令牌有权使用的 Box 上的全部挂载。创建 Box 时若工作区卷已经存在，或更新挂载指向已有卷，缺少对该卷的 `volume:attach` 会返回 `403`。签发与吊销令牌只有所有者可以做，`admin` 预设不能签发令牌。更换 `ACCESS_KEY` 不会吊销这些令牌。审计日志会打码本进程内创建的令牌，以及形如 `mbx_` 再加至少 20 个字符的值。同一枚令牌也可以作为 `/mcp` 的 Bearer 使用，`tools/list` 与每次调用都受其 scope 约束；吊销会结束它的 MCP 会话、终端、事件流与任务流，并在 `failedBoxes` 中列出无法删除的 Box。TTL 到期后 Box 会停止、不删除（#12）。
- 错误的 `Authorization: Bearer` 密钥计入登录限流：`/api/`、`/mcp` 与终端 WebSocket 和登录共用同一计数，超限后返回 `429`。正确的密钥不计入，也不会被拒绝。此前 Bearer 密钥的错误不受限制。
- `/mcp` 接受访问密钥与 Agent 令牌（#13）。持有访问密钥的 MCP 客户端拥有完全的所有者权限，包括以 `root` 执行 `exec`（非「严格」档位）、`delete_box` 与 `rebuild_box`，因此应优先发放令牌。README、README-zh 与 `docs/agents.md` 已用警示块写明。
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
- 创建 Box 与重建时，挂载和网络都要经过结构检查（设计文档 §9.2）。这些检查独立于 `volume:attach` 授权（#13），所有者同样受其约束。`minibox-data`（保存访问密钥与会话）、池根卷 `<前缀>-pool-<池名>`、内部辅助卷，以及没有 MiniBox 标签的卷一律拒绝挂载。检查以卷记录为准：记录的所有者是另一个仍存在的 Box 时拒绝，因此别的 Box 的工作区不能被挂走；独立记录（例如共享工具卷）可以被多个 Box 挂载。尚不存在的名字只能新建为独立卷，且不能以 `<前缀>-ws-` 或 `<前缀>-pool-` 开头；记录或引擎卷已丢失时返回 `409 volume_missing`，不会静默重建。挂载卷需要 `volume:attach`，读写挂载、新建卷以及不带 `mounts` 的新建 Box 还需要 `volume:write`；`pool.replace` 需要 `pool:admin`。重建时网络只能是宿主机的 Box 网络，或 Box 当前已在使用的网络，`host`、`none` 与 `container:*` 始终拒绝。不符合时返回 `403`（错误码 `forbidden`），容器与规格都不变。`PATCH /api/boxes/:id` 更新挂载时只检查新增或改变的挂载，与现有挂载相同的（同一卷、路径与模式）不再检查。
- 卷的辅助容器（chown、池目录的创建与用量测量）不接入网络，根文件系统只读，丢弃全部能力后只加回所需的能力，禁止提权，限制内存与进程数，退出后由引擎删除（#24）。

- 实时帧（`sync` 与 `box`）只含容器环境变量的名称，不含值：同一帧会送到每个打开的事件流。REST 接口的响应不变。重建对话框会把它显示的环境变量原样写回，因此盒子详情页先经 REST 读取完整的盒子，再打开该对话框（#17）。
- 交互终端的 exec 也经由同一个包装脚本运行，因此网页终端断开时，附着进程可以在箱内结束（#14）。
- 会话（tmux）的所有命令与附着进程都以 `dev` 身份运行，包括「严格」档位，不以 root 运行（#14）。
- 会话的输入从不写入审计日志：`session_send` 只记录按键数与字节数，终端只记录开启、关闭以及两个方向的字节数（#14）。
- 接管锁同样约束关闭：接管期间，Agent 的 `DELETE /api/boxes/:id/sessions/:name` 与 `minibox session close` 返回 `409 taken_over`（可重试），会话保持存在；只有控制台能关闭被人持有的会话（#14）。
- Bearer 终端以只读的 tmux 客户端附着（`attach-session -r -f ignore-size`），忽略窗口尺寸；服务端丢弃它发来的 `resize` 消息，因此不会改变控制台的窗口大小（#14）。该附着需要 tmux 3.2 或更高版本，更旧的 tmux 返回 `409 conflict` 并说明版本（#14）。
- 会话的资源上限：每个 Box 最多 16 个 tmux 会话（箱内每一个 tmux 会话都计入，包括名称 MiniBox 无法使用的会话），每个会话最多 8 个同时打开的终端。其中 Bearer 终端最多 6 个，其余 2 个留给控制台，因此 Bearer 终端无法把人挡在门外；超限返回 `429 too_many_requests`。`session_read` 只回看 4000 行历史，单条 tmux 命令的输出最多保留最新的 4 MiB（#14）。
- 会话按 tmux 的会话 id 与创建时间识别，改写 `@minibox-origin` 选项不会重置接管（#14）。
- 接管锁不约束在箱内以 `dev` 运行的 `exec`：它与 tmux 服务器同属一个用户，可直接调用 `tmux send-keys` 或 `tmux kill-session`。README、README-zh 与 `docs/agents.md` 已说明这一边界（#14）。

### 新增
- 自定义工具目录管理：所有者可在 Box 的「工具」页新增、编辑与删除自定义工具（`DATA_DIR/tools.d/<id>.json`，中英文界面）。新操作 `tool.custom.list`、`tool.custom.put`、`tool.custom.delete` 同时提供 REST（`/api/tools/custom`）、CLI（`minibox tool custom`）与 MCP（`list_custom_tools` 等）。条目包含安装、升级、卸载、检测命令与可选的停止命令（卸载前在 Box 内以 `dev` 执行）。保存前按加载器的规则校验，原子写入；覆盖内置 id 需要 `overrideBuiltin`；删除只移除文件，不卸载共享工具卷上的工具。令牌一律不能使用这些操作。
- 检查点（Refs #11，第一部分）：`POST /api/boxes/:id/checkpoints` 为 Box 拍下检查点，默认包含工作区 `/workspace` 与主目录 `/home/dev` 两个自有卷。`include.system` 可把可写层提交为系统镜像，`include.volumes` 可加入 Box 已挂载的共享卷，缓存与共享工具卷永不包含。`consistency` 取 `live`（默认）、`pause` 或 `stop`。数据保存在 restic 仓库中（镜像 `restic/restic:0.18.1`，仓库卷 `minibox-checkpoints-local`，密码位于 `DATA_DIR/secrets/checkpoint-repo.key`），检查点记录保存在 `DATA_DIR/checkpoints/`。`POST /api/checkpoints/:id/fork` 从检查点派生新 Box，使用新卷，默认不复制主目录（`copyHome: false`）。`POST /api/boxes/:id/rollback` 需要 `If-Match`：数据恢复到新卷，Box 重建到这些卷上，原卷保留；没有 `confirm: true` 时返回 `409 confirmation_required` 与预览。新增 `GET /api/checkpoints`、`GET /api/checkpoints/:id`、`PATCH /api/checkpoints/:id`（置顶与标签）与 `DELETE /api/checkpoints/:id`，置顶的检查点不能删除。已有的系统快照以只读检查点的形式出现，可以派生与删除。令牌使用既有的 scope（`checkpoint:create`、`checkpoint:restore`、`box:write`）与资源范围。拍摄、派生与回滚期间 Box 保持唤醒，空闲休眠不会打断它们；休眠中的 Box 不会因检查点被唤醒。保留策略、回滚的确认与撤销、配额与控制台见下一条。
- 检查点（#11，第二部分）：回滚改为先确认或撤销。回滚前的安全检查点以停止式拍摄，数据恢复到新卷并重建 Box 后，旧卷保留为待定状态：`POST /api/boxes/:id/rollback/confirm` 确认后删除旧卷，`POST /api/boxes/:id/rollback/undo` 撤销后重新挂载旧卷并删除恢复出的卷（回滚之后写入的数据丢失），`GET /api/boxes/:id/rollback` 查看待定的回滚。保留策略：自动检查点按 Box 保留最新的 `CHECKPOINT_KEEP_LAST` 个（默认 20），并删除超过 `CHECKPOINT_KEEP_DAYS` 天（默认 30）的，手动与置顶的从不自动删除。容量：`CHECKPOINT_CAPACITY_MB`（默认 0，不限）达到 80% 时记录告警并在界面提示，达到上限时拒绝新的自动检查点（回滚也因此被拒绝），手动拍摄仍可进行。令牌配额 `maxCheckpoints` 限制令牌拍摄的手动检查点合计，`sandboxed-agent` 默认 20。启动时解冻因检查点中断而暂停的容器。`GET /api/checkpoints/usage` 仅所有者可读。控制台的 Box 详情新增「检查点」标签页（中英文）。尚未实现：导入导出（含加密导出包）、定时检查点、单文件取回、MCP 工具、独立卷快照、重建前的检查点、按 Box 覆盖的保留策略与回收站。
- 空闲自动休眠与按需唤醒（#12）：Box 空闲一段时间后自动停止（期望状态 `stopped`，原因 `idle`），容器与工作区卷保留。空闲时长由 `BOX_IDLE_TIMEOUT_SEC` 与每个 Box 的 `idleTimeoutSec` 决定，`0` 关闭休眠。活动包括终端的输入、输出与打开中的连接（无论由 MiniBox 还是箱内其它 tmux 客户端打开，如 `docker exec -it <box> tmux attach`）、exec、会话的启动 / 读取 / 发送、端口预览（含流式响应与预览 WebSocket）、卷上的文件调用（计入挂载该卷的每个 Box），以及箱内异步任务结束时；读取 Box 记录与统计不计入。exec 与 `session_start` 唤醒任何已停止的 Box；终端 WebSocket 与端口预览只唤醒休眠中的 Box，人为停止的 Box 仍返回 `409`。唤醒记入审计 `box.wake`。`ttlSec` 从创建时刻起算，到期后停止 Box（原因 `ttl`），已到期的 Box 不能被启动、重启、重建、唤醒、exec、会话、终端或预览再次启动（`409`，`box_ttl_expired`）。终端与预览会在所有已注册的 Docker 主机上查找 Box。控制台的终端页会说明休眠与 TTL 到期的原因，并可唤醒休眠中的 Box（中英文）。卷上的文件调用计入挂载该卷的每个 Box 的活动，但不启动已停止的 Box（#9、#12）。
- Agent API 令牌（#13）：设置页或 `POST /api/tokens` 创建，`GET /api/tokens` 列出（不含明文），`DELETE /api/tokens/:id` 吊销。创建响应只包含一次明文。操作注册表的默认鉴权钩子改为按 scope、资源范围与配额检查；所有者与浏览器会话仍可做全部操作。`box.create` 与 `snapshot.fork` 接受可选的 `ttlSec`，并记入规格的 `lifecycle.ttlSec`。令牌省略 TTL 或传 `null` 时写入其上限；超过上限的值返回 `403`。到期后停止 Box 见 #12。事件列表与事件流按令牌范围过滤：所有者与未收窄的 admin 令牌看全部，其他令牌只看自己造成的事件以及有权使用的 Box 的事件。中英文界面均可创建、复制一次明文，并吊销令牌。
- 数据卷与存储池（#24）：卷是独立对象，记录放在 `DATA_DIR/volumes`，并写明创建它的主机。Box 通过 `mounts` 挂载零到多个卷，每次挂载指定路径与读写模式。新建 Box 默认挂载工作区 `/workspace`、主目录 `/home/dev`、共享只读工具卷 `/opt/minibox/tools`（每个主机一只，名为 `<前缀>-tools-<主机 id>`）与本地缓存 `/home/dev/.cache`。存储池支持 `local`、`nfs` 与 `path` 三种后端：`PUT /api/pools` 替换配置，`GET /api/pools` 探测可达性；非本地池不可达时，启动、重启与创建返回 `503 docker_unavailable`。删除 Box 时 `deleteVolume=true` 只删除记录中所有者为本 Box、且没有其它 Box 挂载的卷。已有的 `<前缀>-ws-*` 卷会被识别为卷，不改名、不补标签。新增 `/api/volumes`、`/api/pools` 系列接口与控制台「卷」页面（中英文）。存储写入需要 `confirm: true`：`POST /api/volumes`、`DELETE /api/volumes/:id?confirm=true` 与 `PUT /api/pools` 没有该标志时返回 `409 confirmation_required` 与 `details.preview`，不改动任何内容；保存存储池与删除卷的界面会先显示预览（#24）。
- 数据卷与模板列表支持搜索：输入即时过滤，按 Esc 或 × 清除，没有匹配时显示单独的提示。卷列表可按 Box、角色、存储池或归属分组，分组方式保存在本浏览器中。
- 新建 Box 时可以选择卷（#24）：创建对话框的「卷」区域默认不发送 `mounts`，四个角色卷照常新建；选择「自定义」时发送界面中显示的完整挂载列表，它替换默认卷。每一行从已有的卷中选择一个，并填写路径与读写模式；属于其他运行中 Box 的卷不可选，共享的读写挂载会显示提示。卷与挂载相关的服务端错误显示在该区域内。
- 实时推送（#17）：每台主机由一个采样器（`HostSampler`）维护盒子缓存与资源采样。`GET /api/events/stream` 在不带过滤条件时同时推送 `sync`、`box`、`sample`、`host`、`link` 与 `task`（仅状态变化）帧。这些帧以事件名区分、不带 `id`，因此不改变 `Last-Event-ID`，也不写入 `events.db`；审计事件与实时状态共用同一条进程内事件总线。带过滤条件的事件流只收到已存储的事件，与原来一致。`GET /api/boxes/:id/stats?history=true` 返回该盒子最近的采样（按时间从早到晚），供详情页的图表使用。
- 日志实时推送（#17）：`GET /api/boxes/:id/logs/stream?tail=N` 以 SSE 推送盒子的容器日志。先发 `sync`（最新的 `tail` 行，默认 300，最多 5000），之后每行一帧 `line`；容器被替换时重新发送 `sync`，盒子被删除时发送 `closed` 并结束。鉴权与 `GET /api/boxes/:id/logs` 相同：`box:read` 范围，盒子须对调用者可见，并计入 `STREAM_MAX_CONNECTIONS`。每台主机上每个盒子只有一条容器日志跟随，由其全部日志流共享，没有订阅者后保留 30 秒。停止的盒子只在它重新运行后再读取。控制台的日志面板改用该流，断线时按退避重连，并在断线期间回退为每 4 秒读取一次。该接口不在 OpenAPI 中，与事件流和任务流一致（#17）。
- 终端会话（#14）：每个 Box 可以有多个具名的 tmux 会话，名称 1 到 32 位，以字母或数字开头，其后可含字母、数字、`-` 与 `_`。会话在 Box 内运行，关闭页面或断开连接后继续运行，刷新页面后控制台回到上次打开的会话。会话的发起方（`agent` 或 `human`）保存在 tmux 中；接管状态只保存在内存中，MiniBox 重启后每个会话的控制方回到其发起方的默认值。
- 会话接口：`GET` 与 `POST /api/boxes/:id/sessions`，`GET`（支持 `lines` 与 `since`）与 `DELETE /api/boxes/:id/sessions/:name`，以及 `POST /api/boxes/:id/sessions/:name/input`（`keys` 或 `text`，二者只能提供一个）。MCP 的 `session` 工具集提供 `session_start`、`session_send` 与 `session_read`（`/mcp?toolsets=core,session`）；CLI 提供 `minibox session ls`、`start`、`read`、`send` 与 `close`。这些操作在操作注册表中各定义一次，REST、OpenAPI、MCP 与 CLI 由此生成。
- 人工接管（#14）：Agent 发起的会话在控制台中默认只读，点击「接管」后由人输入。接管期间，Agent 的 `session_send` 与关闭会话（`DELETE`）返回 `409`，错误码为 `taken_over`，`retryable` 为 true，并附重试提示；`session_read` 仍可用。点击「还给 Agent」手动归还。人在 `SESSION_TAKEOVER_IDLE_SEC` 秒内没有输入（默认 300，`0` 表示关闭）时，接管自动归还。
- `session_read` 返回 `lines` 与游标 `cursor`。把最新的游标作为 `since` 传回，只读取新增的行；无法接续时返回 `reset: true` 并给出当前窗口。
- 活动标签页（#14）：Box 详情的「日志」标签页改为「活动」，合并 exec 历史、容器启动 / 停止 / 内存溢出（OOM）事件（`container.*`）、终端会话的开启与关闭（`terminal.*`），以及会话的启动、发送与关闭（`session.*`）。`docker logs` 保留在页面下方的折叠区域。默认不记录键入的内容。
- 新增配置 `SESSION_TAKEOVER_IDLE_SEC`（默认 `300`，取值 0 到 86400 的整数）。README、README-zh 与 `.env.example` 均有说明（#14）。
- 异步任务（#16）：模板构建与快照创建返回 `202` 和 `taskId`，进度经现有事件总线的 `task` 主题以 SSE（`GET /api/tasks/:id/events`）推送，不再把长请求挂在 `idleTimeout` 为 60 秒的连接上。任务状态和最近 64 KB 输出保存在 `DATA_DIR/tasks.db`；进程重启后，未完成的任务记为 `interrupted`。同一时间只能构建一个模板，每个 Box 同时只能提交一个快照。控制台顶栏有任务抽屉（中英文），可看实时日志并取消。Bun 的空闲计时从请求开始计算且不会被心跳延长，`server.timeout(req, 0)` 才会关掉它（见 `tests/long-work-routes.test.ts`）。
- 命令执行、MCP 与 CLI（Refs #9）。`POST /api/boxes/:id/exec` 在 Box 里运行命令：`argv` 直接执行，`cmd` 经 `/bin/sh -c`，默认用户 `dev`、目录 `/workspace`，可选 `cwd`、`env`（审计只记变量名）、`stdin`、`timeoutSec` 与 `user`。退出码来自 `exec.inspect`。超时会在箱内杀掉进程树，响应仍是成功，并带 `timedOut: true`（没有退出码时用 137）。终止失败时返回 `502`，exec 保持 `running`，可以用 `POST /api/execs/:execId/kill` 重试。前台 `timeoutSec` 最多 55 秒，更长的命令用 `background: true`（最多 3600 秒）；后台 exec 每个 Box 最多 8 个、全局 64 个，超限返回 `429`，且不唤醒 Box。「严格」档位只允许 `dev` 或 `1000` 作为用户，其他档位的 `root` 运行在审计中标记为 `privileged`。已停止的 Box 会先被启动，这会把期望状态改为运行，因此版本号加 1；空闲超时与 TTL 仍是 #12。结束后的 `durationMs` 不再增长。`background: true` 立即返回 `execId`，`GET /api/execs/:execId?waitMs=` 长轮询（最长 25000 毫秒），`POST /api/execs/:execId/kill` 结束进程树。内联输出保留每个流头尾各约 16 KiB；更长的内容给出 `outputRef`，`GET /api/execs/:execId/output` 读取保存的头尾窗口（各 64 KiB，`DATA_DIR/exec`）。`exec.start`、`exec.finish`、`exec.killed` 记在事件总线上，属于活动档且不合并，并用 `parentId` 挂到对应的 `exec.run`。`POST /mcp` 是带 Bearer 的 Streamable HTTP MCP（不接受浏览器 Cookie；`GET` 不提供 SSE）。`?toolsets=` 选择工具集，默认 `core,meta`。设计目录是 27 个工具、默认 15 个；当前实现是 6 个 Box 工具加上 `exec`、`exec_get`、`exec_kill`，默认工具集共 9 个。`rebuild_box` 不在默认工具集中，放在非默认的 `rebuild` 工具集（`/mcp?toolsets=rebuild`），共 10 个；`session` 工具集的 3 个见下文（#14）；`storage` 工具集见下文（#24）。`bun run build:cli` 用 `bun build --compile` 生成 `dist/minibox`，至少提供 `minibox box ls` 与 `minibox exec`。错误体包含 `retryable`，需要时还有 `hint`。`exec` 可以读写该 Box 上挂载的每一个卷。文件 API（归档、对已停止 Box 的辅助容器读写）不在这次交付中，留到 Volume（#24）之后。
- MCP 的非默认 `storage` 工具集（`/mcp?toolsets=storage`）暴露卷与存储池的 9 个工具：`list_volumes`、`get_volume`、`create_volume`、`delete_volume`、`attach_volume`、`detach_volume`、`measure_volume`、`list_pools` 与 `replace_pools`。`create_volume`、`delete_volume`、`attach_volume`、`detach_volume` 与 `replace_pools` 需要 `confirm: true`，否则返回 `confirmation_required` 与 `details.preview`，不改动任何内容。`attach_volume` 与 `detach_volume` 经 `rebuildBox` 执行，适用与 `rebuild_box` 相同的挂载规则。`measure_volume` 只刷新缓存的大小，不需确认。MCP 工具的错误结果新增 `details` 字段（#24）。
- Box 规格写入 `DATA_DIR/boxes/<id>.json`（权限 600）。稳定 ID 形如 `bx_…`，与容器 ID 分开，名称全局唯一。已有 Box 在列出或读取时自动认领：不改容器名，也不改容器标签（D6，认领后的属主修正留给 #24）。`DATA_DIR` 丢失时从标签和 `inspect` 降级恢复；空闲超时、TTL、标签、工具、环境变量回到默认值，并在 `recovery.needsReset` 中标明需要重新设置。原地更新（CPU、内存、进程数、标签、空闲超时、TTL、重命名）走 `docker update` / `docker rename` 与规格文件，容器标签保持创建时的内容。请求须带 `If-Match: <revision>`；缺少该头返回 428，版本不一致返回 412。新建 Box 的重启策略为 `no`，启动时的协调器按期望状态 `running` 或 `stopped` 启动或停止，并把引擎上的重启策略改回 `no`（D8）。漂移比较 `inspect` 与规格，不自动改回资源或挂载。规格保留最近 20 个版本（Refs #23）。
- `POST /api/boxes/:id/rebuild`：未带 `confirm: true` 时返回 `409 confirmation_required`，`preview` 包含可写层的 `docker diff` 和计划变更。确认后创建新容器（不启动）并校验镜像与配置，停旧容器并改名为 `-old`，把新容器改成正式名称后启动；成功则删除旧容器，失败则恢复旧容器并把规格回滚到上一版。认领仍不改名；重建会把容器名改为 `<前缀>-<id>`（D6）。保留挂载卷、稳定 ID、名称和最近 20 个规格版本；丢失未写入卷的可写层、运行中的进程（含 tmux）和容器 IP。`PATCH /api/boxes/:id` 若带上与当前不同的模板、挂载、环境变量、网络或安全档位，返回同一预览，且不应用同一请求里的原地字段。`secretRef` 只存储、不注入。第一阶段仍只在创建时准备一个工作区卷；显式增删挂载才会重建，不引入卷池（#24）。重建前检查点不在这一步（#11）（Refs #23）。
- 事件与审计（#25）：每次操作执行后（REST、MCP 与 CLI 的调用都会记录），在 `DATA_DIR/events.db`（SQLite，WAL 模式）中记录一条事件，写入前脱敏（访问密钥、常见凭据格式，环境变量只记名称）。新增 `GET /api/events`（过滤与游标分页）与 `GET /api/events/stream`（SSE，支持 `Last-Event-ID` 续传），两者都经过现有的鉴权与同源检查。保留策略可配置并每小时清理：`EVENT_RETENTION_AUDIT_DAYS`（默认 365）、`EVENT_RETENTION_ACTIVITY_DAYS`（默认 30）、`EVENT_OUTPUT_RETENTION_DAYS`（默认 7）与 `EVENT_OUTPUT_MAX_MB`（默认 512）。`events.db` 需要可写的 `DATA_DIR`，否则启动失败。新增进程内事件总线，供后续的任务与状态采样复用。所有者与未收窄的 admin 令牌可以读取全部事件；其他 Agent 令牌只看自己范围内的事件（#13）。命令输出的保留策略已就位，exec 的输出按此策略保存。
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
- 操作执行器的鉴权钩子：未通过鉴权的操作返回 `403`，错误码为 `forbidden`，`key` 为 `operation_forbidden`。默认钩子按 Agent 令牌的 scope、资源范围与配额检查；所有者始终通过。`ownerOnly` 仍导出，供测试使用（#22 #13）。
- 操作审计日志：每次执行写一行结构化日志，事件名为 `operation.ok`（读操作为 debug 级别）、`operation.denied` 或 `operation.failed`（5xx 为 error），字段包括操作名、种类、主体、`run`、结果与错误码（#22）。
- 基础模板以非 root 用户 `dev` 运行（uid/gid 为 1000，可用构建参数 `DEV_UID` / `DEV_GID` 调整）。网页终端与 `docker exec` 默认以 `dev` 进入，并提供无密码 `sudo`（仅限 Box 内）。
- 基础模板新增 `tmux`、`jq`、`ripgrep`、`openssh-client`、`unzip` 与 `sudo`，并保留 `git`、`curl`、`python3`、`build-essential`、`procps`、`vim-tiny` 与 `less`。
- 基础模板的挂载点约定：`/workspace`、`/home/dev`、`/opt/minibox/tools`（只读共享工具，其 `bin` 在 `PATH` 中）与 `/home/dev/.cache`。缓存变量 `XDG_CACHE_HOME`、`npm_config_cache`、`PIP_CACHE_DIR`、`YARN_CACHE_FOLDER` 指向 `/home/dev/.cache` 下，`NPM_CONFIG_PREFIX` 指向 `/home/dev/.npm-global`。卷挂载由 #24 落地。
- 基础模板标签 `minibox.template.user`、`minibox.template.uid` 与 `minibox.template.gid` 记录 uid 约定。
- `scripts/check-box-image.sh` 与 `bun run check:template`：用 Docker 检查基础模板镜像的用户、sudo、工具、挂载点、环境变量、登录 Shell 的 PATH，以及共享卷读写。
- `STOP_TIMEOUT_SEC`（默认 `3`，允许 0 到 300 的整数）：停止与重启 Box 时，发送 SIGTERM 后等待退出的秒数，超时则强制结束。空值或无效值回退为 3 秒（#19）。
- `DELETE /api/boxes/:id` 的响应新增 `volumeError` 字段：删除数据卷失败时返回引擎给出的原因。Box 本身仍会被删除（#19）。
- 新增「关于」页面（侧边栏「设置」之后，路由 `#/about`）：显示 logo、版本、服务启动时间、Bun 运行时版本与 Docker 引擎版本（不可用时显示「不可用」），并提供 README、文档、更新日志、问题反馈与许可证的链接。中英文界面均已翻译。
- 新增配置 `STREAM_MAX_CONNECTIONS`（默认 `256`）：同时打开的事件流、任务流与日志流上限，三者共用。超出时新连接返回 `429`，错误码为 `too_many_requests`，`key` 为 `stream_limit`，响应体给出上限。控制台按退避间隔重试，连接结束时名额即释放。README、README-zh 与 `.env.example` 均有说明（#17）。
- SSH 访问：`ssh`、`scp`、`sftp` 与 `ssh -L` 经由 MiniBox 进入 Box，不发布宿主机端口。`GET /api/ssh/:box` 以 WebSocket 承载一条 SSH 连接，用户为 `dev` 或 Box id，其他用户名（包括 `root`）一律拒绝。访问密钥或令牌在握手时鉴权；令牌需要新增的 `box:ssh` 范围，默认拒绝，`operator` 与 `admin` 预设包含它，`sandboxed-agent` 不包含。与 `exec` 一样，它能在 Box 内执行命令并读写全部挂载。`-L` 只转发到 Box 内的回环地址，并需要 `port:expose`；`-R`、Unix 套接字转发、X11 与 agent 转发被拒绝并审计。停止或休眠的 Box 在连接时启动，打开的 SSH 连接让 Box 保持运行；停止（手动、空闲或 TTL）、删除或重建 Box 会断开它的 SSH 连接，TTL 已过的 Box 拒绝连接（`409 box_ttl_expired`）。连接、通道与断开都写入审计日志。每个 Box 最多 8 个连接，全局 64 个，每个连接 16 个通道。新增 `GET /api/ssh/host-key`，主机密钥保存在 `DATA_DIR/ssh_host_ed25519_key`。CLI 新增 `minibox ssh-proxy <box>` 与 `minibox ssh-config [--append]`，后者写入 `~/.ssh/config`、固定主机密钥，并把服务器地址与密钥保存到 `~/.config/minibox/ssh-credentials.json`（权限 600），ProxyCommand 无需导出环境变量。Box 详情页新增「SSH」按钮与对话框（中英文）。
- CLI 随服务器分发（Refs #85）：`GET /cli/install.sh`（macOS 与 Linux）与 `GET /cli/install.ps1`（Windows）把 `minibox` 安装到 `~/.local/bin`（或 `MINIBOX_INSTALL_DIR`），不需要 sudo，并按 `GET /cli/checksums.txt` 校验；`GET /cli/minibox-<os>-<arch>` 提供 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64` 与 `windows-x64.exe` 五个二进制。这些路由公开只读，每个客户端每分钟最多 120 次请求。二进制在该版本的首次请求时由 `bun build --compile` 构建，缓存于 `DATA_DIR/cli`；与服务器不同的平台需要的 Bun 运行时（约 90 MB）从 npm 下载一次，无法访问 npm 时返回 `503` 与原因及替代方法（`HTTPS_PROXY`，或在源码目录执行 `bun run build:cli`）。`minibox --version` 输出构建该二进制所用的版本。`minibox <命令> --help` 把帮助输出到标准输出并以 0 退出；此前 `--help` 以 2 退出并输出到标准错误，无参数仍以 2 退出。`ssh-proxy` 发现服务器比 CLI 新时输出一行升级提示，`GET /api/ssh/:box` 的探测响应带 `x-minibox-version`。Box 页面的 SSH 对话框（中英文）第一步改为安装命令，并填入当前地址。
- Windows 上的 SSH（Refs #85）：`minibox ssh-config` 以 `USERPROFILE` 作为用户目录；编译版 CLI 的 `ProxyCommand` 写入带引号的绝对路径（使用 `/`），`UserKnownHostsFile` 同样加引号；新增 `--url` 与 `--token`。`install.ps1` 把安装目录加入用户 PATH，并把已有的 `minibox.exe` 移为 `minibox.exe.old`；新文件无法运行时移回原处。Box 详情页的 SSH 对话框新增 PowerShell 步骤，每条命令都带复制按钮；长命令在空格处换行或横向滚动，不再从单词中间断开。
- Agent CLI 工具（#8）：创建 Box 时可勾选，运行中的 Box 可在「工具」页安装、升级与卸载。目录按四组展示（AI 编程助手、语言与运行时、终端与开发工具、网络），创建对话框与「工具」页都带搜索框，可按名称、说明或分组过滤。目录内容见 `catalog/*.json`，每一项都从其官方来源安装。镜像或家目录里已有的工具显示为已安装并附版本，不会重复安装；升级与卸载只作用于 MiniBox 装在 tools 卷上的工具。
- Tailscale 无需 root：目录条目以 `dev` 用户从官方静态包安装，并核对发布的 sha256，任一步失败即中止。`minibox-tailscale up` 以用户态网络模式（`--tun=userspace-networking`）在后台启动 `tailscaled`，状态保存在家目录的 `~/.local/state/tailscale`，然后打印登录链接。守护进程在 `localhost:1055` 提供 SOCKS5 与 HTTP 代理，访问 tailnet 主机的出站连接需经它（`ALL_PROXY=socks5h://localhost:1055`）。发往 Box tailnet IP 的入站 TCP 与 UDP 被转发到 Box 内的 `127.0.0.1`。没有 ICMP。Box 重启或唤醒后需重新执行 `minibox-tailscale up`。
- 卸载前先停止守护进程：目录条目可声明 `stop` 命令，卸载时以 `dev` 在运行中的 Box 内执行。停止失败则工具保持已安装。

### 变更
- Box 的列表、详情、统计与主机指标改为读取每台主机的缓存。缓存由 Docker 容器事件保持最新，列表不再对每个容器调用 `inspect` 或 `docker stats`：Docker 调用次数与 Box 数量无关，也不随打开的标签页数增加。`HostMonitor` 不再每个间隔列出 Box，Box 汇总取自采样器。采样器未就绪时（启动之后、列出完成之前，或与引擎断开期间），读取退回引擎（#17）。
- 控制台改为订阅 `GET /api/events/stream`。盒子列表、概览、详情与主机指标由推送更新，原有的 3 秒、5 秒、10 秒定时刷新取消。事件流断开时，各页面回退为轮询（主机指标与详情 3 秒，任务抽屉 2 秒，盒子列表与活动列表 5 秒，概览 10 秒），并按 1 秒起、最长 30 秒的间隔重连。详情页的资源图表读取后端的采样环形缓冲，长度由 `METRICS_HISTORY` 决定。日志面板开启自动刷新时改用日志流，只在日志流断开期间每 4 秒读取一次（#17）。终端会话列表仍每 10 秒轮询一次，会话没有实时帧。
- 每台主机只有一个采样器和一条容器事件订阅。断线后按 1 秒起、最长 30 秒的退避重新订阅，并重新列出容器。`METRICS_INTERVAL_MS` 决定主机指标的间隔，并在有实时流打开时决定盒子采样的间隔（见下文）。同一盒子与 tail 的日志读取在 2 秒内共享一次引擎调用（#17）。
- 终端 WebSocket 地址改为 `/api/boxes/:id/terminal?session=<名称>`，必须带 `session` 参数，否则返回 `400`。控制台已经如此连接（#14）。
- 终端 WebSocket 对 Bearer 调用者改为只读：可以读取输出；输入，以及接管与归还的控制帧，返回 `forbidden` 错误帧（`terminal_read_only`）。此前 Bearer 调用者可以直接输入。浏览器会话的行为不变（#14）。
- 「日志」标签页改为「活动」。`/api/boxes/:id/logs` 接口不变，`docker logs` 输出移到页面下方、默认折叠（#14）。
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
- 盒子资源采样只在有实时流打开时按 `METRICS_INTERVAL_MS` 进行，没有实时流时，只有最近 5 分钟内有人读取过用量（`stats` 或统计历史）才每 30 秒一次（不短于 `METRICS_INTERVAL_MS`），租约过期后停止采样，不调用 `containerStats`。从没有实时流变为有实时流时，采样器立即采样一轮。因此没有实时流时，REST 的 `stats` 字段最多滞后 60 秒，更旧的样本不再返回；统计历史返回环形缓冲中已有的样本（#17）。
- 事件流与任务流的待发队列同时按帧数（1000 帧）与字节数（1 MiB）限制。超出任一上限时队列被清空：任务流发送 `reset`；事件流发送 `reset`，有实时状态时还发送新的 `sync`，客户端据此重新读取。同一主机的 `sample` 与 `host` 帧在队列中只保留最新一帧，慢速客户端收到的是最新状态，而不是逐个补发的过时状态（#17）。
- 链路就绪时，采样器每 60 秒重新列出一次容器，替换缓存并发布其中的变化，以追平事件流静默停止（无错误、也不结束）时漏掉的变化。重新列出不改变链路状态，断线检测与重连照旧。列出在队列之外进行，30 秒内未返回即放弃，挂起的引擎调用不会阻塞写操作；列出期间若缓存有过变化，结果被丢弃，留待下一次（#17）。
- `ContainerWatch` 不再开第二条引擎事件订阅：它经由采样器的 `subscribeEvents()` 接收同一份事件。事件按 `id`、`action` 与 `timeNano` 去重，引擎重连后重放的事件不再被记录两次（#17）。
- 采样器在一批状态变化中最多八个容器并发 `inspect`（`INSPECT_CONCURRENCY`）。一批挂起的读取合计占用队列的时间由 N × 5 秒降为 ⌈N ÷ 8⌉ × 5 秒（#17）。
- 控制台的下拉选择框（`select.select`）改为应用自绘的菜单：颜色随主题切换，支持方向键、Home / End、按字母快速定位，Esc 与点击外部关闭，并且不会被对话框或表格容器裁切。原生 `select` 仍保留在页面中，负责取值、`name` 与 `change` 事件。
- 基础模板新增 `openssh-sftp-server` 与 `socat`，分别供 `sftp` 与 `ssh -L` 使用。已有的 Box 不会自动获得它们：重新构建基础模板后重新创建 Box，或在标准档位下执行 `sudo apt-get install -y openssh-sftp-server socat` 补装。

### 工程化
- 新增真实引擎测试 `tests/docker-sessions.test.ts`（设置 `MINIBOX_TEST_DOCKER=1` 时运行，`bun run test:docker` 会执行）。它覆盖：会话在终端退出后保留、刷新后重新附着、Agent 会话只读与接管锁、Bearer 只读、空闲归还、关闭会话结束终端、静默连接的心跳关闭、断开而不发关闭帧时不残留附着进程、「严格」档位以 `dev` 运行、`session_read` 的 `since` 与 `reset`，以及 Box 启停事件。测试镜像 `tests/fixtures/tmux` 基于 `alpine:3.20` 并安装 tmux（#14）。
- `scripts/docker-integration.ts` 逐个运行真实引擎测试文件（每个文件一个进程），结束后清理两者创建的容器、镜像与卷（#14）。
- 新增 tmux 模拟（`tests/support/fake-tmux.ts`），以及会话服务（`tests/terminal-service.test.ts`）、tmux 格式与解析（`tests/tmux-format.test.ts`）、容器事件（`tests/container-watch.test.ts`）的单元测试，并扩展终端 WebSocket 与操作注册表的测试（#14）。
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
- 新增 `tests/tokens.test.ts`：哈希存储、预设、`created-by-me`、配额、TTL 上限、速率限制、卷挂载拒绝、事件可见性与立即吊销。HTTP 等价性转录在原有请求之后追加令牌的创建、列表与吊销（#13）。
- 架构测试新增两条规则：`src/operations/` 不得依赖 HTTP 层或组合根；REST 适配层只能通过操作访问服务与引擎（#22）。
- 新增 `bun run test:docker`（`scripts/docker-integration.ts`），在独立的 `mbit` 标签前缀下运行真实引擎测试，结束后清理本次运行创建的容器、镜像与卷。CI 新增非必需的 `Integration tests (real Docker engine)` 任务（#19）。
- 新增假引擎 socket 上的 Docker 适配器测试（`tests/docker-adapter.test.ts`），以及终端 WebSocket 的鉴权、Origin 检查、非运行状态拒绝和 `parseControl` 测试，并为 `format.js` 与 i18n 加载补充前端纯逻辑测试（#19）。
- `tsconfig.json` 的类型检查范围包含 `scripts/`（#19）。
- CI 的 `Docker build (smoke)` 任务新增基础模板的多架构构建（`linux/amd64`、`linux/arm64`），并对 amd64 镜像及模拟的 arm64 镜像运行 `scripts/check-box-image.sh`。新增的 `docker/setup-qemu-action` 同样固定到完整 commit SHA。
- 以路由测试取代依赖 Bun 空闲计时与固定时长阈值的 `tests/idle-timeout.test.ts`，后者在 CI 中不稳定。新的 `tests/long-work-routes.test.ts` 检查 MiniBox 自身的约定：模板构建与快照提交立即返回 `202`，任务进度流与事件流对自身请求调用 `server.timeout(req, 0)`。
- 新增 `tests/host-sampler.test.ts` 与 `tests/box-cache-api.test.ts`，以计数的 fake 运行时验证列表、详情、统计、日志与主机汇总的引擎调用次数，并验证它们不随 Box 数量增长。新增 `tests/event-stream.test.ts` 与 `tests/events-live.test.ts` 覆盖 SSE 的实时帧，`tests/web-live.test.ts` 覆盖前端的连接与轮询回退。`tests/docker-runtime.test.ts` 新增真实引擎下的缓存计数与外部变更测试（#17）。新增 `tests/log-follow.test.ts`、`tests/log-stream.test.ts`、`tests/sampler-logs.test.ts` 与 `tests/box-logs-stream.test.ts`，覆盖日志跟随、日志流及其鉴权；`tests/host-sampler.test.ts` 增加采样租约的用例；`tests/container-watch.test.ts` 检查重放事件只记录一次。`tests/docker-adapter.test.ts` 与 `tests/docker-runtime.test.ts` 覆盖 `followLogs`（真实引擎需要 `MINIBOX_TEST_DOCKER=1`）（#17）。
- `Runtime.events` 接受 `since` 参数；`FakeRuntime` 模拟 `create`、`start`、`die`、`stop`、`restart`、`rename`、`update` 与 `destroy` 等容器事件，并能断开事件流（#17）。
- 新增 `tests/docker-ssh.test.ts`，用真实的 OpenSSH 客户端（`ssh`、`scp`、`sftp`、`ssh -L` 与被拒绝的 `ssh -R`）连接 Docker 中的 Box，并加入 `bun run test:docker`。测试夹具镜像 `debian:bookworm-slim` 由 `scripts/docker-integration.ts` 预先拉取。`tests/ssh-gateway.test.ts` 与 `tests/cli.test.ts` 用假引擎覆盖鉴权、范围、root 拒绝、通道、限额、审计、空闲休眠与 `ssh-config`。`tests/template.test.ts` 检查两个新增包，`scripts/check-box-image.sh` 检查 `sftp-server` 与 `socat` 可用。

### 修复
- 网页终端的空闲超时由 0（关闭）改为 30 秒。静默的连接会被关闭，并结束其附着进程，不再长期占用 exec（#14）。
- 终端输出的背压：`ws.send` 返回背压时暂停读取 tmux 的输出，缓冲可以继续时恢复；未读数据超过 4 MiB 时关闭连接，不再无限缓冲（#14）。
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
- 采样的统计调用不再阻塞写操作：统计调用在队列之外执行（并发 8），每个调用最长等待 `min(METRICS_INTERVAL_MS, 5 秒)`，超时即记为一次缺失的采样。引擎的 `docker stats` 挂起时，停止、启动、删除与重建盒子仍会及时返回，缓存随即反映盒子的状态（#17）。Docker 的一次性统计调用需要 1 到 2 秒，因此 `METRICS_INTERVAL_MS` 应保持在 2000 毫秒以上（默认 3000）。
- 引擎挂起的容器 `inspect` 与订阅后的首次列出不再阻塞写操作（#17）。采样器读取一个容器超过 5 秒仍无答复时放弃该次读取：该容器保留缓存中的旧状态，并在下一轮采样时重读。首次列出超过 30 秒未返回时视为断线，按退避重试，期间读取退回引擎。写操作后等待缓存的 `observe()` 最多等待 5 秒。盒子的引擎 `inspect`（详情与操作前的检查）每次最多等待 5 秒，超时后取消引擎请求并返回 `503` `docker_unavailable`；此前这类读取没有超时，引擎挂起时请求一直等待（#17）。此前一个挂起的 `inspect` 会使另一个盒子的停止一直等到引擎答复为止。见 `docs/runtime.md` 的「超时」。
- 实时流中超过每客户端 1 MiB 字节上限的同步帧（`sync`）会让客户端陷入无限重置：之后的每一帧都超过上限，每帧都触发一次重置并重新发送同步帧。现在每个客户端的字节上限取 1 MiB 与其收到的最大同步帧的 2 倍中较大者，且只升不降（#17）。
- 周期性重新列出的守卫在列出结束后才释放，列出请求带上取消信号：超过 30 秒未返回时请求真正结束。此前守卫在超时后即释放，引擎挂起时每 60 秒就堆积一个未完成的列出（#17）。
- 事件流与任务流读取时抛出异常后，现在会结束并运行一次 `onEnd`，释放连接名额与总线订阅。此前这类流不运行 `onEnd`，名额不会释放：达到 `STREAM_MAX_CONNECTIONS` 后，新的事件流与任务流都返回 `429`，直到进程重启（#17）。
- 基础模板等标签被重新指向新镜像后，以该标签创建的 Box 重建时，此前即使传入同一个模板名也返回 `rebuild_empty`，容器仍运行旧镜像；确认重建后规格仍记录旧摘要，Box 报告 `digest` 漂移。现在这类 Box 跟随标签：预览列出 `标签 (旧镜像短 ID) → 标签 (新镜像短 ID)` 的模板变更，确认后运行标签当前指向的镜像，`template.digest` 随之更新。快照 Box 与标签已删除的 Box 不跟随。
- 镜像早于基础模板的 Box（缺少 `tmux`，或没有 `dev` 用户）启动会话时，此前显示引擎的原始错误（`docker_error`，或 `tmux failed: exit status 126`）。现在返回 `409` 与 `session_image_unsupported`，提示重新构建基础模板，并把该 Box 重建到新模板上。会话列表、启动与附着、终端错误帧都走同一映射。
- 创建 Box，或重建到另一个镜像时，若模板的 `minibox.template.uid` 与 `minibox.template.gid` 标签给出的属主，与可写 `/workspace` 卷根目录的属主不同，启动前把根目录改为模板的属主（只改根目录，不递归）。此前已有内容的卷保留原来的 root 属主，`dev` 无法写入 `/workspace`。重建回滚时恢复原属主。只读挂载与不带属主标签的模板不做改动。
- NFS 池上的 exec 超时不再等待冻结的挂载：终止命令、终端附着与 SSH 中继改在 `/` 下启动，终止命令的创建与启动限时 5 秒。前台 exec 超时后，若终止超过 2 秒仍未完成，调用返回 `status: running` 与 `timedOut: true`，终止在后台继续重试。此前 `hard` 挂载冻结时，带 `timeoutSec` 的 exec 要等服务器恢复才返回。辅助容器的工作目录也统一为 `/`。
- 新建卷时，MiniBox 会以 Box 用户（uid 1000）在新的卷目录中试写一次。写不进去时创建失败，返回 `502 bad_gateway`（`storage_unwritable`），并删除刚建的子目录。错误提示说明应设置 `all_squash,anonuid=1000,anongid=1000`（或 `root_squash,anonuid=1000,anongid=1000`），并链接 NAS 指南。此前导出目录映射为 `nobody` 时，卷会静默创建，Box 内却无法写入。
- NAS 拒绝创建卷目录（`Permission denied` 或 `Operation not permitted`）时，返回 `502 bad_gateway` 与 `storage_permission_denied`，不再是 `400 validation_failed`，错误提示同样指向 NAS 指南。其他准备失败仍是 `400`（`volume_prepare_failed`）。
- 存储池改为并发探测。一台服务器无应答时，其余池照常报告，整次探测约 5 秒返回。单个池 5 秒内没有完成探测即报告 `unreachable`（`no answer within 5 s`），探测本身继续在后台运行，结束时更新缓存。15 秒缓存不变。此前池逐个探测，排在前面的池一直没有应答时，后面池的结果也要等它返回。

### 文档
- README、README-zh 与 `docs/agents.md` 说明会话工具、接管与归还的规则、`SESSION_TAKEOVER_IDLE_SEC`、终端 WebSocket 的参数与控制帧、MCP 工具数（13 个），以及事件表中的活动与审计分档。`docs/design.md` 新增 §10.5 实现说明并更新 §8.9；`docs/runtime.md` 说明 FakeRuntime 对 tmux 的模拟（#14）。
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
- README 与 README-zh 的功能表、架构图、`METRICS_*` 配置说明、API 参考（`GET /api/boxes`、`GET /api/boxes/:id/stats?history=true`、日志读取窗口与日志流，以及事件流的实时帧）同步更新。`docs/runtime.md` 新增「盒子缓存与采样器」一节，修正了关于 `HostMonitor` 的说明，并补充测试与已知限制，记录采样租约与日志跟随（#17）。`docs/design.md` 新增 §8.11（#17）。
- README、README-zh、`docs/agents.md` 与 `docs/design.md` §10.2 说明接管锁覆盖关闭、不约束箱内的 `exec`，以及会话与终端的上限（#14）。
- README 与 README-zh 新增「SSH 访问」章节，并在功能表、空闲休眠、API 参考（`GET /api/ssh/host-key` 与 `GET /api/ssh/:box`）与数据目录表中补充 SSH 相关内容。`docs/design.md` §9.1 与 §9.5 加入 `box:ssh` 范围，并说明 `sandboxed-agent` 不包含它。

### 升级说明
- 终端 WebSocket 地址必须带 `session` 参数。使用 `/api/boxes/:id/terminal` 而不带参数的脚本，需改为 `?session=<名称>`，或先调用 `POST /api/boxes/:id/sessions`（#14）。
- 通过 Bearer 连接终端并输入的脚本，需改用 `POST /api/boxes/:id/sessions/:name/input`，或 MCP 的 `session_send`（#14）。
- 基于不含 tmux 的模板创建的 Box，会话操作返回 `409`（`conflict`），并提示安装 tmux，或基于当前基础模板重建（#14）。
- 接管状态不跨重启保存：MiniBox 重启后，每个会话回到其发起方的默认控制方（#14）。
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
- 新 Box 复用旧 Box 保留下来的工作区卷时，卷内 `/workspace` 仍属于 root，`dev` 无法写入。在该 Box 运行时执行一次 `docker exec -u root minibox-<名称> chown -R 1000:1000 /workspace` 即可修复。创建或重建到带属主标签的模板（如基础模板）时，MiniBox 会在启动前把工作区根目录改为模板属主，卷内已有文件的属主不变。认领已有容器，或模板不带属主标签时，仍需在该 Box 运行时执行一次上述命令，详见 README「基础模板」。
- 创建与重建时的挂载和网络检查（见「安全」）可能让之前成功的请求返回 `403`（错误码 `forbidden`）：挂载没有 MiniBox 标签的卷、挂载属于其它 Box 的卷、挂载 `minibox-data`，或把网络改为既不是 Box 网络、也不是 Box 当前网络的网络。已有 Box 保持现有挂载与网络，只有改动这些字段时才受影响。独立卷可以挂到多个 Box 上，工具卷因此照常共享。读写挂载需要 `volume:write`。所有者持有全部 scope，现有客户端不受影响；令牌只有被授予 `volume:write` 时才能读写挂载（#13）。
- 检查点（Refs #11）：启动时创建 `DATA_DIR/checkpoints/`（权限 700）。首次使用仓库时，生成 `DATA_DIR/secrets/checkpoint-repo.key`（权限 600），创建仓库卷 `minibox-checkpoints-local`，并从镜像仓库拉取 `restic/restic:0.18.1`，因此 Docker 需要能够访问镜像仓库。备份 `DATA_DIR` 时请包含 `secrets/`：丢失这把密钥，检查点就无法再打开。已有快照不做改动，以只读检查点的形式出现在 `GET /api/checkpoints` 中。

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
