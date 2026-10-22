# 模板

模板是新 Box 的起点。它保存 Box 的运行环境：操作系统、已安装的程序以及 `/etc` 中的设置。每个新 Box 都从模板开始。

模板不包含你的文件。`/workspace` 文件夹和主目录是卷，模板会排除它们。检查点负责数据，模板负责环境。请用 git 保存代码，或为 Box 拍摄检查点。

## 基础模板

MiniBox 附带可捆绑的基础模板，你在 **模板** 页面上构建它。

基础模板包含：

- Debian 12 与 Node.js 26。
- Python 3、`git`、`curl`、`build-essential`、`tmux`、`jq`、`ripgrep`、`openssh-client`、`sudo` 及其他常用工具。
- 用户 `dev`，用户 ID 1000，可无密码使用 `sudo`。

MiniBox 镜像不包含基础模板。在控制台中构建一次：

1. 在侧栏点击 **模板**。
2. 点击 **构建基础模板**。
3. 等待构建完成。

要跟踪构建，点击顶栏的 **任务**。需要更新时随时重新 **构建基础模板**。

## 将 Box 存为模板

当你在 Box 中安装了软件，并希望新 Box 也自带这些软件时，可将 Box 存为模板。

1. 打开 Box。
2. 点击 **存为模板**。
3. 输入 **名称**，例如 `python-ml`。需要时可填写 **描述**。
4. 点击 **保存模板**。

MiniBox 保存容器的系统层：卷之外被改动的文件，例如以 root 安装的软件和 `/etc` 下的设置。不包含 `/workspace`、主目录，或仅安装在 home 中的工具。

保存可能耗时较长。在 **任务** 面板中查看进度。

环境变量引用了密钥的 Box 不能存为模板；包含系统镜像的快照或检查点同样不能。请先移除该环境变量。参见[环境变量与密钥](environment-and-secrets.md)。

## 从源构建模板

你也可以从 Dockerfile、Git 代码仓库、构建上下文压缩包或代码仓库中的 `devcontainer.json` 构建模板。以这种方式构建的模板可以按同一来源重新构建。

