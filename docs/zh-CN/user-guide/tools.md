# 工具

工具是你安装到 Box 中的程序，例如 AI 编程 Agent、语言运行时和命令行实用程序。MiniBox 有工具目录。你也可以添加自己的工具。

## 创建 Box 时选择工具

在创建对话框中，**工具** 部分列出目录中的工具。勾选需要的工具。用 **搜索工具** 按名称、说明或分类筛选。

工具分为：

- **AI 编程代理**
- **语言与运行时**
- **终端与开发工具**
- **网络**

目录包括 Claude Code、OpenAI Codex CLI、OpenCode、Pi coding agent、fx agent、Antigravity CLI、Grok Build CLI、Qoder CLI、oh-my-pi、herdr、luvus、Bun、uv、Rust toolchain、Zig 和 Tailscale。

若勾选了工具，MiniBox 会在 Box 启动后安装它们。在 **任务** 面板中查看进度。

## 在 Box 中管理工具

打开 Box，点击 **设置**，再点击 **工具**。表格显示每个工具的 **期望版本** 与 **已安装** 状态。各分组默认展开：可点击分组标题折叠，搜索工具则会在所有分组中显示匹配项。

- **安装** 将目录工具加入共享 tools 卷和 Box 的工具列表。
- **升级** 将该卷上已安装工具刷新为目录当前版本。
- **卸载** 从共享 tools 卷和 Box 工具列表中移除工具。
- **补装缺失** 安装 Box 列表中仍显示为未安装的全部工具。

已在 Box 镜像或 home 卷中的工具会显示为已安装及版本号。MiniBox 不会改动它们。**升级** 和 **卸载** 仅适用于 MiniBox 安装的工具。

部分工具需要 root 和系统服务。MiniBox 从不运行这些工具。目录将它们标记为 **需要 root**。请自行在宿主机上安装。

工具写入共享 tools 卷，在各 Box 中以只读方式挂载。同一宿主机上使用同一存储池 tools 卷的每个 Box 共享各工具的程序文件。安装到一个 Box 的工具，对共享该卷的其他 Box 也可用。

若引擎丢失了共享 tools 卷，MiniBox 会以空卷重新创建它。卷中原有的工具会显示为未安装。点击 **补装缺失** 即可重新安装。参见[卷与存储](volumes-and-storage.md#引擎丢失卷时)。

## Tailscale

Tailscale 将 Box 连接到你的 tailnet。从目录安装后：

1. 在 Box 的 **终端** 标签页运行 `minibox-tailscale up`。它会打印登录 URL。
2. 打开 URL，登录你的 tailnet。

请记住：

- Box 不会在 tailnet 上获得网络接口。监听 `localhost` 或 `0.0.0.0` 的程序可在 tailnet 上访问，具体取决于 tailnet 访问规则。
- 要从 Box 访问 tailnet 主机，使用 `localhost:1055` 上的 SOCKS5 和 HTTP 代理。设置 `ALL_PROXY=socks5h://localhost:1055`。HTTP 客户端将 `HTTP_PROXY` 和 `HTTPS_PROXY` 设为 `http://localhost:1055`。
- `ping` 不能用于 tailnet 主机。请改用 `minibox-tailscale ping`。
- Box 重启或从休眠唤醒后，再次运行 `minibox-tailscale up`。会复用已保存的登录。
- tailnet 流量不会唤醒休眠的 Box。
- 卸载 Tailscale 仅停止该 Box 中的守护进程。登录状态仍保留在 home 卷上。

## 自定义工具

只有 MiniBox 安装的所有者可以添加或修改自定义工具。Agent 令牌无法使用自定义工具。

1. 打开 Box，点击 **设置**，再点击 **工具**，然后点击 **自定义工具**。
2. 填写表单：
   - **标识**：小写字母、数字和连字符，以字母开头。
   - **名称**、**说明** 和 **分组**。
   - **来源**、**包名** 和 **命令名**。
   - **命令**：**安装**、**升级**、**卸载** 和 **检测**。**停止（可选）** 在卸载前停止工具正在运行的程序。
3. 点击 **保存**。

每条命令最多 16,000 个字符。**检测** 在工具存在时必须以代码 0 退出。

若标识与内置工具相同，勾选 **替换内置条目**。删除该自定义条目会恢复内置工具。

**删除** 仅移除自定义条目。已安装在共享 tools 卷上的工具仍会保持安装。
