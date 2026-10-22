# MiniBox 文档

[English](../README.md)

## 从这里开始

- [快速入门](quick-start.md)：安装 MiniBox、登录、构建基础模板并在第一个 Box 中运行命令。

## 用户指南

面向日常使用 MiniBox 的用户。

- [Box](user-guide/boxes.md)：创建、启动、调整规格、重建与删除 Box。
- [空闲休眠与 TTL](user-guide/idle-sleep.md)：让空闲 Box 休眠，并为 Box 设置生命周期。
- [端口预览](user-guide/port-preview.md)：打开 Box 内运行的 Web 应用。
- [模板](user-guide/templates.md)：基础模板，以及从 Box 保存的模板。
- [检查点](user-guide/checkpoints.md)：复制 Box 数据、fork 或回滚。
- [工具与自定义工具](user-guide/tools.md)：在 Box 中安装 Agent CLI 与运行时。
- [环境变量与密钥](user-guide/environment-and-secrets.md)：设置变量并使用宿主机密钥。
- [卷与存储](user-guide/volumes-and-storage.md)：卷、存储池与挂载。
- [NFS 与 NAS 存储](user-guide/nfs.md)：将 Box 数据放在网络文件服务器上。
- [终端与会话](user-guide/terminal-and-sessions.md)：浏览器终端、tmux 会话与接管。
- [SSH 访问与 CLI](user-guide/ssh-and-cli.md)：使用 `ssh`、`scp` 与 `sftp`，安装 CLI（含 Windows）。
- [宿主机](user-guide/hosts.md)：在其他 Docker Engine 上运行 Box。
- [访问与令牌](user-guide/access-and-tokens.md)：访问密钥、浏览器会话与 Agent 令牌。
- [设置](user-guide/settings.md)：设置页。
- [连接 AI Agent](user-guide/agents.md)：MCP、CLI 代理与 `AGENTS.md` 片段。

## 管理

面向安装与运行 MiniBox 的管理员。

- [安装（英文）](../admin/install.md)：运行发布镜像或从源码运行。
- [数据目录（英文）](../admin/data-directory.md)：MiniBox 存储的内容与位置。
- [远程访问与 TLS（英文）](../admin/remote-access.md)：从其他机器访问 MiniBox。
- [升级（英文）](../admin/upgrades.md)：迁移到较新版本。
- [备份（英文）](../admin/backups.md)：备份内容与恢复方法。
- [安全（英文）](../admin/security.md)：信任模型与安全设置。

## 参考

- [REST API（英文）](../reference/api.md)：端点、错误与 OpenAPI 文档（[openapi.json](../openapi.json)）。
- [CLI（英文）](../reference/cli.md)：全部命令与标志。
- [MCP 工具（英文）](../reference/mcp.md)：MCP 端点、工具集与工具。
- [配置（英文）](../reference/configuration.md)：每个环境变量及其默认值。

## 面向开发者

- [架构（英文）](../architecture.md)：组件构成与请求流转。
- [开发（英文）](../development.md)：环境、检查、测试、CI 与项目结构。
