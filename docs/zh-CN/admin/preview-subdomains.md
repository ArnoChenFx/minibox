# 子域名预览

默认情况下，端口预览位于控制台自身地址上的 `/box/<name>/<port>/`。此时预览与控制台共享同一个源，其隔离依赖浏览器的行为：预览运行在沙箱中，控制台的登录 cookie 为 `HttpOnly` 且 `SameSite=Strict`。对于单一可信用户，这已经足够，并且不需要 DNS 或证书。

设置 `PREVIEW_BASE_DOMAIN`，即可让每个预览拥有自己的源：

```
https://<port>-<box>.<PREVIEW_BASE_DOMAIN>/
```

例如，名为 `web` 的 Box 的 3000 端口，在 `PREVIEW_BASE_DOMAIN=minibox-preview.net` 时，地址为 `https://3000-web.minibox-preview.net/`。位于独立源上的预览无法读取控制台的 cookie 或存储，其脚本也无法调用控制台的 API。预览仍可使用自己的存储与 cookie，许多应用都需要这一点。

`<box>` 部分在 Box 名称最多 57 个字符、仅由小写字母、数字和连字符组成且以字母或数字开头和结尾时使用该名称，例如 `web` 或 `my-box`。其他名称会被替换为 Box 的 ID，并将其中的下划线换成连字符，例如 `bx-3f9c…`。请在 Box 的 **端口** 选项卡中点击 **打开**，无需自行拼写地址。

## 所需条件

- **预览域名。** 它不能是控制台的域名，也不能位于控制台域名之下。例如控制台为 `minibox.example.com`，预览为 `*.minibox-preview.net`。若两个名称以相同的两级标签结尾，例如 `minibox.example.com` 与 `preview.example.com`，浏览器可能将它们视为同一站点，自检会对此发出警告。
- **通配符 DNS 记录** `*.minibox-preview.net`，指向 MiniBox，可以直接指向，也可以经隧道指向。
- **通配符证书**，覆盖 `*.minibox-preview.net`。通配符只匹配一级标签，因此 `3000-web.minibox-preview.net` 在覆盖范围内。MiniBox 只生成该层级的名称。
- **控制台与预览均使用 HTTPS。** 预览的授权 cookie 带有 `Secure` 属性，浏览器不会通过明文 HTTP 保存它。
- **保留 `Host` 头。** 代理必须原样传递公网 `Host`。MiniBox 从中读取端口与 Box。

## 启用

1. 在 `.env` 中设置 `PREVIEW_BASE_DOMAIN`，例如 `PREVIEW_BASE_DOMAIN=minibox-preview.net`。只写裸域名，不要包含 `https://`、端口或路径。取值无效时启动会失败，错误信息会说明如何修正。
2. 重启 MiniBox。
3. 打开 **设置**，查看 **端口预览** 卡片。卡片从 MiniBox 所在的主机运行四项检查，每项失败时都会给出说明：
   - 控制台地址位于预览域名之外。
   - 控制台与预览域名属于不同站点。出现警告表示两者以相同的两级标签结尾，例如 `example.com`。
   - 预览域名下的随机名称可以解析。
   - 该名称可以通过 HTTPS 从 MiniBox 得到响应。MiniBox 会识别自己的响应，因此若通配符指向了其他服务器，此项检查失败。

检查在 MiniBox 主机上运行，因此它们显示的是 MiniBox 能解析和访问的内容。另一网络中的浏览器仍可能因检查无法覆盖的原因而失败，例如其自身的 DNS。

设置 `PREVIEW_BASE_DOMAIN` 后，`/box/` 地址返回 `404`。共享源的预览不会与隔离的预览并存。

要关闭子域名预览，请删除 `PREVIEW_BASE_DOMAIN` 并重启 MiniBox。预览会恢复为 `/box/<name>/<port>/`。

## Cloudflare Tunnel

将控制台所在域与 `minibox-preview.net` 域都托管到同一个 Cloudflare 账户，以便一条隧道可以同时路由两个主机名。Universal SSL 随后会为 `*.minibox-preview.net` 签发证书。

在隧道的 ingress 规则中同时配置两个主机名。下面的 `config.yml` 将两者转发给同一台机器上的 MiniBox：

