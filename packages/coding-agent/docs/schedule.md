# Scheduled tasks

The built-in `schedule` extension runs saved instructions in independent background conversations while the interactive pi process stays open. Each execution snapshots the original conversation's latest completed context. Switching conversations does not stop scheduling. Closing pi stops it; a later interactive startup catches up only the latest missed occurrence of each task.

Ask pi to create a task, for example: “Every day at 09:00 Shanghai time, review this project's open work.” Open `/schedule` to inspect tasks, edit their instructions or timing, pause/resume, delete, view execution history, run now, or resend a saved result. Disable the built-in extension with `pi config`. Disabling preserves its data and stops the host. Help, configuration, print, JSON, and RPC invocations do not run saved tasks.

## Timing

`schedule_create` requires a title, instruction (`prompt`), and exactly one selector:

| Selector | Example |
| --- | --- |
| Delay | `"after_seconds": 600` |
| Absolute time | `"at": "2099-01-01T09:00:00+08:00"` |
| Fixed interval | `"every_seconds": 300` |
| Daily | `"daily": {"time":"09:00", "time_zone":"Asia/Shanghai"}` |
| Weekly | `"weekly": {"time":"09:00", "time_zone":"Asia/Shanghai", "weekdays":[1,5]}` |
| Cron | `"cron": {"expression":"*/15 9-17 * * 1-5", "time_zone":"Asia/Shanghai"}` |

Unqualified requests use `Asia/Shanghai`. Daily, weekly, and cron tools require an explicit IANA time zone. Absolute times require seconds and a UTC offset and must be in the future. Fixed intervals are at least 60 whole seconds and retain their creation anchor. Weekdays are ISO Monday `1` through Sunday `7`.

Cron has five numeric fields: minute, hour, day of month, month, weekday. It accepts `*`, lists, ranges, and steps on stars or ranges; Sunday is `0` or `7`. Names, macros, seconds fields, `L`, `W`, and `#` are rejected. When either day field starts with `*`, both day fields must match; otherwise either may match. Missing daylight-saving times are skipped; repeated local times run only at the earlier instant.

## Execution and recovery

Tasks never wait for the original conversation's chat queue. Each execution creates a separate `AgentSession`, ID, and log using the latest completed rounds on the source's current branch. Unfinished and abandoned rounds and their tool calls are excluded. Valid compaction, context edits, and tool configuration are retained. An unfinished first conversation supplies no conversation context; the saved instruction still runs. Active sources are copied from memory; cold files are read without creating another writer.

The original session, selected branch, UI, and Weixin session mapping are unchanged. Results go only to notifications and task history; ask `schedule_history` when following up. Missing files, changed identities or workspaces, unavailable models, resource failures, or interactive confirmations produce a failed run. Background extensions expose clock context, `schedule_list`, and `schedule_history`; scheduling mutations are unavailable even through nested tool calls.

The host allows at most four background executions, with one per Weixin user and one per task. A task retains at most one automatic trigger waiting to start; missed triggers merge into the latest one. Terminal tasks use the global limit. The model service still shares its available capacity with other requests.

Executions time out after 60 minutes by default. Set `"schedule": {"runTimeoutMinutes": 60}` in terminal settings or bridge `config.json` and restart the host to change it (whole minutes, 1–35791). SDK embedders use `runTimeoutMs`. A timeout records and notifies failure before aborting the background instance. Its execution slot remains occupied until resources have actually settled. Main chat is not cancelled, and failures never rerun automatically.

The original working directory and tool permissions are shared. Default generated artifacts belong in `.pi/schedule-artifacts/<taskId>/<runId>/` under that directory. The task may modify the project when instructed; artifact directories do not restrict shell permissions. Built-in file mutations retain their shared write queue.

Execution states are queued, running, succeeded, failed, interrupted, and cancelled. Failed and interrupted runs require an explicit manual run. A crash during execution marks that run interrupted on restart. Paused periods are never caught up; resuming a recurring task chooses its next future occurrence. An expired one-shot must be rescheduled or run manually. Manual runs do not move a recurring schedule. Deleting a task cancels future and queued work while retaining running work and saved results.

