# 备份

MiniBox 可以在运行时备份自己的数据。备份是一个文件，并以 MiniBox 从不保存的口令封装。它包含数据目录：Box 规格、令牌、密钥、宿主机、通知和异地目标的设置，以及事件日志和任务历史。使用命令行工具离线恢复到空的数据目录。

备份不包含 Docker 卷。Box 的文件存放在卷中，检查点数据存放在检查点仓库卷中，因此需要另外备份这些卷。见[备份卷](#备份卷)。

若要把副本保存在本机之外，请添加一个[异地目标](#异地目标)：S3 兼容存储桶或 SFTP 服务器。

代码应存放在 git 中。把代码推送到远程仓库，这样就不依赖 Box 的卷。

## 备份的内容

备份包含数据目录中的每个文件，但以下内容除外：

- 服务器保存备份的文件夹：`DATA_DIR/backups/`，或在 `BACKUP_DIR` 设在数据目录内时是 `BACKUP_DIR`。见[备份保存在哪里](#备份保存在哪里)。
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

## 备份保存在哪里

不设置时，服务器把归档保存在 `DATA_DIR/backups/`，每个备份一个 `<id>.mbbak`，旁边是 `<id>.json` 记录。把 `BACKUP_DIR` 设为别的位置，就能把它们放在另一块盘上：

```bash
BACKUP_DIR=/mnt/backups
```

- 绝对路径原样使用。相对路径从项目根目录（放着 `src/` 的那个文件夹）解析，与 `DATA_DIR` 的规则完全一样，所以 `BACKUP_DIR=archives` 就是 `<项目>/archives`。以 `~/` 开头会展开为运行 MiniBox 的用户的 home 目录。
- 新建备份目录为 `700`，默认 `DATA_DIR/backups` 目录保持 `700`。已有的自定义 `BACKUP_DIR` 保留其权限，共享目录会记录告警。归档和记录文件为 `600`。
- 运行 MiniBox 的用户必须能写入该文件夹。建不出来或写不进去会让备份失败，失败不会留下归档和记录。启动时不会创建任何东西，所以 `BACKUP_DIR` 没设或暂时不可用都不会让 MiniBox 起不来。
- 请使用专用备份文件夹，并禁止不可信用户写入。MiniBox 管理自己的归档、记录和临时文件，不清理无关文件。
- 符号链接按实际目标应用排除规则。位于 `DATA_DIR` 内的 `BACKUP_DIR` 与 `DATA_DIR/backups/` 一样不会被放进备份，所以备份里永远不会套着备份。位于 `DATA_DIR` 之外的 `BACKUP_DIR` 不属于数据目录。
- `BACKUP_DIR` 不能是 `DATA_DIR` 本身，也不能是它上层的文件夹（如 `/mnt` 或项目根目录）：那样整个数据目录都会被排除在归档之外，备份会「成功」却什么也没装，所以 MiniBox 会直接拒绝启动并说明原因。
- `minibox backup ls`、`minibox backup rm`、`GET /api/backups`、下载路由与异地目标读写的都是这个文件夹里的归档。从目标拉取的备份也落在这里。
- 用 `--out` 下载到本机的归档写在指定的位置，不放进这个文件夹。

修改 `BACKUP_DIR` 不会搬动归档，列表只显示当前配置的文件夹。切换目录时，请同时移动归档和对应记录。

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

从异地目标拉取的备份保存在服务器的备份文件夹中：`DATA_DIR/backups/`，设了 `BACKUP_DIR` 时则是它。按上文方法，从该文件或其副本恢复归档。`minibox backup ls` 会列出它的 ID，`GET /api/backups/{id}/download` 可返回归档。

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

### 只保留最新的几份备份

`BACKUP_KEEP=N` 只保留最新的 `N` 份备份，更旧的会被删除：

```bash
BACKUP_KEEP=7
```

哪些算、哪些不算：

- 「备份」指服务器备份文件夹里的归档，也就是 `DATA_DIR/backups/` 或 `BACKUP_DIR`。只有 MiniBox 自己写的才算：一个 `<id>.mbbak` 加上旁边大小与记录相符的 `<id>.json`。记录还在但归档缺失或偏短、崩溃留下的部分归档，以及文件夹里的其他文件都不会被当作备份，也不会被删掉，所以文件夹里放别的东西是安全的。
- 异地目标完全不动。无论 `BACKUP_KEEP` 是多少，MiniBox 都不会删除 S3 兼容存储桶或 SFTP 服务器上的完整对象。请用存储桶或服务器自带的工具清理，或在少推送之前先 `DELETE /api/backups/{id}`。
- 用 `minibox backup --out` 下载到本机的归档不在这个文件夹里，由你自己删除。

顺序与时机：

- 按备份时间从新到旧，时间相同再按 ID 排。同一毫秒做出来的两份备份按 ID 决定顺序，所以每次清理选中的都是同样的几份，而且刚做完的那份一定算在最新的里面。
- 每次备份成功后清理一次，启动时再清理一次。所以调小 `BACKUP_KEEP` 后重启会立刻清理，不必等下一次备份。备份失败不会触发清理，因此失败的备份永远不会删掉好的归档。
- `BACKUP_KEEP=0`、留空与不设置都表示全部保留，这也是默认值。不是整数、或为负数的值同样全部保留，而不是猜一个限额：打错一个字绝不能删掉归档。大于 10000 的数也按全部保留处理。

被 `BACKUP_KEEP` 删掉的备份无法恢复。请先把要留的备份推送到[异地目标](#异地目标)。

坏记录或不可读记录会记录日志并跳过，健康记录可以列出。保留清理失败会记录日志，已完成归档会保留；启动时的维护失败不阻止主服务启动。整个归档目录不可读时，列出和创建备份会失败，请检查目录权限。

### 计划备份

MiniBox 可以按计划备份自己，因此不需要 cron。计划是整个实例的一条规则：每隔几小时一次，或每天在选定时间一次。它默认关闭；设置之后会保存在数据目录的文件中，因此重启后仍然有效。

按计划运行时没有人输入口令，所以 MiniBox 从 `.env` 中的 `BACKUP_PASSPHRASE` 读取：

```bash
BACKUP_PASSPHRASE='correct horse battery staple'
```

规则与手动输入的口令相同：12 至 1024 个字符，首尾不能有空格，也不能包含换行符。留空表示没有设置口令，到点的运行会失败一次并说明原因。值不合法会让 MiniBox 拒绝启动，而不是让每次运行都失败。

在 **设置 → 备份** 的 **计划** 中点击 **设置计划**：

1. 选择 **每隔几小时** 并填写 1 到 720 之间的整数小时，或选择 **每天一次** 并填写时间。每天的时间按浏览器的时区，对话框里会写明该时区。
2. 点击 **保存计划**。

卡片随后显示规则、**下次运行** 与 **上次运行**，都按本地时间并注明时区。**修改计划** 可以编辑，**关闭** 会移除计划。关闭计划不会删除已经做好的备份。

同一条规则也可以通过 REST API 和命令行使用：

```bash
minibox backup schedule set --every-hours 6
minibox backup schedule set --at 02:30 --timezone Asia/Shanghai
minibox backup schedule get
minibox backup schedule clear
```

`PUT /api/backups/schedule` 用 `{ "everyHours": 6 }` 或 `{ "at": "02:30", "timezone": "Asia/Shanghai" }` 设置，两者只能给一个。同一路径的 `GET` 读取，`DELETE` 移除，计划为 `null` 表示没有设置。每天的时间可带 IANA 时区名（如 `Asia/Shanghai`），不带时按 UTC 计算，不接受 `+08:00` 这类偏移。MCP 的存储工具集提供 `get_backup_schedule`、`set_backup_schedule` 与 `clear_backup_schedule`。这些操作仅限所有者。

一次运行会做什么：

- 到点的运行会做一份备份，走与 `minibox backup` 相同的服务。归档落在服务器的备份文件夹（`DATA_DIR/backups/` 或 `BACKUP_DIR`），因此按计划备份与手动备份是同一种归档。
- 之后应用 `BACKUP_KEEP`，与手动备份完全一样。因此计划本身不会把磁盘塞满：例如 `BACKUP_KEEP=7` 时保留最新的七份并删除更旧的。见[只保留最新的几份备份](#只保留最新的几份备份)。
- 失败的运行记录在计划上并只写一次日志，之后等到下一个时间点才再次运行，不会反复重试。
- MiniBox 停机期间到点的运行会在启动后执行一次，而不是把错过的每一次都补上。每隔几小时的计划保持原来的时间网格，晚跑一次不会移动后续时间；每天的计划则在下一次时间运行。
- 计划每分钟检查一次。按计划做好的备份会像其他备份一样出现在 `GET /api/backups` 中，并记录 `backup.scheduled` 审计事件。

按计划备份使用 `BACKUP_PASSPHRASE` 中的口令封装，口令留在服务器的 `.env` 里。请把它与归档分开保存，因为只有它能打开归档。

### 仍然可以使用 cron

MiniBox 内的计划覆盖常见需求，喜欢 cron 的人仍然可以使用它。从 cron 或任务计划程序运行 `minibox backup` 同样可行，而且可以用 `--out` 把归档下载到另一台机器，这一点应用内的计划做不到：

```
30 3 * * * MINIBOX_URL=http://127.0.0.1:3920 MINIBOX_ACCESS_KEY=… MINIBOX_BACKUP_PASSPHRASE=… minibox backup
```

不带 `--out` 时，每次运行都会往服务器的备份文件夹里加一份归档，由 `BACKUP_KEEP` 决定留下几份。带 `--out` 时，归档会下载到运行该任务的机器上，服务器上的那份与其它备份一样计入 `BACKUP_KEEP`。请把口令只保存在该计划程序可以读取的地方。cron 与应用内计划同时设置时，两者会各自做备份，因此请只选一种。

拉取的检查点包在拉取后 24 小时过期。目标上的对象会一直保留，直到你移除它们。

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

Box 的文件存放在名为 `vol_…` 的 Docker 卷中。在卷出现之前创建的 Box 使用 `minibox-ws-<name>`。检查点仓库是卷 `minibox-checkpoints-local`，在其他宿主机上则是 `minibox-checkpoints-<宿主机 ID>`。**存储** 中的 **卷** 标签页会在每个 Box 卷的名称下显示它的 ID。

先停止使用该卷的 Box，使其文件在复制期间不再变化。复制检查点仓库之前请先停止 MiniBox，使复制期间不会写入新的检查点。

```bash
docker run --rm -v vol_abc123:/src:ro -v "$PWD":/backup alpine \
  tar czf /backup/vol_abc123.tar.gz -C /src .
```

把 `vol_abc123` 替换为该卷的 ID。若要恢复归档，见[恢复卷](#恢复卷)。

## 检查点与备份

检查点是单个 Box 数据的副本，它们与 Box 保存在同一台宿主机上。备份包含检查点记录和计划，但不包含检查点数据，检查点数据位于仓库卷中。若要把检查点保存到别处，请先[导出](../user-guide/checkpoints.md#导出与导入)它并下载导出的包，或把该包推送到[异地目标](#异地目标)。

如果进程环境与 `.env` 的 `BACKUP_PASSPHRASE` 不一致（例如 Bun 展开 `$` 后），启动会拒绝这个有歧义的值。请使用明确的单一来源，另存原始口令并验证恢复。
