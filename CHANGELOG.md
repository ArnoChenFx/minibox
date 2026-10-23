# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- 重建类变更暂存、统一应用（Refs [#26](https://github.com/ArnoChenFx/minibox/issues/26)）：Box 设置中修改环境变量或挂载不再立即重建，而是暂存在服务端（重启后保留）。设置页顶部显示「N 项变更待应用 [查看差异] [应用并重建] [放弃]」；应用前的确认框列出规格差异、将被结束的终端会话数、可展开的 Docker 差异、默认勾选的「先创建检查点（含系统层）」，并说明所有卷中的数据保持不变。接口为 `GET/PUT/DELETE /api/boxes/{id}/staged`、`GET /api/boxes/{id}/staged/preview` 与 `POST /api/boxes/{id}/staged/apply`；有 `box:write` 的令牌可以暂存与放弃，应用仅限所有者。

## [0.6.0] - 2026-10-23

### 亮点
- **Box 网络出站策略**：每个 Box 可选择 `open`（默认，与以往相同）、`none`（没有对外路由，exec、SSH 与端口预览仍可使用）或 `proxy-only`（只能经 MiniBox 代理访问白名单中的主机，并记录每次连接的主机、端口与字节数）。`BLOCK_HOST_GATEWAY` 可阻止默认网络上的 Box 访问宿主机服务。
- **官方模板**：内置 `node`、`python`、`go` 与 `minimal` 四个官方模板，在某台宿主机首次需要时才构建。`devcontainer.json` 新增支持 `postCreateCommand`、`forwardPorts` 等一部分设置。
- **控制台改版**：导航精简为概览、Box、存储、库、活动、设置六项。Box 详情页分为六个标签页，每个标签页都有自己的地址。概览页新增「正在进行」与「需要关注」。
- **卷的维护**：可批量删除卷，也可在预览后清理孤立卷。共享工具卷在引擎中丢失后自动重建。卷页标出引擎中已缺失的卷，以及所属 Box 已删除的卷。
- **宿主机之间复制检查点**；**启动命令**在代码仓库克隆完成后才运行，Docker 自行启动容器时也会再运行一次，启动失败的原因会保存下来。
- **破坏性变更**：`MCP_ALLOW_OWNER_KEY` 默认改为 `false`，`/mcp` 不再接受所有者访问密钥，请改用 Agent 令牌。见[升级说明](docs/admin/upgrades.md)。

