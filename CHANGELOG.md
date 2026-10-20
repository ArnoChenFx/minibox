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
- 登录限流不再信任请求头 `X-Forwarded-For`：默认按真实连接地址计数。新增配置 `TRUST_PROXY`（默认 `false`），仅在由你控制、会覆盖这些头的反向代理之后设置为 `true`；此时读取 `X-Forwarded-For` 的最后一项，并信任 `X-Forwarded-Proto` 与 `X-Forwarded-Host`（#1）。
- 登录限流只拒绝错误的密钥：正确的密钥总能登录，即使同一地址（或所有访问者）已被限流。同一地址 5 分钟内错误 10 次，或全部地址合计 50 次后，之后的错误密钥被拒绝（`429`），并延迟约 1 秒返回；IPv6 按 /64 归并。失败记录表设置容量上限并定期清理过期项（#1）。限流不会阻止猜测（每个密钥仍会被校验），抵抗暴力破解靠的是密钥的长度与随机性。
- 新增配置 `COOKIE_SECURE`（默认 `false`）：始终为会话 Cookie 加上 `Secure`。通过 HTTPS 访问，或请求带有 `https://` Origin 时，Cookie 已会带上 `Secure`，通常无需设置（#3）。
- WebSocket 终端升级请求，以及 `/api/` 下的 POST / PATCH / DELETE，要求浏览器的 `Origin` 与请求的 `Host` 同源（或列在新配置 `ALLOWED_ORIGINS` 中），否则返回 `403`。不带 `Origin` 的请求（如使用 `Authorization: Bearer` 的脚本）不受影响（#3）。
- API 写请求声明的 `Content-Type` 必须是 `application/json`，否则返回 `415`，HTML 表单提交无法触发写操作（#3）。
- 登录 Cookie 由 `SameSite=Lax` 改为 `SameSite=Strict`（#3）。
- 增加 `Content-Security-Policy`：脚本只从同源加载（`script-src 'self'`），页面不再使用内联脚本，且禁止被其他页面嵌入（`frame-ancestors 'none'`）（#4）。
- 通过 HTTPS 访问时（直接访问、请求带有 `https://` Origin，或 `TRUST_PROXY=true` 时经代理识别）发送 `Strict-Transport-Security`（一年，不含子域名）（#4）。
- 所有响应增加 `Cross-Origin-Opener-Policy` 与 `Cross-Origin-Resource-Policy: same-origin`（#4）。

### 变更
- xterm.js 与 addon-fit 改为随仓库提供（`web/vendor/`，附 SHA-256 校验测试），不再从 jsDelivr CDN 加载；网页终端可在离线或内网环境中使用（#4）。

### 工程化
- 新增 `.github/dependabot.yml`：每周检查 npm 依赖（Bun）、GitHub Actions 与 Docker 基础镜像（根目录 `Dockerfile` 与 `templates/base`）的更新；GitHub Actions 的小版本与补丁版本更新合并为一个 PR。
- `package.json` 的 `engines.bun` 最低版本要求由 `>=1.2.0` 提高为 `>=1.4.3`，README 中的版本要求同步。
- 所有 GitHub Actions 引用固定到完整 commit SHA，并以注释保留版本号，升级由 Dependabot 提出。
- 发布工作流的镜像构建与 GitHub Release 步骤显式依赖 CI 检查（`checks`），检查不通过时不会推送镜像，也不会创建 Release。

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
