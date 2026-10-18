import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	getDefaultSessionDir,
	isSessionBusy,
	ModelRuntime,
	SessionBusyError,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { InMemoryCodingAgentModelsStore } from "../../coding-agent/src/core/models-store.ts";
import { HttpError, WebAuth } from "../src/auth.ts";
import { WebDialogs } from "../src/dialogs.ts";
import { FileStore, MAX_FILE_BYTES } from "../src/files.ts";
import { WebHost } from "../src/host.ts";
import { applyPiEvent, type Envelope, newView, object } from "../src/protocol.ts";
import { createWebServer } from "../src/server.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture(vision = false) {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-test-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.create(join(agentDir, "auth.json")),
		modelsPath: join(agentDir, "models.json"),
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		tokensPerSecond: 100000,
		models: [{ id: "faux-1", name: "Faux Model", input: vision ? ["text", "image"] : ["text"] }],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const host = new WebHost({ cwd, agentDir, modelRuntime: runtime, dataDir: join(directory, "web") });
	cleanup.push(() => host.close());
	return { directory, cwd, agentDir, runtime, faux, host };
}

function finishRun(host: WebHost, id: string): { done: Promise<Envelope[]>; events: Envelope[] } {
	const events: Envelope[] = [];
	let finish: (events: Envelope[]) => void = () => {};
	const done = new Promise<Envelope[]>((resolve) => {
		finish = resolve;
	});
	const unsubscribe = host.subscribe(id, host.snapshot(id).cursor, (event) => {
		if (!("id" in event)) return;
		events.push(event);
		if (object(event.event).type === "run_finished") {
			unsubscribe();
			finish(events);
		}
	});
	return { done, events };
}

test("native deltas retain content order, authoritative finals, duplicate timestamps and settled boundaries", () => {
	const state = newView();
	applyPiEvent(state, { type: "agent_start" });
	applyPiEvent(state, { type: "message_start", message: { role: "assistant", timestamp: 1, content: [] } });
	for (const update of [
		{ type: "thinking_delta", contentIndex: 0, delta: "plan" },
		{ type: "text_delta", contentIndex: 1, delta: "partial" },
		{ type: "toolcall_start", contentIndex: 2, id: "call", toolName: "read" },
	])
		applyPiEvent(state, { type: "message_update", assistantMessageEvent: update });
	assert.equal(state.messages[0].content[0].thinking, "plan");
	applyPiEvent(state, {
		type: "message_end",
		message: {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "final" },
				{ type: "toolCall", id: "call", name: "read", arguments: {} },
			],
		},
	});
	applyPiEvent(state, {
		type: "tool_execution_update",
		toolCallId: "call",
		toolName: "read",
		partialResult: { content: [{ type: "text", text: "partial output" }] },
	});
	applyPiEvent(state, {
		type: "tool_execution_end",
		toolCallId: "call",
		toolName: "read",
		result: { content: [{ type: "text", text: "done" }] },
		isError: true,
	});
	applyPiEvent(state, { type: "message_start", message: { role: "assistant", timestamp: 1, content: [] } });
	applyPiEvent(state, {
		type: "message_end",
		message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "second" }] },
	});
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[0].content[0].text, "final");
	assert.equal(state.tools.call.status, "failed");
	assert.equal(state.tools.call.output, "done");
	applyPiEvent(state, { type: "agent_end", willRetry: true });
	assert.equal(state.running, true);
	applyPiEvent(state, { type: "compaction_start" });
	assert.match(state.status, /上下文/);
	applyPiEvent(state, { type: "agent_settled", aborted: true });
	assert.equal(state.running, false);
});

