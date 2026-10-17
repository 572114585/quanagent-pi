import { join } from "node:path";
import { type JsonValue, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SessionShutdownEvent,
} from "../../core/extensions/types.ts";
import type { ScheduleHost } from "../../core/schedule/host.ts";
import { ScheduleOutbox } from "../../core/schedule/outbox.ts";
import { DEFAULT_SCHEDULE_TIME_ZONE } from "../../core/schedule/rules.ts";
import type { ScheduleBinding, ScheduleTask, ScheduleTimingInput } from "../../core/schedule/types.ts";

const timing = {
	after_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
	at: Type.Optional(Type.String({ description: "Future RFC 3339 time with seconds and UTC offset." })),
	every_seconds: Type.Optional(Type.Integer({ minimum: 60 })),
	daily: Type.Optional(Type.Object({ time: Type.String(), time_zone: Type.String() })),
	weekly: Type.Optional(
		Type.Object({
			time: Type.String(),
			time_zone: Type.String(),
			weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 })),
		}),
	),
	cron: Type.Optional(Type.Object({ expression: Type.String(), time_zone: Type.String() })),
};

export interface ScheduleExtensionOptions {
	/** Background instances expose only queries and clock context. */
	background?: boolean;
	timeZone?: string;
	ownerId?: string;
	agentDir?: string;
	/** The host provides the current session and identity, not the model. */
	getSession?(ctx: ExtensionContext): AgentSession | undefined;
	getBinding?(ctx: ExtensionContext): ScheduleBinding;
	/** The CLI disables execution in print/json/RPC and metadata-only invocations. */
	isEnabled?(ctx: ExtensionContext): boolean;
	/** Host opt-in: add registered scheduling tools to a restored conversation's loadout. */
	activateToolsOnStart?: boolean;
	beforeStart?(): Promise<void>;
	onShutdown?(ctx: ExtensionContext, event: SessionShutdownEvent): void;
	ui?: boolean;
	outbox?: ScheduleOutbox;
}

function output(value: unknown) {
	const text = JSON.stringify(value);
	const json = JSON.parse(text) as JsonValue;
	return { content: [{ type: "text" as const, text }], details: value, structuredContent: { value: json } };
}

function selectTiming(input: ScheduleTimingInput): ScheduleTimingInput | undefined {
	const result = Object.fromEntries(
		Object.entries(input).filter(([key, value]) => key in timing && value !== undefined),
	);
	return Object.keys(result).length ? result : undefined;
}

