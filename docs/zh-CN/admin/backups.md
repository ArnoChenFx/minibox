# 备份

MiniBox 可以在运行时备份自己的数据。备份是一个文件，并以 MiniBox 从不保存的口令封装。它包含数据目录：Box 规格、令牌、密钥、宿主机、通知和异地目标的设置，以及事件日志和任务历史。使用命令行工具离线恢复到空的数据目录。

备份不包含 Docker 卷。Box 的文件存放在卷中，检查点数据存放在检查点仓库卷中，因此需要另外备份这些卷。见[备份卷](#备份卷)。

若要把副本保存在本机之外，请添加一个[异地目标](#异地目标)：S3 兼容存储桶或 SFTP 服务器。

代码应存放在 git 中。把代码推送到远程仓库，这样就不依赖 Box 的卷。

## 备份的内容

备份包含数据目录中的每个文件，但以下内容除外：

- `backups/`：保存在服务器上的备份。
- `packages/`：检查点包。它们生成 24 小时后过期。若要保留，请将其推送到异地目标。
- `exec/`：`exec` 命令保存的输出。
- `cli/`：缓存的命令行程序。需要时 MiniBox 会重新生成。
- 名称以点开头的路径，例如写入过程中产生的临时文件。

数据库 `events.db` 和 `tasks.db` 取自 SQLite 通过 `VACUUM INTO` 生成的快照。副本只包含完整的变更。

备份包含密钥：访问密钥、SSH 主机密钥、宿主机和通知的密钥、检查点仓库密钥，以及异地目标的凭据。请像保护数据目录本身一样保护它。口令要与备份分开保存。没有口令，归档就无法打开，即使是 MiniBox 也不行。

## 创建备份

无需停止 MiniBox。像其他命令一样设置 `MINIBOX_URL` 和 `MINIBOX_ACCESS_KEY`，然后运行：

```bash
read -rs -p "Backup passphrase: " MINIBOX_BACKUP_PASSPHRASE && export MINIBOX_BACKUP_PASSPHRASE
minibox backup --out minibox-backup.mbbak
```

口令长 12 至 1024 个字符，首尾不能有空格，也不能包含换行符或 NUL 字符。

- `--out FILE` 把归档保存到本机的 `FILE`。只有下载文件的大小和校验和与服务器记录一致时，才会保留该文件。
- `--overwrite` 在 `FILE` 已存在时替换它。仅可与 `--out` 一起使用。
- `--passphrase-stdin` 从标准输入的第一行读取口令，而不是读取 `MINIBOX_BACKUP_PASSPHRASE`。口令从不作为命令参数，因此不会进入 shell 历史。

不带 `--out` 时，备份保存在服务器上，命令会打印它的 ID。用 `minibox backup ls` 列出服务器上的备份，用 `minibox backup rm <id>` 删除一个备份。

通过 REST API，发送 `POST /api/backups` 并附上 `{ "passphrase": "…" }`。它返回 `202` 和 `taskId`。任务成功后，其结果包含该备份。用 `GET /api/backups/{id}/download` 下载归档。[MCP](../../reference/mcp.md)（英文）的存储工具集提供 `create_backup`、`list_backups` 和 `delete_backup`。这些操作仅限所有者。控制台没有备份按钮。通过 API 或命令行启动的备份，其进度会显示在**任务**面板中。

### 备份如何保持一致

备份在 MiniBox 处理请求时运行。每个数据库都从 SQLite 生成的快照复制，因此副本只包含完整的变更。MiniBox 通过替换文件而不是原地改写来写入文件，因此备份过程中被替换的文件，会以备份打开它时的版本完整地归档。备份过程中被删除的文件会被略过。其他文件依次读取，因此两个同时变化的文件，可能分别处于变化的前后两侧。

若要获得所有文件都对应同一时刻的副本，请先停止 MiniBox，然后按[手动复制数据目录](#手动复制数据目录)中的方法复制数据目录。

备份失败时不会留下归档。

## 恢复备份

恢复在离线状态下进行，须先停止 MiniBox。恢复写入空的数据目录，并且从不合并到含有任何文件的目录中。口令错误、文件损坏或不是备份的文件都会被拒绝，且不会恢复任何内容。

1. 若 MiniBox 运行在宿主机上，请先停止它。
2. 把归档恢复到空的数据目录中：

   ```bash
   read -rs -p "Backup passphrase: " MINIBOX_BACKUP_PASSPHRASE && export MINIBOX_BACKUP_PASSPHRASE
   minibox restore minibox-backup.mbbak --data-dir /srv/minibox-data
   ```

3. 将 `DATA_DIR` 设置为该文件夹，然后启动 MiniBox。
4. 按[恢复卷](#恢复卷)中的说明，恢复 Box 和检查点需要的 Docker 卷。在启动 Box 之前完成这一步。

恢复后，MiniBox 使用备份中的访问密钥，除非环境变量或 `.env` 中设置了 `ACCESS_KEY`。

### 恢复到发布镜像

发布镜像把命令行工具放在 `src/cli.ts` 中。恢复到一个空卷（例如新建的卷）：

```bash
read -rs -p "Backup passphrase: " MINIBOX_BACKUP_PASSPHRASE && export MINIBOX_BACKUP_PASSPHRASE
docker run --rm -e MINIBOX_BACKUP_PASSPHRASE \
  -v minibox-data:/data \
  -v "$PWD":/backup:ro \
  ghcr.io/arnochenfx/minibox:latest \
  bun src/cli.ts restore /backup/minibox-backup.mbbak --data-dir /data
```

然后使用 `minibox-data` 卷启动 MiniBox，步骤见[安装指南](../../admin/install.md)（英文）。

### 恢复拉取的备份

从异地目标拉取的备份保存在拉取它的实例的 `DATA_DIR/backups/` 中。按上文方法，从该文件或其副本恢复归档。`minibox backup ls` 会列出它的 ID，`GET /api/backups/{id}/download` 可返回归档。

### 恢复卷

按原名称恢复每个卷，并且要在使用它的 Box 或检查点仓库启动之前完成。以名为 `vol_abc123` 的卷为例，归档按[备份卷](#备份卷)中的方法生成：

```bash
docker volume create vol_abc123
docker run --rm -v vol_abc123:/dst -v "$PWD":/backup:ro alpine \
  tar xzf /backup/vol_abc123.tar.gz -C /dst
```

解压之前，卷必须为空。

## 异地目标

异地目标是本机之外的一个存放位置，用于保存检查点包和备份的副本。目标有两种类型：

| 类型 | 地址 | 凭据 |
|---|---|---|
| S3 兼容 | `https` 端点、区域和存储桶。只有 `localhost`、`127.0.0.1` 和 `[::1]` 可以使用普通的 `http`。 | 访问密钥 ID 和 Secret 访问密钥 |
| SFTP | 主机、端口和用户。端口默认为 22。 | 不带口令的私钥，以及服务器的主机密钥 |

在**设置**中，于**异地目标**下添加目标：

1. 点击**添加目标**，选择**类型**：S3 兼容或 SFTP。
2. 填写**目标名称**和该类型的字段。**文件夹**可选，它相对于存储桶或登录文件夹。为空时，对象放在根目录。
3. 点击**测试**，在不保存的情况下连接目标。对于 SFTP 服务器，MiniBox 会显示服务器出示的主机密钥，格式为 `SHA256:…`。请与服务器上的密钥比对，例如在服务器上运行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`。若一致，请在对话框中点击**信任并测试**。
4. 点击**保存目标**。对于 SFTP，如果尚未确认该密钥，保存前会先执行同样的检查。目标会以已确认的密钥保存，并且不会向出示其他密钥的服务器发送任何内容。

凭据以密钥的形式保存，名称为 `target.<id>.access-key`、`target.<id>.secret-key` 或 `target.<id>.private-key`。MiniBox 之后不会再显示它们的值。以 `target.` 开头的名称是保留的：任何人都不能创建带有该前缀的密钥，Box 也不能使用这类密钥。这些密钥不会出现在**密钥**列表中。

卡片会列出每个目标的地址和文件夹、上次同步（时间、方向、对象以及任何错误），以及该次同步的大小。**检查**会使用已保存的凭据连接目标，并报告它是否有响应。**移除**会删除本机上的目标及其凭据。目标上已有的对象不会被删除。

### 推送与拉取

推送和拉取通过 REST API 和 MCP 存储工具集进行，仅限所有者。每项操作都作为任务运行。

- `POST /api/targets/{id}/push`，请求体为 `{ "object": "bk_…" }` 或 `{ "object": "pk_…" }`，把备份或检查点包复制到目标。
- `POST /api/targets/{id}/pull`，请求体相同，把一个对象从目标复制到本实例。
- `GET /api/targets/{id}/objects` 列出目标上完整的检查点包和备份，最新的在前。

每个对象都以归档和其旁边的 JSON 记录的形式保存，位于目标上的 `backups` 或 `packages` 文件夹中：

```
<folder>/backups/bk_….mbbak
<folder>/backups/bk_….json
<folder>/packages/pk_….mbckpt
<folder>/packages/pk_….json
```

- 先写入归档，最后写入记录。只有记录存在，且与归档的大小一致，目标才会列出该对象，因此中断的上传不会出现在列表中。
- 当目标已保存大小和校验和都相同的对象时，推送会跳过它。当目标保存的对象内容不同时，推送会被拒绝，且不会替换任何内容。
- 只有归档的大小和校验和与记录一致时，拉取才会保存归档。从目标拉取的备份会以来源 `target` 出现在 `GET /api/backups` 中。拉取的检查点包会在拉取后 24 小时过期，与导出的包相同，因此请在此时间内导入。
- 每个目标同一时间只运行一次传输。在第一次传输完成之前，对同一目标的第二次传输会被拒绝。

凭据需要以下权限：

- S3 兼容：在存储桶或文件夹中列出、读取、写入和删除对象。MiniBox 会删除失败的部分上传。
- SFTP：在文件夹中创建文件夹，并写入、重命名和删除文件。MiniBox 会删除失败的部分上传。

MiniBox 不会删除目标上的完整对象。它只会替换一次中断的上传留下的、与其将要写入的名称相同的文件。请使用存储桶或服务器自带的工具删除旧对象。

## 保留与计划

- 备份会一直保留，直到你删除它们，在此之前它们会占用 `DATA_DIR/backups/` 中的空间。MiniBox 不会按计划创建备份，也不会让备份过期。若要按计划备份，请从 cron 或任务计划程序中运行 `minibox backup --out`，并删除不再需要的归档。口令只保存在该计划程序可以读取的地方。
- 拉取的检查点包在拉取后 24 小时过期。目标上的对象会一直保留，直到你移除它们。

## 手动复制数据目录

如果无法使用命令行工具，请停止 MiniBox，然后复制它的数据目录。以这种方式制作的副本没有封装，因此请像保护数据目录本身一样保护它。MiniBox 运行时不要复制 `events.db` 或 `tasks.db`。

对于发布镜像，使用临时容器复制 `minibox-data` 卷：

```bash
docker stop minibox
docker run --rm -v minibox-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/minibox-data-$(date +%F).tar.gz -C /data .
docker start minibox
```

对于源码安装，请在 MiniBox 停止时，复制代码检出目录中的 `data/` 文件夹，或 `DATA_DIR` 指向的文件夹。停止 MiniBox 不会停止你的 Box。若要停止某个 Box，请使用控制台，或运行 `docker stop minibox-<name>`。

## 备份卷

Box 的文件存放在名为 `vol_…` 的 Docker 卷中。在卷出现之前创建的 Box 使用 `minibox-ws-<name>`。检查点仓库是卷 `minibox-checkpoints-local`，在其他宿主机上则是 `minibox-checkpoints-<宿主机 ID>`。**卷**页面会在每个 Box 卷的名称下显示它的 ID。

先停止使用该卷的 Box，使其文件在复制期间不再变化。复制检查点仓库之前请先停止 MiniBox，使复制期间不会写入新的检查点。

```bash
docker run --rm -v vol_abc123:/src:ro -v "$PWD":/backup alpine \
  tar czf /backup/vol_abc123.tar.gz -C /src .
```

把 `vol_abc123` 替换为该卷的 ID。若要恢复归档，见[恢复卷](#恢复卷)。

## 检查点与备份

检查点是单个 Box 数据的副本，它们与 Box 保存在同一台宿主机上。备份包含检查点记录和计划，但不包含检查点数据，检查点数据位于仓库卷中。若要把检查点保存到别处，请先[导出](../user-guide/checkpoints.md#导出与导入)它并下载导出的包，或把该包推送到[异地目标](#异地目标)。