test(
	"faux provider streams thinking, executes tools, restores shared history, and replays cursor events",
	{ timeout: 20000 },
	async () => {
		const { host, faux, cwd, agentDir, runtime } = await fixture();
		await writeFile(join(cwd, "report.md"), "# report");
		faux.setResponses([
			fauxAssistantMessage(
				[fauxThinking("inspect"), fauxToolCall("publish_artifact", { path: "report.md" }, { id: "publish" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Report ready"),
		]);
		const initial = host.create();
		const { done } = finishRun(host, initial.id);
		const runId = host.start(initial.id, { message: "create report", model: { provider: "faux", id: "faux-1" } });
		assert.ok(runId);
		assert.throws(() => host.start(initial.id, { message: "again" }), HttpError);
		const events = await done;
		assert.equal(
			events
				.filter((event) => object(event.event).type === "run_error")
				.map((event) => object(event.event).message)
				.join(""),
			"",
		);
		assert.ok(events.some((event) => object(event.event).type === "tool_execution_end"));
		assert.ok(events.some((event) => object(event.event).type === "agent_settled"));
		assert.equal(host.snapshot(initial.id).messages.filter((message) => message.role === "assistant").length, 2);
		assert.equal(host.snapshot(initial.id).files[0].name, "report.md");
		const path = SessionManager.findById(cwd, initial.id, getDefaultSessionDir(cwd, agentDir));
		// Custom agentDir sessions are discoverable from their shared session directory.
		const listed = await host.list();
		assert.ok(listed.some((item) => item.id === initial.id));
		assert.equal(host.snapshot(initial.id).busy, false);
		const replay: Envelope[] = [];
		const off = host.subscribe(initial.id, events[0].id, (event) => {
			if ("id" in event) replay.push(event);
		});
		off();
		assert.deepEqual(
			replay.map((event) => event.id),
			events.slice(1).map((event) => event.id),
		);
		let reset = false;
		host.subscribe(initial.id, "old-process.1", (event) => {
			if ("snapshot" in event) reset = true;
		})();
		assert.ok(reset);
		const restarted = new WebHost({ cwd, agentDir, modelRuntime: runtime, dataDir: join(agentDir, "unused") });
		cleanup.push(() => restarted.close());
		assert.equal(restarted.snapshot(initial.id).messages.at(-1)?.content[0].text, "Report ready");
		assert.equal(restarted.snapshot(initial.id).files[0].name, "report.md");
		assert.ok(path?.startsWith(agentDir));
		await host.rename(initial.id, "renamed");
		assert.equal(host.snapshot(initial.id).name, "renamed");
		await host.archive(initial.id);
		assert.throws(() => host.snapshot(initial.id), HttpError);
	},
);

test("stop cancels a live faux run, releases its lease, and allows another prompt", { timeout: 20000 }, async () => {
	const { host, faux } = await fixture();
	faux.setResponses([
		async (_context, options) => {
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
		},
	]);
	const { id } = host.create();
	const { done } = finishRun(host, id);
	let started: () => void = () => {};
	const active = new Promise<void>((resolve) => {
		started = resolve;
	});
	const off = host.subscribe(id, host.snapshot(id).cursor, (event) => {
		if ("id" in event && object(event.event).type === "agent_start") started();
	});
	host.start(id, { message: "wait", model: { provider: "faux", id: "faux-1" } });
	await active;
	await host.stop(id);
	await done;
	off();
	assert.equal(host.snapshot(id).busy, false);
	assert.equal(host.snapshot(id).running, false);
	faux.setResponses([fauxAssistantMessage("continued")]);
	const next = finishRun(host, id);
	host.start(id, { message: "continue" });
	await next.done;
	assert.equal(host.snapshot(id).messages.at(-1)?.content[0].text, "continued");
});

test("two subscribers follow retries and consecutive tool rounds through the final settled event", async () => {
	const { host, faux, cwd, agentDir } = await fixture();
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } }),
	);
	await writeFile(join(cwd, "one.md"), "one");
	await writeFile(join(cwd, "two.md"), "two");
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		fauxAssistantMessage(fauxToolCall("publish_artifact", { path: "one.md" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("publish_artifact", { path: "two.md" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("recovered"),
	]);
	const { id } = host.create();
	const first = finishRun(host, id);
	const second = finishRun(host, id);
	let earlyEnd = false;
	const off = host.subscribe(id, host.snapshot(id).cursor, (event) => {
		if ("id" in event && object(event.event).type === "agent_end") {
			if (!host.snapshot(id).running || !host.snapshot(id).busy) earlyEnd = true;
		}
	});
	host.start(id, { message: "recover and publish twice", model: { provider: "faux", id: "faux-1" } });
	const [events, mirrored] = await Promise.all([first.done, second.done]);
	off();
	assert.equal(earlyEnd, false);
	assert.deepEqual(
		events.map((event) => event.id),
		mirrored.map((event) => event.id),
	);
	assert.ok(events.some((event) => object(event.event).type === "auto_retry_start"));
	assert.equal(events.filter((event) => object(event.event).type === "tool_execution_end").length, 2);
	assert.equal(events.filter((event) => object(event.event).type === "agent_settled").length, 1);
	assert.equal(events.filter((event) => object(event.event).type === "run_finished").length, 1);
	assert.equal(host.snapshot(id).messages.at(-1)?.content[0].text, "recovered");
	assert.equal(host.snapshot(id).files.length, 2);
});

test("Web reads a CLI-owned session, rejects writes, and continues after the writer leaves", async () => {
	const { host, cwd, agentDir, runtime, faux } = await fixture();
	const manager = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
	manager.appendMessage({ role: "user", content: "terminal history", timestamp: 1 });
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, sessionManager: manager });
	cleanup.push(async () => session.dispose());
	const id = manager.getSessionId();
	assert.equal(host.snapshot(id).messages[0].content[0].text, "terminal history");
	assert.equal(host.snapshot(id).busy, true);
	assert.throws(
		() => host.start(id, { message: "blocked" }),
		(error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "session_busy",
	);
	await assert.rejects(host.rename(id, "blocked"), SessionBusyError);
	await assert.rejects(host.archive(id), SessionBusyError);
	session.dispose();
	faux.setResponses([fauxAssistantMessage("web continuation")]);
	const { done } = finishRun(host, id);
	host.start(id, { message: "continue", model: { provider: "faux", id: "faux-1" } });
	await done;
	assert.equal(host.snapshot(id).messages.at(-1)?.content[0].text, "web continuation");
	assert.equal(host.snapshot(id).busy, false);
});

test(
	"SDK and independent process writers exclude each other; read-only history never repairs files",
	{ timeout: 20000 },
	async () => {
		const { cwd, agentDir, runtime } = await fixture();
		const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const path = manager.getSessionFile()!;
		const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, sessionManager: manager });
		cleanup.push(async () => session.dispose());
		assert.ok(isSessionBusy(path));
		assert.equal(SessionManager.openReadOnly(path).buildSessionContext().messages.length, 1);
		const resolver = new URL("../../coding-agent/src/experimental/source-resolver.ts", import.meta.url).href;
		const childPath = fileURLToPath(new URL("./fixtures/lease-child.ts", import.meta.url));
		const blocked = spawn(process.execPath, ["--import", resolver, childPath, path], { windowsHide: true });
		let output = "";
		let errors = "";
		blocked.stderr.on("data", (chunk: Buffer) => {
			errors += chunk.toString();
		});
		blocked.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		await once(blocked, "exit");
		assert.match(output, /session_busy/, errors);
		session.dispose();
		assert.equal(isSessionBusy(path), false);
		const child = spawn(process.execPath, ["--import", resolver, childPath, path], { windowsHide: true });
		cleanup.push(async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill();
				await once(child, "exit");
			}
		});
		await once(child.stdout, "data");
		assert.throws(() => SessionManager.open(path).acquireWriteLease(), SessionBusyError);
		child.kill("SIGKILL");
		await once(child, "exit");
		// Simulate the stale heartbeat left behind after a crash, without a 30-second test delay.
		if (isSessionBusy(path)) {
			const old = new Date(Date.now() - 40_000);
			await utimes(`${path}.lock`, old, old);
		}
		const release = manager.acquireWriteLease();
		release();
		assert.equal(isSessionBusy(path), false);
		const original = (await readFile(path, "utf8")).trimEnd();
		await writeFile(path, original);
		const before = await stat(path);
		SessionManager.openReadOnly(path);
		assert.equal(await readFile(path, "utf8"), original);
		assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
		const staleManager = SessionManager.openReadOnly(path);
		assert.equal(staleManager.buildSessionContext().messages.length, 1);
	},
);

