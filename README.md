# MiniBox

个人用的仿 [Upstash Box](https://upstash.com/docs/box) 控制台：用本机 Docker 管理「给 Agent 用的隔离开发环境」。

- 每个 Box = 一个带 `minibox=true` 标签的容器
- 工作区挂在命名卷 `/workspace`
- 支持创建 / 启停 / 删除 / 快照 / 模板 / 资源热更新 / 日志 / 网页终端
- **运行时：Bun.js**（`Bun.serve` 同时提供 HTTP + WebSocket）
- 无独立数据库，状态全部存在 Docker labels / images 里

## 快速开始

```bash
# 依赖：Docker daemon + Bun
curl -fsSL https://bun.sh/install | bash
bun install

# 启动（监听 127.0.0.1:3920，密钥首次自动写入 .env）
bun start
# 或后台：
setsid nohup bun start > server.log 2>&1 < /dev/null &
```

首次启动会在项目根目录生成 `.env`：

```
ACCESS_KEY=<64位十六进制>
PORT=3920
HOST=127.0.0.1
```

浏览器打开后用该密钥登录。也可用 `Authorization: Bearer <key>` 调 API。

构建基础模板：

```bash
# 方式一：Dashboard「模板」页点按钮
# 方式二：
bun run build:template
# 或 API：
curl -H "Authorization: Bearer $ACCESS_KEY" -X POST http://127.0.0.1:3920/api/templates/build
```

## 架构

```
浏览器 ──HTTPS──▶ OpenTunnel ──▶ 127.0.0.1:3920 (Bun)
                                    │
                                    ├── 静态页 public/
                                    ├── REST /api/*
                                    ├── WS   /api/boxes/:id/term
                                    └── dockerode ──▶ /var/run/docker.sock
```

| Label | 含义 |
|---|---|
| `minibox=true` | 这是一个 Box 容器 |
| `minibox.name` | 显示名 |
| `minibox.template` | 创建时用的模板/镜像 |
| `minibox.template=true`（镜像） | 可选模板 |
| `minibox.snapshot=true`（镜像） | 快照 |

## 公网访问（OpenTunnel）

```bash
curl -fsSL https://opentunnel.xyz/install | sh
# 或: npm i -g opentunnel / bun add -g opentunnel
opentunnel route add 3920 --name minibox
```

会打印 `https://minibox.<id>.opentunnel.xyz`。隧道只做转发，**不做鉴权**——密钥是唯一门禁。

## 安全说明

1. **Docker socket ≈ 宿主机 root**。能访问本服务的人，等价于能在宿主机起任意容器。密钥务必保密。
2. 服务只绑 `127.0.0.1`，公网入口必须走隧道或本机代理。
3. OpenTunnel 主机名会出现在证书透明度日志里，路由名也可被猜到；**不要把隧道 URL 当成秘密**，靠 `ACCESS_KEY` 防护。
4. 个人自用、轻隔离；不适合多租户或不信任代码。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | `{key}` → 设置 httpOnly cookie |
| GET | `/api/boxes` | 列表 + 实时 CPU/内存 |
| POST | `/api/boxes` | 创建 `{name,template,cpus,memoryMb}` |
| POST | `/api/boxes/:id/start\|stop\|restart` | 启停 |
| DELETE | `/api/boxes/:id?deleteVolume=true` | 删除 |
| POST | `/api/boxes/:id/snapshot` | 快照 |
| PATCH | `/api/boxes/:id/resources` | 热更新 CPU/内存 |
| GET | `/api/boxes/:id/logs` | 日志 |
| WS | `/api/boxes/:id/term` | 网页终端 |
| GET/POST | `/api/snapshots` … | 快照列表/删除/提升/从此创建 |
| GET/POST | `/api/templates` `/api/templates/build` | 模板 |

## 许可

私人项目，按需自用。
