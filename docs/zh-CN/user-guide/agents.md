# 连接 AI Agent

MiniBox 让 AI Agent 在 Box 内工作。Agent 可通过三种方式连接：

- 经 HTTP 的 **MCP**，地址为 `/mcp`。MCP 客户端使用 bearer 令牌连接。
- **`minibox` 命令行工具**，Agent 在其 shell 中运行。`minibox mcp` 在标准输入输出上启动 MCP 服务器，并转发到 `/mcp`。
- **REST API**，供脚本和其他工具使用。见 [API 参考（英文）](../../reference/api.md)。

Box 内还可以有自己的 Agent，它使用只对该 Box 有效的令牌连接 MiniBox。见 [Box 内的 Agent](#box-内的-agent)。

每个 Agent 应使用 Agent 令牌，而不是访问密钥。访问密钥是所有者的密钥。拥有它的 Agent 可以在未使用 `strict` 档位的任意 Box 中以 root 运行命令，并可以删除和重建 Box。Agent 令牌只有你选择的权限。

## 为 Agent 创建令牌

1. 打开**设置**，在 **Agent API 令牌**中点击**新建令牌**。
2. 对大多数 Agent 选择**沙箱 Agent**预设。它不能挂载已有卷、安装工具或打开 SSH 连接。
3. 限制该令牌可使用的 **Box**，并按需设置过期时间。
4. 点击**新建令牌**，并复制密钥。MiniBox 只显示一次。

预设与 scope 见 [访问、会话与令牌](access-and-tokens.md)。

## 连接 MCP 客户端

在客户端的 MCP 设置中添加服务器。使用 MiniBox 服务器 URL，并将令牌作为 bearer 令牌：

```json
{ "mcpServers": { "minibox": { "url": "http://127.0.0.1:3920/mcp", "headers": { "Authorization": "Bearer mbx_…" } } } }
```

对于启动命令的客户端，运行 `minibox mcp`。将 `MINIBOX_URL` 和 `MINIBOX_ACCESS_KEY` 设为服务器地址和 Agent 的令牌。

## 工具集

MCP 端点将其工具分组为工具集。默认为 `core,meta`。要使用更多工具集，在 URL 中添加，例如 `http://127.0.0.1:3920/mcp?toolsets=core,session`。

`rebuild_box` 工具在 `rebuild` 工具集中，只有添加 `rebuild` 后才可用。`move_box` 同理，在 `move` 工具集中。各工具集及其工具见 [MCP 参考（英文）](../../reference/mcp.md)。

## Agent 在 Box 中能做什么

- 用 `exec` **运行命令**。前台命令最长约 55 秒。更长的命令应在后台运行，最长 3600 秒，并用 `exec_get` 查看进度。一个 Box 最多同时 8 个后台命令，整台服务器最多 64 个。
- 用 `session_start`、`session_send` 和 `session_read` **驱动终端会话**。Agent 断开后会话仍继续运行。见 [终端与会话](terminal-and-sessions.md)。
- 用 `read_file`、`write_file`、`list_files` 和 `copy_files` **读写卷中的文件**。即使没有 Box 在运行也能使用。
- 用 `tools` 工具集**安装和管理工具**。
- 用 `tools` 工具集**构建模板并拉取镜像**，仅限所有者。见 [模板](templates.md)。
- 用 `storage` 工具集**管理卷和存储池**。需要确认的更改会返回预览，直到 Agent 发送 `confirm: true`。

Agent 不能查看或使用其令牌未允许的 Box、卷或宿主机。

## 检查点

拍摄、列出、派生与回滚检查点仅通过 [REST API（英文）](../../reference/api.md) 提供。令牌需要 `checkpoint:create` 或 `checkpoint:restore` scope。

检查点包的导出与导入，以及检查点计划的设置，仅限所有者，因此任何 Agent 令牌都不能执行它们。[MCP 参考（英文）](../../reference/mcp.md) 列出了执行这些操作的存储工具。

## Box 内的 Agent

Box 内的 Agent 可以用它自己的**自助令牌**（self 令牌）使用 MiniBox。自助令牌默认关闭。创建 Box 时开启：在创建表单中勾选**为 Box 的 Agent 启用自助令牌**，对 `POST /api/boxes` 发送 `"selfToken": true`，或运行 `minibox box create <名称> --self-token`。

- **存放位置。** MiniBox 把令牌写入 Box 内的 `/run/minibox/self-token`，权限为 600，位于内存文件系统中。令牌不在 Box 的环境变量、事件或镜像中，MiniBox 只保存它的哈希值。
- **能访问的范围。** 只有它自己的 Box。Agent 可以读取 Box 的信息、为 Box 拍摄检查点、报告状态，并向你提问、读取你的回答。它不能访问其他 Box、密钥、令牌、宿主机或 API 的其余部分，也不能修改 Box 的规格或删除 Box。
- **何时变化。** 每次启动都会给 Box 一个新令牌，因此重启或重建会替换旧令牌。停止或删除 Box 会使它失效。若想在 Box 运行时使其失效，在 Box 页面的 **Agent** 卡片中点击**吊销令牌**，或发送 `DELETE /api/boxes/{id}/self-token`。这会关闭该 Box 的功能，并且在重新创建带令牌的 Box 之前保持关闭。
- **提问。** Agent 提出的问题会显示在 Box 页面的 **Agent** 卡片中，你可以在那里回复。若已设置通知，还会发送 `agent.question` 通知。Agent 不会等待你的回复，它会在此期间继续工作。一个 Box 最多保留 20 个未回答的问题。
- **网络。** Agent 通过网络连接 MiniBox。Box 通过 `minibox-boxes` 网络的网关访问宿主机，因此 MiniBox 必须监听该网络能够访问的地址。`HOST` 不能保持为 `127.0.0.1`，Box 无法访问它。发行镜像监听 `0.0.0.0`。MiniBox 不会把自己的地址告诉 Box，需要你自己提供，例如在 Box 的环境变量中设置 `MINIBOX_URL`。用 `docker network inspect minibox-boxes` 查看网关地址。

Agent 的 MCP 端点为 `/mcp`，只提供 `self` 工具集：`get_info`、`checkpoint`、`get_task`、`ask_human`、`get_question` 与 `report_status`。它的请求限制为每分钟 60 次，手动检查点限制为 20 个。见 [MCP 参考（英文）](../../reference/mcp.md#self-tools)。

### 给 Box 内 Agent 的说明

将以下内容粘贴到 Box 内项目的 `AGENTS.md` 中，让 Box 内的 Agent 了解它的自助令牌：

```markdown
## MiniBox self token

This box has a MiniBox self token when `/run/minibox/self-token` exists. It reaches this box only.

- `MINIBOX_URL` is the MiniBox address. If it is not set, ask the owner for it.
- Call `$MINIBOX_URL/mcp` with `Authorization: Bearer` and the contents of `/run/minibox/self-token`. The tools are get_info, checkpoint, get_task, ask_human, get_question and report_status.
- Call report_status when you start, when you wait for a person, and when you finish.
- To ask a person something only they can answer, call ask_human and keep working. It does not wait for an answer: poll get_question for it.
- Never print the token, write it to a file in /workspace, or commit it.
- If a call returns 401, read the file again once. If it still fails, the owner has turned the token off: report failed and stop.
```

## 停止 Agent

要停止 Agent，在**设置**的 **Agent API 令牌**下吊销其令牌。吊销会结束 Agent 的 MCP 会话、已打开终端和事件流。

## AGENTS.md 说明

将以下内容粘贴到 Agent 所工作项目的 `AGENTS.md` 文件中。它告诉 Agent 如何使用 MiniBox：

```markdown
## MiniBox

Use the MiniBox MCP server (`/mcp`, Bearer access key or agent token) to work inside a box.

- list_boxes or create_box before doing work. exec starts a stopped box, which changes its revision, unless the box's TTL has passed: then exec fails with box_ttl_expired. Read the revision again before an update that sends expectedRevision.
- exec takes argv (no shell) or cmd (via /bin/sh -c). Default user is dev, default directory is /workspace. A strict box allows only dev or 1000 as the user. The box needs /bin/sh, cat, rm and sleep.
- Pass secrets in env, not in argv or cmd. The audit log keeps commands and argv, but never env values.
- To give a box a host secret, pass `env` with `{ "name", "secretRef" }` entries to `create_box`. The call takes the secret's name, never its value. A token without `secret:use` is refused, and a secret that is not set fails the create.
- The result includes status, exitCode, stdout, stderr, truncated and durationMs. A non-zero exit code is the program's status.
- Inline output keeps about 16 KiB from the start and 16 KiB from the end of each stream. When truncated is true, outputRef names the rest: GET /api/execs/{execId}/output.
- A foreground exec may set timeoutSec up to 55. For a longer command, use exec with background true and a larger timeoutSec (up to 3600), then exec_get with waitMs (max 25000). exec_kill stops the process tree.
- exec can read and write every volume mounted on that box.
- rebuild_box is in the rebuild toolset (`/mcp?toolsets=rebuild`) and needs confirm true.
- move_box is in the move toolset (`/mcp?toolsets=move`) and needs confirm true. Without it the call changes nothing and returns confirmation_required with details.preview. It moves a box to another host: volumes are copied or attached there, the box is recreated and started if it runs, and the old container is removed once the new one runs. Only the owner or an admin credential can move a box.
- session_start, session_send and session_read drive a tmux session in the box. They are in the session toolset (`/mcp?toolsets=core,session`). A session keeps running after you disconnect. Use exec for one-off commands and a session for long-running or interactive programs. Listing and closing sessions are in the REST API and the CLI only.
- A session started through MCP has origin agent. A person can take it over in the console. While they hold it, session_send fails with taken_over and retryable true: wait a little, read the session with session_read, and send again. session_read still works during a takeover.
- session_read returns lines and a cursor. Pass the newest cursor as since to read only what is new. reset true means the screen was redrawn, and lines is the current window.
- session_send takes keys (tmux names such as Enter, Tab, Escape or C-c) or text, but not both. The audit log keeps the counts, never the input.
- The tools toolset (`/mcp?toolsets=tools`) holds list_tools, install_tool, upgrade_tool, uninstall_tool, reconcile_tools, save_template, create_template, rebuild_template and pull_image. Installs write to the shared tools volume and update BoxSpec.tools. save_template saves a box as a template: it is long-running, returns a task id, and leaves out `/workspace` and home volumes. create_template builds a template from a Dockerfile, a repository, a build context or a devcontainer.json, rebuild_template rebuilds one from its source, and pull_image pulls an image. Only the owner may use these three, and each returns a task id. list_custom_tools, put_custom_tool and delete_custom_tool manage the custom catalog in DATA_DIR/tools.d. Only the owner may use them. delete_custom_tool removes the file and does not uninstall the tool.
- The storage toolset (`/mcp?toolsets=storage`) holds the volume and pool tools. create_volume, delete_volume, attach_volume, detach_volume and replace_pools need confirm true. Without it the call changes nothing and returns confirmation_required with details.preview. attach_volume and detach_volume rebuild the box, so the same mount rules apply as to rebuild_box. measure_volume only refreshes the cached size. Checkpoint export, import and schedule tools are in the same toolset, for the owner only: export_checkpoint returns a task whose result holds a package id, import_checkpoint imports a package uploaded with POST /api/packages, and get_checkpoint_schedule, set_checkpoint_schedule and clear_checkpoint_schedule manage a box's schedule. A scheduled checkpoint never wakes a stopped or sleeping box. The audit log and the task record never hold a passphrase.
- The network toolset (`/mcp?toolsets=network`) holds list_ports and expose_port for port previews. A returned url opens in a browser signed in to MiniBox: a path under `/box/<name>/<port>/`, or, when PREVIEW_BASE_DOMAIN is set, a sign-in link to the port's own preview host.
- read_file, write_file, list_files and copy_files act on volumes (not boxes). They work when no box is running, via a helper container and the Docker archive API. A call keeps the boxes that mount the volume awake while it runs, and it never starts a stopped box. Paths are jailed inside the volume. write_file stamps uid/gid 1000 (dev). exec already implies volume RW on mounts of boxes the token may use; files:* only matters without exec.
- The default toolsets are core and meta. Add others with `?toolsets=`, for example `/mcp?toolsets=core,meta,session`. Taking, listing, forking and rolling back checkpoints have no MCP tools: use the REST API (`/api/boxes/{id}/checkpoints`, `/api/checkpoints`).
```