Use `schedule_list`, `schedule_update`, `schedule_delete`, `schedule_history`, `schedule_run`, and `schedule_resend` through the agent. CLI shortcuts include `/schedule history <task-id>`, `/schedule log <run-id>` (read-only), `/schedule pause <task-id>`, `/schedule resume <task-id>`, `/schedule run <task-id>`, and `/schedule resend <run-id>`. The list distinguishes the rule's completed status from the latest execution and delivery status. A triggered one-shot is not necessarily a successful execution. Already queued or running tasks should be reported from history, not duplicated. Resending uses saved output and makes no model call.

## Weixin delivery

Start the updated local Weixin bridge and use `/schedule bind-weixin` to select its configured owner account. Ask pi to create a task with Weixin notification (`notify: "weixin"`). Terminal tasks otherwise display locally. Tasks created in Weixin always return to their creator; tools cannot choose arbitrary users.

Saving a task also saves its creation receipt in the same transaction. The receipt contains its ID, occurrence, time zone, and independent background execution mode. It enters the durable sending queue without waiting for a model confirmation reply. A subsequent confirmation timeout does not mean the task failed to be created. Creation receipts and run results have distinct stable notification IDs.

Both processes use `<agent-dir>/schedule-delivery` as a durable local outbox. The bridge owns login credentials and sends saved text and generated files. Individual text chunks and files have independent progress records. Network failures retry after 1, 5, and 15 minutes; output remains pending afterwards. Startup, login recovery, a new message from that user, or a manual resend retries pending output. Missing Weixin conversation context waits for a fresh user message. A crash after Weixin accepted a message but before its acknowledgment was saved can duplicate that part.

## Storage and embedding

Interactive pi stores version 2 task and run state in `<agent-dir>/schedule/state.json`. Version 1 state migrates under the exclusive lock after validation and backup. Existing IDs, rules, pause states, histories, and sending progress are preserved. Old tasks receive no retroactive creation receipt. Completed runs never execute again; queued runs prepare a new background snapshot; unknown started runs become interrupted.

A single `proper-lockfile` lock owns the directory. A second host fails explicitly. Writes serialize through temporary files and atomic replacement; invalid state stops scheduling and leaves the original file untouched. Snapshots and logs persist before the run is marked started and before any model call. The single timer rechecks wall time at least once a minute, including during long waits.

Logs live in `<schedule-storage>/executions/<runId>/session.jsonl`, outside the normal session list. History records source identity, snapshot boundary, background identity, log, and artifact paths. Running logs cannot be opened through the runtime as another writable session. Execution history retains 30 days and at most 200 completed records per task; active workers and pending delivery are exempt. Cleanup verifies exact per-run paths and scheduler ownership metadata before removing its log and artifact directories.

SDK exports include `createScheduleHost`, `createScheduleExtension`, `createScheduleExecutionSession`, `ScheduleOutbox`, `ScheduleExecution`, and `ScheduleNotification`. Replace the previous `resolveSession(binding, signal)` and foreground queue adapter with `createExecutionSession(run, signal)`. It must return a separate persisted session plus its execution metadata and cleanup callback. The helper handles read-only snapshots and SDK initialization; the embedding host authorizes the saved owner and supplies the shared model runtime, resources, and tool restrictions. Background resource loaders use `createScheduleExtension(host, {background: true, getBinding: () => run.binding, ...})`.

Supply `deliverNotification` and call `ScheduleOutbox.enqueueNotification(notification, resend)` for both receipt and result delivery. The outbox migrates version 1 result records with backup under an item lock and preserves per-part acknowledgments. Attach active sources for snapshot boundaries, use `reserveSessionFile` only to guard explicit opens of active background logs, and close the host on process disposal or disable. `AgentSessionRuntime` accepts `hostLifecycle` callbacks for opening and shutdown. Session switches, collection, and extension reloads do not cancel background work. SDK users explicitly install the extension; discovery alone does not start a scheduler.

When a host adds scheduling to existing conversations, pass `activateToolsOnStart: true` to `createScheduleExtension`. Old transcripts restore their previous active tools, which may predate `schedule_*`. This option activates only registered scheduling tools and respects SDK allowlists and denylists. The CLI enables it for the default tool selection; the Weixin bridge enables it explicitly. Requests use native tools and report a persisted task ID on success; an unavailable scheduler must be reported as a failure rather than replaced with an OS task.

The implementation references the host ownership, six selectors, and Vixie timing semantics of [DeepSeek Harness Schedule](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/schedule/schedule). The Temporal implementation is local; upstream attribution and its MIT license are preserved in [Schedule attribution](schedule-notice.md).
