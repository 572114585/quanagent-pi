# Pi Web

Pi Web 是 pi 智能体的浏览器入口。界面参考 quanAgent `master` 分支的 `388a894e` 提交，后端直接使用本仓库的 pi SDK。浏览器、终端可以读取同一个工作目录的会话历史，通过跨进程写锁避免同时写入。

适合在本机或个人服务器上运行，使用单个管理员账号登录。

## 功能

- 流式聊天，展示 Markdown、思考过程、工具参数、执行进度、结果和错误。
- 创建、重命名、归档会话；刷新和断线后恢复历史与事件。关闭浏览器不会停止任务。
- 与终端共用 Pi JSONL 会话；被终端占用时网页只读，释放后可以继续聊天。
- 选择模型与思考强度，管理 Provider API Key、自定义 OpenAI 兼容接口；继续使用已有 OAuth 凭据。
- 上传图片和普通文件；智能体通过 `publish_artifact` 交付文件，支持下载、图片和 PDF 预览。
- 处理扩展发起的确认、选择、文本输入和多行编辑请求。
- 桌面与手机布局、浅色与深色主题。

目前没有接入 quanAgent 的 DeepAgents 审批协议、Todo、子智能体面板、Plan 模式或 Tauri 桌面封装。这个入口也没有多用户账号和工作区权限隔离。

## 架构与目录

```text
浏览器（Vue）
    │ 同源 HTTP / SSE
    ▼
Node HTTP 服务
    │ pi SDK
    ▼
模型接口、工具、技能、扩展、MCP、工作目录与 JSONL 会话
```

| 目录 | 用途 |
| --- | --- |
| `apps/web` | Vue 3、Pinia 前端，包含聊天、设置和文件预览 |
| `packages/web-server` | 原生 Node HTTP 服务，负责鉴权、会话、事件流、模型配置和文件接口 |
| `packages/coding-agent` | pi SDK、配置发现、会话存储和跨进程写锁 |
| `apps/web/dist` | 前端构建产物，由 Node 服务同源提供 |

服务为一个固定工作目录运行。`--cwd` 指定智能体操作的目录；该目录中的项目指令、技能、扩展和 MCP 配置按 pi 的规则加载。工作目录用于上下文和文件交付校验，不是工具执行的安全沙箱。

## 环境要求

- Node.js **22.19 或更新版本**，以及 npm。先用 `node --version`、`npm --version` 核对。
- 完整的 pi 仓库源码和根目录 `package-lock.json`。
- 可用的模型接口和凭据，也可以在启动后通过网页设置。
- 工具所需的运行环境。例如 Linux 上的 Bash，以及项目需要的 Git、Python 或其他程序。

以下 npm 命令均从仓库根目录执行。依赖安装使用 `--ignore-scripts`；生产构建需要开发依赖，不要使用 `--omit=dev`。

## 本地启动（Windows）

### 1. 安装依赖

```powershell
cd D:\codes\pi
npm ci --ignore-scripts
```

### 2. 启动后端

先创建或选择一个实际存在的工作目录。打开第一个 PowerShell：

```powershell
cd D:\codes\pi
$env:PI_WEB_USERNAME = 'admin'
$env:PI_WEB_PASSWORD = '<替换为至少 12 个字符的密码>'
$env:PI_WEB_ORIGIN = 'http://127.0.0.1:1420'
npm run start:web -- --cwd D:\codes\your-project
```

密码占位符需要替换。后端默认监听 `127.0.0.1:8000`。建议始终传入绝对路径 `--cwd`；通过 npm 工作区启动时，未指定的默认目录是 `packages/web-server`。

### 3. 启动前端

打开第二个 PowerShell：

```powershell
cd D:\codes\pi
npm run dev:web
```

