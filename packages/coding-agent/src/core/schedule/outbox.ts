import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { scheduleNotificationSchema, scheduleRunSchema, writeScheduleJson } from "./store.ts";
import type { ScheduleNotification, ScheduleRun } from "./types.ts";

export type ScheduleDeliveryPart = { kind: "text"; text: string } | { kind: "file"; path: string };

export interface ScheduleWeixinBinding {
	version: 1;
	bindingId: string;
	ownerId: string;
	accountId: string;
}

interface OutboxItem {
	version: 2;
	notification: ScheduleNotification;
	parts?: Array<{ content: ScheduleDeliveryPart; sent: boolean }>;
	attempts: number;
	nextAttemptAt?: number;
	waitingForContext?: boolean;
	error?: string;
	completedAt?: string;
	/** A changed request generation requests a resend without overwriting sender progress. */
	generation: number;
}

export interface ScheduleDeliveryAdapter {
	authorize(userId: string): boolean;
	prepare(notification: ScheduleNotification): Promise<ScheduleDeliveryPart[]>;
	send(userId: string, part: ScheduleDeliveryPart): Promise<void>;
}

export class ScheduleDeliveryContextError extends Error {}

const partSchema = Type.Union([
	Type.Object({ kind: Type.Literal("text"), text: Type.String() }),
	Type.Object({ kind: Type.Literal("file"), path: Type.String({ minLength: 1 }) }),
]);
const progressSchema = {
	parts: Type.Optional(Type.Array(Type.Object({ content: partSchema, sent: Type.Boolean() }))),
	attempts: Type.Integer({ minimum: 0 }),
	generation: Type.Integer({ minimum: 0 }),
	nextAttemptAt: Type.Optional(Type.Number()),
	waitingForContext: Type.Optional(Type.Boolean()),
	error: Type.Optional(Type.String()),
	completedAt: Type.Optional(Type.String()),
};
const itemValidator = Compile(
	Type.Object({ version: Type.Literal(2), notification: scheduleNotificationSchema, ...progressSchema }),
);
const legacyValidator = Compile(Type.Object({ version: Type.Literal(1), run: scheduleRunSchema, ...progressSchema }));
const bindingValidator = Compile(
	Type.Object({
		version: Type.Literal(1),
		bindingId: Type.String({ minLength: 1 }),
		ownerId: Type.String({ minLength: 1 }),
		accountId: Type.String({ minLength: 1 }),
	}),
);
const RETRIES = [60_000, 300_000, 900_000];

function component(id: string): string {
	if (!/^[\w-]+$/.test(id)) throw new Error("Invalid outbox identity.");
	return id;
}

/** Durable local handoff. It contains results and recipient ids, never Weixin credentials. */
export class ScheduleOutbox {
	readonly directory: string;
	constructor(directory: string) {
		this.directory = directory;
	}

	async registerBinding(binding: ScheduleWeixinBinding): Promise<void> {
		const directory = join(this.directory, component(binding.bindingId));
		await mkdir(join(directory, "items"), { recursive: true, mode: 0o700 });
		await writeScheduleJson(join(directory, "binding.json"), binding);
	}

