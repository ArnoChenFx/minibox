# 通知

MiniBox 可以在你不盯着控制台时告诉你出现了问题。当 Box 内存耗尽、命令失败、Box 即将停止或休眠、终端会话被接管，或宿主机离线时，它会向 **Webhook**、**ntfy** 主题或 **Telegram** 聊天发送一条简短消息。

只有所有者可以设置通知，位置在 **设置** 的 **通知** 部分。发送失败不会阻止触发它的操作。

## 发送的通知

| 通知 | 发送时机 |
|---|---|
| `box.oom` | Box 内存耗尽并已停止。 |
| `exec.failed` | Box 中的命令以非零退出码结束，或超时。 |
| `checkpoint.failed` | 检查点在服务器端失败，无论是定时的还是手动创建的。被拒绝的情况（例如仓库已满）不会发送通知。 |
| `box.ttl_soon` | Box 的 TTL 将在 5 分钟内结束，Box 随即停止。 |
| `box.idle_soon` | Box 将在 5 分钟内因空闲而休眠。 |
| `session.takeover` | 有人接管了 Agent 的终端会话。 |
| `host.offline` | 原本在线的宿主机停止响应。MiniBox 启动时已处于离线状态的宿主机不会发送此通知。 |
| `volume.usage_high` | 卷的用量达到软上限。该上限是尽力而为，不是配额。参见[用量、上限与剩余空间](volumes-and-storage.md#用量上限与剩余空间)。 |
| `volume.usage_limit` | 卷的用量达到硬上限。通知会注明原因与动作，并列出被停止的 Box。 |
| `host.disk_low` | 宿主机磁盘的剩余空间低于下限，因此拒绝创建新卷和检查点。 |

Agent 提出的问题暂时还不会发送。

## 添加渠道

1. 打开 **设置**，找到 **通知**，选择 **添加渠道**。
2. 填写 **名称** 和 **标识**。标识由小写字母、数字和连字符组成，以字母开头，之后不能修改。
3. 选择 **类型**：Webhook、ntfy 或 Telegram，并填写对应字段。参见 [渠道类型](#渠道类型)。
4. 选择 **要发送的通知**。新渠道默认包含全部通知。
5. 可选：将渠道限定为部分 **Box**，按名称或 ID 填写，用逗号或换行分隔。留空表示所有 Box。宿主机与卷的通知总会发送到该渠道。
6. 选择 **保存渠道**，然后在渠道所在行点击 **发送测试**。结果会立即显示在屏幕上。

关闭 **发送到此渠道** 的渠道会保留其设置，但不发送任何通知。

## 渠道类型

### Webhook

MiniBox 会将每条通知以 HTTP `POST` 的方式、以 JSON 作为请求体发送到你填写的地址，支持 `http` 与 `https`：

```json
{
  "id": "01J…",
  "kind": "box.oom",
  "title": "Box 内存耗尽：demo",
  "body": null,
  "box": "demo",
  "host": null,
  "at": "2026-10-22T08:15:00.000Z"
}
```

每个请求还带有以下请求头：

| 请求头 | 值 |
|---|---|
| `x-minibox-event` | 通知类型，例如 `box.oom` |
| `x-minibox-timestamp` | 通知发送的时间，单位为 Unix 秒 |
| `x-minibox-delivery` | 发送记录的 ID。重试时 ID 不变，接收方可据此去重。 |
| `user-agent` | `MiniBox/<版本>` |

如果渠道设置了 **签名密钥**，每个请求还会带有 `x-minibox-signature: sha256=<十六进制值>`。该值是以密钥为键、对“时间戳 + 点 + 原始请求体”计算的 HMAC-SHA256。校验时，请用收到的原始请求体重新计算，以恒定时间比较，并拒绝与本地时钟相差过大的时间戳，以防旧请求被重放：

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
const expected = `sha256=${digest}`;
const valid = expected.length === received.length && timingSafeEqual(Buffer.from(expected), Buffer.from(received));
```

### ntfy

MiniBox 会把通知发送到 `<服务器>/<主题>`。**ntfy 服务器** 默认为 `https://ntfy.sh`。消息正文为标题，换行后接正文。标题通过请求头发送，只允许可打印的 ASCII 字符，其他字符会显示为 `?`。每种通知都有优先级：`box.oom`、`checkpoint.failed`、`host.offline`、`volume.usage_limit` 与 `host.disk_low` 为 4，其他为 3。每种通知还带有与其对应的标签，例如 `warning` 或 `zzz`。

知道主题名的人都能读取，请选择难以猜到的名称。如果主题需要令牌，请将其填入 **访问令牌**。MiniBox 会以 `Authorization: Bearer` 发送该令牌。

### Telegram

通过 @BotFather 创建机器人，并将其令牌填入 **机器人令牌**。**聊天 ID** 可以是 `-1001234567890` 这样的数字（群组或频道），也可以是 `@alerts` 这样的频道名。机器人必须已是该聊天的成员。MiniBox 调用 Bot API 的 `sendMessage` 方法，并关闭链接预览。

## 发送

- **不阻塞。** 通知先进入队列，再在后台发送，触发它的操作不会等待。最多同时发送 4 条，最多可排队 256 条。超出时，该通知会被记为失败，原因为 `queue_full`。
- **超时。** 每次尝试在 10 秒后放弃，包括域名解析在内。
- **重试。** 每次发送最多尝试 3 次，两次之间依次等待 1 秒和 2 秒。只有超时、网络与 DNS 失败，以及 HTTP `429` 与 `5xx` 应答会被重试。其他应答（例如 `404`）会立即失败。不跟随重定向，因此 `3xx` 应答视为失败。
- **重复。** 同一渠道在 5 分钟内不会再次发送针对同一 Box、宿主机或卷的相同通知。
- **排队中的通知不会保存。** 服务重启会丢弃尚未发送的通知。

## 发送记录

通知卡片列出最近 20 次尝试：时间、渠道、通知、结果与尝试次数。失败的尝试会显示原因：

| 原因 | 含义 |
|---|---|
| `timeout` | 10 秒内没有应答 |
| `network` | 连接失败 |
| `dns_failed` | 无法解析域名 |
| `blocked_address` | 地址不是公网地址。参见 [私有地址](#私有地址)。 |
| `bad_url` | 地址无效 |
| `http_<状态码>` | 渠道返回了该 HTTP 状态码 |
| `queue_full` | 等待发送的通知过多 |
| `unexpected` | 意外错误。服务器日志会记录渠道与错误类型。 |

每次尝试还会以 `notify.deliver` 的形式记入事件日志，因此会保留审计保留期，默认 365 天。记录包含渠道、通知、尝试次数、HTTP 状态码与原因，从不包含密钥或 URL。

## 私有地址

MiniBox 默认只向公网地址发送。回环、私有网络、链路本地、共享地址与保留地址都会被拒绝，因此渠道无法访问你本机或局域网中的服务。若要发送到自建的 ntfy 服务器，或发送到你网络中的 Webhook，请设置 `NOTIFY_ALLOW_PRIVATE=true`。该设置对所有渠道生效。参见 [配置](../../reference/configuration.md#notifications)。`198.18.0.0/15` 中的地址是允许的，因为 Clash、Surge 等 fake-IP 模式的 DNS 代理会用这一段地址应答所有域名。

## 限制与隐私

- 一台服务器最多有 32 个渠道。
- 通知标题最多 200 个字符，正文最多 500 个字符。
- 通知不包含命令输出，也不包含密钥的值。发送前会从文本中移除已知密钥。
- 渠道的签名密钥、ntfy 访问令牌或机器人令牌保存在 `DATA_DIR/secrets/notify/<渠道标识>` 中，权限为 600。保存后不会再次显示。
- 部分聊天服务会把令牌放在 Webhook 地址里，因此 Webhook 地址同样按密钥保存在 `DATA_DIR/secrets/notify/<渠道标识>.url` 中。接口与设置卡片只显示其来源部分，例如 `https://hooks.example.com/…`。要更换地址，请输入完整的新地址；留空即保留已保存的地址。
- 渠道的其他设置保存在 `DATA_DIR/notify.json` 中，权限同样为 600：ntfy 服务器与主题、Telegram 聊天 ID、订阅的通知与 Box 筛选。参见 [数据目录](../../admin/data-directory.md)。
- 只有所有者可以查看或修改渠道，Agent 令牌不能。

## 通过 API 管理渠道

渠道也可以通过 [REST API](../../reference/api.md#notify) 与 [MCP 工具](../../reference/mcp.md#meta) 进行列出、修改、测试与删除，例如 `list_notify_channels` 与 `set_notify_channel`。命令行暂无通知命令。