/** Registers only capabilities during discovery; the owning host starts at session_start. */
export function createScheduleExtension(host?: ScheduleHost, options: ScheduleExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		let detach: (() => void) | undefined;
		let unlisten: (() => void) | undefined;
		const ownerId = options.ownerId ?? "local";
		const toolNames = new Set<string>();
		const outbox = options.outbox ?? new ScheduleOutbox(join(getAgentDir(), "schedule-delivery"));
		const service = (ctx: ExtensionContext): ScheduleHost => {
			if (!host || options.isEnabled?.(ctx) === false)
				throw new Error("Scheduling is available in an enabled persistent pi host, not this invocation.");
			return host;
		};
		const binding = (ctx: ExtensionContext, notify?: "local" | "weixin"): ScheduleBinding => {
			const given = options.getBinding?.(ctx);
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Scheduling requires a persisted session.");
			const result: ScheduleBinding = given ?? {
				ownerId,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile,
				cwd: ctx.cwd,
				agentDir: options.agentDir ?? getAgentDir(),
				delivery: { channel: "local" },
			};
			if (notify === "weixin" && result.delivery.channel === "local") {
				const target = service(ctx).getWeixinBinding();
				if (!target) throw new Error("Bind your Weixin account first with /schedule bind-weixin.");
				result.delivery = { channel: "weixin", ...target };
			}
			// A bridge-supplied recipient cannot be replaced by model input.
			return result;
		};

		pi.on("session_start", async (_event, ctx) => {
			if (!host || options.isEnabled?.(ctx) === false) return;
			if (options.background) {
				pi.setActiveTools([...new Set([...pi.getActiveTools(), "schedule_list", "schedule_history"])]);
				return;
			}
			await options.beforeStart?.();
			if (options.activateToolsOnStart) {
				const available = new Set(pi.getAllTools().map((tool) => tool.name));
				pi.setActiveTools([
					...new Set([...pi.getActiveTools(), ...[...toolNames].filter((name) => available.has(name))]),
				]);
			}
			detach?.();
			unlisten?.();
			const session = options.getSession?.(ctx);
			if (session) detach = host.attach(session);
			try {
				await host.start();
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (options.ui !== false && ctx.mode === "tui")
				unlisten = host.onResult((run) => {
					if (run.binding.ownerId === ownerId) {
						ctx.ui.notify(
							`Schedule: ${run.title} (${run.status}). Open /schedule for the result.`,
							run.status === "succeeded" ? "info" : "warning",
						);
					}
				});
		});
		pi.on("session_shutdown", (event, ctx) => {
			detach?.();
			unlisten?.();
			detach = undefined;
			unlisten = undefined;
			options.onShutdown?.(ctx, event);
		});
		pi.on("before_agent_start", (_event, ctx) => {
			if (!host || options.isEnabled?.(ctx) === false) return;
			return {
				message: {
					customType: "schedule-clock",
					content: `Current time: ${new Date().toISOString()}. Effective time zone: ${options.timeZone ?? DEFAULT_SCHEDULE_TIME_ZONE}. ${options.background ? "This is an independent background task. Only schedule_list and schedule_history are available; do not create, edit, rerun or resend schedules." : "Use native schedule_* tools; never substitute Windows Task Scheduler, schtasks, cron, background scripts or sleeping processes. Tasks execute in separate background conversations using completed source context; results appear in history and notifications, not the source chat. Only report creation after a persisted task ID. If already queued or running, report its history state; do not run duplicate work. A confirmation reply failure after persistence does not mean creation failed."}`,
					display: false,
				},
			};
		});

		const common = {
			namespace: {
				name: "schedule",
				description: "Persistent work executed in independent background conversations.",
			},
			executionMode: "sequential" as const,
			outputSchema: Type.Object({ value: Type.Unknown() }),
			promptGuidelines: [
				"Use the native schedule_* tools for scheduled agent work. Report the saved task ID and nextAt only after creation succeeds; never substitute an operating-system scheduler.",
			],
		};
		if (!options.background)
			pi.registerTool({
				...common,
				name: "schedule_create",
				label: "Create scheduled task",
				description:
					"Create an independent background task using the completed context of this conversation. Supply exactly one timing selector. The host must stay running. Results are saved in schedule_history, not written into this chat. Persistence also queues a creation receipt, independently of your confirmation reply.",
				parameters: Type.Object({
					title: Type.String({ minLength: 1, maxLength: 120 }),
					prompt: Type.String({ minLength: 1 }),
					...timing,
					notify: Type.Optional(StringEnum(["local", "weixin"] as const)),
				}),
				async execute(_id, args, signal, _update, ctx) {
					signal?.throwIfAborted();
					return output(await service(ctx).create(binding(ctx, args.notify), args));
				},
			});
		pi.registerTool({
			...common,
			name: "schedule_list",
			label: "List scheduled tasks",
			description:
				"List this user's tasks with separate schedule, latest execution and delivery states. A completed one-shot schedule only means it was triggered. Report existing queued/running work instead of duplicating it.",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			async execute(_id, _args, _signal, _update, ctx) {
				return output(await service(ctx).list(binding(ctx).ownerId));
			},
		});
		if (!options.background)
			pi.registerTool({
				...common,
				name: "schedule_update",
				label: "Update scheduled task",
				description:
					"Edit a task or pause/resume it. Timing updates accept exactly one selector. Paused periods are not caught up. Use expected_revision to reject concurrent changes.",
				parameters: Type.Object({
					id: Type.String(),
					title: Type.Optional(Type.String()),
					prompt: Type.Optional(Type.String()),
					paused: Type.Optional(Type.Boolean()),
					expected_revision: Type.Optional(Type.Integer()),
					...timing,
				}),
				async execute(_id, args, signal, _update, ctx) {
					signal?.throwIfAborted();
					return output(
						await service(ctx).update(binding(ctx).ownerId, args.id, {
							title: args.title,
							prompt: args.prompt,
							paused: args.paused,
							expectedRevision: args.expected_revision,
							timing: selectTiming(args),
						}),
					);
				},
			});
		if (!options.background)
			pi.registerTool({
				...common,
				name: "schedule_delete",
				label: "Delete scheduled task",
				description:
					"Delete a task and cancel work that has not started. Running work and its saved output are retained.",
				parameters: Type.Object({ id: Type.String() }),
				async execute(_id, args, signal, _update, ctx) {
					signal?.throwIfAborted();
					await service(ctx).delete(binding(ctx).ownerId, args.id);
					return output({ deleted: true, id: args.id });
				},
			});
		pi.registerTool({
			...common,
			name: "schedule_history",
			label: "Scheduled task history",
			description: "Read execution results, errors and delivery state for this user's tasks.",
			parameters: Type.Object({ task_id: Type.Optional(Type.String()) }),
			annotations: { readOnlyHint: true },
			async execute(_id, args, _signal, _update, ctx) {
				return output(await service(ctx).history(binding(ctx).ownerId, args.task_id));
			},
		});
		if (!options.background)
			pi.registerTool({
				...common,
				name: "schedule_run",
				label: "Run scheduled task",
				description:
					"Explicitly queue one run of a saved task without changing its recurring schedule. Never call automatically to retry a failed execution.",
				parameters: Type.Object({ id: Type.String() }),
				async execute(_id, args, signal, _update, ctx) {
					signal?.throwIfAborted();
					return output(await service(ctx).run(binding(ctx).ownerId, args.id));
				},
			});
		if (!options.background)
			pi.registerTool({
				...common,
				name: "schedule_resend",
				label: "Resend scheduled result",
				description: "Resend a saved run's output without executing its instruction or calling a model again.",
				parameters: Type.Object({ run_id: Type.String() }),
				async execute(_id, args, signal, _update, ctx) {
					signal?.throwIfAborted();
					await service(ctx).resend(binding(ctx).ownerId, args.run_id);
					return output({ requested: true });
				},
			});
		for (const name of [
			"schedule_create",
			"schedule_list",
			"schedule_update",
			"schedule_delete",
			"schedule_history",
			"schedule_run",
			"schedule_resend",
		])
			if (!options.background || name === "schedule_list" || name === "schedule_history") toolNames.add(name);

		if (options.ui !== false && !options.background)
			pi.registerCommand("schedule", {
				description: "Manage scheduled tasks, execution history and Weixin binding",
				handler: async (args, ctx) => {
					const current = service(ctx);
					await current.start();
					const [action, id] = args.trim().split(/\s+/);
					if (action === "bind-weixin") {
						const choices = await outbox.bindings();
						const chosen =
							id ??
							(await ctx.ui.select(
								"Bind Weixin owner account",
								choices.map((item) => item.bindingId),
							));
						if (!chosen) return;
						const target = choices.find((item) => item.bindingId === chosen);
						if (!target) throw new Error("Registered bridge not found. Start the Weixin bridge first.");
						await current.bindWeixin(target.bindingId, target.ownerId);
						ctx.ui.notify("Weixin owner account bound. Use notify=weixin when creating a task.", "info");
						return;
					}
					const actor = binding(ctx).ownerId;
					if (action === "log" && id) {
						ctx.ui.notify(await current.readLog(actor, id), "info");
						return;
					}
					if (id && ["pause", "resume", "delete", "run", "resend", "history", "show", "edit"].includes(action!)) {
						if (action === "pause" || action === "resume")
							await current.update(actor, id, { paused: action === "pause" });
						else if (action === "delete") await current.delete(actor, id);
						else if (action === "run") await current.run(actor, id);
						else if (action === "resend") await current.resend(actor, id);
						else if (action === "history")
							ctx.ui.notify(JSON.stringify(await current.history(actor, id), null, 2), "info");
						else {
							const task = (await current.list(actor)).find((item) => item.id === id);
							if (!task) throw new Error("Task not found.");
							await showTask(current, actor, task, ctx);
						}
						return;
					}
					const tasks = await current.list(actor);
					if (!tasks.length) {
						ctx.ui.notify("No scheduled tasks. Ask the agent to create one.", "info");
						return;
					}
					const history = await current.history(actor);
					const labels = tasks.map((task) => {
						const latest = history.find((run) => run.taskId === task.id);
						return `${task.title} [schedule: ${task.status}; run: ${latest?.status ?? "not triggered"}; delivery: ${latest?.delivery ?? "none"}] ${task.nextAt ?? ""} (${task.id})`;
					});
					const chosen = await ctx.ui.select("Scheduled tasks", labels);
					const task = tasks[labels.indexOf(chosen ?? "")];
					if (task) await showTask(current, actor, task, ctx);
				},
			});
	};
}