1. 在侧栏点击 **模板**，然后点击 **新建模板**。
2. 在 **模板名称** 中输入名称，例如 `node-tools`。名称规则与 Box 名称相同：字母、数字、点、下划线和连字符，以字母或数字开头，最多 63 个字符。需要时可填写 **描述**。
3. 在 **来源** 中选择文件的来源，并填写对应字段：

   | 来源 | 字段 |
   |---|---|
   | **Dockerfile** | 粘贴的 Dockerfile，需要包含 `FROM` 指令。 |
   | **Git 代码仓库** | **代码仓库地址**，然后可选填写 **分支**、**子目录**、**Dockerfile 路径** 和 **私有仓库的密钥**。 |
   | **构建上下文 URL** | 指向 `.tar` 或 `.tar.gz` 压缩包的 `http://` 或 `https://` 链接，以及可选的 **Dockerfile 路径**。 |
   | **devcontainer.json** | **代码仓库地址**，然后可选填写 **分支**、**devcontainer.json 路径** 和 **私有仓库的密钥**。参见 [devcontainer.json](#devcontainerjson)。 |

4. 点击 **构建模板**。

构建在后台运行。在 **任务** 面板中查看构建日志，任务名称为 **构建模板**。构建成功后，模板会出现在列表中。构建失败时不会留下模板，任务会说明原因。名称仍然可用，可以再试一次。

各来源需注意以下几点：

- **分支** 可以是分支或标签名。留空则使用代码仓库的默认分支。克隆为浅克隆，构建只能看到最新提交。
- **子目录** 是代码仓库内的构建上下文。留空则使用仓库根目录。**Dockerfile 路径** 相对于构建上下文，默认为 `Dockerfile`。
- 构建上下文压缩包会在其顶层解开。如果压缩包把所有文件放在一个文件夹中，例如 `repo-main/`，请在 Dockerfile 路径中填写该文件夹，例如 `repo-main/Dockerfile`。
- 要基于基础模板构建，请让 Dockerfile 以 `FROM minibox-template:base` 开头。若你修改了 `LABEL_PREFIX` 或 `BASE_TEMPLATE`，名称也会随之变化。`FROM` 中引用的、引擎中没有的镜像会在构建时拉取。
- 代码仓库的 `.git` 文件夹永远不会进入镜像。

在命令行中，同样的构建为：

```bash
minibox template create node-tools --repo https://github.com/example/app.git --branch main --subdir services/api --secret DEPLOY_TOKEN
minibox template create node-tools --dockerfile ./Dockerfile
```

## 重新构建模板

由来源构建的模板，其在 **模板** 列表中的卡片上有 **重新构建** 按钮。重新构建会按同一来源再次构建：分支会取最新提交，压缩包 URL 会重新下载。模板保留原名。

只有重新构建成功时，新镜像才会替换旧镜像。重新构建失败时，模板保留原来的镜像。

Box 会一直运行它所用的镜像，直到你重建该 Box。参见[重建 Box](boxes.md#重建-box)。

## 拉取镜像

拉取会提前把镜像下载到宿主机，这样模板和 Box 无需等待即可使用。

1. 在 **模板** 页面点击 **拉取镜像**。
2. 在 **镜像** 中输入名称，可带标签，例如 `node:24-bookworm-slim`。
3. 点击 **拉取镜像**。

拉取作为任务运行，日志会显示每一层的进度。宿主机已有的镜像保持不变。

Box 或重新构建若需要宿主机上没有的仓库镜像，会在其请求过程中拉取，因此请求会等待下载完成。想避免等待，请先拉取该镜像。在命令行中，`minibox box create my-box --template node:24-bookworm-slim` 会在缺少该镜像时先拉取，然后创建 Box。令牌只能从 MiniBox 模板创建 Box，因此只有所有者可以这样使用仓库镜像。

MiniBox 从不拉取它自己的模板、快照和检查点镜像。这些镜像只存在于生成它们的宿主机上，因此缺失时会报错。

## 从模板创建 Box

1. 点击 **Box**，然后点击 **创建 Box**。
2. 在 **模板** 中选择模板。
3. 填写表单，点击 **创建并启动**。

你也可以在 **模板** 列表中某张模板卡片上点击 **用此模板创建**。若要在创建的同时把代码仓库克隆进 Box，参见[克隆代码仓库](boxes.md#克隆代码仓库)。

## 内置与自定义模板

**模板** 页面显示以下标签：

- **内置** 标签表示捆绑的基础模板。
- **自定义** 模板是你从 Box 保存的模板。
- **由……构建** 说明模板的来源，例如 **由 Git 代码仓库 构建**。它出现在由 Dockerfile、代码仓库、构建上下文或 `devcontainer.json` 构建的模板上。

删除模板不会影响已用它创建的 Box。在控制台中构建过的模板可在同一页面再次构建。

## 谁可以构建，以及构建能访问什么

构建模板、重新构建模板和拉取镜像仅限所有者。任何令牌都不能执行这些操作，即使该令牌拥有全部 scope。

- **密钥。** 私有仓库的令牌或部署密钥只用于该次克隆。MiniBox 会在任务日志显示克隆输出之前去掉其值。该值永远不会写入镜像，构建记录只保存密钥的名称。不要把密钥粘贴进 Dockerfile、`containerEnv` 或 `build.args`，这些值会进入镜像或构建日志。
- **构建记录。** 粘贴的 Dockerfile 和来源字段保存在宿主机的 `DATA_DIR/template-recipes/` 中，以便重新构建时再次使用。
- **构建上下文。** 若压缩包条目或代码仓库文件的路径超出构建上下文、为绝对路径，或是硬链接、设备或其他特殊文件，MiniBox 会拒绝。它也会拒绝指向上下文之外的符号链接，以及会经过符号链接写入的操作。
- **URL 由服务器发起。** MiniBox 自己下载构建上下文 URL，并从 Docker 网络上的辅助容器克隆代码仓库。两者都会跟随重定向到任意地址。MiniBox 不会阻止私有地址、回环地址或云元数据地址，因此构建可以访问宿主机能访问的任何服务。请只把所有者权限交给应当拥有这种访问能力的人。
- **SSH 主机密钥。** SSH 克隆在首次连接时会接受服务器的主机密钥，因为每次克隆都从空的 known_hosts 文件开始。网络中的攻击者可能在这次首次连接时冒充服务器。能用时请使用带令牌的 HTTPS，它会校验服务器证书。
- **克隆辅助容器。** 克隆在一个丢弃了全部 Linux 能力、根文件系统只读的辅助容器中运行，内存 512 MB，最多运行 5 分钟。
- **远程宿主机。** 模板构建和镜像拉取只在本地宿主机上运行。在远程宿主机上，它们返回 `501`。

## devcontainer.json

当代码仓库已把运行环境描述在 `devcontainer.json` 中时，可以从该文件构建模板。除非你给出路径，否则 MiniBox 会依次查找 `.devcontainer/devcontainer.json` 和 `.devcontainer.json`。若代码仓库两者都有，使用 `.devcontainer/devcontainer.json`。如需使用 `.devcontainer.json`，请给出它的路径。

MiniBox 读取以下配置项：

| 配置项 | MiniBox 的用法 |
|---|---|
| `image` | 基础镜像。MiniBox 会在自己生成的 Dockerfile 中写入 `FROM <image>`。 |
| `build.dockerfile` | Dockerfile，相对于 `devcontainer.json`。它必须位于构建上下文之内。 |
| `build.context` | 构建上下文，相对于 `devcontainer.json`，默认为该文件所在目录。它必须位于代码仓库之内。 |
| `build.args` | 构建参数。 |
| `containerEnv` | 每个条目对应镜像中的一条 `ENV` 指令。 |
| `$schema`、`name` | 仅作元数据，不改变任何内容。 |

该文件只能设置 `image` 或 `build` 之一，不能同时设置；设置 `build` 时必须同时给出 `build.dockerfile`。取值中不能使用 `${…}` 引用，因为 MiniBox 不展开变量。`devcontainer.json` 文件限制为 256 KB。设置了 `containerEnv` 时，MiniBox 会复制 Dockerfile 以添加 `ENV` 行，该副本同样限制为 256 KB。代码仓库中的原文件不会被修改。

不支持的内容：

- 其他顶层配置项，例如 `features`、`forwardPorts`、`mounts`、`remoteUser` 和 `customizations`。构建会被拒绝，错误信息会列出每一项。
- 生命周期命令：`initializeCommand`、`onCreateCommand`、`updateContentCommand`、`postCreateCommand`、`postStartCommand` 和 `postAttachCommand`。MiniBox 从不执行它们；文件中设置了其中任何一项，构建都会被拒绝。
- 除 `dockerfile`、`context` 和 `args` 之外的构建配置，例如 `target` 和 `cacheFrom`。

这些限制的原因是：MiniBox 只构建镜像，不运行代码仓库中的任何命令。生命周期命令在 Box 启动后于 Box 内运行，而模板本身不会启动 Box。请把安装步骤写成 Dockerfile 中的 `RUN` 指令。对于不支持的配置项，MiniBox 选择拒绝而不是跳过，这样模板永远不会缺少文件所要求的内容。

`containerEnv` 不是放置密钥的地方，因为它的值会写入镜像，并显示在构建日志中。若要给 Box 提供密钥，请使用引用密钥的环境变量。参见[环境变量与密钥](environment-and-secrets.md)。

## 限制

| 项目 | 限制 |
|---|---|
| 模板名称 | 63 个字符 |
| 描述 | 200 个字符，单行 |
| 粘贴的 Dockerfile | 64 KB |
| `devcontainer.json`，或 MiniBox 为 `containerEnv` 复制的 Dockerfile | 各 256 KB |
| 构建上下文压缩包 | 下载后与解包后均为 256 MB，最多 20,000 个条目 |
| 下载构建上下文 | 2 分钟 |
| 克隆 | 5 分钟，辅助容器内存 512 MB |
| URL | 2,048 个字符 |
| 分支 | 200 个字符 |
| 代码仓库或压缩包内的路径 | 512 个字符 |
| 镜像名称 | 255 个字符 |

## 参考

[REST API（英文）](../../reference/api.md)、[MCP 工具（英文）](../../reference/mcp.md) 与 [CLI 参考（英文）](../../reference/cli.md) 描述了相同的操作。
