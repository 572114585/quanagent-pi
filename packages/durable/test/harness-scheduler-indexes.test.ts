// The scheduler's in-memory indexes: cases where a wrong index changes behaviour, each against what the committed
// records imply (spec §5.4, §5.5).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, defineTask, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { context } from "./session-support.ts";
import { aborted, type Deferred, deferred, eventually, openTasks, settled } from "./task-support.ts";

const gates = new Map<string, Deferred<void>>();
function gate(name: string): Deferred<void> {
	let found = gates.get(name);
	if (found === undefined) {
		found = deferred<void>();
		gates.set(name, found);
	}
	return found;
}

/** Holds until its gate opens, then completes; its abort handler ends it `aborted`. */
const Hold = defineTask<{ name: string }, { phase: "hold" }, null>({
	name: "test.index.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			const opened = await Promise.race([gate(task.input.name).promise.then(() => true), aborted(runtime.signal)]);
			if (opened !== true) return;
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const directories: string[] = [];
afterEach(async () => {
	gates.clear();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-indexes-"));
	directories.push(directory);
	return join(directory, "session.sqlite");
}

async function state(harness: Harness, id: TaskId) {
	return (await harness.getTask(id, context))!;
}

describe("scheduler indexes", () => {
	it("takes a cascade's reason from the nearest cancelling owner", async () => {
		// top (abort requested) -> middle (restart-marked) -> leaf: the leaf gets middle's `restart` first, as the nearest
		// cancelling owner, and the request only once middle carries it.
		const path = await sqlitePath();
		const session = createSession(await openNodeSqliteStorage(path));
		const ids = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const top = await tx.createTask(
				Hold,
				{ name: "top" },
				{ conversationId: conversation.id, ownership: { kind: "conversation" } },
			);
			const middle = await tx.createTask(Hold, { name: "middle" }, { ownership: { kind: "task", taskId: top } });
			const leaf = await tx.createTask(Hold, { name: "leaf" }, { ownership: { kind: "task", taskId: middle } });
			return { top, middle, leaf };
		}, context);
		await session.commit(async (tx) => {
			const top = (await tx.task(ids.top))!;
			const middle = (await tx.task(ids.middle))!;
			const set = (tx as unknown as { setTask(value: unknown): void }).setTask.bind(tx);
			set({ ...top, abortRequested: true });
			set({ ...middle, abortRequested: true, abortReason: "restart" });
		}, context);
		await session.close(context);
		// Record every mark of the leaf, in commit order.
		const storage = await openNodeSqliteStorage(path);
		const reasons: (string | undefined)[] = [];
		const commit = storage.commit.bind(storage);
		storage.commit = (writes, commitContext) => {
			for (const write of writes) {
				if (write.type === "task" && write.value.id === ids.leaf && write.value.abortRequested) {
					reasons.push(write.value.abortReason);
				}
			}
			return commit(writes, commitContext);
		};
		const { harness } = await openTasks(storage, [Hold]);
		harness.resume();
		for (const id of [ids.leaf, ids.middle, ids.top]) await harness.waitForTask(id, context);
		expect(reasons[0]).toBe("restart");
		await harness.close(context);
	});

	it("finalizes a chain of held owners in the commit that frees the last one", async () => {
		const storage = await openNodeSqliteStorage(await sqlitePath());
		// The commit, by count, that wrote each terminal record.
		const endedIn = new Map<TaskId, number>();
		let commits = 0;
		const commit = storage.commit.bind(storage);
		storage.commit = (writes, commitContext) => {
			commits++;
			for (const write of writes) {
				if (write.type === "task" && write.value.state.status === "terminal") endedIn.set(write.value.id, commits);
			}
			return commit(writes, commitContext);
		};
		const opened = await openTasks(storage, [Hold]);
		const harness = opened.harness;
		const root = await harness.root(context);
		harness.resume();
		const { top, middle, leaf } = await root.commit(async (tx) => {
			const top = await tx.createTask(Hold, { name: "top" }, { ownership: { kind: "conversation" } });
			const middle = await tx.createTask(Hold, { name: "middle" }, { ownership: { kind: "task", taskId: top } });
			const leaf = await tx.createTask(Hold, { name: "leaf" }, { ownership: { kind: "task", taskId: middle } });
			return { top, middle, leaf };
		}, context);
		gate("top").resolve();
		gate("middle").resolve();
		await eventually(async () => (await state(harness, top)).state.status === "completing");
		await eventually(async () => (await state(harness, middle)).state.status === "completing");
		gate("leaf").resolve();
		expect((await harness.waitForTask(top, context)).state.outcome.status).toBe("completed");
		// Both owners end in one finalize commit, after the leaf's.
		expect(endedIn.get(middle)).toBe(endedIn.get(top));
		expect(endedIn.get(middle)).toBeGreaterThan(endedIn.get(leaf)!);
		await harness.close(context);
	});

	it("keeps a scope busy after reopen for work below an ended task whose chain is not loaded yet", async () => {
		const path = await sqlitePath();
		let opened = await openTasks(await openNodeSqliteStorage(path), [Hold]);
		let root = await opened.harness.root(context);
		opened.harness.resume();
		// root conversation -> owner (ends) -> conversation C -> inner (created after owner ended), as a subagent call's.
		const { owner, child } = await root.commit(async (tx) => {
			const owner = await tx.createTask(Hold, { name: "owner" }, { ownership: { kind: "conversation" } });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			return { owner, child: child.id };
		}, context);
		gate("owner").resolve();
		await opened.harness.waitForTask(owner, context);
		const conversation = (await opened.harness.conversation(child, context))!;
		const inner = await conversation.commit(
			(tx) => tx.createTask(Hold, { name: "inner" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await opened.harness.close(context);
		gates.clear();
		// Hold the read of C's record, so the chain above `inner` stays unloaded while idle is decided.
		const storage = await openNodeSqliteStorage(path);
		const read = storage.conversation.bind(storage);
		const held = deferred<void>();
		storage.conversation = async (id, readContext) => {
			if (id === child) await held.promise;
			return read(id, readContext);
		};
		opened = await openTasks(storage, [Hold]);
		// A task whose chain is not loaded counts as inside every scope. (The held read blocks the Session line, so the
		// root handle comes after.)
		expect(await settled(opened.harness.waitForIdle(context))).toBe(false);
		held.resolve();
		root = await opened.harness.root(context);
		opened.harness.resume();
		gate("inner").resolve();
		await opened.harness.waitForTask(inner, context);
		await root.waitForIdle(context);
		await opened.harness.close(context);
	});
});
