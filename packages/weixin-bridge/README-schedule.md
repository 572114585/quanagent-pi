# 定时任务

在仓库根目录启动桥接（直接加载同仓库源码）：

```powershell
npm run start:weixin
```

在微信中直接说“每天北京时间 9 点生成日报并发给我”。支持延迟、指定时间、固定间隔、每天、每周及五字段 cron。每次运行从原会话最新完整对话取得快照，在独立后台会话中执行。跳过正在处理的轮次，不占用普通消息队列，不写回原聊天，也不修改 current-session.json。同用户后台最多一路，宿主最多四路。守护进程需要保持运行。

可以通过对话列出、修改、暂停、恢复和删除任务，查询历史，手动重跑或重新发送已有结果。暂停期间不补跑；重启只补最近一次。失败或中断的执行不会自动重跑。

执行结果与文件通过持久发送队列补发。网络失败按 1、5、15 分钟重试；缺少微信会话令牌时等待用户再次发送消息。补发不会再次调用模型。

终端 pi 的 `/schedule bind-weixin` 可选择本桥接已注册的 owner 账号，之后要求创建任务时选择微信通知。桥接与终端必须使用同一个个人 pi 配置目录。登录令牌仍只由微信 SDK 管理。

状态位置：数据目录下的 `workspace/.schedule` 保存任务；每用户 `current-session.json` 固定原会话；个人 pi 配置目录下的 `schedule-delivery` 保存发送队列。默认数据目录和复用原目录的方法见 [README.md](README.md)。不要在两个进程中同时启用同一个任务存储目录。

离线验证（不会登录微信、调用真实模型或发送消息）：

```powershell
cd packages/weixin-bridge
node --import ../coding-agent/src/experimental/source-resolver.ts --test test/startup.test.ts test/scheduling.test.ts
cd ../..
npm run check
```

任务保存后，创建回执立即进入持久发送队列，不等待模型确认回复。创建回执和运行结果分别去重。后续追问结果请查询 schedule_history。

默认运行时限 60 分钟，可在 config.json 设置 `"schedule": {"runTimeoutMinutes": 60}`。超时通知失败并取消后台实例，等待实际回收后才释放名额；不自动重跑，不影响主聊天。

后台日志位于 workspace/.schedule/executions/<runId>/session.jsonl，默认产物位于原工作区 .pi/schedule-artifacts/<taskId>/<runId>/。运行中的日志只读查看，不要打开第二个写入实例。

状态和发送记录自动迁移至版本 2，迁移前备份，保留已确认分片进度。旧任务不补发创建回执，已完成任务不重新执行。宿主退出停止后台任务；没有新增 Windows 系统任务或常驻守护进程。
