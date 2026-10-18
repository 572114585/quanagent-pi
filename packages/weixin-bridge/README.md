# 微信桥接

微信桥接是 Pi 仓库内的私有 npm 工作区包。使用同仓库的 Pi 源码，无需单独安装或构建另一个项目。

支持白名单、多用户独立会话、按用户排队、空闲回收、引用消息、图片视觉输入、语音和文件处理，以及定时任务和持久发送队列。

## 启动

在仓库根目录安装依赖：

```powershell
npm install --ignore-scripts
```

默认数据目录为 `~/.pi/agent/weixin-bridge`，跟随 `PI_CODING_AGENT_DIR`。在该目录创建 `config.json`，内容参考 [config.example.json](config.example.json)，填入 owner 和允许使用的微信用户 ID。可选的 `shellPath` 指定 bash 路径。

桥接共享个人 Pi 目录中的模型配置和鉴权。在 `config.json` 里用 `provider` 和 `model` 指定要使用的模型（也可用环境变量 `PI_WEIXIN_PROVIDER` / `PI_WEIXIN_MODEL` 覆盖），取值需与个人 `models.json` 中的配置项一致；图片输入需要模型声明支持 image。

```powershell
npm run login:weixin
npm run start:weixin
```

首次登录扫码，后续复用微信 SDK 存在 `~/.wechatbot` 的凭证。`login:weixin -- --force` 强制重新登录；需要输入配对码时，将数字写入 `packages/weixin-bridge/src/demo/verifycode.txt`。

owner 与 allowlist 内用户均拥有 Pi 默认完整工具集。普通用户发送的附件限制在其工作目录内，owner 可发送外部路径的附件。工作目录分开存放不构成操作系统沙箱。

## 网页扫码连接

启动 [Pi Web](../../README.web.md) 后，在设置中打开“微信连接”。首次使用先选择已配置凭据的模型，再点击“连接微信”，使用微信扫描页面二维码，并按提示确认或输入配对码。

没有 `config.json` 时，扫码成功后自动将扫码账号的微信用户 ID 设为 owner，白名单为空。已有配置的 owner、白名单和模型保持不变。微信使用原有独立会话和工作目录，网页聊天上下文不会混入微信。

Web 服务自动管理桥接子进程，无需另行运行 `start:weixin`。关闭网页不停止桥接；服务重启后恢复已启用的连接。点击“断开连接”保留凭据和历史，并关闭自动恢复；“重新扫码”先停止旧进程再开始登录。

连接偏好保存在 `<数据目录>/web-control.json`，微信凭据仍由 SDK 存放在 `~/.wechatbot`。网页、`start:weixin`、`login:weixin` 和调试扩展共用数据目录与凭据目录的进程锁；提示占用时先停止其他入口。更新前仍需停止不支持进程锁的旧版桥接。

需要隔离部署的凭据时，可设置 `PI_WEIXIN_STORAGE_DIR` 指定 SDK 存储目录；所有使用同一账号的入口必须使用相同目录。

## 从原项目迁移

代码已迁入本包；已有配置、会话、文件和任务可继续使用原数据目录。在仓库根目录运行：

```powershell
$env:PI_WEIXIN_BRIDGE_HOME = '<原数据目录>'
npm run start:weixin
```

先停止原桥接进程，再启动新入口，避免同一个微信账号重复轮询、同一份任务存储被两个进程写入。上述路径只存运行数据，后续开发和依赖安装都在本仓库进行。

保留原数据路径是为了维持会话、任务绑定及已生成文件中的绝对路径。不要直接移动 `workspace`：已有 session header、current-session.json 和任务记录中的绝对路径也需要迁移。

数据目录中的 `skills/` 继续作为本地扩展技能源，并覆盖同名内置技能。内置 PaddleOCR 技能从 `PADDLEOCR_TOKEN` 环境变量读取凭证；本仓库不保存服务令牌。

## 文件和验证

| 路径 | 用途 |
|------|------|
| `src/daemon.ts` | 多用户守护进程入口 |
| `src/demo/index.ts` | 早期单会话终端扩展，保留供调试 |
| `src/demo/login.ts` | 扫码及配对登录 |
| `skills/` | 随用户会话分发的内置技能 |
| `<数据目录>/config.json` | 白名单和 shell 配置 |
| `<数据目录>/workspace/` | 会话、用户文件、任务记录 |

终端扩展通过 `pi --extension packages/weixin-bridge/src/demo/index.ts` 加载，输入 `/wechat` 连接。该调试扩展共享当前终端会话，只有一个待回复槽；多用户使用守护进程。

定时任务操作和状态说明见 [README-schedule.md](README-schedule.md)。

离线验证不会登录微信、调用真实模型或发送消息：

```powershell
cd packages/weixin-bridge
node --import ../coding-agent/src/experimental/source-resolver.ts --test test/startup.test.ts test/scheduling.test.ts test/control.test.ts
cd ../..
npm run check
```
