# 快速入门

本指南在 Linux 机器上启动 MiniBox，创建你的第一个 Box，并在其中运行命令。

你需要：

- 一台已运行 Docker Engine 的 Linux 机器。
- 一个 Web 浏览器。

## 1. 启动 MiniBox

运行以下命令：

```bash
docker run -d --name minibox --restart unless-stopped \
  -p 127.0.0.1:3920:3920 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v minibox-data:/data \
  ghcr.io/arnochenfx/minibox:latest
```

`-p 127.0.0.1:3920:3920` 选项使 MiniBox 仅在本机可访问。

## 2. 获取访问密钥

MiniBox 在首次启动时会创建访问密钥。打印它：

```bash
docker exec minibox cat /data/access_key
```

复制 64 位密钥。请妥善保管。任何持有该密钥的人都能控制 MiniBox。

## 3. 登录

1. 在浏览器中打开 <http://127.0.0.1:3920>。
2. 在 **访问密钥** 中粘贴密钥。
3. 点击 **登录**。

## 4. 构建基础模板

Box 从模板启动。MiniBox 镜像不包含基础模板，因此需要构建一次。

1. 在侧栏点击 **库**，**模板** 标签页随即打开。
2. 点击 **构建基础模板**。
3. 等待构建完成。首次构建可能需要几分钟，因为要下载镜像。
4. 要查看进度，点击顶栏的 **任务**。

构建完成后，列表中会出现模板 **base**。

## 5. 创建 Box

1. 在侧栏点击 **Box**。
2. 点击 **创建 Box**。
3. 在 **名称** 中输入 `my-box`。
4. 将 **模板** 保持为 **base**。
5. 在 **规格** 下点击 **小型**。
6. 点击 **创建并启动**。

## 6. 在 Box 中运行命令

1. 在 Box 列表中点击 `my-box`。
2. 点击 **终端** 标签页。
3. 输入以下命令，每行后按 Enter：

   ```bash
   whoami
   pwd
   ```

第一条命令会输出 `dev`，即每个 Box 内运行的用户。第二条会输出 `/workspace`，即保存你文件的目录。

## 7. 安装命令行工具（可选）

`minibox` 命令可在你自己的终端中运行 Box 及其命令。

1. 从服务器安装：

   ```bash
   curl -fsSL http://127.0.0.1:3920/cli/install.sh | sh
   ```

2. 若安装程序打印了关于 `PATH` 的一行，请将其加入 shell 配置文件，然后打开新终端。
3. 为当前终端会话设置访问密钥：

   ```bash
   export MINIBOX_ACCESS_KEY="$(docker exec minibox cat /data/access_key)"
   ```

4. 列出 Box，并在 `my-box` 中运行命令：

   ```bash
   minibox box ls
   minibox exec my-box -- uname -a
   ```

## 下一步

- [Box](user-guide/boxes.md)：调整规格、停止、重建与删除 Box。
- [终端与会话](user-guide/terminal-and-sessions.md)：在浏览器中操作 Box，或让 Agent 使用它。
- [工具](user-guide/tools.md)：在 Box 中安装 Claude Code、Codex 等工具。
- [远程访问与 TLS（英文）](../admin/remote-access.md)：从另一台计算机打开 MiniBox。