test("dialogs validate answers, cancel on abort, and expire without approval", async () => {
	const dialogs = new WebDialogs(() => {});
	const ui = dialogs.context();
	const first = ui.confirm("approve", "execute?", { timeout: 10 });
	assert.equal(await first, false);
	const controller = new AbortController();
	const second = ui.select("pick", ["a"], { signal: controller.signal });
	assert.throws(() => dialogs.answer(dialogs.list()[0].id, "b"), HttpError);
	controller.abort();
	assert.equal(await second, undefined);
	const third = ui.editor("edit", "text");
	dialogs.answer(dialogs.list()[0].id, "changed");
	assert.equal(await third, "changed");
	const fourth = ui.input("input");
	dialogs.cancelAll();
	assert.equal(await fourth, undefined);
});

test("SDK setup failures release the writer and stale managers reload before reuse", async () => {
	const { cwd, agentDir, runtime } = await fixture();
	const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
	manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	await assert.rejects(
		createAgentSession({ cwd, agentDir, modelRuntime: runtime, sessionManager: manager, tools: ["+read", "write"] }),
	);
	assert.equal(isSessionBusy(manager.getSessionFile()!), false);
	const writer = SessionManager.open(manager.getSessionFile()!);
	const release = writer.acquireWriteLease();
	writer.appendMessage({ role: "user", content: "newer", timestamp: 2 });
	release();
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, sessionManager: manager });
	try {
		assert.equal(session.messages.filter((message) => message.role === "user").length, 2);
	} finally {
		session.dispose();
	}
});

