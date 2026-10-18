# Pi Web

项目介绍、本地启动、Linux 服务器部署、HTTPS/SSE 代理与运维步骤见仓库根目录的 [Pi Web README](../../README.web.md)。

Vue 前端参考 quanAgent `master` 的 `388a894e` 提交。Node 服务直接使用本仓库的 Pi SDK，支持流式聊天、工具与思考展示、会话恢复、扩展交互、附件和文件交付。

Vue 与 UI 依赖沿用参考项目的固定版本；Vite 升级到仓库已有的 8，以支持 ES2024 配置并保持插件类型一致。前端使用独立 TypeScript 配置，不修改仓库根目录的编译目标。

## 本地开发

Node.js 需要 22.19 或更新版本。仓库根目录安装依赖：

```powershell
npm install --ignore-scripts
```

第一个终端启动服务。工作目录通过 `--cwd` 指定，建议始终传入绝对路径；通过 npm 工作区启动而未指定时，默认是 `packages/web-server` 目录：

```powershell
$env:PI_WEB_USERNAME = 'admin'
$env:PI_WEB_PASSWORD = '<至少 12 个字符的密码>'
$env:PI_WEB_ORIGIN = 'http://127.0.0.1:1420'
npm run start:web -- --cwd D:\codes\your-project
```

第二个终端启动前端：

```powershell
npm run dev:web
```

打开 `http://127.0.0.1:1420`。浏览器使用同源 `/api`，Vite 将请求代理到本机 `8000` 端口。修改后端代码后重启后端服务。

## 公网部署

部署前构建静态前端：

```powershell
npm run build --workspace=@earendil-works/pi-web
```

服务会同时提供 `apps/web/dist` 静态文件和 `/api`。生产环境设置：

```text
PI_WEB_USERNAME=admin
PI_WEB_PASSWORD=<长随机密码>
PI_WEB_ORIGIN=https://pi.example.com
```

通过反向代理提供 HTTPS。Node 默认只监听 `127.0.0.1:8000`，可用 `--host` 和 `--port` 修改。`PI_WEB_ORIGIN` 必须与浏览器实际地址一致，不包含结尾斜杠。公网 HTTP 地址会被拒绝。

Nginx 示例（证书配置按实际域名填写）：

```nginx
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
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

只通过反向代理访问 API，不开放 Vite 开发服务。登录 Cookie 在 HTTPS 下使用 `Secure`、`HttpOnly` 和 `SameSite=Strict`，七天后过期；服务重启后需要重新登录。登录尝试按服务端看到的来源地址限流，代理部署时所有请求共用代理的限制。

## 配置与会话

- 配置目录沿用 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`。Windows 的 bash 工具沿用 pi 的 `shellPath` 设置。
- 网页与终端使用相同工作目录的 Pi JSONL 会话；`PI_CODING_AGENT_SESSION_DIR` 可指定自定义会话目录。
- 终端持有会话时网页只读。终端切换会话或退出后，刷新或重新打开会话即可继续。Web 运行结束后释放会话；浏览器断开不会停止任务。
- 同一份会话需要所有写入进程都使用支持写锁的这份 Pi。旧版本进程不会遵守新增的占用锁。
- 会话归档保存在原会话目录的 `.archive`，移回原目录即可恢复；此操作也会影响终端会话列表。
- 首次使用包含项目扩展或技能的目录时，网页要求确认是否信任。遵守已有 Pi 信任配置；网页中的临时选择只对当前服务进程有效。
- 在“模型设置”添加 Provider 密钥，或配置 OpenAI 兼容服务的地址、模型 ID、Chat Completions/Responses 协议和能力。密钥只写入服务端 `auth.json`，接口不会返回密钥。已有 OAuth 登录可继续使用；网页新增登录目前支持 API Key。
- 模型配置写入 Pi 的 `models.json`，不会覆盖其他 Provider 和未编辑字段。任务运行时禁止修改配置。终端刷新模型配置后可使用网页保存的接口。
- API 地址中的凭据、查询参数和片段不通过网页编辑；复杂鉴权和自定义请求头继续使用 Pi 配置文件。

## 文件与扩展

单个附件最大 20 MiB，每条消息最多 8 个附件。图片作为模型图片输入，其他文件以本地路径交给智能体处理，具体格式依赖工作目录中的技能和工具。

智能体调用 `publish_artifact` 交付工作目录内的文件。服务复制文件形成独立快照，网页提供下载；图片和 PDF 支持预览。PDF 通过本地 PDF.js Worker 渲染，开发和构建命令会准备字体、字符映射及解码资源，无需外部 CDN 或浏览器插件。HTML、SVG 和未知格式强制下载。文件及元数据存放在 `<agentDir>/web/<workspace-hash>/files`；会话保存附件与产物引用。归档会话不会清理这些文件。

扩展的确认、选择、输入和多行编辑请求可以在网页完成。取消、停止或超时不会批准操作。终端自定义组件在 Web 中不可用。quanAgent 的 DeepAgents 审批、Todo、子智能体面板、Plan 模式和 Tauri 封装不属于这个入口。

## 验证

不调用真实模型或发送外部消息：

```powershell
cd packages/web-server
node --import ../coding-agent/src/experimental/source-resolver.ts --test test/web.test.ts
cd ../..
npm run check
```

主要接口：`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth`、`GET /api/models`、`PUT/DELETE /api/providers/:id`、会话 CRUD `/api/sessions`、`POST /api/sessions/:id/messages`、`GET /api/sessions/:id/events`、`POST /api/sessions/:id/stop`、`POST /api/sessions/:id/dialogs/:requestId`、`POST /api/sessions/:id/uploads`、`GET /api/files/:id`。

SSE 使用 Pi 原生 JSON 事件，并携带会话、运行 ID 和事件游标。重连优先使用 `Last-Event-ID`，游标过期或服务重启时发送快照。只有 `agent_settled` 表示 Pi 不会继续自动工作；`run_finished` 表示 Web 入口也已完成清理并释放会话。
