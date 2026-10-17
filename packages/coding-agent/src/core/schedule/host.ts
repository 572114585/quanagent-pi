import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSession } from "../agent-session.ts";
import { cleanupScheduleExecution } from "./files.ts";
import { createScheduleRule, DEFAULT_SCHEDULE_TIME_ZONE, scheduleOccurrence } from "./rules.ts";
import { ScheduleExecutionPreparationError, trackScheduleSource } from "./sessions.ts";
import { ScheduleStore } from "./store.ts";
import type {
	ScheduleBinding,
	ScheduleHostOptions,
	ScheduleRun,
	ScheduleState,
	ScheduleTask,
	ScheduleTaskSummary,
	ScheduleTimingInput,
} from "./types.ts";

// Re-sample wall time even for distant targets so clock corrections cannot strand a task.
const MAX_TIMER_DELAY = 60_000;
const TERMINAL_RUNS = new Set(["succeeded", "failed", "interrupted", "cancelled"]);

function sessionPathKey(file: string): string {
	const path = resolve(file);
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function taskFor(state: ScheduleState, ownerId: string, id: string): ScheduleTask {
	const task = state.tasks.find((item) => item.id === id && item.binding.ownerId === ownerId);
	if (!task) throw new Error("Task not found for this user.");
	return task;
}

function required(value: string, name: string, maximum = Number.MAX_SAFE_INTEGER): string {
	const result = value.trim();
	if (!result || result.length > maximum)
		throw new Error(`${name} must be non-empty and at most ${maximum} characters.`);
	return result;
}

export interface ScheduleTaskUpdate {
	title?: string;
	prompt?: string;
	timing?: ScheduleTimingInput;
	paused?: boolean;
	expectedRevision?: number;
}

/** Process-owned scheduler. Extension reloads and session switches do not own it. */
export class ScheduleHost {
	private readonly options: ScheduleHostOptions;
	private readonly store: ScheduleStore;
	private readonly clock: () => number;
	private readonly attached = new Map<string, { session: AgentSession; unsubscribe: () => void }>();
	private readonly workers = new Map<
		string,
		{ promise: Promise<void>; controller: AbortController; session?: AgentSession; ownerId: string; runId: string }
	>();
	private readonly listeners = new Set<(run: ScheduleRun) => void>();
	private timer?: ReturnType<typeof setTimeout>;
	private started = false;
	private starting?: Promise<void>;
	private stopped = false;
	private drive?: Promise<void>;
	private requested = false;
	private deliveryAt = 0;
	private failure?: Error;

	constructor(options: ScheduleHostOptions) {
		this.options = options;
		this.clock = options.clock ?? Date.now;
		if (
			options.concurrency !== undefined &&
			(!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4)
		)
			throw new Error("Concurrency must be an integer from 1 to 4.");
		if (
			options.ownerConcurrency !== undefined &&
			(!Number.isInteger(options.ownerConcurrency) || options.ownerConcurrency < 1)
		)
			throw new Error("Owner concurrency must be positive.");
		if (
			options.runTimeoutMs !== undefined &&
			(!Number.isSafeInteger(options.runTimeoutMs) ||
				options.runTimeoutMs < 1 ||
				options.runTimeoutMs > 2_147_483_647)
		)
			throw new Error("Run timeout must be a positive millisecond duration within the platform timer limit.");
		this.store = new ScheduleStore(options.storageDir, (error) => this.fail(error));
	}

	get isStarted(): boolean {
		return this.started;
	}

	async start(): Promise<void> {
		if (this.failure) throw this.failure;
		if (this.started) return;
		if (this.starting) return this.starting;
		this.stopped = false;
		this.starting = (async () => {
			await this.store.start();
			try {
				if (this.store.state.runs.some((run) => run.status === "running")) {
					await this.store.transact((state) => {
						for (const run of state.runs)
							if (run.status === "running") {
								run.status = "interrupted";
								run.error = "The host stopped before this execution completed. Rerun explicitly.";
								run.finishedAt = new Date(this.clock()).toISOString();
							}
					});
				}
				this.started = true;
				await this.pruneHistory();
				this.wake();
			} catch (error) {
				await this.store.close();
				throw error;
			}
		})();
		try {
			await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	/** Stop admission before awaiting work; abort only runs this scheduler owns. */
	async close(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.starting) await this.starting.catch(() => {});
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		await this.drive;
		for (const worker of this.workers.values()) {
			worker.controller.abort();
			if (worker.session) await worker.session.abort();
		}
		await Promise.all([...this.workers.values()].map((worker) => worker.promise));
		await this.store.close();
		this.started = false;
	}

	attach(session: AgentSession): () => void {
		const existing = this.attached.get(session.sessionId);
		if (existing && existing.session !== session) throw new Error("Another runtime already owns this session.");
		if (existing) return () => this.detach(session);
		const unsubscribe = trackScheduleSource(session);
		this.attached.set(session.sessionId, { session, unsubscribe });
		this.wake();
		return () => this.detach(session);
	}

	detach(session: AgentSession): void {
		const entry = this.attached.get(session.sessionId);
		if (entry?.session !== session) return;
		entry.unsubscribe();
		this.attached.delete(session.sessionId);
		this.wake();
	}

	onResult(listener: (run: ScheduleRun) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Background logs may be inspected read-only, never opened as a second writable session. */
	async reserveSessionFile(file: string): Promise<() => void> {
		const path = sessionPathKey(file);
		if (
			[...this.workers.values()].some(
				(worker) =>
					sessionPathKey(join(this.options.storageDir, "executions", worker.runId, "session.jsonl")) === path,
			) ||
			this.store.state.runs.some(
				(run) =>
					run.execution && sessionPathKey(run.execution.sessionFile) === path && this.workers.has(run.taskId),
			)
		)
			throw new Error(
				"This background log is still owned by the scheduler. View it read-only through /schedule history.",
			);
		return () => {};
	}

	async list(ownerId: string): Promise<ScheduleTaskSummary[]> {
		await this.ensureStarted();
		return structuredClone(
			this.store.state.tasks
				.filter((task) => task.binding.ownerId === ownerId)
				.map((task) => {
					const latest = this.store.state.runs.findLast(
						(run) => run.taskId === task.id && run.binding.ownerId === ownerId,
					);
					return {
						...task,
						latestRun: latest
							? {
									id: latest.id,
									status: latest.status,
									delivery: latest.delivery,
									startedAt: latest.startedAt,
									finishedAt: latest.finishedAt,
									error: latest.error,
								}
							: undefined,
					};
				}),
		);
	}

	async readLog(ownerId: string, runId: string): Promise<string> {
		await this.ensureStarted();
		const run = this.store.state.runs.find((item) => item.id === runId && item.binding.ownerId === ownerId);
		if (
			!run?.execution ||
			!/^[\w-]+$/.test(run.id) ||
			sessionPathKey(run.execution.sessionFile) !==
				sessionPathKey(join(this.options.storageDir, "executions", run.id, "session.jsonl"))
		)
			throw new Error("Background log not found for this user.");
		return readFile(run.execution.sessionFile, "utf8");
	}

	async history(ownerId: string, taskId?: string): Promise<ScheduleRun[]> {
		await this.ensureStarted();
		await this.pruneHistory();
		return structuredClone(
			this.store.state.runs
				.filter((run) => run.binding.ownerId === ownerId && (!taskId || run.taskId === taskId))
				.toReversed(),
		);
	}

	async create(
		binding: ScheduleBinding,
		input: ScheduleTimingInput & { title: string; prompt: string },
	): Promise<ScheduleTask> {
		await this.ensureStarted();
		if (!existsSync(binding.sessionFile))
			throw new Error("A scheduled task requires an existing persisted conversation.");
		const now = this.clock();
		const rule = createScheduleRule(input, now);
		const nextAt = scheduleOccurrence(rule, now, 1);
		if (!nextAt) throw new Error("This rule has no future occurrence.");
		const task: ScheduleTask = {
			id: randomUUID(),
			revision: 1,
			title: required(input.title, "Title", 120),
			prompt: required(input.prompt, "Instruction"),
			rule,
			binding: structuredClone(binding),
			nextAt,
			status: "active",
			createdAt: new Date(now).toISOString(),
		};
		const source = this.attached.get(binding.sessionId)?.session;
		if (source) task.binding.toolNames = source.getCallableToolNames();
		await this.store.transact((state) => {
			state.tasks.push(task);
			state.creationNotices.push({
				kind: "task-created",
				id: `task-created-${task.id}`,
				taskId: task.id,
				title: task.title,
				binding: structuredClone(binding),
				createdAt: task.createdAt,
				nextAt,
				timeZone: "timeZone" in rule ? rule.timeZone : DEFAULT_SCHEDULE_TIME_ZONE,
				delivery: "pending",
			});
		});
		this.deliveryAt = 0;
		this.wake();
		return structuredClone(task);
	}

	async update(ownerId: string, id: string, update: ScheduleTaskUpdate): Promise<ScheduleTask> {
		await this.ensureStarted();
		const result = await this.store.transact((state) => {
			const task = taskFor(state, ownerId, id);
			if (update.expectedRevision !== undefined && update.expectedRevision !== task.revision)
				throw new Error("Task changed. Reload before saving.");
			if (update.title !== undefined) task.title = required(update.title, "Title", 120);
			if (update.prompt !== undefined) task.prompt = required(update.prompt, "Instruction");
			if (update.timing) {
				const rule = createScheduleRule(update.timing, this.clock());
				const sameInterval =
					rule.kind === "every" && task.rule.kind === "every" && rule.seconds === task.rule.seconds;
				if (!sameInterval && JSON.stringify(rule) !== JSON.stringify(task.rule)) {
					task.rule = rule;
					task.nextAt = scheduleOccurrence(rule, this.clock(), 1);
					if (!task.nextAt) throw new Error("This rule has no future occurrence.");
					if (task.status === "completed") task.status = "active";
				}
			}
			if (update.paused === true) {
				task.status = "paused";
				for (const run of state.runs)
					if (run.taskId === id && run.status === "queued") {
						run.status = "cancelled";
						run.delivery = "sent";
					}
			} else if (update.paused === false && task.status !== "active") {
				task.nextAt = scheduleOccurrence(task.rule, this.clock(), 1);
				if (!task.nextAt) throw new Error("Reschedule this expired one-shot task or run it manually.");
				task.status = "active";
			}
			task.revision++;
			return task;
		});
		this.wake();
		return result;
	}

	async delete(ownerId: string, id: string): Promise<void> {
		await this.ensureStarted();
		await this.store.transact((state) => {
			taskFor(state, ownerId, id);
			state.tasks = state.tasks.filter((task) => task.id !== id);
			for (const run of state.runs)
				if (run.taskId === id && run.status === "queued") {
					run.status = "cancelled";
					run.delivery = "sent";
				}
		});
		this.wake();
	}

	async run(ownerId: string, id: string): Promise<ScheduleRun> {
		await this.ensureStarted();
		const result = await this.store.transact((state) => {
			const task = taskFor(state, ownerId, id);
			if (
				state.runs.some((run) => run.taskId === id && (run.status === "queued" || run.status === "running")) ||
				this.workers.has(id)
			)
				throw new Error(
					"This task is already queued or executing. Read its history instead of duplicating the work.",
				);
			const run = this.newRun(task, new Date(this.clock()).toISOString(), true);
			state.runs.push(run);
			return run;
		});
		this.wake();
		return result;
	}

	async resend(ownerId: string, runId: string): Promise<void> {
		await this.ensureStarted();
		const run = this.store.state.runs.find((item) => item.id === runId && item.binding.ownerId === ownerId);
		if (!run || !TERMINAL_RUNS.has(run.status) || run.status === "cancelled")
			throw new Error("Completed run not found.");
		await this.deliver(run, true);
	}

	async bindWeixin(bindingId: string, userId: string): Promise<void> {
		await this.ensureStarted();
		await this.store.transact((state) => {
			state.weixinBinding = { bindingId: required(bindingId, "Binding"), userId: required(userId, "User") };
		});
	}

	getWeixinBinding(): { bindingId: string; userId: string } | undefined {
		return structuredClone(this.store.state.weixinBinding);
	}

	/** Exposed for clocks controlled by embedders and offline tests. */
	async tick(): Promise<void> {
		await this.ensureStarted();
		this.wake();
		await this.drive;
	}

	async waitForIdle(): Promise<void> {
		do {
			await this.drive;
			await Promise.all([...this.workers.values()].map((worker) => worker.promise));
		} while (this.drive || this.workers.size);
	}

	private async ensureStarted(): Promise<void> {
		if (this.failure) throw this.failure;
		if (this.stopped) throw new Error("Schedule host is stopped.");
		await this.start();
	}

	private fail(error: Error): void {
		this.failure = error;
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		for (const worker of this.workers.values()) {
			worker.controller.abort();
			void worker.session?.abort();
		}
		this.options.onError?.(error);
	}

	private wake(): void {
		if (!this.started || this.stopped) return;
		this.requested = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.drive) return;
		this.drive = (async () => {
			while (this.requested && !this.stopped) {
				this.requested = false;
				await this.admitDue();
				await this.pruneHistory();
				this.launch();
				if (this.deliveryAt <= this.clock()) {
					this.deliveryAt = this.clock() + 60_000;
					for (const notice of this.store.state.creationNotices.filter((item) => item.delivery === "pending")) {
						try {
							if (notice.binding.delivery.channel === "weixin" && !this.options.deliverNotification)
								throw new Error("No creation receipt adapter is configured.");
							const status = await this.options.deliverNotification?.(structuredClone(notice));
							await this.store.transact((state) => {
								state.creationNotices = state.creationNotices.filter(
									(item) => item.id !== notice.id || status === "pending",
								);
							});
						} catch (error) {
							this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
						}
					}
					for (const run of this.store.state.runs.filter(
						(item) => item.delivery === "pending" && TERMINAL_RUNS.has(item.status),
					)) {
						await this.deliver(run).catch((error: unknown) =>
							this.options.onError?.(error instanceof Error ? error : new Error(String(error))),
						);
					}
				}
			}
		})()
			.catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))))
			.finally(() => {
				this.drive = undefined;
				if (this.requested) this.wake();
				else this.arm();
			});
	}

	private newRun(task: ScheduleTask, occurrenceAt: string, manual: boolean): ScheduleRun {
		return {
			id: randomUUID(),
			taskId: task.id,
			title: task.title,
			prompt: task.prompt,
			binding: structuredClone(task.binding),
			occurrenceAt,
			timeZone: "timeZone" in task.rule ? task.rule.timeZone : DEFAULT_SCHEDULE_TIME_ZONE,
			manual,
			status: "queued",
			delivery: "pending",
		};
	}

	private async admitDue(): Promise<void> {
		const now = this.clock();
		if (
			!this.store.state.tasks.some(
				(task) => task.status === "active" && task.nextAt && Date.parse(task.nextAt) <= now,
			)
		)
			return;
		await this.store.transact((state) => {
			for (const task of state.tasks) {
				if (task.status !== "active" || !task.nextAt || Date.parse(task.nextAt) > now) continue;
				const occurrence = scheduleOccurrence(task.rule, now, -1) ?? task.nextAt;
				const queued = state.runs.find((run) => run.taskId === task.id && run.status === "queued");
				if (queued) {
					if (!queued.manual) {
						queued.occurrenceAt = occurrence;
						queued.title = task.title;
						queued.prompt = task.prompt;
						queued.timeZone = "timeZone" in task.rule ? task.rule.timeZone : DEFAULT_SCHEDULE_TIME_ZONE;
					}
				} else state.runs.push(this.newRun(task, occurrence, false));
				task.nextAt = scheduleOccurrence(task.rule, now, 1);
				if (!task.nextAt) task.status = "completed";
				task.revision++;
			}
		});
	}

	private launch(): void {
		for (const run of this.store.state.runs) {
			if (this.workers.size >= (this.options.concurrency ?? 4)) break;
			if (
				run.status !== "queued" ||
				(!run.manual && Date.parse(run.occurrenceAt) > this.clock()) ||
				this.workers.has(run.taskId) ||
				(this.options.ownerConcurrency !== undefined &&
					[...this.workers.values()].filter((worker) => worker.ownerId === run.binding.ownerId).length >=
						this.options.ownerConcurrency)
			)
				continue;
			const controller = new AbortController();
			const worker = {
				controller,
				runId: run.id,
				ownerId: run.binding.ownerId,
				session: undefined as AgentSession | undefined,
				promise: Promise.resolve(),
			};
			this.workers.set(run.taskId, worker);
			worker.promise = Promise.resolve()
				.then(async () => {
					if (!controller.signal.aborted) await this.execute(run.id, controller, worker);
				})
				.catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))))
				.finally(() => {
					this.workers.delete(run.taskId);
					this.wake();
				});
		}
	}

	private async execute(id: string, controller: AbortController, worker: { session?: AgentSession }): Promise<void> {
		let run = this.store.state.runs.find((item) => item.id === id);
		if (!run || run.status !== "queued") return;
		let release: (() => Promise<void> | void) | undefined;
		let restoreUI: (() => void) | undefined;
		let timeoutWork: Promise<void> | undefined;
		const timeout = setTimeout(() => {
			timeoutWork = (async () => {
				try {
					await this.finish(
						id,
						"failed",
						undefined,
						`Background execution exceeded its ${this.options.runTimeoutMs ?? 3_600_000} ms time limit. Rerun explicitly.`,
					);
				} finally {
					controller.abort();
					await worker.session?.abort();
				}
			})();
			timeoutWork.catch((error: unknown) =>
				this.options.onError?.(error instanceof Error ? error : new Error(String(error))),
			);
		}, this.options.runTimeoutMs ?? 3_600_000);
		timeout.unref();
		try {
			controller.signal.throwIfAborted();
			const lease = await this.options.createExecutionSession(structuredClone(run), controller.signal);
			if (
				lease.session.sessionId === run.binding.sessionId ||
				sessionPathKey(lease.session.sessionFile ?? "") === sessionPathKey(run.binding.sessionFile) ||
				lease.execution.sessionId !== lease.session.sessionId ||
				lease.execution.sourceSessionId !== run.binding.sessionId ||
				sessionPathKey(lease.execution.sourceSessionFile) !== sessionPathKey(run.binding.sessionFile) ||
				sessionPathKey(lease.execution.sessionFile) !== sessionPathKey(lease.session.sessionFile ?? "") ||
				!existsSync(lease.execution.sessionFile)
			)
				throw new Error("Scheduled work requires a distinct, durably persisted background session.");
			release = lease.release;
			worker.session = lease.session;
			run = await this.store.transact((state) => {
				const current = state.runs.find((item) => item.id === id)!;
				current.execution = lease.execution;
				if (
					current.status !== "queued" ||
					controller.signal.aborted ||
					(!current.manual && Date.parse(current.occurrenceAt) > this.clock())
				)
					return current;
				current.status = "running";
				current.startedAt = new Date(this.clock()).toISOString();
				return current;
			});
			if (run.status !== "running") return;
			controller.signal.throwIfAborted();
			let answer: string | undefined;
			let modelError: string | undefined;
			let interactionError: string | undefined;
			const runner = lease.session.extensionRunner;
			if (runner.createContext().mode === "print") {
				const previousUI = runner.getUIContext();
				const unavailable = async (): Promise<never> => {
					interactionError =
						"Background execution requires interactive confirmation or input. Run this task interactively.";
					throw new Error(interactionError);
				};
				runner.setUIContext(
					{
						...previousUI,
						confirm: unavailable,
						select: unavailable,
						input: unavailable,
						editor: unavailable,
						custom: unavailable,
					},
					"print",
				);
				restoreUI = () => runner.setUIContext(previousUI, "print");
			}
			let settled = false;
			const unsubscribe = lease.session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					if (event.message.stopReason === "error" || event.message.stopReason === "aborted")
						modelError = event.message.errorMessage ?? event.message.stopReason;
					else {
						modelError = undefined;
						answer = event.message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("")
							.trim();
					}
				}
				if (event.type === "agent_settled") {
					settled = true;
					if (event.aborted) modelError = "Execution aborted.";
				}
			});
			try {
				await lease.session.prompt(
					`[SCHEDULE ${run.id}]\nTask: ${run.title}\nOccurrence: ${run.occurrenceAt}\nCurrent time: ${new Date(this.clock()).toISOString()}\nTime zone for this run: ${run.timeZone ?? DEFAULT_SCHEDULE_TIME_ZONE}\nDefault artifact directory: ${lease.execution.artifactDir}\nThis is an independent background execution. Return results here; do not modify the original conversation or create more scheduled work.\n\n${run.prompt}`,
					{ expandPromptTemplates: false, source: "extension" },
				);
				await lease.session.waitForIdle();
			} finally {
				unsubscribe();
			}
			controller.signal.throwIfAborted();
			if (interactionError || modelError || !settled || !answer)
				throw new Error(
					interactionError ?? modelError ?? "This execution produced no completed assistant response.",
				);
			await this.finish(id, "succeeded", answer);
		} catch (error) {
			if (error instanceof ScheduleExecutionPreparationError)
				await this.store.transact((state) => {
					const current = state.runs.find((item) => item.id === id);
					if (current) current.execution = error.execution;
				});
			const current = this.store.state.runs.find((item) => item.id === id);
			if (current?.status === "running" || (current?.status === "queued" && !controller.signal.aborted)) {
				await this.finish(
					id,
					controller.signal.aborted ? "interrupted" : "failed",
					undefined,
					error instanceof Error ? error.message : String(error),
				);
			}
		} finally {
			clearTimeout(timeout);
			try {
				await timeoutWork;
			} finally {
				restoreUI?.();
				await release?.();
			}
		}
	}

	private async finish(id: string, status: ScheduleRun["status"], result?: string, error?: string): Promise<void> {
		const finished = await this.store.transact((state) => {
			const run = state.runs.find((item) => item.id === id)!;
			if (TERMINAL_RUNS.has(run.status)) return undefined;
			run.status = status;
			run.result = result;
			run.error = error;
			run.finishedAt = new Date(this.clock()).toISOString();
			return run;
		});
		if (!finished) return;
		for (const listener of this.listeners) {
			try {
				listener(structuredClone(finished));
			} catch {}
		}
		await this.deliver(finished).catch((cause: unknown) =>
			this.options.onError?.(cause instanceof Error ? cause : new Error(String(cause))),
		);
	}

	private async deliver(run: ScheduleRun, resend = false): Promise<void> {
		if (run.status === "cancelled") return;
		if (run.binding.delivery.channel === "weixin" && !this.options.deliverResult && !this.options.deliverNotification)
			throw new Error("No Weixin delivery adapter is configured.");
		const status = this.options.deliverNotification
			? await this.options.deliverNotification(
					{ kind: "run-result", id: run.id, binding: structuredClone(run.binding), run: structuredClone(run) },
					resend,
				)
			: await this.options.deliverResult?.(structuredClone(run), resend);
		await this.store.transact((state) => {
			const current = state.runs.find((item) => item.id === run.id);
			if (current) current.delivery = status === "pending" ? "pending" : "sent";
		});
		await this.pruneHistory();
	}

	private async pruneHistory(): Promise<void> {
		const kept = new Set(this.retainedRuns(this.store.state).map((run) => run.id));
		const removed = this.store.state.runs.filter((run) => !kept.has(run.id));
		if (!removed.length) return;
		await this.store.transact((state) => {
			state.runs = this.retainedRuns(state);
		});
		for (const run of removed) {
			if (this.store.state.runs.some((item) => item.id === run.id)) continue;
			await cleanupScheduleExecution(this.options.storageDir, run).catch((error: unknown) =>
				this.options.onError?.(error instanceof Error ? error : new Error(String(error))),
			);
		}
	}

	private retainedRuns(state: ScheduleState): ScheduleRun[] {
		const counts = new Map<string, number>();
		return state.runs
			.toReversed()
			.filter((item) => {
				if (!TERMINAL_RUNS.has(item.status) || item.delivery === "pending" || this.workers.has(item.taskId))
					return true;
				const count = (counts.get(item.taskId) ?? 0) + 1;
				counts.set(item.taskId, count);
				return count <= 200 && Date.parse(item.finishedAt ?? item.occurrenceAt) >= this.clock() - 30 * 86_400_000;
			})
			.reverse();
	}

	private arm(): void {
		if (!this.started || this.stopped) return;
		let next = Number.POSITIVE_INFINITY;
		for (const task of this.store.state.tasks)
			if (task.status === "active" && task.nextAt) next = Math.min(next, Date.parse(task.nextAt));
		for (const run of this.store.state.runs)
			if (run.status === "queued" && !run.manual && Date.parse(run.occurrenceAt) > this.clock())
				next = Math.min(next, Date.parse(run.occurrenceAt));
		if (this.store.state.runs.some((run) => run.delivery === "pending" && TERMINAL_RUNS.has(run.status)))
			next = Math.min(next, this.deliveryAt);
		if (this.store.state.creationNotices.length) next = Math.min(next, this.deliveryAt);
		if (!Number.isFinite(next)) return;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				this.wake();
			},
			Math.max(0, Math.min(next - this.clock(), MAX_TIMER_DELAY)),
		);
		this.timer.unref();
	}
}

export function createScheduleHost(options: ScheduleHostOptions): ScheduleHost {
	return new ScheduleHost(options);
}
