import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	type AgentSession,
	type AgentSessionEvent,
	ScheduleDeliveryContextError,
	type ScheduleRun,
} from "@earendil-works/pi-coding-agent";
import { NoContextError } from "@wechatbot/wechatbot";
import { promptForReply } from "../src/chat.ts";
import { loadConfig } from "../src/config.ts";
import { extractMediaPaths } from "../src/media.ts";
import { createWeixinScheduleAdapter, weixinBindingId } from "../src/scheduling.ts";
import { openUserSession, saveUserSession } from "../src/session-state.ts";

test("file paths support Windows separators, Unicode, spaces and Markdown links", () => {
	const windows = "C:\\reports\\每日报告 final.pdf";
	const unix = "/reports/weekly report.xlsx";
	assert.deepEqual(extractMediaPaths(`文件：\`${windows}\`\n[表格](${unix})`), [windows, unix]);
});

test("scheduled results send text and attachments using the supplied recipient", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-weixin-schedule-"));
	try {
		const path = join(directory, "weekly_report.pdf");
		await writeFile(path, "report bytes");
		const sent: Array<{ user: string; value: unknown }> = [];
		const adapter = createWeixinScheduleAdapter(
			{
				send: async (user, value) => {
					sent.push({ user, value });
				},
			},
			{ ownerId: "owner", isAuthorized: (user) => user === "alice" },
		);
		const run: ScheduleRun = {
			id: "run",
			taskId: "task",
			title: "Weekly report",
			prompt: "Generate",
			occurrenceAt: "2026-10-17T00:00:00Z",
			manual: false,
			status: "succeeded",
			result: `完成报告\n${path}`,
			delivery: "pending",
			binding: {
				ownerId: "alice",
				sessionId: "session",
				sessionFile: join(directory, "session.jsonl"),
				cwd: directory,
				agentDir: directory,
				delivery: { channel: "weixin", bindingId: "bridge", userId: "alice" },
			},
		};
		const parts = await adapter.prepare({ kind: "run-result", id: run.id, binding: run.binding, run });
		const receipt = await adapter.prepare({
			kind: "task-created",
			id: "task-created-task",
			taskId: run.taskId,
			title: run.title,
			binding: run.binding,
			createdAt: run.occurrenceAt,
			nextAt: run.occurrenceAt,
			timeZone: "Asia/Shanghai",
			delivery: "pending",
		});
		assert.equal(receipt.length, 1);
		assert.match(receipt[0]!.kind === "text" ? receipt[0]!.text : "", /独立后台会话/);
		assert.equal(parts.length, 2);
		for (const part of parts) await adapter.send("alice", part);
		assert.equal(sent[0]?.user, "alice");
		assert.equal(sent[1]?.user, "alice");
		assert.deepEqual(parts[1], { kind: "file", path: resolve(path) });
		await assert.rejects(adapter.send("bob", { kind: "text", text: "wrong" }), ScheduleDeliveryContextError);
		const outside = join(directory, "..", "another-user.pdf");
		const blocked = await adapter.prepare({
			kind: "run-result",
			id: run.id,
			binding: run.binding,
			run: { ...run, result: `not allowed\n${outside}` },
		});
		assert.equal(
			blocked.some((part) => part.kind === "file"),
			false,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("foreground failure uses this turn's events and never a previous reply", async () => {
	let emit: ((event: AgentSessionEvent) => void) | undefined;
	let unsubscribed = false;
	const session: Pick<AgentSession, "subscribe" | "prompt" | "waitForIdle"> = {
		subscribe: (listener) => {
			emit = listener;
			return () => {
				unsubscribed = true;
			};
		},
		prompt: async () => {
			emit?.({ type: "agent_settled", aborted: false });
			throw new Error("confirmation timed out");
		},
		waitForIdle: async () => {},
	};
	assert.deepEqual(await promptForReply(session, "Create a task"), { error: "confirmation timed out" });
	assert.equal(unsubscribed, true);
});

test("background timeout configuration defaults to sixty minutes and validates input", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-weixin-config-"));
	try {
		await writeFile(
			join(directory, "config.json"),
			JSON.stringify({ owner: "owner", allowlist: [], provider: "faux", model: "faux-1" }),
		);
		assert.equal((await loadConfig(directory)).schedule.runTimeoutMinutes, 60);
		for (const minutes of [0, -1, "60", 1.5, 40000]) {
			await writeFile(
				join(directory, "config.json"),
				JSON.stringify({
					owner: "owner",
					allowlist: [],
					provider: "faux",
					model: "faux-1",
					schedule: { runTimeoutMinutes: minutes },
				}),
			);
			await assert.rejects(loadConfig(directory), /runTimeoutMinutes/);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing Weixin context remains a delivery failure, not another model execution", async () => {
	const adapter = createWeixinScheduleAdapter(
		{
			send: async () => {
				throw new NoContextError("alice");
			},
		},
		{ ownerId: "alice", isAuthorized: () => true },
	);
	await assert.rejects(adapter.send("alice", { kind: "text", text: "saved output" }), ScheduleDeliveryContextError);
	assert.equal(weixinBindingId("account"), weixinBindingId("account"));
	assert.notEqual(weixinBindingId("account"), weixinBindingId("other"));
});

test("user session pointers restore the original context after collection or restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-weixin-session-"));
	try {
		const cwd = join(directory, "work");
		await mkdir(cwd);
		const original = await openUserSession("alice", directory, cwd);
		original.appendMessage({ role: "user", content: "Keep this context", timestamp: Date.now() });
		await saveUserSession("alice", directory, original);
		const restored = await openUserSession("alice", directory, cwd);
		assert.equal(restored.getSessionId(), original.getSessionId());
		assert.equal(
			restored
				.buildSessionContext()
				.messages.some(
					(message) => message.role === "user" && JSON.stringify(message.content).includes("Keep this context"),
				),
			true,
		);
		await assert.rejects(openUserSession("bob", directory, cwd), /mapping/);
		const path = original.getSessionFile();
		assert.ok(path);
		await unlink(path);
		await assert.rejects(openUserSession("alice", directory, cwd), /ENOENT/);
		assert.equal(JSON.parse(await readFile(join(directory, "current-session.json"), "utf8")).userId, "alice");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
