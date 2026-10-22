# 终端与会话

每个 Box 在浏览器中有一个终端。终端以用户 `dev` 在 `/workspace` 文件夹中运行 shell。

终端工作在会话中进行。会话是 Box 内具名的 tmux 会话。关闭页面后会话继续运行，返回时会从离开处恢复。关闭会话或 Box 停止时会话结束。

## 打开终端

1. 打开 Box，点击 **终端** 标签页。
2. 若 Box 已停止，点击 **启动 Box**。

若 Box 处于休眠，终端会唤醒它。你手动停止的 Box 不会因终端而唤醒。参见[空闲休眠与 TTL](idle-sleep.md)。

## 新建会话

1. 在 **终端** 标签页，点击 **新建会话**。
2. 在 **会话名称** 中输入名称。最多 32 个字母、数字、短横线和下划线。
3. 点击 **新建会话**。

会话名称用于再次找到该会话。**会话** 列表显示 Box 中的全部会话。

要结束会话，点击 **关闭会话** 并确认。会话中运行的程序会停止。

一个 Box 最多 16 个会话。每个会话同时最多打开 8 个终端。

## Agent 驱动的会话

AI Agent 可在 Box 中启动自己的会话。这些会话称为 Agent 会话。

- Agent 会话在控制台中以只读方式打开。**终端** 标签页显示 **Agent 操作中**，附注「Agent 操作时此会话只读。接管后即可输入。」
- 要在会话中输入，点击 **接管**。
- 要将会话交还给 Agent，点击 **交还 Agent**。

你接管的会话在你一段时间无输入后会自动交还给 Agent。管理员用 `SESSION_TAKEOVER_IDLE_SEC` 设置该时长。默认 300 秒。若时长为 `0`，会话会一直由你持有，直到你手动交还。

你自己启动的会话始终由你持有。需要 Agent 在其中输入时再交还给 Agent。

你持有会话期间，Agent 仍可读取其屏幕，但在你交还之前 Agent 的输入会被拒绝。

重启 MiniBox 会将每个会话恢复到初始控制状态：Agent 会话归 Agent，你启动的会话归你。

## 在命令行中使用会话

```bash
minibox session ls my-box
minibox session start my-box build
minibox session read my-box build --lines 50
minibox session send my-box build --text "npm test"
minibox session send my-box build --key Enter
minibox session close my-box build
```

全部选项见 [CLI 参考（英文）](../../reference/cli.md)。