访问 [http://127.0.0.1:1420](http://127.0.0.1:1420)，使用上一步设置的管理员账号登录。

开发时 Vite 将同源 `/api` 转发到 `127.0.0.1:8000`。后端改动需要重启后端；前端改动由 Vite 自动更新。不要将 Vite 开发端口开放到公网。

### 4. 配置模型并开始聊天

打开侧栏“模型设置”，选择已有 Provider 并保存 API Key，或填写自定义 Provider、Base URL、协议和模型 ID。自定义接口支持 Chat Completions 和 Responses，可设置思考、图片、上下文和输出长度能力。

保存后选择模型发送消息。任务运行期间禁止修改模型配置。密钥只存放在服务端，浏览器接口不回传密钥。

## 启动参数与环境变量

| 参数 / 环境变量 | 说明 |
| --- | --- |
| `--cwd /absolute/path` | 固定工作目录，必须已存在 |
| `--host 127.0.0.1` | Node 监听地址，默认 `127.0.0.1` |
| `--port 8000` | Node 监听端口，默认 `8000` |
| `PI_WEB_USERNAME` | 管理员账号，必填 |
| `PI_WEB_PASSWORD` | 管理员密码，至少 12 个字符，必填 |
| `PI_WEB_ORIGIN` | 浏览器实际访问的源，例如 `https://pi.example.com`，不带路径或结尾斜杠 |
| `PI_CODING_AGENT_DIR` | Pi 配置和数据目录，默认当前服务用户的 `~/.pi/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | 可选，自定义会话目录 |

未设置 `PI_WEB_ORIGIN` 时使用 `http://127.0.0.1:<后端端口>`。开发时必须明确设置为前端地址；生产时设置为实际 HTTPS 地址。`localhost` 和 `127.0.0.1` 是不同的源，不能混用。

## 服务器部署（Linux + systemd + Nginx）

以下以 Ubuntu/Debian、域名 `pi.example.com` 为例。将域名、路径、账号和密码替换为实际值。部署完成后只需运行一个 Node 服务，静态页面和 API 由它统一提供。

### 1. 准备服务器和源码

安装符合版本要求的 Node.js 和 npm，以及 Nginx、Certbot、Git、Bash。Node 的安装方式可参考 [Node.js 官方下载说明](https://nodejs.org/en/download)。发行版自带的 Node 版本需要单独核对。

```bash
sudo apt update
sudo apt install nginx certbot git bash
node --version
npm --version
```

将**包含本次 Web 改动的完整源码**放到 `/opt/pi`，并让部署用户能够安装依赖、写入构建产物。尚未提交的新增文件不会出现在普通 `git clone` 中，上传时应包含 `apps/web`、`packages/web-server`、SDK 改动及根目录锁文件。不要直接复制 Windows 的 `node_modules` 到 Linux。

创建独立的服务账号、数据目录和工作目录：

```bash
sudo useradd --system --create-home --home-dir /var/lib/pi-web --shell /usr/sbin/nologin pi-web
sudo install -d -o pi-web -g pi-web -m 700 /var/lib/pi-web/agent
sudo install -d -o pi-web -g pi-web -m 750 /srv/pi-workspace
```

账号已存在时跳过 `useradd`。服务用户需要读取仓库和依赖，并能够写入配置目录和工作目录；原有项目目录也要授予相应权限。

### 2. 安装依赖并构建前端

使用部署用户在 `/opt/pi` 执行：

```bash
cd /opt/pi
npm ci --ignore-scripts
npm run build --workspace=@earendil-works/pi-web
test -f apps/web/dist/index.html
```

构建命令会准备 PDF.js 的本地资源。后端通过源码解析器直接运行本仓库 SDK，需要保留源码、根目录 `tsconfig.json` 和 `node_modules`；不能只上传 `apps/web/dist`，也不要在构建后裁剪开发依赖。

### 3. 配置管理员与数据目录

```bash
sudo install -o root -g root -m 600 /dev/null /etc/pi-web.env
sudoedit /etc/pi-web.env
```

填写以下内容，不要保留密码占位符：

```ini
PI_WEB_USERNAME=admin
PI_WEB_PASSWORD='替换为长随机密码'
PI_WEB_ORIGIN=https://pi.example.com
PI_CODING_AGENT_DIR=/var/lib/pi-web/agent
```

环境文件采用 systemd 格式，不写 `export`。不要把管理员密码或模型密钥提交到仓库。使用独立配置目录时，首次登录网页后需要添加模型凭据；已有配置可以复制到该目录并调整文件所有者。

### 4. 创建 systemd 服务

先执行 `command -v node` 找到 Node 的绝对路径。以下假设为 `/usr/bin/node`，使用其他安装位置时需要修改 `ExecStart`。systemd 不会加载交互式 shell 的 nvm 配置。

创建 `/etc/systemd/system/pi-web.service`：

```ini
[Unit]
Description=Pi Web agent workspace
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=pi-web
Group=pi-web
WorkingDirectory=/opt/pi
EnvironmentFile=/etc/pi-web.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --import /opt/pi/packages/coding-agent/src/experimental/source-resolver.ts /opt/pi/packages/web-server/src/main.ts --cwd /srv/pi-workspace --host 127.0.0.1 --port 8000
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=infinity
UMask=0077

[Install]
WantedBy=multi-user.target
```

启动并查看日志：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pi-web
sudo systemctl status pi-web --no-pager
sudo journalctl -u pi-web -n 100 --no-pager
curl -i http://127.0.0.1:8000/api/auth
```

未登录时 `/api/auth` 返回 `401` 是正常结果。停止服务会等待任务中止和会话持久化，因此未设置强制终止超时。工具不能及时退出时，停止操作也可能持续等待；更新前先在网页停止任务。

### 5. 配置域名与 HTTPS 证书

将 `pi.example.com` 的 DNS 指向服务器，并在云安全组和防火墙开放 `80`、`443`，保留实际使用的 SSH 入口。后端 `8000` 和开发端口 `1420` 不需要开放。

如果已有证书，可以直接进入下一步。否则先配置 ACME 验证目录：

```bash
sudo mkdir -p /var/www/letsencrypt
sudoedit /etc/nginx/sites-available/pi-web
```

首次申请证书时填写下面的 HTTP 配置：

```nginx
server {
    listen 80;
    server_name pi.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 404;
    }
}
```

启用站点、校验 Nginx，然后申请证书：

```bash
sudo ln -s /etc/nginx/sites-available/pi-web /etc/nginx/sites-enabled/pi-web
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt -d pi.example.com
```

站点链接已存在时跳过 `ln -s`。按 Certbot 提示填写邮箱和确认协议；若申请失败，先检查 DNS、80 端口和验证目录的访问情况。

### 6. 配置 HTTPS 与 SSE 反向代理

证书签发后，将 `/etc/nginx/sites-available/pi-web` 替换为：

```nginx
server {
    listen 80;
    server_name pi.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name pi.example.com;
    ssl_certificate /etc/letsencrypt/live/pi.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pi.example.com/privkey.pem;
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        gzip off;
    }
}
```

关闭代理缓冲可让 SSE 事件及时送达浏览器；较长的读取超时用于保持事件流连接。其他 CDN 或网关也需要允许长连接，并关闭对事件流的缓冲和缓存。

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

确认证书续期定时任务已启用，并在续期后重新加载 Nginx。使用 Certbot 时，可在 `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx` 写入以下脚本，再执行 `sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx`：

```sh
#!/bin/sh
systemctl reload nginx
```

### 7. 部署后验证

访问 `https://pi.example.com`，登录后完成以下检查：