### 新增
- 卷的批量删除与清理孤立卷（[#178](https://github.com/ArnoChenFx/minibox/issues/178)）：卷页可勾选多个卷批量删除，删除前列出每个卷的去向。「清理孤立卷」预览没有任何 Box 配置引用、也没有被挂载的卷，确认后只删除预览列出的卷，并逐个再次检查。共享工具卷、系统卷与被挂载的卷在服务端一律拒绝删除；缓存卷不保留副本，删除后无法恢复。接口为 `POST /api/volumes/delete` 与 `POST /api/volumes/prune`（`dryRun` 默认为 `true`；`dryRun: false` 时必须用 `ids` 指定预览列出的卷）。批量删除需要新令牌权限 `volume:delete`（任何预设都不包含），且只能操作令牌自己创建的卷；清理孤立卷仅限所有者。命令行新增 `minibox volume delete` 与 `minibox volume prune`，MCP 的 `storage` 工具集新增 `delete_volumes` 与 `prune_volumes`。
- 官方模板（[#15](https://github.com/ArnoChenFx/minibox/issues/15)）：MiniBox 内置 `node`、`python`、`go` 与 `minimal` 四个官方模板，各由源码中的一份 Dockerfile 构建，基础镜像固定到具体版本与发行版代号（Node.js 26、Python 3.14、Go 1.26 与 Debian 12）。它们不在启动时构建，也没有预热池：某台宿主机首次需要某个模板时才在该宿主机上构建。创建 Box 时若没有宿主机持有该模板，构建会在 Box 所在的宿主机上作为任务运行，创建请求等待其完成；使用自动选择宿主机时，由余量最大、且可以构建该模板的在线宿主机承担。模板页与创建 Box 对话框列出尚未构建的官方模板，并标注「首次使用时构建」。API 为 `GET /api/templates/official` 与 `POST /api/templates/official/{name}/build`，CLI 为 `minibox template build-official`，MCP 为 `list_official_templates` 与 `build_official_template`。构建与列出仅限所有者；令牌只能在所有者已于该宿主机上构建模板之后使用它。
- 宿主机之间复制检查点（Refs [#21](https://github.com/ArnoChenFx/minibox/issues/21)）：`POST /api/checkpoints/{id}/copy`（请求体 `{ host }`，返回 `202` 与任务）、`minibox checkpoint copy <id> --host ID` 与 MCP 工具 `copy_checkpoint`（`storage` 工具集，仅所有者）把检查点复制到另一台宿主机，检查点行中的「复制到宿主机」按钮提供同样的操作。源宿主机把数据打包成一个口令只为本次复制而生的密封包，包经控制面转交目标宿主机，用完（无论成功与否）即删除。目标缺少基础模板或检查点所用的模板时，先复制这些模板。副本是目标上的新检查点，保留原检查点的标签、置顶、创建时间与 Box 设置；失败时目标上不留下副本的快照，已复制过去的模板保留。包的大小受 `CHECKPOINT_PACKAGE_MAX_MB` 限制，带系统层的检查点暂不能复制。
- 设置 → 宿主机在配置了多台宿主机且其中含非本机宿主机时显示访问提醒：本控制台是所有宿主机的入口，能登录的人可以操作全部宿主机，因此应只给每个 Agent 令牌它需要的宿主机（Refs [#21](https://github.com/ArnoChenFx/minibox/issues/21)）。
- 网络出站策略（[#120](https://github.com/ArnoChenFx/minibox/issues/120)）：`POST /api/boxes`、`minibox box create --egress` 与 MCP 的 `create_box` 接受 `egress` 对象，其中 `mode` 为 `open`、`none` 或 `proxy-only`，`proxy-only` 另可指定 `presets` 与 `domains`。`POST /api/boxes/{id}/rebuild` 与 `rebuild_box` 同样接受它。预设为 `agent-default` 与 `package-registries`；白名单最多 100 个主机，支持 `*.` 通配子域名。`none` 与 `proxy-only` 的 Box 使用各自的私有网络，并由各安装自己的宿主机防火墙链 `MINIBOX-EGRESS-<hash>` 阻止访问宿主机。
- `proxy-only` 代理只转发 80 与 443 端口，拒绝私有、回环与保留地址，并为每次连接记录 `egress.allowed`、`egress.denied` 或 `egress.failed` 事件。事件只含主机、端口、字节数、耗时与原因，不记录路径、查询、请求头或正文。Box 的**设置**中，**安全**分组显示档位、允许的主机与最近被拒绝的连接，活动列表可按**出站**筛选，创建对话框的**高级**中新增**网络出站**选择器。
- `BLOCK_HOST_GATEWAY`（[#120](https://github.com/ArnoChenFx/minibox/issues/120)）：设为 `true` 后，默认网络上的 Box 无法通过桥接网关访问宿主机上的服务。默认关闭。
- 远程宿主机的 Agent 只接受出站地址池 `240.0.0.0/12` 内的网段，或其引擎上某个网络的网段，作为宿主机防火墙的阻止来源，因此控制面无法借此切断宿主机的入站连接。MiniBox 重启或宿主机重启后的对账会重新设置防火墙规则，并继续读取已在运行的代理日志。
- `devcontainer.json` 子集（Refs #15）：从 `.devcontainer/devcontainer.json` 构建的模板现在还读取 `build.target`、`remoteEnv`、`postCreateCommand`、`forwardPorts` 与 `remoteUser`（仅 `dev` 或 `1000`）。由它创建的 Box 在设置任务（`setup.taskId`）中依次克隆代码仓库、把 `forwardPorts` 加为手动预览端口，并以用户 `dev` 运行一次 `postCreateCommand`：挂载了 `/workspace` 时在其中运行，否则在 `/` 中运行。命令上限 30 分钟，失败或超时时保留 Box。`POST /api/boxes` 的响应新增 `setup`，`clone` 仍在并指向同一任务；`minibox box create` 会等待该任务。以令牌创建这类 Box 需要 `exec`（`postCreateCommand`）与 `port:expose`（`forwardPorts`）作用域。设置只在创建时运行，模板保存的 Box 不继承。复制到其他宿主机（同步或迁移）的模板则保留设置。见[模板](docs/zh-CN/user-guide/templates.md#devcontainerjson)。
- 设置 → 密钥的「添加密钥」表单每次打开时自动填入一个新的随机值（32 字节、URL 安全的 base64，共 43 个字符），可「重新生成」、复制、显示，或清空后自行输入或粘贴。
- 创建 Box 的模板选择器支持按名称、标签、描述与镜像搜索，可折叠，搜索时显示全部匹配项，已选模板在折叠时始终可见。模板页的卡片列表过长时同样可以折叠。
- 创建 Box 的工具选择器可按分类折叠，已选工具在折叠时始终可见，搜索时自动展开匹配项。
- 卷列表与 `GET /api/volumes` 为每个卷新增 `engineMissing`（引擎已没有该卷）与 `ownerMissing`（拥有它的 Box 已删除并保留了卷）。控制台的**卷**页以徽标标出这两种状态。
- 创建 Box 对话框的「工具」与「模板」两节可在标题前的箭头按钮处整节折叠，折叠状态保存在浏览器中；折叠时标题旁仍显示已选的模板或工具。「模板」一节移到「规格」下方。
- Box 详情页改为六个标签页：概览、终端、文件、端口、活动与设置（[#26](https://github.com/ArnoChenFx/minibox/issues/26)）。每个标签页有自己的地址，例如 `#/boxes/<id>/terminal`，刷新或收藏后仍停留在原标签页。
- 「设置」标签页分为资源、存储与挂载、工具、环境变量、生命周期、安全与检查点七组，每组有自己的地址，例如 `#/boxes/<id>/settings/checkpoints`。工具分组默认展开，可逐组折叠。手机上标签页与设置分组可横向滚动，打开时当前项在视野内，标题栏按钮收为一行（除启动/停止外只显示图标）。
- 终端标签页列出 Box 内的全部 tmux 会话，并标明每个会话是你创建的还是 Agent 创建的。
- 标题栏的「创建检查点」在任何标签页都可用。在「设置」的检查点分组中创建后，列表立即显示新检查点，无需刷新页面。
- 概览页「正在进行」与「需要关注」（[#26](https://github.com/ArnoChenFx/minibox/issues/26)）：`GET /api/overview`（`overview.get`，作用域 `overview:read`，仅所有者可读）返回 `inProgress` 与 `attention`。「正在进行」列出最近 10 分钟内 Agent 操作过的 Box，以及仍在运行命令的 Box；两张卡片位于容量卡片下方；每行占一行，依次为操作者（令牌名，或 Box 内的 Agent）、最近命令与最近使用的会话、时间和操作，运行中命令的最后 3 行输出与 Agent 备注通过行末的箭头展开。没有需要关注的事项时，「需要关注」收成一行。「需要关注」只列服务器已记录的事项：内存耗尽与检查点失败保留 24 小时，配置漂移、待确认的回滚、卷超出硬上限、存储池不可达、宿主机离线与磁盘不足在其条件存续期间列出。
- 「观察」以只读方式打开会话，「接管」打开同一会话，由人在终端中点击才会接管。不属于任何会话的命令只提供「观察」，它打开 Box 的活动。
- Box 列表中，Agent 正在工作的 Box 显示「Agent 活动中 · 12 秒前」。
- 终端会话有自己的地址（`#/boxes/<id>/terminal/<会话名>`）。在列表中切换会话会更新地址，刷新或分享链接后仍会打开该会话。
- 概览的列表默认只显示前几项：「正在进行」3 项，「需要关注」、概览中的「Box」与「最近活动」5 项。其余通过「展开全部（N）」展开，「收起」收回。

### 变更
- **破坏性变更：`/mcp` 默认拒绝所有者访问密钥。** `MCP_ALLOW_OWNER_KEY` 的默认值由 `true` 改为 `false`。此后，用访问密钥访问 `/mcp` 的请求返回 `401`（`mcp_owner_key_refused`），Agent 令牌不受影响。升级前请为每个 Agent 创建令牌（控制台的**设置**，或 `minibox token create <name>`），并把它设为 Agent 的 Bearer 密钥或 `MINIBOX_ACCESS_KEY`。若要暂时保留旧行为，设置 `MCP_ALLOW_OWNER_KEY=true`，每次使用仍会被记录。启动时若最近 7 天内有访问密钥访问过 `/mcp`，日志会写入 `mcp.owner_key_now_refused` 警告，控制台横幅也会给出同样的做法。`minibox mcp` 遇到拒绝时会说明原因，并提示 `minibox token create`。见[升级说明](docs/admin/upgrades.md)（[#121](https://github.com/ArnoChenFx/minibox/issues/121)）。
- 自动选择宿主机找不到可用宿主机时，错误信息改为「持有该模板，或能够构建它的在线宿主机都没有余量」，因为官方模板可在没有宿主机持有时由余量最大的宿主机构建。
- 离线宿主机的后台检查改为退避。此前每 30 秒检查一次所有宿主机；现在每次连续失败后等待更久，最长约五分钟检查一次。宿主机恢复在线后，检查恢复为每 30 秒一次（Refs [#21](https://github.com/ArnoChenFx/minibox/issues/21)）。
- 更改已有 Box 的出站档位属于重建：API 与 MCP 先返回预览，带 `confirm: true` 确认后才会重建。Box 保留名称、ID 与卷。
- 出站档位不为 `open` 的 Box 无法迁移到其他宿主机（返回 `409`，`egress_move_refused`）。回收站恢复与检查点派生会保留出站策略，并为其创建新的私有网络。Box 视图仅在档位不是 `open` 时包含 `egress` 字段。
- `devcontainer.json` 中不支持的设置不再拒绝整个构建。它们在构建日志中以 `Warning:` 列出，其余设置照常应用。无法按原样应用的设置仍会拒绝构建，例如取值中的 `${…}` 引用，或 `postCreateCommand` 中的 devcontainer 变量（Refs #15）。
- 控制台导航改为六项：概览、Box、存储、库、活动、设置（[#26](https://github.com/ArnoChenFx/minibox/issues/26)，本次仅改导航与路由）。**存储**包含**卷**与**检查点**两个标签页，**库**包含**模板**与**工具目录**两个标签页。标签页写在地址中，刷新或收藏后仍停留在原标签页，检查点与工具目录标签页的地址还包含所选 Box。原来的「资源」「系统」分组与独立的「回收站」入口已取消：回收站从**存储**页面打开，「关于」改为侧栏底部的版本号链接。
- 旧地址继续可用：`#/volumes` 打开存储的卷标签页，`#/templates` 与 `#/templates/<名称>` 打开库的模板标签页，`#/snapshots` 打开模板标签页。
- Box 详情页的「资源」「工具」「检查点」标签页并入「设置」。旧地址继续可用：`#/boxes/<id>/resources`、`/tools` 与 `/checkpoints` 打开「设置」中的对应分组，`/snapshots` 打开检查点分组，`/logs` 打开活动标签页。
- Box 概览精简为状态、指标、Agent 卡片与基本信息，不再需要滚动。出站与安全、环境变量、启动命令、生命周期与挂载移入「设置」的对应分组。
- Box 详情页的标题栏按钮始终靠右对齐，窄屏换行后也靠右，且不遮住 Box 名称。
- 「活动」打开概览页并定位到「最近活动」卡片。全局审计时间线（[#25](https://github.com/ArnoChenFx/minibox/issues/25)）尚未实现，因此暂用这一处。
- 顶栏的宿主机筛选器只在配置了不止一台宿主机时显示。
- 设置页改为左侧分类导航（窄屏时为可横向滚动的一行）。每次只显示一个分类，每个分类有自己的地址（如 `#/settings/secrets`），浏览器的前进与后退可在分类之间切换，默认显示「会话」。令牌横幅的链接直接打开「Agent API 令牌」分类。
- 长列表默认只显示前 5 项，其余通过「展开全部（N）」展开，「收起」收回。涉及设置页的会话、令牌、密钥、通知渠道与投递记录、宿主机与异地目标，创建 Box 的工具与模板选择器，以及模板页的卡片列表。设置页中当前会话排在最前。
- 创建带启动命令的 Box 立即返回，不再等待命令启动。启动与重启仍最多等待 5 秒，超时的启动在后台完成（[#133](https://github.com/ArnoChenFx/minibox/issues/133)）。

### 修复
- 卡片标题栏中相邻的按钮不再挤在一起：检查点的「导入」与「创建检查点」、端口的「刷新」与「添加端口」、模板卡片底部的「构建」与「用此模板创建」与页面标题栏一样间隔 8px，并靠右对齐（Refs [#26](https://github.com/ArnoChenFx/minibox/issues/26)）。
- 官方模板目录读取失败时，模板页不再整页报错，而是照常列出宿主机上已有的模板（与创建 Box 对话框一致）。
- 创建 Box 对话框中可折叠的各节（模板、高级、克隆代码仓库、工具、卷、环境变量）统一使用同一种箭头折叠按钮，样式一致并左对齐。
- 多行文本框（如「额外允许的主机」）按行数显示高度，文字上下留白与「启动命令」一致。
- 挂载的访问模式显示为「只读」/「读写」，不再显示 ro / rw。
- 挂载与环境变量列表（创建 Box、重建 Box、Box 详情）中，「添加挂载」「添加变量」按钮与最后一行之间留出与行间相同的间距，不再紧贴；窄屏下各行之间的间距也更大。
- Box 内 Agent 自助（[#118](https://github.com/ArnoChenFx/minibox/issues/118)）：在 Agent 宿主机上创建带自助令牌的 Box 时，请求在创建流程开始前即返回 `501`（`self_token_host_unsupported`），不再进入后续检查。
- 共享 tools 卷在引擎中丢失后，MiniBox 会以同一记录与引擎名称重新创建该卷（[#128](https://github.com/ArnoChenFx/minibox/issues/128)），不再以 `409 volume_missing` 拒绝创建、启动、重建或移动 Box。本地池上的卷以空卷返回，其中的工具需在 Box 的**工具**标签页点击**补装缺失**重新安装。工作区、主目录与缓存卷仍然拒绝挂载。
- 休眠中的 Box 在终端标签页唤醒后，会话启动完成时页面没有切换到实时终端：终端标签页原先缺少重新渲染的回调，唤醒后停留在「正在唤醒」。
- 重建、移动 Box，或挂载与卸载卷之后，页面留在原来的标签页与设置分组上，不再跳回概览。
- 启动命令：带仓库创建的 Box 在克隆完成后才运行命令。克隆失败或被服务器重启打断时，状态显示原因，命令不会自行运行；等待克隆时的状态为新增的 `cloning`（[#133](https://github.com/ArnoChenFx/minibox/issues/133)）。
- 启动命令：Docker 在 MiniBox 之外启动容器时（例如 `docker start`，或宿主机重启后设有重启策略的容器），命令会再运行一次。每次容器启动只运行一次，重启 MiniBox 不会重复运行（[#133](https://github.com/ArnoChenFx/minibox/issues/133)）。
- 启动命令：启动失败的原因保存在 Box 上，MiniBox 重启后仍会显示，直到命令成功启动。重新运行时，`sudo` 启动的进程也会被结束，经 `sudo` 启动后又脱离的进程除外（[#133](https://github.com/ArnoChenFx/minibox/issues/133)）。

### 工程化
- 新增 `.cursor/environment.json` 与 `.cursor/install.sh`：Cursor 云端 Agent 构建环境时把 Bun 升到最新版并对照 `engines.bun` 检查，再安装依赖；新增 `AGENTS.md`，要求 Agent 不得降低 Bun 版本或改回 `tsc` 类型检查。
- 新增真实引擎的出站集成测试 `tests/docker-egress.test.ts`，由 `bun run test:docker` 运行。它覆盖 `none` 的断网、exec、SSH 与端口预览，`proxy-only` 的允许、拒绝、事件与绕过，以及 `BLOCK_HOST_GATEWAY`。测试使用独立的标签前缀、数据目录与网络，并清理其代理、网络、防火墙规则与镜像。
- 控制台导航的测试：`tests/web-routes.test.ts` 覆盖地址解析、标签页与旧地址的跳转，`tests/web-console-browser.test.ts` 用 Chromium 覆盖导航、标签页切换、刷新后的状态、宿主机筛选器与中文界面。浏览器测试与预览隔离测试一样，未配置 Chromium 时跳过，CI 中缺失则失败。
- Dependabot 监控四个官方模板 Dockerfile（`templates/official/{node,python,go,minimal}`）的基础镜像，与基础模板一样每周检查、提交前缀为 `build`。
- CI 新增 `official-templates` 任务：在 `linux/amd64` 上构建四个官方模板，并对每个镜像运行 `scripts/check-box-image.sh`；最小模板通过 `REQUIRED_TOOLS` 只检查它所带的工具。
- Box 详情页的测试：`tests/web-box-detail.test.ts` 为无 DOM 的组件测试，覆盖设置分组与会话来源标记；`tests/web-box-detail-browser.test.ts` 用 Chromium 覆盖六个标签页的地址与切换、概览不滚动、设置分组、标题栏的「创建检查点」、会话来源、休眠的 Box 在终端中唤醒、工具栏对齐、手机上的单行工具栏与当前标签页可见，以及旧地址跳转。`tests/web-routes.test.ts` 补充了标签页、设置分组与移动后的地址。截图脚本改为打开检查点分组。
- 概览的测试：`tests/overview.test.ts` 以行为方式覆盖 `GET /api/overview` 的权限、正在进行的命令与输出、各类需要关注的事项，以及跨宿主机的情况；`tests/web-overview.test.ts` 覆盖概览的文字、链接与轮询间隔，并核对事项类型与服务器输出 schema 一致；`tests/web-console-browser.test.ts` 在 Chromium 中覆盖概览的四个列表及其展开按钮、观察与接管的地址、会话的切换与刷新、需要关注的链接，以及 Box 列表的活动标记。
- 启动命令的真实引擎测试 `tests/docker-startup-command.test.ts` 新增 Docker 自行启动容器（`docker restart`，以及先停止再 `docker start`）的用例：每次启动命令恰好运行一次。该用例的超时设为 60 秒（[#133](https://github.com/ArnoChenFx/minibox/issues/133)）。

### 文档
- 模板指南新增「官方模板」一节（中英文），说明四个模板的内容、何时构建、重新构建时基础镜像的更新方式，以及权限；API、CLI 与 MCP 参考同步新增相应条目（[#15](https://github.com/ArnoChenFx/minibox/issues/15)）。
- 检查点指南新增「复制到其他宿主机」一节，宿主机指南新增「对所有宿主机的访问」，并说明 `auto` 只考虑持有模板的宿主机、暂不按 `arch` 或 `gpu` 标签放置。API、CLI、MCP 参考与 Agent 指南同步更新，中英文版本一致（Refs [#21](https://github.com/ArnoChenFx/minibox/issues/21)）。
- 新增网络出站文档：英文 `docs/admin/network-egress.md` 与中文 `docs/zh-CN/admin/network-egress.md`，说明各档位、白名单、事件、`BLOCK_HOST_GATEWAY` 与限制（[#120](https://github.com/ArnoChenFx/minibox/issues/120)）。安全指南、配置、CLI、检查点与 Box 指南，以及 `.env.example` 同步更新。
- 模板指南的 `devcontainer.json` 一节改写：列出支持的设置、构建日志中的警告与被拒绝的设置，以及 Box 设置任务的顺序、运行用户、工作目录、时限与失败行为，中英文版本同步。API、CLI、MCP、安全与架构文档同步更新（Refs #15）。
- `/mcp` 访问密钥的说明更新：安全指南、升级说明、配置、MCP 与 CLI 参考，以及 Agent 与访问和令牌指南，中英文同步（[#121](https://github.com/ArnoChenFx/minibox/issues/121)）。
- 快速开始、用户指南与管理文档中提到侧栏「模板」「卷」「回收站」的地方，改为新的导航位置，中英文同步。开发文档同步说明新增的控制台导航浏览器测试。
- Box 内 Agent 与宿主机指南（中英文）说明：Agent 宿主机无法把令牌文件写入 Box，因此不能在其上创建带自助令牌的 Box（[#118](https://github.com/ArnoChenFx/minibox/issues/118)）。
- Box 指南、检查点、环境变量与密钥、空闲休眠、NFS、工具、终端与会话，以及管理文档的网络出站，中英文同步改为新的标签页与设置分组（[#26](https://github.com/ArnoChenFx/minibox/issues/26)）。
- 终端与会话指南新增「在概览中观察 Agent」一节，Box 指南新增「概览与 Box 列表」一节，中英文同步（[#26](https://github.com/ArnoChenFx/minibox/issues/26)）。
- 启动命令指南说明命令在 `ps` 中可见、不应写入密钥，以及带仓库创建、Docker 重启与 `sudo` 进程的行为；环境变量与密钥指南补充对应规则，中英文同步（[#133](https://github.com/ArnoChenFx/minibox/issues/133)）。

## [0.5.1] - 2026-10-23

### 亮点
- **回收站与安全检查点**：删除 Box 或卷时，数据先保留在回收站中，默认保留 7 天（`TRASH_RETENTION_DAYS`），可恢复为新的 Box 或卷。重建 Box、挂载或卸载卷前，自动拍摄一个安全检查点。
- **在线备份与异地目标**：MiniBox 运行时即可把数据目录备份为一个用口令封装的文件，并可离线恢复到空目录。检查点包与备份可推送到 S3 兼容存储桶或 SFTP 服务器，也可从那里拉取。
- **宿主机功能对等**：模板、快照、存为模板、镜像拉取、回滚与端口预览可在 ssh、tcp 与 Unix 套接字宿主机上使用；创建 Box 时自动把缺少的模板同步到目标宿主机。
- **Box 内 Agent 自助**：可为 Box 内的 Agent 开启仅限本 Box 的自助令牌，让它拍摄检查点、向人提问并报告状态。

### 新增
- 回收站与重建安全检查点（[#115](https://github.com/ArnoChenFx/minibox/issues/115)）：删除 Box 或卷时保留其数据副本，保留期由 `TRASH_RETENTION_DAYS` 设定（默认 7，范围 1 到 365），到期后每小时清理一次。删除 Box 时保留其自有的 `/workspace` 与 home 卷；删除卷时保留卷的数据，缓存卷与工具卷除外。控制台的「回收站」页面列出各条记录，可恢复为新的 Box 或卷，或立即彻底删除。恢复 Box 时需要新名称，Box 保留模板、数据、资源与安全档位，但不保留环境变量、启动命令、标签、网络、TTL 与共享挂载。接口为 `GET /api/trash`、`POST /api/trash/:id/restore`（202，任务，可设置 `name`、`cpus`、`memoryMb`）与 `DELETE /api/trash/:id`（202，任务），仅所有者可用。回收站条目计入 `CHECKPOINT_CAPACITY_MB`：超过上限时先清除最旧的条目，仍不够则拒绝删除并说明原因，且不停止、不删除任何内容。宿主机剩余空间低于下限时，保留副本的删除返回 `507`。`DELETE /api/boxes/:id` 与 `DELETE /api/volumes/:id` 接受 `skipTrash=true`，表示不保留副本，需要所有者或持有新令牌权限 `trash:skip` 的令牌；该权限不属于任何预设。删除响应的 `trash` 字段给出保留的条目，没有保留时为 `null`。重建 Box（`POST /api/boxes/:id/rebuild`）以及挂载与卸载卷（`attach`、`detach`）默认先拍摄「重建前」的安全检查点，`safetyCheckpoint: false` 可关闭它。重建失败且 Box 恢复原状时丢弃该检查点；无法原样恢复时保留它，并在错误中给出 id。新增事件 `box.trashed`、`volume.trashed`、`trash.restored` 与 `trash.purged`。命令行新增 `minibox trash ls`、`restore` 与 `purge`；MCP 新增 `list_trash`、`restore_trash` 与 `purge_trash`，位于 `storage` 工具集，仅所有者可用。
- `/mcp` 所有者访问密钥的记录与提示：新增 `MCP_ALLOW_OWNER_KEY`（默认 `true`）。访问密钥每次用于 `/mcp` 都会记入事件，同一分钟内的读取合并为一行；首次使用时写入 `mcp.owner_key_used` 警告日志，控制台在最近 7 天内有使用时显示横幅。`minibox mcp` 使用访问密钥时在标准错误输出警告，并提示 `minibox token create`。新增 `minibox token create <name>`，在标准输出打印一次密钥，支持 `--preset`、`--scopes`、`--expires-in` 与 `--json`（[#121](https://github.com/ArnoChenFx/minibox/issues/121)）。
- 在线备份与异地目标（[#116](https://github.com/ArnoChenFx/minibox/issues/116)）：`POST /api/backups`（任务）在 MiniBox 运行时生成数据目录的一致备份。数据库取自 SQLite 的 `VACUUM INTO` 快照，其余文件逐个复制。归档用口令封装（AES-256-GCM，密钥由 scrypt 派生），口令为 12 到 1024 个字符，只用于封装，不写入归档、日志、审计或任务结果。备份可下载（`GET /api/backups/:id/download`）、列出与删除。命令行：`minibox backup` 创建备份，`--out FILE` 下载到本机，`--passphrase-stdin` 从标准输入读取口令；`minibox backup ls` 与 `minibox backup rm <id>` 列出与删除；`minibox restore <文件> --data-dir DIR` 离线恢复到空目录，口令错误、文件损坏、不是备份或目录非空时拒绝恢复。异地目标（`/api/targets`，推送与拉取为任务）支持 S3 兼容存储与 SFTP：凭据保存为 `target.<id>.*` 密钥，SFTP 的主机密钥须先确认才能保存。检查点包与备份可推送到目标或从目标拉取，同一目标同一时间只运行一次传输。设置页新增「异地目标」卡片（中英文），MCP 的 `storage` 工具集提供对应工具。备份与目标操作只对所有者开放，令牌不能使用。
- 宿主机功能对等（[#114](https://github.com/ArnoChenFx/minibox/issues/114)）：模板、快照、存为模板与镜像拉取可在 ssh、tcp 与 Unix 套接字宿主机上运行，不再返回 `501`。Agent 宿主机仍返回 `501`。
- 创建 Box 时自动同步模板：目标宿主机没有所选模板时，创建前先把模板镜像复制过去，复制与迁移使用同一条镜像传输路径。创建对话框会显示复制的大小，复制以「同步模板」任务显示进度，创建会等待其完成。新增 `POST /api/templates/:ref/sync`（请求体 `{ host }`）、MCP 工具 `sync_template` 与命令 `minibox template sync <ref> --host ID`。
- 模板列表按宿主机显示每个模板是否已有，并可用「同步到此宿主机」把模板复制到缺少它的宿主机。
- 远程宿主机上的端口预览：HTTP 与 WebSocket 经该宿主机的引擎转发，访问休眠中的 Box 会将其唤醒，响应或 WebSocket 打开期间保持唤醒。Box 内需要 `python3`。
- 检查点显示其所在宿主机。不在 Box 当前宿主机上的检查点不能回滚，迁移预览改为说明检查点留在原宿主机。
- Box 内 Agent 自助（[#118](https://github.com/ArnoChenFx/minibox/issues/118)）：创建 Box 时可以为其 Agent 开启自助令牌（默认关闭；`POST /api/boxes` 的 `selfToken`、`minibox box create --self-token` 与控制台的创建表单）。令牌只写入 Box 内的 `/run/minibox/self-token`（权限 600，位于内存文件系统），不进入环境变量、事件、审计或镜像，服务器只保存其哈希。每次启动、重启、重建或迁移都会轮换令牌；停止或删除 Box 会使其失效；所有者可在 Box 页面吊销，或调用 `DELETE /api/boxes/{id}/self-token`（吊销后该 Box 的功能关闭，需重新创建才能再次开启）。令牌只能使用本 Box 的 `get_info`、`checkpoint`、`get_task`、`ask_human`、`get_question` 与 `report_status`（REST 位于 `/api/self`）；访问其他 Box、令牌管理、密钥或宿主机时返回 `403`。`self` 工具集只对该 Box 的 Agent 可见，每个令牌每分钟最多 60 次请求。
- Agent 提问：`ask_human` 提出的问题保存在 `DATA_DIR/questions.json`，每个 Box 最多 20 个未回答的问题。问题显示在 Box 页面的 **Agent** 卡片中，所有者可以回复；每个新问题发送 `agent.question` 通知。REST 接口为 `GET /api/boxes/{id}/questions` 与 `POST /api/questions/{id}/answer`。
- Agent 状态：`report_status` 报告的状态记入事件日志，并显示在活动面板中。

### 变更
- 删除 Box 与卷的默认行为改变：数据先保留在回收站中，而不是立即删除。要立即删除且不保留副本，需传入 `skipTrash=true`（所有者或 `trash:skip`）。
- 重建 Box、挂载与卸载卷默认先拍摄安全检查点。需要旧行为的调用方传入 `safetyCheckpoint: false`。
- 检查点的容量上限现在也统计回收站条目。
- 控制台各页面标题栏的按钮改为右对齐，换行到标题下方时也是如此。带搜索框的页面（Box、模板）把工具栏放在标题下方一行，搜索框在左，按钮在右。
- `/mcp` 对所有者访问密钥的处理：本版本默认仍接受（`MCP_ALLOW_OWNER_KEY=true`），但每次使用都会记录并警告。默认值将在下一个次要版本改为 `false`，届时访问密钥访问 `/mcp` 将返回 `401` 并提示使用 Agent 令牌，Agent 令牌不受影响。升级前请为每个 Agent 创建令牌；需要保留旧行为时设置 `MCP_ALLOW_OWNER_KEY=true`。见[升级说明](docs/admin/upgrades.md)（[#121](https://github.com/ArnoChenFx/minibox/issues/121)）。
- 迁移不复制检查点，因为每个检查点都包含卷数据，逐个复制代价过高。如需保留，请先导出，再导入到新宿主机。

### 修复
- 设置了标记文件（`marker`）的路径存储池不再总被报告为不可达：健康检查原先运行 `test -f -- 文件`，在 busybox、dash 与 bash 中都会失败（[#143](https://github.com/ArnoChenFx/minibox/issues/143)）。
- 概览的「最近活动」为模板、通知渠道、文件、卷、工具、宿主机、备份与异地目标等全部操作显示中英文文案与图标，未知操作显示为可读文字而不是原始名称；英文界面 1 核显示为 “1 core” 而不是 “1 cores”（[#144](https://github.com/ArnoChenFx/minibox/issues/144)）。
- 上传文件时，请求体长度与声明的长度不符或在传输中途出错，上传会被拒绝，卷中不再残留隐藏的 `.minibox-upload-*` 临时文件。

### 工程化
- 工作流中的 GitHub Actions 引用改为各 action 最新的主版本标签（如 `actions/checkout@v7`、`docker/build-push-action@v7`），不再固定到 commit SHA。`docker/build-push-action` 从 v6 升到 v7，`actions/configure-pages` 升到 v6，`actions/upload-pages-artifact` 与 `actions/deploy-pages` 升到 v5；所用输入在新版本中均未变化。
- Bun 最低版本升到 1.4.4（`engines.bun`、`@types/bun` 与文档同步更新）；Pages 工作流与 CI 一致使用 `bun-version: latest`。`bun run typecheck` 改用 Bun 内置的类型检查器 `bun check --no-script`（与 TypeScript 7.0.2 报告相同的错误），替代 `tsc --noEmit`；`--no-script` 确保它不会转去运行同名的 `check` 脚本。`typescript` 仍保留为开发依赖，供编辑器使用。

### 文档
- 检查点、Box、卷、令牌、配置、API、CLI、MCP 与架构文档，以及 `.env.example`，补充回收站与安全检查点的说明，并提供中文版本。
- 备份指南（`docs/admin/backups.md`，并提供 `docs/zh-CN/admin/backups.md` 中文版本）说明备份内容、一致性、恢复、卷备份与异地目标，并在检查点、设置、密钥、CLI、API、MCP、数据目录、安全与架构文档中补充相关内容（[#116](https://github.com/ArnoChenFx/minibox/issues/116)）。
- 宿主机、模板、端口预览与检查点指南去掉「模板不复制」与「不支持端口预览」的说明，并写明镜像复制与迁移要求目标引擎保留镜像 ID：Docker 的经典镜像存储满足此要求，containerd 镜像存储不满足。
- 命令行与 API 参考补充模板同步与各操作的 `host` 参数。
- 新增 Box 内 Agent 指南（`docs/user-guide/agents.md` 与 `docs/zh-CN/user-guide/agents.md`），含供 Box 内 Agent 使用的 `AGENTS.md` 说明文本，并在 API、MCP、CLI、通知、访问与令牌、Box、安全、配置与数据目录文档中补充相关内容。Box 访问 MiniBox 需要服务器监听 `minibox-boxes` 网络可达的地址，见配置中的 `HOST`。

## [0.5.0] - 2026-10-23

### 亮点
- **声明式模板**：从 Dockerfile、Git 代码仓库、构建上下文压缩包或 `devcontainer.json`（支持子集）构建模板，创建 Box 时可把代码仓库克隆到 `/workspace`。
- **启动命令**：Box 每次启动时在 `minibox-init` tmux 会话中运行一条命令，不阻塞启动。
- **事件通知**：把内存耗尽、命令失败、检查点失败、宿主机离线等事件发送到 Webhook、ntfy 主题或 Telegram 聊天。

### 新增
- 声明式模板与镜像拉取：可从粘贴的 Dockerfile、Git 代码仓库（可选分支与子目录）、构建上下文压缩包 URL 或仓库中的 `devcontainer.json` 构建模板（`POST /api/templates`，任务），构建失败不留下模板；`POST /api/templates/:ref/rebuild` 按同一来源重新构建，成功后才替换镜像；`POST /api/images/pull` 按需拉取镜像；`POST /api/boxes` 的 `repo` 可在首次创建时把代码仓库克隆到 `/workspace`，私有仓库使用密钥。构建、重新构建与拉取仅限所有者（Refs #15）
- 启动命令：每个 Box 可设置一条启动命令，每次容器启动后以 Box 用户在 `/workspace` 中用 `bash -lc` 运行，运行在名为 `minibox-init` 的 tmux 会话中。创建、启动、唤醒、重启、重建与检查点恢复时都会运行。命令保存在 Box 规格中，无需重建，Box 停止或休眠时也可修改，改动在下次启动时生效；运行中的 Box 可以即时运行（`PUT` 的 `applyNow`，或 `POST /api/boxes/:id/startup-command/run`）。命令最长 4096 字节，按输入原样保存，不能含控制字符（制表符与换行除外）。接口为 `GET`、`PUT`（需要 `If-Match`，请求体 `{ command, applyNow }`）与 `DELETE /api/boxes/:id/startup-command`，`POST /api/boxes` 与 `POST /api/snapshots/:ref/boxes` 接受 `startupCommand`。MCP 工具 `get_startup_command`、`set_startup_command`、`delete_startup_command` 与 `run_startup_command` 位于 `core` 工具集。命令行为 `minibox box create --startup-command` 与 `minibox box startup-command get|set|rm|run`。读取需要 `secret:use`，设置、删除与运行还需要 `exec`；命令文本不进入审计、活动、事件或 SSE，只显示已更改。`minibox-init` 会话只有有人 attach 时才算活动，手动运行与 `applyNow` 计入活动。模板不携带启动命令，从模板、快照或检查点创建的 Box 不继承源 Box 的命令。
- 事件通知（[#117](https://github.com/ArnoChenFx/minibox/issues/117)）：可以把事件发送到通用 Webhook（JSON POST，可选 HMAC-SHA256 签名）、ntfy 主题或 Telegram 聊天。在「设置 → 通知」中添加渠道，并用「发送测试」检查连通性。通知包括 Box 内存耗尽、命令失败、检查点失败（含定时检查点）、Box 的 TTL 或空闲休眠即将发生、终端会话被接管，以及宿主机离线。发送不阻塞触发它的操作：每次尝试 10 秒超时，最多 3 次，只重试超时、网络与 DNS 失败以及 HTTP 429 与 5xx；同一渠道 5 分钟内不重复发送同一通知；每次尝试都记入事件日志，并显示在「最近的发送记录」中。渠道密钥与 Webhook 地址保存在 `DATA_DIR/secrets/notify`：密钥不会返回，Webhook 地址只显示打码后的来源部分，二者都不会出现在事件、审计或日志中。默认拒绝非公网地址（`198.18.0.0/15` 除外，以兼容 Clash 等 fake-IP 模式的 DNS 代理），需设置 `NOTIFY_ALLOW_PRIVATE=true` 才能发送到内网。只有所有者可以管理渠道；REST、OpenAPI 与 MCP（`meta` 工具集）提供对应接口，命令行暂无通知命令。
- Box 的 TTL 将在 5 分钟内结束，或因空闲将在 5 分钟内休眠时，记录 `box.ttl_soon` 与 `box.idle_soon` 事件。
- 环境变量 `NOTIFY_ALLOW_PRIVATE`（默认 `false`），允许通知渠道发送到回环、私有网络及其他非公网地址。
- 卷用量监控、告警与上限（[#119](https://github.com/ArnoChenFx/minibox/issues/119)）：后台按 `VOLUME_USAGE_INTERVAL_SEC`（默认 600 秒，范围 60 到 86400）采样每个卷的用量。本地卷与路径卷用 `du` 统计自身目录树，NFS 卷用 `df` 统计共享根目录，不遍历目录。每次采样有各自的截止时间（目录树 120 秒，NFS 共享 30 秒），一个卡住的挂载只影响它自己。每个卷可设置软上限与硬上限（`PUT /api/volumes/:id/limits` 与 MCP 工具 `set_volume_limits`，仅所有者，默认无上限）：超过软上限记录 `volume.usage_high` 事件，超过硬上限按动作处理，动作为 `warn`（默认，仅警告）或 `stop`（停止挂载该卷的运行中 Box，原因为 `volume_limit`），并发送通知。NFS 卷不支持上限，应在 NAS 导出上设置配额。宿主机剩余空间低于 `HOST_DISK_MIN_FREE_PERCENT`（默认 10%，设为 0 关闭）时记录 `host.disk_low` 并发送通知，此时创建卷（包括新建 Box 的默认卷）与创建检查点都返回 `507`（`insufficient_storage`），定时检查点记为 `disk` 跳过。卷用量超过硬上限、动作为 `stop` 时，创建、启动、重启或重建挂载该卷的 Box，以及把该卷挂到 Box 上，都返回 `409`（`volume_over_limit`）。控制台卷页面显示用量条与趋势线，超过上限的行高亮，Box 详情页显示卷用量。软上限是尽力而为，不是配额；文件系统配额为后续工作。
- 端口预览子域名隔离（[#122](https://github.com/ArnoChenFx/minibox/issues/122)）：设置 `PREVIEW_BASE_DOMAIN` 后，每个端口预览运行在 `<端口>-<box>.<base>` 上，拥有自己的源，无法读取控制台的 cookie、存储或 API。打开预览时控制台签发一次性、60 秒有效的票据，预览域名将其兑换为只对该预览有效的授权 cookie（`__Host-minibox_preview`，`HttpOnly; Secure; SameSite=Lax`，最长 8 小时）。登录结束、Box 重命名或删除后该预览不能再打开，重启 MiniBox 会使所有授权失效。写入与 WebSocket 只接受来自该预览自身的请求。预览域名之下只接受 `<端口>-<box>` 形式的主机名，其余返回 `404`。子域名模式下预览的沙箱允许同源，应用可以使用自己的 localStorage 与 cookie。设置页的「端口预览」卡片检查通配符 DNS、HTTPS 与域名划分。未设置时仍为默认的路径预览 `/box/<名称>/<端口>/`，其隔离依赖浏览器。见 [子域名预览](docs/zh-CN/admin/preview-subdomains.md)。

### 文档
- 新增通知指南（`docs/user-guide/notifications.md`，并提供 `docs/zh-CN/` 中文版本），并在设置、配置、API、MCP、数据目录、备份与安全文档中补充通知相关内容。
- README、项目主页与文档的截图换成中英文、浅色与深色版本，由新脚本 `bun run screenshots` 在隔离的实例中生成（[#125](https://github.com/ArnoChenFx/minibox/issues/125)）。
- 升级文档新增 1.0 之前的兼容性说明，并汇总 0.4 以来需要手动处理的升级步骤。

## [0.4.1] - 2026-10-23

### 新增
- 宿主机 Agent（[#109](https://github.com/ArnoChenFx/minibox/issues/109)）：新镜像 `ghcr.io/arnochenfx/minibox-agent`（linux/amd64、linux/arm64）。在「设置 → 宿主机 → 添加宿主机」选择「Agent（推荐）」，生成一次性配对码和 bash、PowerShell 两种 `docker run` 命令；宿主机只需出站连接 MiniBox，无需开放端口或 SSH。每个 Agent 使用独立的 Ed25519 凭据，私钥仅保存在其数据卷中（600）；断线后指数退避重连；吊销会立即断开并阻止重连；协议不一致时提示「Agent 需要升级」。Agent 只执行固定的 Docker 操作白名单（只能挂载命名卷，不能使用宿主机网络，附加的容器能力限于 Docker 默认集合），其余操作返回 `unsupported`，且暂不支持迁移 Box 进出 Agent 宿主机。
- Box 文件浏览器（#106）：Box 页面新增「文件」标签页，浏览 Box 挂载的卷（工作区、主目录及其他卷），Box 停止时也可用。支持面包屑、按名称、大小或修改时间排序、筛选、显示隐藏文件、预览不超过 256 KiB 的文本文件、下载文件（文件夹下载为 `.tar.gz`）。上传支持拖放与选择文件或文件夹，逐个上传并显示进度，可取消；遇到同名文件时只询问一次，可替换、跳过或取消。可新建文件夹、重命名与删除（删除前确认）。REST：`PUT /api/volumes/:id/files/stream` 以 `application/octet-stream` 流式上传单个文件（缺少 `Content-Length` 返回 `411`，超过上限返回 `413`），`GET /api/volumes/:id/files/stream` 下载，另有 `POST …/files/directory`、`POST …/files/move` 与 `DELETE …/files`（需 `confirm=true`）。上传上限为 `FILE_UPLOAD_MAX_MB`（默认 1024，范围 1 到 65536）。路径不能越出卷，指向卷外的符号链接被拒绝；上传的文件归 uid 1000 所有。命令行新增 `minibox upload`、`minibox download` 与 `minibox cp`。仅浏览卷中的文件，不浏览容器自身的文件系统。
- 检查点导出、导入与定时检查点（#11，第三部分）：`POST /api/checkpoints/:id/export`（202，任务）把一个检查点封装为 `.mbckpt` 包，口令 12 到 1024 个字符，首尾不能有空白，不能含换行或 NUL。口令只用于封装，不写入包、日志、审计或任务记录。包保存在 `DATA_DIR/packages/`（目录 700，文件 600），24 小时后自动清理；`GET /api/packages/:id/download` 下载，`POST /api/packages`（`application/octet-stream`）上传，`POST /api/packages/:id/import`（202，任务）导入到 `host` 指定的宿主机（缺省 `local`）。导入前重新校验包的字节与清单：口令不对返回 `400`（`package_passphrase_wrong`），包损坏或不是检查点包返回 `400`（`package_invalid`）。导入成功后删除包，失败则保留，以便再次尝试。包大小上限为 `CHECKPOINT_PACKAGE_MAX_MB`（默认 2048，范围 1 到 65536），超过返回 `413`。包只含这一个检查点的卷数据与清单，不含检查点仓库的密钥；带系统层、没有卷数据或早于检查点的快照不能导出（`409`）。密钥只以只读文件的形式交给辅助容器，从不进入环境变量。定时检查点：`GET`、`PUT` 与 `DELETE /api/boxes/:id/checkpoint-schedule` 为每个 Box 设置计划，每 1 到 720 个小时（`everyHours`）或每天 `HH:MM`（`at`）运行，二者只能选其一。每天定时按 `timezone` 时区运行（IANA 时区名，如 `Asia/Shanghai`，缺省 UTC；`+08:00` 这类偏移或未知时区返回 `400` `schedule_timezone_invalid`），夏令时切换时仍按当地钟点；控制台按浏览器时区设置，显示为「每天 03:00（Asia/Shanghai）」，下次与上次运行按本地时间并标出时区。已保存的时区若服务器不再识别，计划保留并暂按 UTC 运行，记录警告，响应带 `timezoneUnknown: true`，控制台提示重新设置。后台每分钟检查一次，到点时拍下自动检查点，并遵守保留策略与仓库容量上限（`CHECKPOINT_CAPACITY_MB`）。停止或休眠的 Box 跳过，且不会因此被唤醒；计划检查点不算作活动，不会让空闲 Box 无法休眠；Box 迁移到其他宿主机后计划随之在新宿主机上运行；仓库达到上限时同样跳过。计划保存在 `DATA_DIR/checkpoints/schedules/`，重启后继续执行；控制台显示上次与下次运行，未跳过的运行（成功或失败）写入审计 `checkpoint.scheduled`。缺省没有计划，单机行为不变。导出、导入与计划的 REST 与 MCP（`export_checkpoint`、`import_checkpoint`、`get_checkpoint_schedule`、`set_checkpoint_schedule`、`clear_checkpoint_schedule`，位于 `storage` 工具集）以及控制台 Box 详情页的「检查点」标签页都只对所有者开放，令牌不能获得这些权限；命令行暂无检查点命令。

### 变更
- 请求体上限：只有检查点包上传（`POST /api/packages`）与卷文件上传（`PUT /api/volumes/:id/files/stream`）可以超过 Bun 默认的 128 MiB：检查点包最大为 `CHECKPOINT_PACKAGE_MAX_MB` 加 1 MiB（#11），卷文件最大为 `FILE_UPLOAD_MAX_MB`（#106）。其余请求（JSON 接口、MCP、预览）仍限 128 MiB：声明更大的请求体在路由之前即返回 `413`（`payload_too_large`），未声明长度的请求体读取或转发超过上限时停止。

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
