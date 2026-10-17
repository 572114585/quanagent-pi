import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createScheduleHost, type ScheduleHost } from "../../src/core/schedule/host.ts";
import type { ScheduleBinding, ScheduleNotification } from "../../src/core/schedule/types.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createScheduleExtension } from "../../src/extensions/schedule/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const hosts: ScheduleHost[] = [];
const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.close();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function openForeground(
	binding: ScheduleBinding,
	options: {
		session: Pick<CreateAgentSessionOptions, "modelRuntime" | "tools">;
		resources: Omit<ConstructorParameters<typeof DefaultResourceLoader>[0], "cwd" | "agentDir">;
	},
) {
	const resourceLoader = new DefaultResourceLoader({
		...options.resources,
		cwd: binding.cwd,
		agentDir: binding.agentDir,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		...options.session,
		cwd: binding.cwd,
		agentDir: binding.agentDir,
		sessionManager: SessionManager.open(binding.sessionFile),
		resourceLoader,
	});
	await session.bindExtensions({ mode: "print" });
	return {
		session,
		release: async () => {
			await session.abort();
			session.dispose();
		},
	};
}

describe("schedule extension", () => {
	it("queues a durable receipt before a failed model confirmation without duplicating the task", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-schedule-receipt-"));
		directories.push(directory);
		const notices: ScheduleNotification[] = [];
		const host = createScheduleHost({
			storageDir: join(directory, "schedule"),
			createExecutionSession: async () => {
				throw new Error("Must not execute yet");
			},
			deliverNotification: async (notice) => {
				notices.push(notice);
				return "sent";
			},
		});
		hosts.push(host);
		const harness = await createHarness({
			sessionManager: SessionManager.create(directory, join(directory, "sessions")),
			settings: { retry: { enabled: false } },
			extensionFactories: [createScheduleExtension(host, { ownerId: "alice", agentDir: directory, ui: false })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("schedule_create", { title: "Saved first", prompt: "Generate later", after_seconds: 3600 }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "confirmation timed out" }),
		]);
		await harness.session.prompt("Schedule this");
		await host.tick();
		const tasks = await host.list("alice");
		expect(tasks).toHaveLength(1);
		expect(notices.filter((notice) => notice.kind === "task-created").map((notice) => notice.id)).toEqual([
			`task-created-${tasks[0]!.id}`,
		]);
		expect(await host.history("alice")).toEqual([]);
	});
	it("exposes native scheduling when a host resumes a conversation created before the extension existed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-schedule-legacy-"));
		directories.push(directory);
		const harness = await createHarness();
		harnesses.push(harness);
		const manager = SessionManager.create(directory, join(directory, "sessions"));
		manager.appendModelChange(harness.getModel().provider, harness.getModel().id);
		manager.appendMessage({
			role: "system",
			content: "",
			toolsAdded: ["read", "bash", "edit", "write"].map((name) => ({
				name,
				description: name,
				parameters: { type: "object", properties: {} },
			})),
			timestamp: Date.now(),
		});
		manager.appendMessage({ role: "user", content: "Keep the previous conversation", timestamp: Date.now() });
		const binding = {
			ownerId: "alice",
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			cwd: directory,
			agentDir: directory,
			delivery: { channel: "local" as const },
		};
		const host = createScheduleHost({
			storageDir: join(directory, "schedule"),
			createExecutionSession: async () => {
				throw new Error("Unexpected background restore");
			},
		});
		hosts.push(host);
		const lease = await openForeground(binding, {
			session: { modelRuntime: harness.session.modelRuntime },
			resources: {
				noSkills: true,
				noThemes: true,
				noContextFiles: true,
				noPromptTemplates: true,
				extensionFactories: [
					createScheduleExtension(host, {
						ownerId: "alice",
						agentDir: directory,
						ui: false,
						activateToolsOnStart: true,
					}),
				],
			},
		});
		try {
			expect(lease.session.getActiveToolNames()).toContain("schedule_create");
			expect(lease.session.getActiveToolNames()).toContain("schedule_list");
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("schedule_create", {
						title: "Native reminder",
						prompt: "Return to this conversation",
						after_seconds: 3600,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Created with the native scheduler"),
			]);
			await lease.session.prompt("Create a one-shot reminder");
			expect(await host.list("alice")).toHaveLength(1);
			expect(
				lease.session.messages.some((message) => message.role === "toolResult" && message.toolName === "bash"),
			).toBe(false);
		} finally {
			await lease.release();
		}
		const restricted = await openForeground(binding, {
			session: { modelRuntime: harness.session.modelRuntime, tools: ["read"] },
			resources: {
				noSkills: true,
				noThemes: true,
				noContextFiles: true,
				noPromptTemplates: true,
				extensionFactories: [createScheduleExtension(host, { ui: false, activateToolsOnStart: true })],
			},
		});
		try {
			expect(restricted.session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			await restricted.release();
		}
	});
	it("creates tasks through the real tool pipeline and preserves their original user", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-schedule-tools-"));
		directories.push(directory);
		let harness: Harness;
		const host = createScheduleHost({
			storageDir: join(directory, "schedule"),
			createExecutionSession: async () => {
				throw new Error("Unexpected execution");
			},
		});
		hosts.push(host);
		const factory = createScheduleExtension(host, {
			ownerId: "alice",
			agentDir: directory,
			ui: false,
			getSession: () => harness.session,
		});
		harness = await createHarness({
			sessionManager: SessionManager.create(directory, join(directory, "sessions")),
			extensionFactories: [factory],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("schedule_create", {
					title: "Daily review",
					prompt: "Review progress",
					daily: { time: "09:00", time_zone: "Asia/Shanghai" },
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Created"),
		]);
		await harness.session.prompt("Create the reminder");
		const task = (await host.list("alice"))[0]!;
		expect(task.binding.ownerId).toBe("alice");
		expect(task.binding.sessionId).toBe(harness.session.sessionId);
		expect(getToolResult(harness, "schedule_create").isError).not.toBe(true);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("schedule_update", { id: task.id, paused: true, expected_revision: task.revision }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Paused"),
		]);
		await harness.session.prompt("Pause the reminder");
		expect((await host.list("alice"))[0]?.status).toBe("paused");
		expect(await host.list("bob")).toEqual([]);
		await harness.session.reload();
		expect(host.isStarted).toBe(true);
		expect(await host.list("alice")).toHaveLength(1);
		expect((await host.list("alice"))[0]?.status).toBe("paused");
	});

	it("does not start a scheduler when the invocation is disabled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-schedule-disabled-"));
		directories.push(directory);
		const host = createScheduleHost({
			storageDir: join(directory, "schedule"),
			createExecutionSession: async () => {
				throw new Error("Must not restore anything");
			},
		});
		hosts.push(host);
		const harness = await createHarness({
			extensionFactories: [createScheduleExtension(host, { isEnabled: () => false })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });
		expect(host.isStarted).toBe(false);
		harness.setResponses([fauxAssistantMessage("ordinary response")]);
		await harness.session.prompt("Ordinary one-shot work");
		expect(host.isStarted).toBe(false);
	});
});