	async bindings(): Promise<ScheduleWeixinBinding[]> {
		let directories: string[];
		try {
			directories = await readdir(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const result: ScheduleWeixinBinding[] = [];
		for (const id of directories) {
			if (!/^[\w-]+$/.test(id)) continue;
			try {
				result.push(await this.binding(id));
			} catch {
				/* Incomplete bridge registrations are not offered. */
			}
		}
		return result;
	}

	async binding(id: string): Promise<ScheduleWeixinBinding> {
		const value: unknown = JSON.parse(await readFile(join(this.directory, component(id), "binding.json"), "utf8"));
		if (!bindingValidator.Check(value) || value.bindingId !== id) throw new Error("Invalid Weixin binding.");
		return value;
	}

	async enqueue(run: ScheduleRun, resend = false): Promise<"pending" | "sent"> {
		return this.enqueueNotification({ kind: "run-result", id: run.id, binding: run.binding, run }, resend);
	}

	async enqueueNotification(notification: ScheduleNotification, resend = false): Promise<"pending" | "sent"> {
		if (notification.binding.delivery.channel !== "weixin") return "sent";
		const target = notification.binding.delivery;
		await this.binding(target.bindingId);
		const path = this.itemPath(target.bindingId, notification.id);
		// Sender and producer share only a short per-item lock; no network I/O holds it.
		const release = await lockfile.lock(path, {
			realpath: false,
			retries: { retries: 5, minTimeout: 10, maxTimeout: 100 },
		});
		try {
			let existing: OutboxItem | undefined;
			try {
				existing = await this.readItem(path, true);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (existing) {
				if (resend) {
					existing.generation++;
					existing.attempts = 0;
					existing.nextAttemptAt = 0;
					existing.waitingForContext = false;
					if (existing.completedAt) {
						existing.completedAt = undefined;
						for (const part of existing.parts ?? []) part.sent = false;
					}
					await writeScheduleJson(path, existing);
				}
				return existing.completedAt ? "sent" : "pending";
			}
			await writeScheduleJson(path, { version: 2, notification, attempts: 0, generation: 0 } satisfies OutboxItem);
			return "pending";
		} finally {
			await release();
		}
	}

	async createWorker(
		bindingId: string,
		adapter: ScheduleDeliveryAdapter,
		onError: (error: Error) => void = () => {},
		clock: () => number = Date.now,
	): Promise<ScheduleOutboxWorker> {
		await this.binding(bindingId);
		const worker = new ScheduleOutboxWorker(this, bindingId, adapter, onError, clock);
		await worker.start();
		return worker;
	}

	itemPath(bindingId: string, runId: string): string {
		return join(this.directory, component(bindingId), "items", `${component(runId)}.json`);
	}

	/** Migration writes are allowed only while the caller holds this item's lock. */
	async readItem(path: string, migrate = false): Promise<OutboxItem> {
		let value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (legacyValidator.Check(value)) {
			const { run, ...progress } = value;
			const next: OutboxItem = {
				...progress,
				version: 2,
				notification: { kind: "run-result", id: run.id, binding: run.binding, run },
			};
			if (migrate) {
				await copyFile(path, `${path}.v1.${randomUUID()}.backup`);
				await writeScheduleJson(path, next);
			}
			value = next;
		}
		if (!itemValidator.Check(value)) throw new Error(`Invalid delivery record: ${path}`);
		return value;
	}
}

export class ScheduleOutboxWorker {
	private readonly outbox: ScheduleOutbox;
	private readonly bindingId: string;
	private readonly adapter: ScheduleDeliveryAdapter;
	private readonly onError: (error: Error) => void;
	private readonly clock: () => number;
	private release?: () => Promise<void>;
	private timer?: ReturnType<typeof setTimeout>;
	private running?: Promise<void>;
	private stopped = false;

	constructor(
		outbox: ScheduleOutbox,
		bindingId: string,
		adapter: ScheduleDeliveryAdapter,
		onError: (error: Error) => void,
		clock: () => number,
	) {
		this.outbox = outbox;
		this.bindingId = bindingId;
		this.adapter = adapter;
		this.onError = onError;
		this.clock = clock;
	}

	async start(): Promise<void> {
		this.release = await lockfile.lock(join(this.outbox.directory, this.bindingId), {
			onCompromised: (error) => {
				this.stopped = true;
				this.onError(error);
			},
		});
		await this.flush(true);
	}

	flush(force = false, userId?: string): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.running) return this.running.then(() => (force ? this.flush(true, userId) : undefined));
		if (this.timer) clearTimeout(this.timer);
		this.running = this.drain(force, userId)
			.catch((error: unknown) => this.onError(error instanceof Error ? error : new Error(String(error))))
			.finally(() => {
				this.running = undefined;
				if (!this.stopped) {
					this.timer = setTimeout(() => {
						void this.flush();
					}, 5_000);
					this.timer.unref();
				}
			});
		return this.running;
	}

	async close(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		await this.running;
		await this.release?.();
		this.release = undefined;
	}

	private async save(path: string, item: OutboxItem): Promise<void> {
		const release = await lockfile.lock(path, {
			realpath: false,
			retries: { retries: 5, minTimeout: 10, maxTimeout: 100 },
		});
		try {
			const latest = await this.outbox.readItem(path);
			if (latest.generation !== item.generation) return;
			await writeScheduleJson(path, item);
		} finally {
			await release();
		}
	}

	private async drain(force: boolean, userId?: string): Promise<void> {
		const directory = join(this.outbox.directory, this.bindingId, "items");
		for (const file of await readdir(directory)) {
			if (this.stopped) return;
			if (!/^[\w-]+\.json$/.test(file)) continue;
			const path = join(directory, file);
			let item: OutboxItem;
			try {
				const release = await lockfile.lock(path, {
					realpath: false,
					retries: { retries: 5, minTimeout: 10, maxTimeout: 100 },
				});
				try {
					item = await this.outbox.readItem(path, true);
				} finally {
					await release();
				}
			} catch (error) {
				this.onError(error instanceof Error ? error : new Error(String(error)));
				continue;
			}
			const target = item.notification.binding.delivery;
			if (
				target.channel !== "weixin" ||
				target.bindingId !== this.bindingId ||
				item.completedAt ||
				(userId && userId !== target.userId)
			)
				continue;
			if (
				!force &&
				(item.waitingForContext || item.attempts > RETRIES.length || (item.nextAttemptAt ?? 0) > this.clock())
			)
				continue;
			try {
				if (!this.adapter.authorize(target.userId))
					throw new ScheduleDeliveryContextError("This recipient is no longer authorized.");
				if (!item.parts) {
					item.parts = (await this.adapter.prepare(item.notification)).map((content) => ({
						content,
						sent: false,
					}));
					if (!item.parts.length) throw new Error("The output adapter produced no notification.");
					await this.save(path, item);
				}
				for (const part of item.parts) {
					if (this.stopped) return;
					if (part.sent) continue;
					await this.adapter.send(target.userId, part.content);
					part.sent = true;
					await this.save(path, item);
				}
				item.completedAt = new Date(this.clock()).toISOString();
				item.error = undefined;
				item.waitingForContext = false;
				await this.save(path, item);
			} catch (error) {
				item.error = error instanceof Error ? error.message : String(error);
				item.attempts++;
				item.waitingForContext = error instanceof ScheduleDeliveryContextError;
				const delay = RETRIES[item.attempts - 1];
				item.nextAttemptAt = delay === undefined ? undefined : this.clock() + delay;
				await this.save(path, item);
				this.onError(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}
}
