<p align="center">
  <img src="web/assets/logo-readme.svg" alt="MiniBox" height="56" />
</p>

<p align="center"><strong>基于 Docker 的、可自托管的个人 AI Agent 工作区。</strong></p>

<p align="center">
  <a href="https://github.com/ArnoChenFx/minibox/actions/workflows/ci.yml"><img src="https://github.com/ArnoChenFx/minibox/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="许可证：Apache-2.0" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4.3-f9f1e1?logo=bun&amp;logoColor=black" alt="运行时：Bun ≥ 1.4.3" /></a>
  <img src="https://img.shields.io/badge/sandbox-Docker-2496ED?logo=docker&amp;logoColor=white" alt="沙箱：Docker" />
</p>

<p align="center"><a href="README.md">English</a> | <b>简体中文</b></p>

![MiniBox 概览页](docs/screenshots/overview-light.png)

## 什么是 MiniBox？

MiniBox 在你自己的机器上运行相互隔离的 **Box**。Box 是一个长期运行的 Docker 容器，拥有独立的文件系统与进程，以及持久化的 `/workspace` 卷。你可以通过 Web 控制台、REST API、命令行工具或 MCP 创建、启动、查看和删除 Box。Claude Code、Codex、OpenCode 等 AI 编程 Agent 在 Box 内工作，因此它们的安装、构建与后台进程不会污染宿主机。

MiniBox 是单个 Bun 进程。它通过 Docker 套接字与 Docker Engine 通信，不需要数据库服务器。镜像与卷存放在 Docker 中。Box 规格、访问密钥、Agent 令牌与事件日志存放在宿主机上的数据目录中。

## 适用对象

- 运行编程 Agent，并希望为每个任务提供干净、可复现工作区的开发者。
- 希望使用自己的硬件与网络，而不是按分钟计费的托管沙箱的用户。
- 希望将 Box 数据放在 NAS 或 NFS 服务器上的用户。

MiniBox 面向单一可信用户。它没有用户账户，因此任何持有访问密钥的人都能控制服务器。在对外暴露之前，请先阅读[安全指南（英文）](docs/admin/security.md)。

## 主要能力

- **Box。** 创建、启动、停止、重启和删除 Box，并调整其 CPU 与内存上限。命令默认以非 root 用户 `dev` 运行。空闲的 Box 可以休眠，并在需要时唤醒。
- **存储。** 在重建后保留 `/workspace` 与 `/home/dev`。将 Docker 卷、NFS 导出或宿主机路径用作存储池。
- **模板。** 从内置基础模板（Debian 12、Node.js 26、Python 3、git 与 tmux）或从 Box 保存的模板启动新 Box。
- **检查点。** 将 Box 的数据复制到 restic 仓库，然后从中 fork 新 Box，或将 Box 回滚。
- **工具。** 从目录安装 Agent CLI 与语言运行时，或添加自定义条目。
- **终端与会话。** 打开浏览器终端，或让 Agent 驱动你可接管的 tmux 会话。
- **预览。** 通过 MiniBox 打开 Box 内运行的 Web 应用，而无需在宿主机上发布端口。
- **Agent 访问。** 为每个 Agent 发放各自限定权限的令牌，通过 MCP、CLI、SSH 或 REST API 连接。
- **多宿主机。** 通过 SSH、双向 TLS 或 Unix 套接字，在其他 Docker Engine 上运行 Box。可由 MiniBox 把 Box 放到最空闲的宿主机，也可以把 Box 连同卷迁移到另一台宿主机。

![MiniBox 控制台中的 Box 列表](docs/screenshots/boxes-light.png)

## 安装

在已安装 Docker 的 Linux 机器上运行发布镜像：

```bash
docker run -d --name minibox --restart unless-stopped \
  -p 127.0.0.1:3920:3920 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v minibox-data:/data \
  ghcr.io/arnochenfx/minibox:latest
```

读取生成的访问密钥，然后打开 <http://127.0.0.1:3920> 并用它登录：

```bash
docker exec minibox cat /data/access_key
```

[快速入门](docs/zh-CN/quick-start.md) 会引导你创建第一个 Box。

## 文档

| 指南 | 内容 |
|---|---|
| [快速入门](docs/zh-CN/quick-start.md) | 安装、登录、构建基础模板并创建第一个 Box |
| [用户指南](docs/zh-CN/user-guide/boxes.md) | Box、模板、检查点、工具、存储、终端、Agent 与宿主机 |
| [管理指南（英文）](docs/admin/install.md) | 安装、配置、远程访问、备份、升级与安全 |
| [参考（英文）](docs/reference/api.md) | REST API、CLI、MCP 工具与配置项 |
| [架构（英文）](docs/architecture.md) | 服务器、控制台、Agent 与 Docker 如何协同 |
| [开发（英文）](docs/development.md) | 构建、测试与贡献 |

[文档索引](docs/zh-CN/README.md) 列出全部页面。英文文档见 [docs/README.md](docs/README.md)。

## 系统要求

- 装有 Docker Engine 的 Linux 宿主机。MiniBox 从 `/proc` 读取宿主机指标。
- 若从源码安装，需要 [Bun](https://bun.sh) 1.4.3 或更高版本。

## 许可证

Apache-2.0。Copyright © 2026 Arno Chen。详见 [LICENSE](LICENSE)。

第三方组件继续适用各自的许可证，见 [NOTICE](NOTICE)。
