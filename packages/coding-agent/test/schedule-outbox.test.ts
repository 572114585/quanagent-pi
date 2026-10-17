import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ScheduleDeliveryContextError,
	ScheduleOutbox,
	type ScheduleOutboxWorker,
} from "../src/core/schedule/outbox.ts";
import type { ScheduleRun } from "../src/core/schedule/types.ts";

const directories: string[] = [];
const workers: ScheduleOutboxWorker[] = [];
afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "pi-schedule-outbox-"));
	directories.push(directory);
	const outbox = new ScheduleOutbox(directory);
	await outbox.registerBinding({ version: 1, bindingId: "test-bridge", ownerId: "alice", accountId: "account" });
	const run: ScheduleRun = {
		id: "saved-run",
		taskId: "task",
		title: "Report",
		prompt: "Generate report",
		occurrenceAt: "2026-10-17T01:00:00Z",
		manual: false,
		status: "succeeded",
		result: "report text",
		delivery: "pending",
		binding: {
			ownerId: "alice",
			sessionId: "conversation",
			sessionFile: "/session.jsonl",
			cwd: "/work",
			agentDir: "/agent",
			delivery: { channel: "weixin", bindingId: "test-bridge", userId: "alice" },
		},
	};
	return { directory, outbox, run };
}

describe("durable result delivery", () => {
	it("migrates legacy partial sends under lock with a backup and preserves confirmed parts", async () => {
		const { outbox, run } = await setup();
		const path = outbox.itemPath("test-bridge", run.id);
		const legacy = {
			version: 1,
			run,
			attempts: 2,
			generation: 3,
			parts: [
				{ content: { kind: "text", text: "already acknowledged" }, sent: true },
				{ content: { kind: "file", path: "/pending.pdf" }, sent: false },
			],
		};
		await writeFile(path, JSON.stringify(legacy));
		const sent: string[] = [];
		const worker = await outbox.createWorker("test-bridge", {
			authorize: () => true,
			prepare: async () => {
				throw new Error("Do not prepare again");
			},
			send: async (_user, part) => {
				sent.push(part.kind === "file" ? part.path : part.text);
			},
		});
		workers.push(worker);
		expect(sent).toEqual(["/pending.pdf"]);
		const saved = JSON.parse(await readFile(path, "utf8")) as {
			version: number;
			generation: number;
			parts: Array<{ sent: boolean }>;
		};
		expect(saved.version).toBe(2);
		expect(saved.generation).toBe(3);
		expect(saved.parts.every((part) => part.sent)).toBe(true);
		const backup = (await readdir(join(outbox.directory, "test-bridge", "items"))).find((file) =>
			file.endsWith(".backup"),
		)!;
		expect(JSON.parse(await readFile(join(outbox.directory, "test-bridge", "items", backup), "utf8"))).toEqual(
			legacy,
		);
	});

	it("uses distinct stable identities for creation receipts and results", async () => {
		const { outbox, run } = await setup();
		const notice = {
			kind: "task-created" as const,
			id: `task-created-${run.taskId}`,
			taskId: run.taskId,
			title: run.title,
			binding: run.binding,
			createdAt: run.occurrenceAt,
			nextAt: run.occurrenceAt,
			timeZone: "Asia/Shanghai",
			delivery: "pending" as const,
		};
		await outbox.enqueueNotification(notice);
		await outbox.enqueueNotification(notice);
		await outbox.enqueue(run);
		const prepared: string[] = [];
		const worker = await outbox.createWorker("test-bridge", {
			authorize: () => true,
			prepare: async (item) => {
				prepared.push(item.kind);
				return [{ kind: "text", text: item.id }];
			},
			send: async () => {},
		});
		workers.push(worker);
		expect(prepared.sort()).toEqual(["run-result", "task-created"]);
		expect(await outbox.enqueueNotification(notice)).toBe("sent");
	});
	it("retries unacknowledged parts after restart without rerunning a task", async () => {
		const { outbox, run } = await setup();
		await outbox.enqueue(run);
		const sent: string[] = [];
		const first = await outbox.createWorker("test-bridge", {
			authorize: (user) => user === "alice",
			prepare: async () => [
				{ kind: "text", text: "report" },
				{ kind: "file", path: "/report.pdf" },
			],
			send: async (_user, part) => {
				if (part.kind === "file") throw new Error("offline");
				sent.push(part.text);
			},
		});
		await first.close();
		expect(sent).toEqual(["report"]);
		const second = await outbox.createWorker("test-bridge", {
			authorize: () => true,
			prepare: async () => {
				throw new Error("Already prepared");
			},
			send: async (_user, part) => {
				sent.push(part.kind === "file" ? part.path : part.text);
			},
		});
		workers.push(second);
		expect(sent).toEqual(["report", "/report.pdf"]);
		expect(await outbox.enqueue(run)).toBe("sent");
	});

	it("waits for a fresh user context and isolates recipients", async () => {
		const { outbox, run } = await setup();
		await outbox.enqueue(run);
		let calls = 0;
		let connected = false;
		const worker = await outbox.createWorker("test-bridge", {
			authorize: () => true,
			prepare: async () => [{ kind: "text", text: "saved" }],
			send: async () => {
				calls++;
				if (!connected) throw new ScheduleDeliveryContextError("no token");
			},
		});
		workers.push(worker);
		await worker.flush();
		await worker.flush(true, "bob");
		expect(calls).toBe(1);
		connected = true;
		await worker.flush(true, "alice");
		expect(calls).toBe(2);
		expect(await outbox.enqueue(run)).toBe("sent");
	});

	it("uses bounded retries and supports explicit resend of saved output", async () => {
		const { outbox, run } = await setup();
		await outbox.enqueue(run);
		let now = 0;
		let calls = 0;
		let connected = false;
		const worker = await outbox.createWorker(
			"test-bridge",
			{
				authorize: () => true,
				prepare: async () => [{ kind: "text", text: "saved" }],
				send: async () => {
					calls++;
					if (!connected) throw new Error("network");
				},
			},
			() => {},
			() => now,
		);
		workers.push(worker);
		for (const time of [59_999, 60_000, 359_999, 360_000, 1_260_000, 9_000_000]) {
			now = time;
			await worker.flush();
		}
		expect(calls).toBe(4);
		connected = true;
		await outbox.enqueue(run, true);
		await worker.flush();
		expect(calls).toBe(5);
		expect(await outbox.enqueue(run)).toBe("sent");
		await outbox.enqueue(run, true);
		await worker.flush();
		expect(calls).toBe(6);
	});

	it("stores no authentication tokens and does not accept unsafe binding paths", async () => {
		const { outbox, run } = await setup();
		await outbox.enqueue(run);
		const saved = await readFile(outbox.itemPath("test-bridge", run.id), "utf8");
		expect(saved).not.toContain("context_token");
		expect(saved).not.toContain("bot_token");
		await expect(outbox.binding("../other")).rejects.toThrow("identity");
	});
});