1. 配置模型并发送消息，确认回答持续流式显示。
2. 刷新页面，确认会话历史恢复；打开第二个标签页，确认同一会话同步。
3. 运行工具、停止任务，确认任务结束后可以继续发送消息。
4. 上传附件，让智能体生成并交付文件，检查下载和 PDF 预览。
5. 重启服务后重新登录，确认历史、模型配置和文件仍可读取。

公网登录使用 `Secure`、`HttpOnly`、`SameSite=Strict` Cookie，默认七天过期；服务重启后需要重新登录。外部访问必须使用 HTTPS。当前限流使用直接连接的来源地址，反向代理后的用户共用该代理地址的登录失败限制。

## 日常管理、更新与备份

```bash
# 查看实时日志
sudo journalctl -u pi-web -f

# 重启或停止服务
sudo systemctl restart pi-web
sudo systemctl stop pi-web
```

更新时先停止任务和服务，备份数据，再由部署用户更新 `/opt/pi` 的源码并执行：

```bash
cd /opt/pi
npm ci --ignore-scripts
npm run build --workspace=@earendil-works/pi-web
sudo systemctl start pi-web
```

修改 systemd 单元后先执行 `sudo systemctl daemon-reload`。只修改环境文件时重启服务即可。回滚应恢复匹配版本的源码、锁文件和前端构建产物。