test("disposing an active SDK session keeps its writer until the aborted turn is persisted", async () => {
	const { cwd, agentDir, runtime, faux } = await fixture();
	const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
	let started: () => void = () => {};
	const active = new Promise<void>((resolve) => {
		started = resolve;
	});
	let finish: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	cleanup.push(async () => finish());
	faux.setResponses([
		async () => {
			started();
			await gate;
			return fauxAssistantMessage("stopped", { stopReason: "aborted" });
		},
	]);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		sessionManager: manager,
		model: runtime.getModel("faux", "faux-1"),
	});
	const prompt = session.prompt("wait");
	await active;
	session.dispose();
	assert.equal(isSessionBusy(manager.getSessionFile()!), true);
	assert.throws(() => SessionManager.open(manager.getSessionFile()!).acquireWriteLease(), SessionBusyError);
	finish();
	await prompt;
	await session.waitForIdle();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(isSessionBusy(manager.getSessionFile()!), false);
	assert.equal(SessionManager.openReadOnly(manager.getSessionFile()!).getEntries().at(-1)?.type, "message");
});

test(
	"image and document attachments enter Pi input and retain metadata after completion",
	{ timeout: 20000 },
	async () => {
		const { host, faux } = await fixture(true);
		const { id } = host.create();
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		);
		const image = await host.upload(id, "pixel.png", png);
		const document = await host.upload(id, "note.md", Buffer.from("# input"));
		faux.setResponses([
			(context) => {
				const user = context.messages.findLast((message) => message.role === "user");
				assert.ok(user && Array.isArray(user.content));
				assert.ok(user.content.some((block) => block.type === "image"));
				assert.ok(user.content.some((block) => block.type === "text" && block.text.includes("note.md")));
				return fauxAssistantMessage("received attachments");
			},
		]);
		const { done } = finishRun(host, id);
		host.start(id, {
			message: "inspect attachments",
			attachments: [image.id, document.id],
			model: { provider: "faux", id: "faux-1" },
		});
		const events = await done;
		assert.equal(events.filter((event) => object(event.event).type === "run_error").length, 0);
		assert.equal(host.snapshot(id).files.length, 2);
		assert.equal(host.snapshot(id).messages.at(-1)?.content[0].text, "received attachments");
	},
);

