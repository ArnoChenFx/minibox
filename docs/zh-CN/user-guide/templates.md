# 模板

模板是新 Box 的起点。它保存 Box 的运行环境：操作系统、已安装的程序以及 `/etc` 中的设置。每个新 Box 都从模板开始。

模板不包含你的文件。`/workspace` 文件夹和主目录是卷，模板会排除它们。检查点负责数据，模板负责环境。请用 git 保存代码，或为 Box 拍摄检查点。

## 基础模板

MiniBox 附带可捆绑的基础模板，你在 **库** 的 **模板** 标签页上构建它。

基础模板包含：

- Debian 12 与 Node.js 26。
- Python 3、`git`、`curl`、`build-essential`、`tmux`、`jq`、`ripgrep`、`bubblewrap`、`openssh-client`、`sudo` 及其他常用工具。
- 用户 `dev`，用户 ID 1000，可无密码使用 `sudo`。

MiniBox 镜像不包含基础模板。在控制台中构建一次：

1. 在侧栏点击 **库**，**模板** 标签页随即打开。
2. 点击 **构建基础模板**。
3. 等待构建完成。

要跟踪构建，点击顶栏的 **任务**。需要更新时随时重新 **构建基础模板**。

## 官方模板

MiniBox 提供四个官方模板。每个模板都来自 MiniBox 源码中的一份 Dockerfile，并包含基础模板的常用工具：

| 模板 | 基础镜像 | 额外内容 |
|---|---|---|
| `node` | `node:26-bookworm-slim` | Node.js 26、pnpm 与 yarn，并含 `build-essential` |
| `python` | `python:3.14-slim-bookworm` | Python 3.14 与 uv，并含 `build-essential` |
| `go` | `golang:1.26-bookworm` | Go 1.26 与 gopls，并含 `build-essential` |
| `minimal` | `debian:bookworm-slim` | 不含语言工具链 |

常用工具包括 `git`、`curl`、`tmux`、`jq`、`ripgrep`、`bubblewrap`、`openssh-client`、`sudo` 与 `vim`。每个模板都有用户 `dev`，用户 ID 1000。

预装 `bubblewrap`（命令 `bwrap`），是因为 OpenAI Codex CLI 的 Linux 沙箱依赖它。此前创建的 Box 没有它：重新构建模板后重新创建 Box，或在 Box 内执行 `sudo apt-get install -y bubblewrap`。在 Docker 容器里，`bwrap` 可能还需要放宽用户命名空间或 seccomp 限制才能运行，这一点尚未验证。

MiniBox 启动时不构建官方模板。模板在某台宿主机上首次被 Box 需要时，才在该宿主机上构建：

- **创建 Box 时。** 若没有宿主机持有该模板，MiniBox 会在 Box 所在的宿主机上构建它，创建请求等待构建完成。构建日志显示在 **任务** 面板中。使用自动选择宿主机时，若持有该模板的宿主机都没有余量，Box 会放在能够构建该模板的在线宿主机中余量最大的一台上。构建失败时，既不会留下模板，也不会创建 Box。
- **提前构建。** 在 **库** 的 **模板** 标签页，点击尚未构建的模板卡片上的 **构建**；控制台有多台宿主机时，则点击某台宿主机旁的 **在此构建**。在命令行中运行 `minibox template build-official go`，并可用 `--host` 选择宿主机。

在 **创建 Box** 对话框中，尚未构建的官方模板排在已构建模板之后，并标注 **首次使用时构建**。

重新构建 Box 不会构建缺失的官方模板，因此请先构建它。重新构建已构建的官方模板会再次运行其 Dockerfile，所用的基础镜像是宿主机已持有的那个。若要使用该基础镜像的较新补丁版本，请先用 **拉取镜像** 拉取它，例如 `node:26-bookworm-slim`，然后重新构建模板。MiniBox 更新可能会修改官方 Dockerfile，该变更在模板下次重新构建时生效。

只有所有者可以构建官方模板或列出目录。令牌只能在所有者已于该宿主机上构建模板之后，用它创建 Box。

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

1. 在侧栏点击 **库**，然后点击 **新建模板**。
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

