# SSH 访问与命令行工具

你可以用 `ssh`、`scp`、`sftp` 和 `ssh -L` 连接 Box。有两种方式：

- **经命令行工具。** 连接经服务器的 HTTPS 地址传输，不需要额外开放端口。运行 `ssh` 的机器需要服务器提供的 `minibox` 命令行工具。见 [安装命令行工具](#安装命令行工具) 至 [连接 Box](#连接-box) 各节。
- **直连，使用任意 SSH 客户端。** Termius 等应用或普通的 `ssh` 连接服务器在设置 `SSH_PORT` 后开放的 SSH 端口，只需主机、端口、用户名，以及密码或私钥。见 [用任意 SSH 客户端直连](#用任意-ssh-客户端直连)。

示例中的 `minibox.example.com` 请换成你的 MiniBox 服务器地址。本地服务器使用 `127.0.0.1:3920`。

## 安装命令行工具

在 macOS 或 Linux 上运行：

```bash
curl -fsSL https://minibox.example.com/cli/install.sh | sh
```

安装程序会把 `minibox` 放到 `~/.local/bin`。无需 `sudo`。若该目录不在 `PATH` 中，安装程序会打印需加入 shell 配置的一行。添加后请新开一个终端。

在 Windows 上，打开普通 PowerShell 窗口（非管理员），运行：

```powershell
irm https://minibox.example.com/cli/install.ps1 | iex
```

安装程序会把 `minibox.exe` 放到 `%USERPROFILE%\.local\bin`，并将该目录加入用户 `PATH`。完成后请新开一个终端。

检查安装可运行 `minibox --version`。

## 一次性配置 SSH

设置服务器地址和访问密钥，然后运行 `minibox ssh-config --append`：

```bash
export MINIBOX_URL=https://minibox.example.com
export MINIBOX_ACCESS_KEY=...
minibox ssh-config --append
```

该命令会：

- 在 `~/.ssh/config` 中添加 `Host *.minibox` 块。
- 将服务器主机密钥保存到 `~/.ssh/minibox_known_hosts`，使 ssh 只信任该密钥。
- 将服务器地址和密钥保存到 `~/.config/minibox/ssh-credentials.json`。在 macOS 和 Linux 上，该文件权限为 600。

之后，任何 shell 以及使用 Remote-SSH 的 IDE 都可在环境中不带密钥的情况下连接。

请使用访问密钥，或带有 `box:ssh` scope 的 Agent 令牌。使用 `-L` 做端口转发时，令牌还需要 `port:expose` scope。不要在命令行用 `--token` 传入密钥，因为它会留在 shell 历史中。请改为设置 `MINIBOX_ACCESS_KEY`。

在 Windows 上，在 PowerShell 中运行相同命令，使用 `$env:MINIBOX_URL="https://minibox.example.com"` 和 `$env:MINIBOX_ACCESS_KEY="..."`。

## 连接 Box

在 Box 名称后加上 `.minibox`：

```bash
ssh my-box.minibox
scp ./build.tar.gz my-box.minibox:/workspace/
sftp my-box.minibox
ssh -N -L 8080:127.0.0.1:8080 my-box.minibox
```

- 登录用户始终为 `dev`。你也可以用 Box 的 ID 作为用户名。
- 已停止或休眠的 Box 会在你连接时启动。
- 保持连接会让 Box 保持唤醒。
- 停止、删除或重建 Box 会结束其 SSH 连接。
- `-L` 将 Box 上的端口转发到你本机。转发在 Box 内仅到达 `localhost` 和 `127.0.0.1`。
- 拒绝 `-R`、Unix 套接字转发、X11 转发和 agent 转发。

每个 Box 同时最多接受 8 个 SSH 连接。服务器总共最多接受 64 个。每个连接最多可打开 16 个 channel。

`sftp` 和 `-L` 需要 `openssh-sftp-server` 和 `socat` 包。基础模板已包含它们。较旧的 Box 可在 Box 内运行 `sudo apt-get install -y openssh-sftp-server socat`。

## 用任意 SSH 客户端直连

服务器管理员需先设置 `SSH_PORT`，并让该端口可以访问。见 [直连 SSH](../../admin/install.md#direct-ssh)。开启后，Box 的 **SSH** 对话框在 **SSH 客户端** 标签页中显示连接信息，每项都有复制按钮。

在 SSH 应用中这样填写：

| 字段 | 值 |
|---|---|
| 主机 | 服务器地址，以对话框中显示的为准 |
| 端口 | 直连 SSH 端口，以对话框中显示的为准，例如 `2222` |
| 用户名 | Box 的名称或 ID |
| 密码 | 带 `box:ssh` 权限的 Agent 令牌，或访问密钥 |
| 私钥 | 代替密码：其公钥已在 **设置** › **SSH 公钥** 中添加的私钥 |

在终端中，同样的登录为：

```bash
ssh -p 2222 my-box@minibox.example.com
```

- 用户名决定连接哪个 Box。在 Box 内，你始终是 `dev` 用户。
- **密码。** 更安全的做法是使用 Agent 令牌：在 **设置** › **Agent API 令牌** 中创建一个带 `box:ssh` 权限的令牌，并限定它可访问的 Box。令牌的 Box 限制同样生效。使用 `-L` 还需 `port:expose`。访问密钥只有足够强（至少 20 个随机字符）时才能使用。
- **私钥。** 在 **设置** › **SSH 公钥** 中点击 **添加公钥**，粘贴公钥，例如 `~/.ssh/id_ed25519.pub` 的内容。支持 Ed25519、ECDSA 与 RSA。公钥以所有者身份登录，可访问任何 Box。切勿粘贴私钥，控制台会拒绝。
- **主机密钥。** 首次连接时，应用会请你信任服务器的主机密钥。请核对其指纹与对话框中的 **主机密钥** 一致。它与 `minibox ssh-config` 保存的是同一个密钥。
- 已停止或休眠的 Box 会在连接时启动。`scp`、`sftp` 与 `-L` 用法同上，拒绝的功能也相同。
- 不存在的 Box 与错误的密码得到同样的 `Permission denied`。
- 15 分钟内登录失败 5 次后，该地址需等待 30 秒才能再试；之后每失败一次，等待时间加倍，最长一小时。每次登录（无论成功与否）都会连同客户端地址与登录方式记入活动日志，密码从不记录。

## Windows 说明

- 必须安装 OpenSSH 客户端。在 **设置**、**系统**、**可选功能** 中启用 **OpenSSH 客户端**。
- `%USERPROFILE%\.ssh` 中的文件必须属于你的账户。若 ssh 报告权限错误，用 `icacls "%USERPROFILE%\.ssh\config"` 检查文件。所有者应为你本人。
- 若移动了 `minibox.exe`，请再次运行 `minibox ssh-config --append`，使 `ProxyCommand` 指向新路径。

## 命令行工具参考

`minibox` 命令用于运行 Box、会话和文件操作。常用命令如下：

```bash
minibox box ls
minibox exec my-box -- npm test
minibox exec my-box --background --timeout 600 -- npm test
minibox files ls my-volume --path /
minibox mcp
```

每个命令都有 `--help` 选项。[CLI 参考（英文）](../../reference/cli.md) 列出全部命令与选项。