test("files survive restart, reject traversal and oversized uploads, and snapshot artifacts", async () => {
	const { directory, cwd } = await fixture();
	const files = new FileStore(join(directory, "files"), cwd);
	const uploaded = await files.save("session", "../../bad.html", Buffer.from("<script>alert(1)</script>"), "upload");
	assert.equal(uploaded.name, "bad.html");
	assert.equal(uploaded.mime, "application/octet-stream");
	assert.equal((await new FileStore(join(directory, "files"), cwd).get(uploaded.id)).info.name, "bad.html");
	await assert.rejects(files.get("../../secret"), HttpError);
	await assert.rejects(files.get(uploaded.id, "other-session"), HttpError);
	await assert.rejects(files.save("session", "big", Buffer.alloc(MAX_FILE_BYTES + 1), "upload"), HttpError);
	await writeFile(join(cwd, "out.pdf"), "%PDF-1.7\nreport");
	const artifact = await files.publish("session", "out.pdf");
	await writeFile(join(cwd, "out.pdf"), "changed");
	assert.equal(await readFile((await files.get(artifact.id)).path, "utf8"), "%PDF-1.7\nreport");
	await writeFile(join(directory, "outside"), "secret");
	await assert.rejects(files.publish("session", "../outside"), HttpError);
	await writeFile(
		join(directory, "files", `${uploaded.id}.json`),
		JSON.stringify({ ...uploaded, url: "javascript:alert(1)" }),
	);
	await assert.rejects(files.get(uploaded.id), HttpError);
});