1. 在 **库** 的 **模板** 标签页点击 **拉取镜像**。
2. 在 **镜像** 中输入名称，可带标签，例如 `node:24-bookworm-slim`。
3. 点击 **拉取镜像**。

拉取作为任务运行，日志会显示每一层的进度。宿主机已有的镜像保持不变。

Box 或重新构建若需要宿主机上没有的仓库镜像，会在其请求过程中拉取，因此请求会等待下载完成。想避免等待，请先拉取该镜像。在命令行中，`minibox box create my-box --template node:24-bookworm-slim` 会在缺少该镜像时先拉取，然后创建 Box。令牌只能从 MiniBox 模板创建 Box，因此只有所有者可以这样使用仓库镜像。

MiniBox 从不拉取它自己的模板、快照和检查点镜像。这些镜像只存在于生成它们的宿主机上，因此缺失时会报错。

## 从模板创建 Box

1. 点击 **Box**，然后点击 **创建 Box**。
2. 在 **模板** 中选择模板。
3. 填写表单，点击 **创建并启动**。

你也可以在 **模板** 列表中某张模板卡片上点击 **用此模板创建**。若要在创建的同时把代码仓库克隆进 Box，参见[克隆代码仓库](boxes.md#克隆代码仓库)。由 `devcontainer.json` 构建、且设置了 `postCreateCommand` 或 `forwardPorts` 的模板，会为由它创建的每个 Box 完成设置。参见 [Box 的设置](#box-的设置)。

## 把模板复制到其他宿主机

其他宿主机上的 Box 需要该宿主机上已有模板的镜像。MiniBox 在你于该宿主机上创建 Box 时会自动复制镜像，因此通常无需手动复制。若想提前复制，请在模板卡片上点击缺少该模板的宿主机旁的 **同步到此宿主机**。复制以 **同步模板** 任务的形式运行。每张卡片都会列出所有宿主机，以及各自是否已有该模板。复制还会带上由来源构建的模板的构建记录。副本保留该模板的设置，并可以在该宿主机上按同一来源重新构建。

在控制台中删除模板会删除每台宿主机上的副本。重新构建会改变第一台持有该模板的宿主机上的副本，其他副本保留旧镜像，直到你删除它们并重新复制模板。复制要求目标引擎保留镜像 ID。见 [限制](hosts.md#限制)。

## 内置与自定义模板

**模板** 标签页显示以下标签：

- **内置** 标签表示捆绑的基础模板。
- **官方** 标签表示四个官方模板之一。尚未在任何宿主机上构建的官方模板会显示 **尚未在任何宿主机上构建**，并带有 **构建** 按钮。
- **自定义** 模板是你从 Box 保存的模板。
- **由……构建** 说明模板的来源，例如 **由 Git 代码仓库 构建**。它出现在由 Dockerfile、代码仓库、构建上下文或 `devcontainer.json` 构建的模板上。

删除模板不会影响已用它创建的 Box。在控制台中构建过的模板可在同一标签页再次构建。

## 谁可以构建，以及构建能访问什么

构建模板、重新构建模板和拉取镜像仅限所有者。任何令牌都不能执行这些操作，即使该令牌拥有全部 scope。

- **密钥。** 私有仓库的令牌或部署密钥只用于该次克隆。MiniBox 会在任务日志显示克隆输出之前去掉其值。该值永远不会写入镜像，构建记录只保存密钥的名称。不要把密钥粘贴进 Dockerfile、`containerEnv`、`remoteEnv` 或 `build.args`，这些值会进入镜像或构建日志。
- **构建记录。** 粘贴的 Dockerfile 和来源字段保存在持有该模板的每台宿主机的 `DATA_DIR/template-recipes/` 中，以便重新构建时再次使用。复制到其他宿主机时，构建记录也会一并复制。
- **构建上下文。** 若压缩包条目或代码仓库文件的路径超出构建上下文、为绝对路径，或是硬链接、设备或其他特殊文件，MiniBox 会拒绝。它也会拒绝指向上下文之外的符号链接，以及会经过符号链接写入的操作。
- **URL 由服务器发起。** MiniBox 自己下载构建上下文 URL，并从 Docker 网络上的辅助容器克隆代码仓库。两者都会跟随重定向到任意地址。MiniBox 不会阻止私有地址、回环地址或云元数据地址，因此构建可以访问宿主机能访问的任何服务。请只把所有者权限交给应当拥有这种访问能力的人。
- **SSH 主机密钥。** SSH 克隆在首次连接时会接受服务器的主机密钥，因为每次克隆都从空的 known_hosts 文件开始。网络中的攻击者可能在这次首次连接时冒充服务器。能用时请使用带令牌的 HTTPS，它会校验服务器证书。
- **克隆辅助容器。** 克隆在一个丢弃了全部 Linux 能力、根文件系统只读的辅助容器中运行，内存 512 MB，最多运行 5 分钟。
- **其他宿主机。** 控制台只在本机构建模板和拉取镜像。若要在其他宿主机上构建或拉取，请在命令行使用 `--host`，或在 API 中使用 `?host=`。Agent 宿主机暂不支持模板。

## devcontainer.json

当代码仓库已把运行环境描述在 `devcontainer.json` 中时，可以从该文件构建模板。除非你给出路径，否则 MiniBox 会依次查找 `.devcontainer/devcontainer.json` 和 `.devcontainer.json`。若代码仓库两者都有，使用 `.devcontainer/devcontainer.json`。如需使用 `.devcontainer.json`，请给出它的路径。

MiniBox 读取以下配置项：

| 配置项 | MiniBox 的用法 |
|---|---|
| `image` | 基础镜像。MiniBox 会在自己生成的 Dockerfile 中写入 `FROM <image>`。 |
| `build.dockerfile` | Dockerfile，相对于 `devcontainer.json`。它必须位于构建上下文之内。 |
| `build.context` | 构建上下文，相对于 `devcontainer.json`，默认为该文件所在目录。它必须位于代码仓库之内。 |
| `build.args` | 构建参数。 |
| `build.target` | 要构建的 Dockerfile 阶段。 |
| `containerEnv` | 每个条目对应镜像中的一条 `ENV` 指令。 |
| `remoteEnv` | 同样是写入镜像的 `ENV` 指令，因此 Box 中的每个进程都能看到。与 `containerEnv` 中同名的条目会被它替换。 |
| `postCreateCommand` | 由模板创建 Box 时，在 Box 中运行一次。参见 [Box 的设置](#box-的设置)。 |
| `forwardPorts` | 由模板创建 Box 时，成为该 Box 手动预览端口的 TCP 端口。 |
| `remoteUser` | 为 `dev` 或 `1000` 时接受，即每个 Box 运行所用的用户。 |
| `$schema`、`name` | 仅作元数据，不改变任何内容。 |

该文件只能设置 `image` 或 `build` 之一，不能同时设置；设置 `build` 时必须同时给出 `build.dockerfile`。若设置了 `build.target`，并且有 `ENV` 行需要添加，MiniBox 会构建该阶段，并在其之上添加一个最后阶段，其中包含这些 `ENV` 行。没有 `ENV` 行时，目标阶段即为镜像。Dockerfile 中未声明的目标会被拒绝。`devcontainer.json` 文件限制为 256 KB。需要添加 `ENV` 行时，MiniBox 会复制 Dockerfile 以添加它们，该副本同样限制为 256 KB。代码仓库中的原文件不会被修改。

### Box 的设置

`postCreateCommand` 和 `forwardPorts` 不属于镜像。模板在每台持有其副本的宿主机上都保存它们，由该模板创建的 Box 会在其设置任务中运行它们，顺序如下：

1. 若你给出了代码仓库，则克隆该仓库。
2. `forwardPorts` 中的每个端口成为该 Box 的手动预览端口。
3. 运行 `postCreateCommand`。

- 字符串形式以 `/bin/sh -c "<命令>"` 运行，因此 `npm ci && npm run build` 这样的 shell 语法可以使用。列表形式按原样运行，不经过 shell，其中的 `$HOME` 保持字面文本。
- 命令以用户 `dev` 运行。若 Box 挂载了 `/workspace`，则在其中运行，否则在 `/` 中运行。其输出位于任务日志中，即**任务**面板里的**设置 Box**。
- 退出代码非零的命令会使设置任务失败，任务会说明该代码。Box 会保留，你可以打开它并修复问题。
- 运行超过 30 分钟的命令会被停止，任务随之失败。取消任务也会停止命令。两种情况下 Box 都会保留。
- 设置只在创建 Box 时运行一次。启动、停止、重启和重建 Box 都不会再次运行它。从模板保存的 Box 不会继承它。
- 从设置了 `postCreateCommand` 的模板创建 Box 需要令牌具有 `exec` scope；设置了 `forwardPorts` 时还需要 `port:expose` scope。缺少相应 scope 的令牌会在 Box 创建之前被拒绝。

### MiniBox 不应用的设置

MiniBox 不应用的设置不会中止构建。构建日志中会有一行以 `Warning:` 开头的文字指出该设置，构建会在没有它的情况下继续。这包括表中未列出的每个顶层配置项，例如 `features`、`mounts`、`runArgs` 和 `customizations`，也包括生命周期命令 `initializeCommand`、`onCreateCommand`、`updateContentCommand`、`postStartCommand` 和 `postAttachCommand`。MiniBox 从不运行这些命令。

以下设置同样会以警告列出：

- `remoteUser` 为 `dev` 或 `1000` 以外的值，因为每个 Box 都以 `dev` 运行命令。
- `remoteEnv` 中值为 `null` 的条目，因为它会取消一个变量的设置，而 MiniBox 无法取消变量。
- `build` 中除 `dockerfile`、`context`、`args` 和 `target` 之外的设置，例如 `cacheFrom`。
- 对象形式的 `postCreateCommand`，它会并行运行多条命令。MiniBox 不会运行它。
- `forwardPorts` 中不是 Box 内 TCP 端口的条目，例如 `db:5432`。
- 引用了 devcontainer 变量的 `containerEnv`、`remoteEnv` 或 `build.args` 取值，例如 `${containerEnv:PATH}`，以及引用了变量的 `postCreateCommand`，例如 `${localEnv:HOME}` 或 `${containerWorkspaceFolder}`。MiniBox 不展开变量，因此该条目不会应用，或该命令不会运行，构建则继续进行。

MiniBox 应用但无法按原样应用的设置会被拒绝，构建不会开始：

- 名称不是合法的变量名，或取值含有控制字符，例如换行符或制表符。
- `containerEnv`、`remoteEnv` 或 `build.args` 的取值含有其他 `${…}` 形式的引用，例如 `${dockerfile:VARIABLE}`。MiniBox 不展开变量，因此值会与文件中的不同。
- `postCreateCommand` 超过 64 KB，或 `forwardPorts` 不是列表。
- `build.target` 没有在 Dockerfile 中以 `FROM … AS <名称>` 声明。

MiniBox 只从代码仓库运行一条命令，即 `postCreateCommand`，并且只在创建 Box 时运行。其他生命周期命令属于 dev container 生命周期中 MiniBox 并不具备的阶段。请把安装步骤写成 Dockerfile 中的 `RUN` 指令：构建时只运行一次，由该模板创建的每个 Box 都会得到其结果。

`containerEnv` 和 `remoteEnv` 不是放置密钥的地方，因为它们的值会写入镜像，并显示在构建日志中。若要给 Box 提供密钥，请使用引用密钥的环境变量。参见[环境变量与密钥](environment-and-secrets.md)。

## 限制

| 项目 | 限制 |
|---|---|
| 模板名称 | 63 个字符 |
| 描述 | 200 个字符，单行 |
| 粘贴的 Dockerfile | 64 KB |
| `devcontainer.json`，或 MiniBox 为添加 `ENV` 行而复制的 Dockerfile | 各 256 KB |
| `postCreateCommand` | 64 KB，运行最长 30 分钟 |
| 构建上下文压缩包 | 下载后与解包后均为 256 MB，最多 20,000 个条目 |
| 下载构建上下文 | 2 分钟 |
| 克隆 | 5 分钟，辅助容器内存 512 MB |
| URL | 2,048 个字符 |
| 分支 | 200 个字符 |
| 代码仓库或压缩包内的路径 | 512 个字符 |
| 镜像名称 | 255 个字符 |

## 参考

[REST API（英文）](../../reference/api.md)、[MCP 工具（英文）](../../reference/mcp.md) 与 [CLI 参考（英文）](../../reference/cli.md) 描述了相同的操作。