async function showTask(
	host: ScheduleHost,
	ownerId: string,
	task: ScheduleTask,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const latest = (await host.history(ownerId, task.id))[0];
	const action = await ctx.ui.select(
		`${task.title}\n${task.prompt}\n${JSON.stringify(task.rule)}\nNext: ${task.nextAt ?? "none"}\nLatest run: ${latest?.status ?? "not triggered"}; delivery: ${latest?.delivery ?? "none"}`,
		[
			"History",
			"Edit title",
			"Edit instruction",
			"Edit timing",
			task.status === "paused" ? "Resume" : "Pause",
			"Run now",
			"Resend result",
			"Delete",
		],
	);
	if (action === "History") {
		ctx.ui.notify(JSON.stringify(await host.history(ownerId, task.id), null, 2), "info");
		return;
	}
	if (action === "Run now") {
		await host.run(ownerId, task.id);
		return;
	}
	if (action === "Resend result") {
		const runs = (await host.history(ownerId, task.id)).filter((run) =>
			["succeeded", "failed", "interrupted"].includes(run.status),
		);
		const id = await ctx.ui.select(
			"Choose saved result",
			runs.map((run) => run.id),
		);
		if (id) await host.resend(ownerId, id);
		return;
	}
	if (action === "Delete") {
		if (await ctx.ui.confirm("Delete scheduled task?", task.title)) await host.delete(ownerId, task.id);
		return;
	}
	if (action === "Pause" || action === "Resume") {
		await host.update(ownerId, task.id, { paused: action === "Pause", expectedRevision: task.revision });
		return;
	}
	if (action === "Edit title" || action === "Edit instruction") {
		const value = await ctx.ui.input(action, action === "Edit title" ? task.title : task.prompt);
		if (value !== undefined)
			await host.update(ownerId, task.id, {
				expectedRevision: task.revision,
				...(action === "Edit title" ? { title: value } : { prompt: value }),
			});
	} else if (action === "Edit timing") {
		const value = await ctx.ui.editor(
			"Timing selector JSON (one of after_seconds, at, every_seconds, daily, weekly, cron)",
			JSON.stringify(taskTiming(task), null, 2),
		);
		if (value !== undefined) {
			const parsed: unknown = JSON.parse(value);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error("Expected one timing selector object.");
			await host.update(ownerId, task.id, {
				expectedRevision: task.revision,
				timing: parsed as ScheduleTimingInput,
			});
		}
	}
}

function taskTiming(task: ScheduleTask): ScheduleTimingInput {
	const rule = task.rule;
	if (rule.kind === "after" || rule.kind === "at") return { at: rule.at };
	if (rule.kind === "every") return { every_seconds: rule.seconds };
	if (rule.kind === "daily") return { daily: { time: rule.time, time_zone: rule.timeZone } };
	if (rule.kind === "weekly")
		return { weekly: { time: rule.time, time_zone: rule.timeZone, weekdays: rule.weekdays } };
	return { cron: { expression: rule.expression, time_zone: rule.timeZone } };
}

// Metadata discovery loads this without constructing a running host. main() supplies its host factory.
export default createScheduleExtension();