test(
	"HTTPS cookie auth, origin checks, rate limits, protected files/SSE and credential persistence",
	{ timeout: 20000 },
	async () => {
		const { host, directory, agentDir, faux } = await fixture();
		let now = Date.now();
		const origin = "https://pi.example.test";
		const auth = new WebAuth("admin", "test-password-long", origin, () => now);
		const server = createWebServer({ host, auth, staticDir: directory });
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanup.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
		assert.equal((await fetch(`${base}/api/files/no-file`)).status, 401);
		assert.equal((await fetch(`${base}/api/sessions/no-session/events`)).status, 401);
		const login = (password: string, requestOrigin = origin) =>
			fetch(`${base}/api/auth/login`, {
				method: "POST",
				headers: { Origin: requestOrigin, "Content-Type": "application/json" },
				body: JSON.stringify({ username: "admin", password }),
			});
		assert.equal((await login("test-password-long", "https://other.test")).status, 403);
		const signedIn = await login("test-password-long");
		assert.equal(signedIn.status, 200);
		const header = signedIn.headers.get("set-cookie")!;
		assert.match(header, /HttpOnly/);
		assert.match(header, /Secure/);
		assert.match(header, /SameSite=Strict/);
		const cookie = header.split(";")[0];
		const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
		const created = await fetch(`${base}/api/sessions`, { method: "POST", headers });
		assert.equal(created.status, 201);
		const sessionId = String(object(await created.json()).id);
		const upload = await fetch(`${base}/api/sessions/${sessionId}/uploads`, {
			method: "POST",
			headers: { ...headers, "X-File-Name": "test.svg" },
			body: "<svg><script>bad()</script></svg>",
		});
		assert.equal(upload.status, 201);
		const uploaded = object(await upload.json());
		const downloaded = await fetch(`${base}${String(uploaded.url)}`, { headers });
		assert.equal(downloaded.headers.get("content-type"), "application/octet-stream");
		assert.match(downloaded.headers.get("content-disposition")!, /attachment/);
		assert.equal(
			(
				await fetch(`${base}/api/sessions/${sessionId}/uploads`, {
					method: "POST",
					headers: { ...headers, "X-File-Name": "big.bin" },
					body: Buffer.alloc(MAX_FILE_BYTES + 1),
				})
			).status,
			413,
		);
		let releaseResponse: () => void = () => {};
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		cleanup.push(async () => releaseResponse());
		faux.setResponses([
			async (_context, options) => {
				options?.signal?.addEventListener("abort", releaseResponse, { once: true });
				await responseGate;
				return fauxAssistantMessage("survived disconnect");
			},
		]);
		const run = finishRun(host, sessionId);
		const firstStream = new AbortController();
		const stream = await fetch(`${base}/api/sessions/${sessionId}/events?after=${host.snapshot(sessionId).cursor}`, {
			headers,
			signal: firstStream.signal,
		});
		const reader = stream.body!.getReader();
		assert.equal(
			(
				await fetch(`${base}/api/sessions/${sessionId}/messages`, {
					method: "POST",
					headers,
					body: JSON.stringify({ message: "wait", model: { provider: "faux", id: "faux-1" } }),
				})
			).status,
			202,
		);
		const firstChunk = new TextDecoder().decode((await reader.read()).value);
		const firstCursor = /^id: (.+)$/m.exec(firstChunk)![1];
		firstStream.abort();
		releaseResponse();
		await run.done;
		assert.equal(host.snapshot(sessionId).messages.at(-1)?.content[0].text, "survived disconnect");
		const secondStream = new AbortController();
		const resumed = await fetch(`${base}/api/sessions/${sessionId}/events?after=old-process.0`, {
			headers: { ...headers, "Last-Event-ID": firstCursor },
			signal: secondStream.signal,
		});
		const replay = new TextDecoder().decode((await resumed.body!.getReader().read()).value);
		assert.ok(!replay.includes(`id: ${firstCursor}\n`));
		assert.ok(!replay.includes("event: snapshot"));
		secondStream.abort();
		assert.equal(
			(
				await fetch(`${base}/api/sessions`, {
					method: "POST",
					headers: { ...headers, Origin: "https://other.test" },
				})
			).status,
			403,
		);
		const key = "test-api-key-secret";
		const configured = await fetch(`${base}/api/providers/custom`, {
			method: "PUT",
			headers,
			body: JSON.stringify({
				baseUrl: "https://example.invalid/v1",
				api: "openai-completions",
				modelId: "test-model",
				apiKey: key,
			}),
		});
		assert.equal(configured.status, 200, await configured.text());
		assert.ok(!(await (await fetch(`${base}/api/models`, { headers })).text()).includes(key));
		const restored = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
		});
		assert.ok(restored.getModel("custom", "test-model"));
		assert.ok(restored.hasConfiguredAuth("custom"));
		assert.equal((await fetch(`${base}/api/providers/custom`, { method: "DELETE", headers })).status, 200);
		await fetch(`${base}/api/auth/logout`, { method: "POST", headers });
		assert.equal((await fetch(`${base}/api/sessions`, { headers })).status, 401);
		for (let attempt = 0; attempt < 5; attempt++) assert.equal((await login("wrong")).status, 401);
		assert.equal((await login("wrong")).status, 429);
		now += 60_001;
		const renewed = await login("test-password-long");
		const renewedCookie = renewed.headers.get("set-cookie")!.split(";")[0];
		now += 7 * 24 * 3600_000 + 1;
		assert.equal((await fetch(`${base}/api/sessions`, { headers: { Cookie: renewedCookie } })).status, 401);
	},
);