备份工作目录、`/etc/pi-web.env` 和完整 `PI_CODING_AGENT_DIR`。如设置了独立会话目录，也要备份该目录。备份包含凭据，应限制访问；复制时先停止服务及共用会话的终端，保证数据一致。

| 数据 | 默认位置 / 行为 |
| --- | --- |
| 模型密钥、OAuth 凭据 | `<agentDir>/auth.json` |
| 自定义模型 | `<agentDir>/models.json` |
| Pi 设置、技能、扩展等 | `<agentDir>` 及工作目录中的 Pi 配置 |
| 会话历史 | `<agentDir>/sessions` 下按工作目录分组，或指定会话目录 |
| 附件与产物快照 | `<agentDir>/web/<workspace-hash>/files` |
| 归档会话 | 原会话目录的 `.archive`；归档不会清理文件快照 |

默认本地 `agentDir` 为 `~/.pi/agent`，本部署示例为 `/var/lib/pi-web/agent`。迁移服务器时应保持或明确迁移工作目录路径，路径变化会影响会话分组和文件存储分组。

与终端共享会话时，终端和 Web 必须使用同一份支持写锁的 pi、相同工作目录和配置/会话目录，并具备相应文件权限。旧版 pi 不遵守新增写锁。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| `invalid_origin` | 检查 `PI_WEB_ORIGIN` 与地址栏的协议、域名、端口完全一致，没有结尾斜杠；修改后重启后端 |
| `frontend_not_built` / HTTP 503 | 在仓库根目录执行前端构建，确认 `apps/web/dist/index.html` 存在 |
| Nginx 返回 502 | 检查 `systemctl status pi-web`、Node 路径、目录权限以及后端是否监听 8000 |
| 回答结束才一次性显示 | 检查 Nginx/CDN 是否缓冲、缓存或压缩 SSE；使用文档中的代理配置 |
| 会话显示被占用 | 等待终端切换或退出会话；异常退出后的锁通常在心跳过期约 30 秒后可恢复，不要删除活跃会话的锁 |
| 模型不可用 | 登录“模型设置”，检查服务端凭据、自定义 Base URL、协议和模型 ID |
| 上传返回 413 | 单文件上限为 20 MiB；同时检查 Nginx 和外层网关限制，每条消息最多 8 个附件 |
| 重启后历史为空 | 检查服务用户、`PI_CODING_AGENT_DIR`、会话目录和 `--cwd` 是否与原先一致 |
| 服务报 TypeScript / 模块解析错误 | 检查 Node 版本，保留源码、根目录 `tsconfig.json` 与完整依赖，并使用文档中的源码解析器启动命令 |

## 开发验证

以下定向测试使用模拟模型，不调用真实模型 API：

```bash
cd packages/web-server
node --import ../coding-agent/src/experimental/source-resolver.ts --test test/web.test.ts
cd ../..
npm run check:web
npm run check
```

接口与实现细节见 [Web 服务说明](packages/web-server/README.md)。部署配置可查阅 [Nginx 代理缓冲文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)、[systemd 服务文档](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) 和 [systemd 环境文件文档](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#EnvironmentFile=)。
