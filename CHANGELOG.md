# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- 数据目录 `DATA_DIR`（默认 `./data`，Docker 镜像中为 `/data`）。目录权限 700；启动时创建 `boxes/`、`exec/`、`secrets/` 子目录，供后续功能使用。
- Docker 镜像设置 `DATA_DIR=/data` 并创建该挂载点，README 中的示例使用 `-v minibox-data:/data` 持久化。

### 变更
- 未设置 `ACCESS_KEY` 时，自动生成的密钥写入 `DATA_DIR/access_key`（权限 600），重启后保持不变。访问密钥的优先级为：进程环境变量 > `.env` > `DATA_DIR/access_key` > 自动生成。空值视为未设置。
- `scripts/restart.sh` 改为通过服务自身的配置加载逻辑读取 `PORT` 与密钥位置（此前只读取 `.env` 中的 `PORT`），启动后提示密钥保存位置，但不输出密钥本身。
- 登录页说明访问密钥的来源（`.env` 或 `DATA_DIR/access_key`）。
- README、README-zh 与 `.env.example` 同步更新。

### 工程化
- 新增 `.github/dependabot.yml`：每周检查 npm 依赖（Bun）、GitHub Actions 与 Docker 基础镜像（根目录 `Dockerfile` 与 `templates/base`）的更新；GitHub Actions 的小版本与补丁版本更新合并为一个 PR。
- `package.json` 的 `engines.bun` 最低版本要求由 `>=1.2.0` 提高为 `>=1.4.3`，README 中的版本要求同步。
- 所有 GitHub Actions 引用固定到完整 commit SHA，并以注释保留版本号，升级由 Dependabot 提出。
- 发布工作流的镜像构建与 GitHub Release 步骤显式依赖 CI 检查（`checks`），检查不通过时不会推送镜像，也不会创建 Release。

### 修复
- 自动生成访问密钥时不再整体重写 `.env`。此前会把 `.env` 改写为只剩 `ACCESS_KEY`、`PORT`、`HOST` 三项，其他配置随之丢失。现在任何情况下都不修改 `.env`。

### 安全
- 文档补充容器以 root 运行的说明，以及缓解方案：Docker Socket 代理（只转发 MiniBox 所需的 API），或 rootless Docker / Podman。

### 迁移
- 已有部署无需操作。`.env` 中已有的 `ACCESS_KEY` 照常生效，之前写入 `.env` 的密钥不会改变。
- 新版本首次启动时会创建 `./data/`（已在 git 中忽略）。其中只有空的子目录，不影响现有 Box。
- Docker 部署：旧镜像生成的密钥位于容器内的 `/app/.env`，删除容器后会丢失。重建容器前请先用 `docker exec <容器名> grep '^ACCESS_KEY=' /app/.env` 取出密钥，并通过 `-e ACCESS_KEY=...` 传入；或挂载数据卷 `-v minibox-data:/data`。

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
