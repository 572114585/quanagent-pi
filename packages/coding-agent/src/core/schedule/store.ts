import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { validateScheduleRule } from "./rules.ts";
import type { ScheduleState } from "./types.ts";

const text = Type.String({ minLength: 1 });
const delivery = Type.Union([
	Type.Object({ channel: Type.Literal("local") }),
	Type.Object({ channel: Type.Literal("weixin"), bindingId: text, userId: text }),
]);
const binding = Type.Object({
	ownerId: text,
	sessionId: text,
	sessionFile: text,
	cwd: text,
	agentDir: text,
	toolNames: Type.Optional(Type.Array(text)),
	delivery,
});
const rule = Type.Union([
	Type.Object({ kind: Type.Literal("after"), seconds: Type.Integer(), at: text }),
	Type.Object({ kind: Type.Literal("at"), at: text }),
	Type.Object({ kind: Type.Literal("every"), seconds: Type.Integer(), anchor: text }),
	Type.Object({ kind: Type.Literal("daily"), time: text, timeZone: text }),
	Type.Object({ kind: Type.Literal("weekly"), time: text, timeZone: text, weekdays: Type.Array(Type.Integer()) }),
	Type.Object({ kind: Type.Literal("cron"), expression: text, timeZone: text }),
]);
export const scheduleRunSchema = Type.Object({
	id: text,
	taskId: text,
	title: text,
	prompt: text,
	binding,
	occurrenceAt: text,
	timeZone: Type.Optional(text),
	manual: Type.Boolean(),
	status: Type.Union(
		["queued", "running", "succeeded", "failed", "interrupted", "cancelled"].map((s) => Type.Literal(s)),
	),
	startedAt: Type.Optional(text),
	finishedAt: Type.Optional(text),
	result: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
	delivery: Type.Union([Type.Literal("pending"), Type.Literal("sent")]),
	execution: Type.Optional(
		Type.Object({
			sourceSessionId: text,
			sourceSessionFile: text,
			snapshotLeafId: Type.Union([text, Type.Null()]),
			sessionId: text,
			sessionFile: text,
			artifactDir: text,
		}),
	),
});
export const scheduleCreatedSchema = Type.Object({
	kind: Type.Literal("task-created"),
	id: text,
	taskId: text,
	title: text,
	binding,
	createdAt: text,
	nextAt: text,
	timeZone: text,
	delivery: Type.Union([Type.Literal("pending"), Type.Literal("sent")]),
});
export const scheduleNotificationSchema = Type.Union([
	scheduleCreatedSchema,
	Type.Object({ kind: Type.Literal("run-result"), id: text, binding, run: scheduleRunSchema }),
]);
const stateValidator = Compile(
	Type.Object({
		version: Type.Literal(2),
		creationNotices: Type.Array(scheduleCreatedSchema),
		tasks: Type.Array(
			Type.Object({
				id: text,
				revision: Type.Integer({ minimum: 1 }),
				title: text,
				prompt: text,
				rule,
				binding,
				status: Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("completed")]),
				nextAt: Type.Union([text, Type.Null()]),
				createdAt: text,
			}),
		),
		runs: Type.Array(scheduleRunSchema),
		weixinBinding: Type.Optional(Type.Object({ bindingId: text, userId: text })),
	}),
);

export async function writeScheduleJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

/** Owns a single-writer namespace; failed validation never rewrites its source file. */
export class ScheduleStore {
	readonly directory: string;
	private release?: () => Promise<void>;
	private chain: Promise<unknown> = Promise.resolve();
	state: ScheduleState = { version: 2, tasks: [], runs: [], creationNotices: [] };
	private readonly onCompromised: (error: Error) => void;

	constructor(directory: string, onCompromised: (error: Error) => void) {
		this.directory = directory;
		this.onCompromised = onCompromised;
	}

	async start(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		try {
			this.release = await lockfile.lock(this.directory, { onCompromised: this.onCompromised });
		} catch (error) {
			throw new Error(`Schedule host unavailable: another process may own ${this.directory}.`, { cause: error });
		}
		try {
			this.state = { version: 2, tasks: [], runs: [], creationNotices: [] };
			let value: unknown;
			try {
				value = JSON.parse(await readFile(join(this.directory, "state.json"), "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
			const legacy = value !== null && typeof value === "object" && "version" in value && value.version === 1;
			if (value !== null && typeof value === "object" && "version" in value && value.version === 1)
				value = { ...value, version: 2, creationNotices: [] };
			if (!stateValidator.Check(value)) throw new Error("Invalid schedule state schema.");
			const state: ScheduleState = value;
			if (
				new Set(state.tasks.map((task) => task.id)).size !== state.tasks.length ||
				new Set(state.runs.map((run) => run.id)).size !== state.runs.length
			)
				throw new Error("Duplicate schedule identities.");
			for (const task of state.tasks) {
				validateScheduleRule(task.rule);
				if (
					!Number.isFinite(Date.parse(task.createdAt)) ||
					(task.status === "active" && task.nextAt === null) ||
					(task.nextAt !== null && !Number.isFinite(Date.parse(task.nextAt)))
				)
					throw new Error("Invalid stored schedule time.");
			}
			for (const run of state.runs)
				if (
					[run.occurrenceAt, run.startedAt, run.finishedAt].some(
						(at) => at !== undefined && !Number.isFinite(Date.parse(at)),
					)
				)
					throw new Error("Invalid stored occurrence.");
			if (legacy) {
				await copyFile(
					join(this.directory, "state.json"),
					join(this.directory, `state.v1.${randomUUID()}.backup.json`),
				);
				await writeScheduleJson(join(this.directory, "state.json"), state);
			}
			this.state = state;
		} catch (error) {
			await this.close();
			throw new Error("Schedule storage is invalid; its file has been left unchanged.", { cause: error });
		}
	}

	transact<T>(work: (state: ScheduleState) => T): Promise<T> {
		const operation = this.chain.then(async () => {
			if (!this.release) throw new Error("Schedule host is not running.");
			const next = structuredClone(this.state);
			const result = work(next);
			await writeScheduleJson(join(this.directory, "state.json"), next);
			this.state = next;
			return structuredClone(result);
		});
		this.chain = operation.catch(() => {});
		return operation;
	}

	async close(): Promise<void> {
		await this.chain;
		const release = this.release;
		this.release = undefined;
		await release?.();
	}
}