```yaml
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: minibox.example.com
    service: http://127.0.0.1:3920
  - hostname: "*.minibox-preview.net"
    service: http://127.0.0.1:3920
  - service: http_status:404
```

为隧道创建 DNS 记录：

```bash
cloudflared tunnel route dns <tunnel-name> minibox.example.com
cloudflared tunnel route dns <tunnel-name> "*.minibox-preview.net"
```

`cloudflared` 会转发它收到的 `Host` 头，因此无需设置 `httpHostHeader`。请在 `.env` 中保留示例中的 `HOST=127.0.0.1` 与 `PORT=3920`。

## Caddy

Caddy 只能通过 DNS 验证签发通配符证书。请使用对应 DNS 服务商的模块构建 Caddy，例如 `caddy-dns/cloudflare`：

```bash
xcaddy build --with github.com/caddy-dns/cloudflare
```

然后在 Caddyfile 中使用以下站点块。请在 Caddy 的环境变量中设置 `CLOUDFLARE_API_TOKEN`，其值须为可以编辑该域名 DNS 记录的 Cloudflare API 令牌：

```caddyfile
minibox.example.com {
	reverse_proxy 127.0.0.1:3920
}

*.minibox-preview.net {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:3920
}
```

`reverse_proxy` 默认保留请求的 `Host` 头，除非你设置了 `header_up Host`，因此请不要设置它。

## 检查

- 打开 **设置**，再打开 **端口预览**：卡片上没有错误，各项检查均通过。
- 从 Box 的 **端口** 选项卡中打开某个端口。浏览器会前往 `https://<port>-<box>.<domain>/`，应用在该地址加载。
- 在未登录控制台的浏览器中粘贴该地址。它无法打开，因为预览需要控制台签发的授权。

## 有效期

- 预览以一次性链接打开，链接在 60 秒内有效。预览域名会使用该链接并设置授权 cookie。
- 授权最长持续 8 小时。若其所属的登录会话结束（例如退出登录），或其 Box 被重命名或删除，则会提前失效。
- 授权保存在内存中，因此重启 MiniBox 会使其全部失效。请从控制台重新打开预览。
- 已停止的 Box 会拒绝预览。休眠中的 Box 会在你打开预览时被唤醒。

## 故障排查

| 现象 | 可能原因 |
|---|---|
| `401`，"请从 MiniBox 控制台打开此预览。" | 链接已被使用或已过期，打开它的登录会话已结束，或 Box 已被重命名或删除。请从 **端口** 选项卡重新打开该端口。 |
| `404`，"此地址没有提供任何 Box 端口。" | 主机名不是 `<port>-<box>.<domain>`，或代理修改了 `Host` 头。 |
| 端口预览卡片："无法解析 ……" | 缺少通配符 DNS 记录，或 MiniBox 主机无法解析该记录。 |
| 端口预览卡片："无法通过 HTTPS 连接 ……" | 通配符未指向 MiniBox，或其证书未覆盖 `*.minibox-preview.net`。 |
| 端口预览卡片："有应答，但不是 MiniBox 的" | 域名下有其他服务器响应。请将通配符指向 MiniBox。 |
| 预览能加载，但应用的请求失败 | 应用构造的地址位于 `/box/<name>/<port>/` 之下。子域名模式下应用位于 `/`。 |

## 安全说明

- 控制台的登录 cookie 永远不会发送到预览域名。授权不等于登录会话，它只能打开签发时对应的那一个预览。
- 票据只能使用一次，且只对签发时指定的 Box 与端口有效。
- 来自预览的写入与 WebSocket 连接，只有在其 `Origin` 为该预览自身地址时才会被接受。这可阻止一个预览修改同级预览。同级预览发出的 `GET` 请求不会被拦截，因此应用不得在 `GET` 中修改状态。
- Box 在响应中设置的 cookie 只留在其自己的预览主机上，因为 MiniBox 会去掉其 `Domain` 属性。页面脚本仍可为整个预览域名设置 cookie，因此不要信任来自其他预览的 cookie。
- 基础域名之下、且不是预览的名称（包括基础域名本身），返回 `404`。
- 子域名预览可以使用自己的存储与 cookie。与之前一样，请只在 Box 中运行你信任的应用。

完整的安全模型见 [安全（英文）](../../admin/security.md#port-previews)。
