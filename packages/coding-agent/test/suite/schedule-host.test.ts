import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScheduleHost, type ScheduleHost } from "../../src/core/schedule/host.ts";
import {
	createScheduleExecutionSession,
	type ScheduleExecutionSessionOptions,
} from "../../src/core/schedule/sessions.ts";
import type {
	ScheduleBinding,
	ScheduleHostOptions,
	ScheduleNotification,
	ScheduleRun,
	ScheduleState,
} from "../../src/core/schedule/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createScheduleExtension } from "../../src/extensions/schedule/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const hosts: ScheduleHost[] = [];
const harnesses: Harness[] = [];
const directories: string[] = [];
const gates: Array<() => void> = [];
afterEach(async () => {
	for (const release of gates.splice(0)) release();
	for (const host of hosts.splice(0)) await host.close();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	gates.push(release);
	return { promise, release };
}

async function setup(
	overrides: Partial<ScheduleHostOptions> = {},
	resources: ScheduleExecutionSessionOptions["resources"] = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-schedule-host-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, join(directory, "sessions"));
	const harness = await createHarness({
		sessionManager: manager,
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	harnesses.push(harness);
	manager.appendModelChange(harness.getModel().provider, harness.getModel().id);
	manager.appendMessage({ role: "user", content: "Original context", timestamp: Date.now() });
	const firstUser = manager.getLeafId()!;
	manager.appendMessage(fauxAssistantMessage("Original completed answer"));
	harness.session.refreshContext();
	let now = Date.parse("2026-10-17T00:00:00Z");
	const delivered: ScheduleRun[] = [];
	const notices: ScheduleNotification[] = [];
	const binding: ScheduleBinding = {
		ownerId: "alice",
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile()!,
		cwd: directory,
		agentDir: directory,
		delivery: { channel: "local" },
	};
	const executionOptions: ScheduleExecutionSessionOptions = {
		storageDir: join(directory, "schedule"),
		source: harness.session,
		session: { modelRuntime: harness.session.modelRuntime },
		resources: {
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			...resources,
		},
	};
	const options: ScheduleHostOptions = {
		storageDir: executionOptions.storageDir,
		clock: () => now,
		createExecutionSession: (run, signal) => createScheduleExecutionSession(run, { ...executionOptions, signal }),
		deliverNotification: async (notice) => {
			notices.push(notice);
			if (notice.kind === "run-result") delivered.push(notice.run);
			return "sent";
		},
		...overrides,
	};
	const host = createScheduleHost(options);
	hosts.push(host);
	host.attach(harness.session);
	await host.start();
	return {
		directory,
		harness,
		manager,
		binding,
		host,
		options,
		executionOptions,
		delivered,
		notices,
		firstUser,
		setTime: (time: number) => {
			now = time;
		},
	};
}

async function queue(host: ScheduleHost, binding: ScheduleBinding, title = "report") {
	const task = await host.create(binding, { title, prompt: "Generate a report", after_seconds: 60 });
	await host.run(binding.ownerId, task.id);
	return task;
}

describe("independent schedule snapshots", () => {
	it("omits earlier abandoned rounds and their unpaired tool calls", async () => {
		const { host, harness, manager, binding } = await setup();
		manager.appendMessage({ role: "user", content: "abandoned request", timestamp: Date.now() });
		manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", {}, { id: "abandoned-call" }), { stopReason: "aborted" }),
		);
		manager.appendMessage({ role: "user", content: "recovered request", timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage("recovered answer"));
		harness.session.refreshContext();
		harness.setResponses([
			(context) => {
				const text = JSON.stringify(context.messages);
				expect(text).not.toContain("abandoned");
				expect(text).toContain("recovered answer");
				return fauxAssistantMessage("clean snapshot");
			},
		]);
		await queue(host, binding);
		await host.waitForIdle();
		expect((await host.history("alice"))[0]?.result).toBe("clean snapshot");
	});

	it("persists a separate log and latest complete context without changing the original branch", async () => {
		const { host, harness, binding, manager } = await setup();
		harness.setResponses([fauxAssistantMessage("Newest complete context")]);
		await harness.session.prompt("Latest question");
		const before = await readFile(binding.sessionFile, "utf8");
		const leaf = manager.getLeafId();
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Newest complete context");
				return fauxAssistantMessage("Scheduled result");
			},
		]);
		await queue(host, binding);
		await host.waitForIdle();
		const [run] = await host.history("alice");
		expect(run?.result).toBe("Scheduled result");
		expect(run?.execution?.snapshotLeafId).toBe(leaf);
		expect(run?.execution?.sessionId).not.toBe(binding.sessionId);
		expect(run?.execution?.sessionFile).not.toBe(binding.sessionFile);
		expect(await readFile(run!.execution!.sessionFile, "utf8")).toContain("Scheduled result");
		expect(await readFile(binding.sessionFile, "utf8")).toBe(before);
		expect(manager.getLeafId()).toBe(leaf);
		expect(JSON.stringify(harness.session.messages)).not.toContain("Scheduled result");
	});

	it("starts while the foreground model waits and skips its entire unfinished tool round", async () => {
		const { host, harness, binding, manager } = await setup();
		manager.appendCompaction("Safe pre-turn compaction", manager.getLeafId()!, 100);
		harness.session.refreshContext();
		const waiting = gate();
		harness.setResponses([
			async () => {
				await waiting.promise;
				return fauxAssistantMessage("foreground done");
			},
			(context) => {
				const text = JSON.stringify(context.messages);
				expect(text).toContain("Original completed answer");
				expect(text).toContain("Safe pre-turn compaction");
				expect(text).not.toContain("Unfinished foreground question");
				expect(text).not.toContain("orphan-tool");
				return fauxAssistantMessage("background done");
			},
		]);
		const chat = harness.session.prompt("Unfinished foreground question");
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", {}, { id: "orphan-tool" }), { stopReason: "toolUse" }),
		);
		await queue(host, binding);
		await host.waitForIdle();
		expect((await host.history("alice"))[0]?.result).toBe("background done");
		expect(harness.session.isIdle).toBe(false);
		waiting.release();
		await chat;
	});

	it("lets the foreground handle another message while the background model waits", async () => {
		const { host, harness, binding } = await setup();
		const waiting = gate();
		harness.setResponses([
			async () => {
				await waiting.promise;
				return fauxAssistantMessage("background done");
			},
			fauxAssistantMessage("chat continues"),
		]);
		const task = await queue(host, binding);
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		await harness.session.prompt("Can we keep chatting?");
		expect(JSON.stringify(harness.session.messages)).toContain("chat continues");
		expect((await host.history("alice", task.id))[0]?.status).toBe("running");
		await expect(host.run("alice", task.id)).rejects.toThrow("already queued or executing");
		waiting.release();
		await host.waitForIdle();
	});

	it("uses empty context for an unfinished first conversation", async () => {
		const { host, harness, manager, binding, firstUser } = await setup();
		manager.branch(firstUser);
		harness.session.refreshContext();
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("Original context");
				return fauxAssistantMessage("first task");
			},
		]);
		await queue(host, binding);
		await host.waitForIdle();
		expect((await host.history("alice"))[0]?.execution?.snapshotLeafId).toBeNull();
		expect((await host.history("alice"))[0]?.result).toBe("first task");
	});

	it("preserves compaction, context edits and the selected branch for a cold source", async () => {
		const { host, harness, manager, binding, executionOptions } = await setup();
		const completed = manager.getLeafId()!;
		manager.appendCompaction("Earlier summary", completed, 100);
		manager.appendContextEdit(completed, { content: [{ type: "text", text: "Edited complete context" }] });
		executionOptions.source = undefined;
		host.detach(harness.session);
		const before = await readFile(binding.sessionFile, "utf8");
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Earlier summary");
				expect(JSON.stringify(context.messages)).toContain("Edited complete context");
				return fauxAssistantMessage("cold result");
			},
		]);
		await queue(host, binding);
		await host.waitForIdle();
		expect((await host.history("alice"))[0]?.result).toBe("cold result");
		expect(await readFile(binding.sessionFile, "utf8")).toBe(before);
	});

	it("rejects missing files and mismatched source identities without replacing them", async () => {
		const { host, harness, binding } = await setup();
		const task = await host.create(binding, { title: "identity", prompt: "Run", after_seconds: 60 });
		await writeFile(binding.sessionFile, `${JSON.stringify({ type: "session", id: "other", cwd: binding.cwd })}\n`);
		await host.run("alice", task.id);
		await host.waitForIdle();
		expect((await host.history("alice"))[0]?.error).toContain("identity");
		await unlink(binding.sessionFile);
		await host.run("alice", task.id);
		await host.waitForIdle();
		expect((await host.history("alice"))[0]?.error).toContain("ENOENT");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("restricts background scheduling to queries and fails interactive confirmation", async () => {
		let performed = false;
		const { host, harness, binding, executionOptions, options } = await setup();
		executionOptions.resources!.extensionFactories = [
			createScheduleExtension(host, { background: true, ui: false, ownerId: "alice", getBinding: () => binding }),
			(pi) => {
				pi.registerTool({
					name: "protected_action",
					label: "Protected action",
					description: "Requires confirmation",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						if (await ctx.ui.confirm("Approve?", "Action")) performed = true;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				});
			},
		];
		executionOptions.session!.tools = ["protected_action", "schedule_list", "schedule_history", "schedule_create"];
		options.createExecutionSession = async (run, signal) => {
			const lease = await createScheduleExecutionSession(run, { ...executionOptions, signal });
			expect(lease.session.getCallableToolNames()).toContain("schedule_list");
			expect(
				lease.session
					.getAllTools()
					.some((tool) =>
						["schedule_create", "schedule_update", "schedule_delete", "schedule_run", "schedule_resend"].includes(
							tool.name,
						),
					),
			).toBe(false);
			return lease;
		};
		harness.setResponses([
			() => {
				return fauxAssistantMessage(fauxToolCall("protected_action", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Could not confirm"),
		]);
		await queue(host, binding);
		await host.waitForIdle();
		expect(performed).toBe(false);
		expect((await host.history("alice"))[0]?.error).toContain("interactive confirmation");
	});
});

describe("background admission, delivery and recovery", () => {
	it("retains prepared logs when a task is deleted before its model starts", async () => {
		const { host, harness, binding, options, executionOptions } = await setup();
		const waiting = gate();
		let prepared = false;
		options.createExecutionSession = async (run, signal) => {
			const lease = await createScheduleExecutionSession(run, { ...executionOptions, signal });
			prepared = true;
			await waiting.promise;
			return lease;
		};
		const task = await queue(host, binding);
		await vi.waitFor(() => expect(prepared).toBe(true));
		await host.delete("alice", task.id);
		waiting.release();
		await host.waitForIdle();
		const run = (await host.history("alice"))[0]!;
		expect(run.status).toBe("cancelled");
		expect(run.execution).toBeDefined();
		expect(harness.faux.state.callCount).toBe(0);
		expect(await host.readLog("alice", run.id)).toContain("Original context");
		await expect(host.readLog("bob", run.id)).rejects.toThrow("not found");
	});

	it("records background initialization confirmations as failure while preserving the log", async () => {
		const { host, harness, binding, executionOptions } = await setup();
		executionOptions.resources!.extensionFactories = [
			(pi) => {
				pi.on("session_start", async (_event, ctx) => {
					await ctx.ui.confirm("Approve?", "Startup");
				});
			},
		];
		await queue(host, binding);
		await host.waitForIdle();
		const run = (await host.history("alice"))[0]!;
		expect(run.status).toBe("failed");
		expect(run.error).toContain("interactive confirmation");
		expect(await host.readLog("alice", run.id)).toContain("Original context");
		expect(harness.faux.state.callCount).toBe(0);
	});
	it("cleans only acknowledged retired per-run directories and retains pending output", async () => {
		const { host, harness, binding, directory, options } = await setup();
		harness.setResponses([fauxAssistantMessage("first result"), fauxAssistantMessage("pending result")]);
		const first = await queue(host, binding, "retired");
		await host.waitForIdle();
		const second = await queue(host, binding, "pending");
		await host.waitForIdle();
		await host.update("alice", first.id, { paused: true });
		await host.update("alice", second.id, { paused: true });
		await host.close();
		const path = join(directory, "schedule", "state.json");
		const state = JSON.parse(await readFile(path, "utf8")) as ScheduleState;
		for (const run of state.runs) run.finishedAt = "2026-01-01T00:00:00Z";
		state.runs.find((run) => run.taskId === second.id)!.delivery = "pending";
		await writeFile(path, JSON.stringify(state));
		const retired = state.runs.find((run) => run.taskId === first.id)!;
		const pending = state.runs.find((run) => run.taskId === second.id)!;
		const reopened = createScheduleHost({ ...options, deliverNotification: async () => "pending" });
		hosts.push(reopened);
		await reopened.start();
		await reopened.waitForIdle();
		await expect(readFile(retired.execution!.sessionFile)).rejects.toThrow("ENOENT");
		expect(await readFile(pending.execution!.sessionFile, "utf8")).toContain("pending result");
		expect(await readFile(binding.sessionFile, "utf8")).toContain("Original context");
	});
	it("limits each owner to one task and independent owners to four", async () => {
		const { host, harness, binding } = await setup({ ownerConcurrency: 1 });
		const waiting = gate();
		let active = 0;
		let peak = 0;
		harness.setResponses(
			Array.from({ length: 6 }, () => async () => {
				active++;
				peak = Math.max(peak, active);
				await waiting.promise;
				active--;
				return fauxAssistantMessage("done");
			}),
		);
		for (const ownerId of ["alice", "alice", "bob", "carol", "dan", "eve"])
			await queue(host, { ...binding, ownerId });
		await vi.waitFor(() => expect(active).toBe(4));
		expect((await host.history("alice")).map((run) => run.status).sort()).toEqual(["queued", "running"]);
		waiting.release();
		await host.waitForIdle();
		expect(peak).toBe(4);
		expect(harness.faux.state.callCount).toBe(6);
	});

	it("coalesces automatic triggers while a task runs without overlapping it", async () => {
		const { host, harness, binding, setTime } = await setup();
		const waiting = gate();
		harness.setResponses([
			async () => {
				await waiting.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("latest"),
		]);
		const task = await host.create(binding, { title: "recurring", prompt: "Poll", every_seconds: 60 });
		setTime(Date.parse(task.createdAt) + 60_000);
		await host.tick();
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		for (const minutes of [2, 3, 10]) {
			setTime(Date.parse(task.createdAt) + minutes * 60_000);
			await host.tick();
		}
		const queued = (await host.history("alice")).filter((run) => run.status === "queued");
		expect(queued).toHaveLength(1);
		expect(queued[0]?.occurrenceAt).toBe("2026-10-17T00:10:00.000Z");
		waiting.release();
		await host.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("records timeout before cleanup and holds the owner slot until the child really settles", async () => {
		const { host, harness, binding, delivered } = await setup({ runTimeoutMs: 150, ownerConcurrency: 1 });
		const waiting = gate();
		harness.setResponses([
			async () => {
				await waiting.promise;
				return fauxAssistantMessage("late");
			},
			fauxAssistantMessage("next"),
		]);
		await queue(host, binding, "slow");
		await queue(host, binding, "next");
		await vi.waitFor(() =>
			expect(delivered.some((run) => run.status === "failed" && run.error?.includes("time limit"))).toBe(true),
		);
		expect(harness.faux.state.callCount).toBe(1);
		expect((await host.history("alice")).some((run) => run.status === "queued")).toBe(true);
		expect(harness.session.isIdle).toBe(true);
		waiting.release();
		await host.waitForIdle();
		expect((await host.history("alice")).find((run) => run.title === "slow")?.result).toBeUndefined();
	});

	it("keeps creation receipts durable even if model confirmation fails or delivery is offline", async () => {
		const { host, binding, directory, notices } = await setup({
			deliverNotification: async () => {
				throw new Error("offline");
			},
		});
		const task = await host.create(
			{ ...binding, delivery: { channel: "weixin", bindingId: "bridge", userId: "alice" } },
			{ title: "receipt", prompt: "Run", after_seconds: 60 },
		);
		await host.tick();
		const state = JSON.parse(await readFile(join(directory, "schedule", "state.json"), "utf8")) as ScheduleState;
		expect(state.creationNotices[0]?.id).toBe(`task-created-${task.id}`);
		expect(state.creationNotices[0]?.nextAt).toBe(task.nextAt);
		expect(await host.list("alice")).toHaveLength(1);
		expect(notices).toEqual([]);
	});

	it("resends saved results after deletion without another model call", async () => {
		const { host, harness, binding, delivered } = await setup();
		const waiting = gate();
		harness.setResponses([
			async () => {
				await waiting.promise;
				return fauxAssistantMessage("saved result");
			},
		]);
		const task = await queue(host, binding);
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		await host.delete("alice", task.id);
		waiting.release();
		await host.waitForIdle();
		const run = (await host.history("alice"))[0]!;
		await host.resend("alice", run.id);
		expect(delivered.map((item) => item.result)).toEqual(["saved result", "saved result"]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(await host.list("alice")).toEqual([]);
	});

	it("does not use an earlier successful answer when this model request fails", async () => {
		const { host, harness, binding, delivered } = await setup();
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux failure" })]);
		await queue(host, binding);
		await host.waitForIdle();
		expect(delivered[0]?.status).toBe("failed");
		expect(delivered[0]?.result).toBeUndefined();
		expect(delivered[0]?.error).toContain("faux failure");
	});

	it("cancels only its background child during shutdown and allows origin detach", async () => {
		const { host, harness, binding } = await setup();
		const waiting = gate();
		harness.setResponses([
			async () => {
				await waiting.promise;
				return fauxAssistantMessage("late");
			},
			fauxAssistantMessage("chat unaffected"),
		]);
		await queue(host, binding);
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		await host.reserveSessionFile(binding.sessionFile);
		host.detach(harness.session);
		const closing = host.close();
		await harness.session.prompt("Still here");
		expect(JSON.stringify(harness.session.messages)).toContain("chat unaffected");
		waiting.release();
		await closing;
	});

	it("rejects a writable open of an active child while allowing the original", async () => {
		const { host, harness, binding } = await setup();
		const waiting = gate();
		harness.setResponses([
			async () => {
				await waiting.promise;
				return fauxAssistantMessage("done");
			},
		]);
		await queue(host, binding);
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		const run = (await host.history("alice"))[0]!;
		await expect(host.reserveSessionFile(run.execution!.sessionFile)).rejects.toThrow("read-only");
		await expect(host.reserveSessionFile(binding.sessionFile)).resolves.toBeTypeOf("function");
		waiting.release();
		await host.waitForIdle();
	});

	it("migrates legacy state with backup and does not rerun unknown started work or send old receipts", async () => {
		const { host, harness, binding, directory, options } = await setup();
		const task = await host.create(binding, { title: "migration", prompt: "Run", after_seconds: 60 });
		await host.close();
		const run: ScheduleRun = {
			id: "old-running",
			taskId: task.id,
			title: task.title,
			prompt: task.prompt,
			binding,
			occurrenceAt: task.createdAt,
			manual: true,
			status: "running",
			delivery: "pending",
		};
		const legacy = { version: 1, tasks: [task], runs: [run] };
		await writeFile(join(directory, "schedule", "state.json"), JSON.stringify(legacy));
		const reopened = createScheduleHost(options);
		hosts.push(reopened);
		await reopened.start();
		await reopened.waitForIdle();
		expect((await reopened.history("alice"))[0]?.status).toBe("interrupted");
		expect(harness.faux.state.callCount).toBe(0);
		const files = await readdir(join(directory, "schedule"));
		const backup = files.find((file) => file.endsWith("backup.json"))!;
		expect(JSON.parse(await readFile(join(directory, "schedule", backup), "utf8"))).toEqual(legacy);
	});

	it("catches up only the latest interval after restart and resumes without paused catch-up", async () => {
		const { host, harness, binding, setTime } = await setup();
		const task = await host.create(binding, { title: "poll", prompt: "Run", every_seconds: 60 });
		await host.close();
		setTime(Date.parse("2026-10-18T00:00:15Z"));
		harness.setResponses([fauxAssistantMessage("latest")]);
		await host.start();
		await host.waitForIdle();
		expect((await host.history("alice"))[0]?.occurrenceAt).toBe("2026-10-18T00:00:00.000Z");
		await host.update("alice", task.id, { paused: true });
		setTime(Date.parse("2026-10-19T00:00:15Z"));
		await host.update("alice", task.id, { paused: false });
		await host.tick();
		expect(await host.history("alice")).toHaveLength(1);
		expect((await host.list("alice"))[0]?.nextAt).toBe("2026-10-19T00:01:00.000Z");
	});

	it("retains pending results and at most 200 acknowledged recent runs", async () => {
		const { host, binding, directory } = await setup();
		const task = await host.create(binding, { title: "retention", prompt: "Run", after_seconds: 60 });
		await host.close();
		const path = join(directory, "schedule", "state.json");
		const state = JSON.parse(await readFile(path, "utf8")) as ScheduleState;
		const saved: ScheduleRun = {
			id: "pending",
			taskId: task.id,
			title: task.title,
			prompt: task.prompt,
			binding,
			occurrenceAt: "2026-01-01T00:00:00Z",
			finishedAt: "2026-01-01T00:00:00Z",
			manual: false,
			status: "succeeded",
			delivery: "pending",
		};
		state.runs = [
			saved,
			...Array.from({ length: 201 }, (_, index) => ({
				...saved,
				id: `recent-${index}`,
				occurrenceAt: task.createdAt,
				finishedAt: task.createdAt,
				delivery: "sent" as const,
			})),
		];
		await writeFile(path, JSON.stringify(state));
		const reopened = createScheduleHost({
			storageDir: join(directory, "schedule"),
			clock: () => Date.parse(task.createdAt),
			createExecutionSession: async () => {
				throw new Error("Unexpected");
			},
			deliverNotification: async () => "pending",
		});
		hosts.push(reopened);
		await reopened.start();
		await reopened.waitForIdle();
		expect(await reopened.history("alice")).toHaveLength(201);
		expect((await reopened.history("alice")).some((run) => run.id === "pending")).toBe(true);
	});

	it("rechecks wall time after preparation and bounds long timer waits", async () => {
		const { host, harness, binding, options, executionOptions, setTime } = await setup();
		await host.close();
		const waiting = gate();
		let preparing = false;
		const scheduler = createScheduleHost({
			...options,
			createExecutionSession: async (run, signal) => {
				preparing = true;
				await waiting.promise;
				return createScheduleExecutionSession(run, { ...executionOptions, signal });
			},
		});
		hosts.push(scheduler);
		await scheduler.start();
		const task = await scheduler.create(binding, { title: "clock", prompt: "Run", after_seconds: 60 });
		setTime(Date.parse(task.nextAt!));
		await scheduler.tick();
		await vi.waitFor(() => expect(preparing).toBe(true));
		setTime(Date.parse(task.createdAt));
		waiting.release();
		await scheduler.waitForIdle();
		expect((await scheduler.history("alice"))[0]?.status).toBe("queued");
		expect(harness.faux.state.callCount).toBe(0);
		harness.setResponses([fauxAssistantMessage("on time")]);
		setTime(Date.parse(task.nextAt!));
		await scheduler.tick();
		await scheduler.waitForIdle();
		expect((await scheduler.history("alice"))[0]?.result).toBe("on time");
		const timer = vi.spyOn(globalThis, "setTimeout");
		await scheduler.create(binding, { title: "distant", prompt: "Wait", after_seconds: 3_000_000 });
		await scheduler.tick();
		expect(timer.mock.calls.some((call) => call[1] === 60_000)).toBe(true);
	});
});
