/**
 * 微信桥接守护进程（阶段三/四：多用户 + 媒体消息）
 *
 * WeChatBot 长轮询收消息 → 白名单过滤 → 每用户串行队列 →
 * 媒体下载落盘（图片走 vision 输入，语音/视频/文件降级为描述 + 本地路径）→
 * pi session.prompt()（await 整个 run）→ 取最终助手文本 →
 * stripMarkdown → 媒体路径回传微信 / 文本发回。
 *
 * 运行: npm run start:weixin（仓库根目录）
 * 配置: config.json（白名单准入，名单外拒绝；所有白名单用户默认完整工具）
 * 用户区: workspace/<userId>/{work,.pi-agent}
 * 鉴权: 显式共享宿主 ~/.pi/agent 的 ModelRuntime（models.json）
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	createAgentSession,
	createScheduleExecutionSession,
	createScheduleExtension,
	createScheduleHost,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	ScheduleOutbox,
	type ScheduleOutboxWorker,
} from "@earendil-works/pi-coding-agent";
import type { IncomingMessage, WeChatBot } from "@wechatbot/wechatbot";
import { BridgeBot } from "./bot.ts";
import { promptForReply } from "./chat.ts";
import { type BridgeConfig, getRole, loadConfig, type UserRole } from "./config.ts";
import { acquireBridgeLocks, BridgeControl, bridgePaths } from "./control.ts";
import { buildPiPrompt, getQuotedRef, type RefMessage, sendReply } from "./media.ts";
import type { BridgeCommand } from "./protocol.ts";
import { createWeixinScheduleAdapter, weixinBindingId } from "./scheduling.ts";
import { openUserSession, saveUserSession } from "./session-state.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const paths = bridgePaths(getAgentDir());
const BRIDGE_ROOT = paths.root;
const WORKSPACE_ROOT = join(BRIDGE_ROOT, "workspace");
// 空闲超过该时长的会话被回收（释放内存），下次消息时重建（历史自动恢复）
const SESSION_IDLE_MS = 30 * 60 * 1000;

function log(message: string, data?: unknown) {
	const suffix = data !== undefined ? ` ${JSON.stringify(data)}` : "";
	process.stderr.write(`${new Date().toISOString()} ${message}${suffix}\n`);
}

function sanitizeForFs(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const managed = process.env.PI_WEIXIN_MANAGED === "1" && typeof process.send === "function";
const control = new BridgeControl((status) => {
	if (managed && process.connected) process.send?.({ type: "weixin-status", status }, () => {});
});
let releaseLocks: (() => Promise<void>) | undefined;
let startupError = "configuration_invalid";
let stopping = false;
async function runBridge(): Promise<void> {
	// Load existing configuration first, retaining the standalone missing-config error.
	let config: BridgeConfig;
	let newConfig = false;
	try {
		config = await loadConfig(BRIDGE_ROOT);
	} catch (error) {
		if (!managed || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (!process.env.PI_WEIXIN_SETUP_PROVIDER || !process.env.PI_WEIXIN_SETUP_MODEL) throw error;
		newConfig = true;
		config = {
			owner: "",
			allowlist: [],
			provider: process.env.PI_WEIXIN_SETUP_PROVIDER,
			model: process.env.PI_WEIXIN_SETUP_MODEL,
			schedule: { runTimeoutMinutes: 60 },
		};
	}
	startupError = "bridge_busy";
	releaseLocks = await acquireBridgeLocks(BRIDGE_ROOT, paths.storage);
	startupError = "model_unavailable";
	log("config loaded", { owner: config.owner, allowlist: config.allowlist.length });

	// 共享宿主 ~/.pi/agent 的鉴权与模型配置；会话目录按用户隔离
	const modelRuntime = await ModelRuntime.create();
	const model = modelRuntime.getModel(config.provider, config.model);
	if (!model) {
		log(`model ${config.provider}/${config.model} not found in model runtime`);
		throw new Error("model_unavailable");
	}

	interface SessionEntry {
		session: AgentSession;
		workDir: string;
		lastUsed: number;
	}

	const sessions = new Map<string, SessionEntry>();
	const scheduleOutbox = new ScheduleOutbox(join(getAgentDir(), "schedule-delivery"));
	let bindingId = "";
	let deliveryWorker: ScheduleOutboxWorker | undefined;
	const scheduleHost = createScheduleHost({
		storageDir: join(WORKSPACE_ROOT, ".schedule"),
		ownerConcurrency: 1,
		runTimeoutMs: config.schedule.runTimeoutMinutes * 60_000,
		createExecutionSession: async (run, signal) => {
			const binding = run.binding;
			signal.throwIfAborted();
			const userId = binding.ownerId;
			const role = getRole(config, userId);
			if (!role) throw new Error("The task's user is no longer authorized.");
			const userDir = join(WORKSPACE_ROOT, sanitizeForFs(userId));
			if (
				resolve(binding.cwd) !== resolve(userDir, "work") ||
				resolve(binding.agentDir) !== resolve(userDir, ".pi-agent")
			)
				throw new Error("Scheduled workspace does not belong to this user.");
			const rel = relative(resolve(binding.agentDir, "sessions"), resolve(binding.sessionFile));
			if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
				throw new Error("The source session is outside this user's session directory.");
			const existing = sessions.get(userId)?.session;
			return createScheduleExecutionSession(run, {
				storageDir: join(WORKSPACE_ROOT, ".schedule"),
				signal,
				source: existing?.sessionId === binding.sessionId ? existing : undefined,
				session: { modelRuntime, model },
				projectTrusted: true,
				resources: {
					extensionFactories: [
						createScheduleExtension(scheduleHost, {
							background: true,
							timeZone: run.timeZone,
							ownerId: userId,
							ui: false,
							getBinding: () => binding,
						}),
					],
				},
			});
		},
		deliverNotification: async (notice, resend) => {
			const status = await scheduleOutbox.enqueueNotification(notice, resend);
			void deliveryWorker?.flush();
			return status;
		},
		onError: (error) => log(`schedule: ${error.message}`),
	});

	function scheduleExtension(userId: string) {
		return createScheduleExtension(scheduleHost, {
			ownerId: userId,
			ui: false,
			activateToolsOnStart: true,
			outbox: scheduleOutbox,
			getSession: (ctx) => {
				const session = sessions.get(userId)?.session;
				return session?.sessionId === ctx.sessionManager.getSessionId() ? session : undefined;
			},
			getBinding: (ctx) => {
				if (!bindingId) throw new Error("Weixin delivery is not initialized.");
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("A persisted conversation is required.");
				return {
					ownerId: userId,
					sessionId: ctx.sessionManager.getSessionId(),
					sessionFile,
					cwd: ctx.cwd,
					agentDir: join(WORKSPACE_ROOT, sanitizeForFs(userId), ".pi-agent"),
					delivery: { channel: "weixin", bindingId, userId },
				};
			},
		});
	}

	// 会话用每用户 agentDir，全局 ~/.pi/agent/settings.json 不会被读取，
	// 因此需要在用户区写入 settings.json（如 shellPath 指向非标准位置的 Git Bash）
	function ensureUserSettings(userDir: string): void {
		if (!config.shellPath) return;
		const agentDir = join(userDir, ".pi-agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsPath = join(agentDir, "settings.json");
		let settings: Record<string, unknown> = {};
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		} catch {
			// 不存在或损坏则重建
		}
		if (settings.shellPath === config.shellPath) return;
		settings.shellPath = config.shellPath;
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
	}

	// 微信不渲染 markdown，且回复中提到的媒体路径会被自动回传；
	// 通过工作区 AGENTS.md 注入这些行为说明（DefaultResourceLoader 自动加载）
	function ensureWorkInstructions(cwd: string): void {
		const filePath = join(cwd, "AGENTS.md");
		if (existsSync(filePath)) return;
		writeFileSync(
			filePath,
			`# 微信桥接工作区

你正在通过微信桥接与真实用户对话，你的回复会被发送到对方手机。

行为要求：
- 不使用 markdown：微信不渲染 markdown，用纯文本与换行组织内容。
- 发送文件给用户：在回复中给出文件的绝对路径（以媒体类扩展名结尾，如 .png/.jpg/.mp4/.pdf 等），桥接会自动把该文件发回微信。
- 简洁：手机聊天场景，回复尽量短。
- 收到的媒体：图片以视觉输入提供；语音/视频/文件会以描述文本给出本地保存路径，可用工具读取处理。
- 收到文件被保存到工作区 inbox/ 目录。
`,
			"utf8",
		);
	}

	// 共享 skills 随会话分发：桥接根目录 skills/ → 每用户 agentDir/skills
	// （pi 从 agentDir/skills 加载 user skills，不依赖项目信任）
	function ensureUserSkills(agentDir: string): void {
		for (const root of new Set([PACKAGE_ROOT, BRIDGE_ROOT])) {
			const skillsDir = join(root, "skills");
			if (existsSync(skillsDir)) cpSync(skillsDir, join(agentDir, "skills"), { recursive: true });
		}
	}

	async function getSession(userId: string, role: UserRole): Promise<SessionEntry> {
		const existing = sessions.get(userId);
		if (existing) {
			existing.lastUsed = Date.now();
			return existing;
		}

		const userDir = join(WORKSPACE_ROOT, sanitizeForFs(userId));
		const cwd = join(userDir, "work");
		mkdirSync(cwd, { recursive: true });
		ensureUserSettings(userDir);
		ensureUserSkills(join(userDir, ".pi-agent"));
		ensureWorkInstructions(cwd);

		const sessionManager = await openUserSession(userId, userDir, cwd);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: join(userDir, ".pi-agent"),
			extensionFactories: [scheduleExtension(userId)],
		});
		await resourceLoader.reload();
		const resourceErrors = resourceLoader.getExtensions().errors;
		if (resourceErrors.length)
			throw new Error(`Failed restoring user resources: ${resourceErrors.map((item) => item.error).join("; ")}`);
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir: join(userDir, ".pi-agent"),
			modelRuntime,
			model: sessionManager.buildSessionContext().messages.length ? undefined : model,
			sessionManager,
			resourceLoader,
		});
		if (modelFallbackMessage) {
			session.dispose();
			throw new Error(modelFallbackMessage);
		}
		const entry = { session, workDir: cwd, lastUsed: Date.now() };
		sessions.set(userId, entry);
		try {
			if (existsSync(sessionManager.getSessionFile() ?? "")) await saveUserSession(userId, userDir, sessionManager);
			await session.bindExtensions({ mode: "print", onError: (error) => log(`extension: ${error.error}`) });
			const activeTools = session.getActiveToolNames();
			if (!activeTools.includes("schedule_create") || !activeTools.includes("schedule_list"))
				throw new Error("Native schedule tools are unavailable; refusing to start this user session.");
		} catch (error) {
			sessions.delete(userId);
			session.dispose();
			throw error;
		}
		log(`session created for ${userId} (role=${role})`, {
			cwd,
			scheduleTools: session.getActiveToolNames().filter((name) => name.startsWith("schedule_")),
		});
		return entry;
	}

	// 空闲回收：释放长期不活跃会话的内存；历史已持久化，下次自动恢复
	const idleSweep = setInterval(
		() => {
			const now = Date.now();
			for (const [userId, entry] of sessions) {
				if (now - entry.lastUsed > SESSION_IDLE_MS && entry.session.isIdle && !queues.get(userId)?.length) {
					void enqueue(userId, async () => {
						if (
							sessions.get(userId) !== entry ||
							!entry.session.isIdle ||
							Date.now() - entry.lastUsed <= SESSION_IDLE_MS
						)
							return;
						log(`disposing idle session for ${userId}`);
						await entry.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
						scheduleHost.detach(entry.session);
						entry.session.dispose();
						sessions.delete(userId);
					}).catch((error) => log(`idle collection: ${error instanceof Error ? error.message : String(error)}`));
				}
			}
		},
		5 * 60 * 1000,
	);

	// 从会话消息中取最终助手回复（跳过 error/aborted）
	// 每用户串行队列：prompt 运行中再调用会抛错，必须排队
	const queues = new Map<string, Array<() => Promise<void>>>();
	const activeWork = new Set<Promise<void>>();

	// ── 消息历史（用于引用内容还原）──────────────────────────────────
	// 协议层 ref_msg 只带 msg_id/create_time_ms，不携带被引用内容；
	// 这里记录最近收发的消息，收到引用时按 msg_id 或时间戳查回内容给模型。
	interface HistoryEntry {
		timeMs: number;
		from: "user" | "bot";
		summary: string;
		msgKey?: string;
	}

	const HISTORY_LIMIT = 200;
	const QUOTE_TIME_WINDOW_MS = 10000;
	const history = new Map<string, HistoryEntry[]>();
	const historyLoaded = new Set<string>();

	function historyPath(userId: string): string {
		return join(WORKSPACE_ROOT, sanitizeForFs(userId), "history.jsonl");
	}

	// 重启后历史不丢：首次引用解析时从 jsonl 载入
	function ensureHistoryLoaded(userId: string): void {
		if (historyLoaded.has(userId)) return;
		historyLoaded.add(userId);
		try {
			const lines = readFileSync(historyPath(userId), "utf8").split("\n");
			const list: HistoryEntry[] = [];
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					list.push(JSON.parse(line) as HistoryEntry);
				} catch {
					// 跳过损坏行
				}
			}
			history.set(userId, list.slice(-HISTORY_LIMIT));
		} catch {
			// 文件不存在则从空历史开始
		}
	}

	function recordMessage(userId: string, entry: HistoryEntry): void {
		ensureHistoryLoaded(userId);
		const list = history.get(userId) ?? [];
		list.push(entry);
		if (list.length > HISTORY_LIMIT) list.shift();
		history.set(userId, list);
		// 聊天频率下整文件重写开销可忽略，换取文件永不膨胀
		try {
			writeFileSync(historyPath(userId), `${list.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
		} catch {
			// 持久化失败不影响主流程
		}
	}

	function summarizeIncoming(msg: IncomingMessage): string {
		const parts: string[] = [];
		for (const item of msg.raw.item_list) {
			if (item.text_item?.text?.trim()) parts.push(item.text_item.text.trim());
			else if (item.image_item) parts.push("[图片]");
			else if (item.voice_item) parts.push(item.voice_item.text?.trim() || "[语音]");
			else if (item.file_item) parts.push(`[文件: ${item.file_item.file_name ?? "file"}]`);
			else if (item.video_item) parts.push("[视频]");
		}
		return parts.join("\n");
	}

	function rawMsgKey(raw: Record<string, unknown>): string | undefined {
		const key = raw.msg_id ?? raw.message_id;
		return key === undefined || key === null ? undefined : String(key);
	}

	/** 按引用结构查回被引用消息的内容；有引用但查不到时返回 null。 */
	function resolveQuotedText(userId: string, ref: RefMessage): string | null {
		ensureHistoryLoaded(userId);
		const list = history.get(userId);
		if (!list || list.length === 0) return null;
		const item = ref.message_item as Record<string, unknown> | undefined;
		if (!item) return null;

		const key = item.msg_id !== undefined && item.msg_id !== null ? String(item.msg_id) : undefined;
		if (key) {
			const byKey = list.find((e) => e.msgKey === key);
			if (byKey) return byKey.summary;
		}

		const timeMs = typeof item.create_time_ms === "number" ? item.create_time_ms : undefined;
		if (timeMs !== undefined) {
			let best: HistoryEntry | undefined;
			for (const e of list) {
				if (Math.abs(e.timeMs - timeMs) <= QUOTE_TIME_WINDOW_MS) {
					if (!best || Math.abs(e.timeMs - timeMs) < Math.abs(best.timeMs - timeMs)) best = e;
				}
			}
			if (best) return best.summary;
		}
		return null;
	}

	function enqueue(userId: string, task: () => Promise<void>): Promise<void> {
		if (stopping) return Promise.reject(new Error("The bridge is shutting down."));
		return new Promise((resolve, reject) => {
			const q = queues.get(userId) ?? [];
			queues.set(userId, q);
			q.push(async () => {
				try {
					await task();
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			if (q.length === 1) void drainQueue(userId);
		});
	}

	async function drainQueue(userId: string): Promise<void> {
		const q = queues.get(userId);
		if (!q) return;
		while (q.length > 0) {
			const task = q[0];
			try {
				await task();
			} catch (e) {
				log(`task failed for ${userId}: ${e instanceof Error ? e.message : e}`);
			}
			q.shift();
		}
	}

	async function handleMessage(bot: WeChatBot, msg: IncomingMessage, role: UserRole): Promise<void> {
		if (stopping) return;
		const entry = await getSession(msg.userId, role);
		if (stopping) return;

		try {
			await bot.sendTyping(msg.userId);
		} catch {
			// typing 失败不影响主流程
		}

		// 入站：文本 + 媒体（图片 → vision；语音/视频/文件 → 落盘 + 描述）
		// 引用：协议层只带 msg_id/时间，从本地历史查回内容给模型
		const ref = getQuotedRef(msg);
		const quotedText = ref ? resolveQuotedText(msg.userId, ref) : undefined;
		const prompt = await buildPiPrompt(msg, bot, entry.workDir, ref ? quotedText : undefined);
		log(
			`prompt from ${msg.userId} (type=${msg.type}, images=${prompt.images?.length ?? 0}, quoted=${ref ? quotedText !== null : false}): ${prompt.text.slice(0, 80)}`,
		);

		recordMessage(msg.userId, {
			timeMs: msg.raw.create_time_ms,
			from: "user",
			summary: summarizeIncoming(msg),
			msgKey: rawMsgKey(msg.raw as unknown as Record<string, unknown>),
		});
		if (stopping) return;
		void deliveryWorker?.flush(true, msg.userId);

		const knownTasks = new Set((await scheduleHost.list(msg.userId)).map((task) => task.id));
		const response = await promptForReply(entry.session, prompt.text, { images: prompt.images });
		await saveUserSession(msg.userId, join(WORKSPACE_ROOT, sanitizeForFs(msg.userId)), entry.session.sessionManager);
		if (stopping) return;

		const created = response.error
			? (await scheduleHost.list(msg.userId)).filter((task) => !knownTasks.has(task.id))
			: [];
		const reply = response.error
			? created.length
				? `任务已保存并独立后台排期（${created.map((task) => task.id).join(", ")}）。模型确认回复失败，不影响任务创建。创建回执已进入发送队列。`
				: `本次处理失败：${response.error}`
			: (response.text ?? "[empty response]");

		// 出站：媒体路径回传微信，其余作为文本发送；入站带引用则回复挂引用
		// 注意传原始回复：sendReply 先提取路径再做 stripMarkdown，
		// 否则路径中的下划线会被当作斜体标记剥掉
		await sendReply(bot, msg, reply, {
			workDir: entry.workDir,
			allowExternalPaths: role === "owner",
		});
		log(`replied to ${msg.userId} (${reply.length} chars)`);

		recordMessage(msg.userId, { timeMs: Date.now(), from: "bot", summary: reply.slice(0, 500) });

		try {
			await bot.stopTyping(msg.userId);
		} catch {
			// 同上
		}
	}

	const bot = new BridgeBot(
		{ storage: "file", storageDir: paths.storage, logLevel: managed ? "silent" : "info" },
		{
			onQrUrl: (url) => {
				control.qr(url);
				if (!managed) log(`scan QR to login: ${url}`);
			},
			onScanned: () => {
				control.scanned();
				log("QR scanned, confirm on phone");
			},
			onExpired: () => control.expired(),
			...(managed ? { onVerifyCode: (retry: boolean) => control.requestCode(retry) } : {}),
		},
		() => control.begin(),
	);

	bot.onMessage((msg) => {
		if (stopping) return;
		// 白名单过滤：名单外账号一律拒绝，不触发任何会话
		const role = getRole(config, msg.userId);
		if (!role) {
			log(`rejected message from non-allowlisted user ${msg.userId}`);
			bot.reply(msg, "未授权用户，无法使用本服务。").catch(() => {});
			return;
		}

		const work = enqueue(msg.userId, async () => {
			if (stopping) return;
			try {
				await handleMessage(bot, msg, role);
			} catch (e) {
				log(`handle failed: ${e instanceof Error ? e.message : e}`);
				try {
					await bot.reply(msg, `处理失败：${e instanceof Error ? e.message : String(e)}`);
				} catch {
					// 回复也失败则只记日志
				}
			}
		}).catch((error) => log(`queue: ${error instanceof Error ? error.message : String(error)}`));
		activeWork.add(work);
		void work.finally(() => activeWork.delete(work));
	});

	bot.on("error", (e) => {
		if (!managed) log(`bot error: ${e instanceof Error ? e.message : String(e)}`);
		control.update({ phase: "error", error: "connection_failed" });
	});
	bot.on("session:expired", () => log("wechat session expired, SDK re-login flow started"));
	bot.on("session:restored", (c) => {
		log(`wechat session restored: ${c.accountId}`);
		void deliveryWorker?.flush(true);
	});
	bot.on("poll:start", () => {
		const credentials = bot.getCredentials();
		control.update({ phase: "connected", accountId: credentials?.accountId });
		void deliveryWorker?.flush(true);
	});

	async function shutdown(): Promise<void> {
		if (stopping) return;
		stopping = true;
		control.update({ phase: "stopping" });
		log("shutting down");
		bot.stop();
		control.cancelCode();
		clearInterval(idleSweep);
		await Promise.all([...sessions.values()].map((entry) => entry.session.abort()));
		await Promise.all([...activeWork]);
		await scheduleHost.close();
		await deliveryWorker?.close();
		for (const [userId, entry] of sessions) {
			if (existsSync(entry.session.sessionManager.getSessionFile() ?? ""))
				await saveUserSession(userId, join(WORKSPACE_ROOT, sanitizeForFs(userId)), entry.session.sessionManager);
			await entry.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			entry.session.dispose();
		}
		await releaseLocks?.();
		control.update({ phase: "disconnected" });
		process.exit(0);
	}
	process.on("SIGINT", () => {
		void shutdown();
	});
	process.on("SIGTERM", () => {
		void shutdown();
	});

	if (managed) {
		process.on("message", (value: unknown) => {
			if (!value || typeof value !== "object" || !("type" in value)) return;
			if (value.type === "stop") void shutdown();
			else if (value.type === "verify-code") {
				const command = value as BridgeCommand & { type: "verify-code" };
				const accepted = control.submit(command);
				if (process.connected)
					process.send?.(
						{ type: "verify-result", attemptId: command.attemptId, challengeId: command.challengeId, accepted },
						() => {},
					);
			}
		});
		process.once("disconnect", () => {
			void shutdown();
		});
		if (!process.connected) await shutdown();
	}
	startupError = "login_failed";
	const creds = await bot.login({ force: managed && process.env.PI_WEIXIN_FORCE_LOGIN === "1" });
	if (stopping) await shutdown();
	if (newConfig) {
		config.owner = creds.userId;
		await writeFile(join(BRIDGE_ROOT, "config.json"), `${JSON.stringify(config, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	}
	startupError = "connection_failed";
	log(`logged in as ${creds.accountId}`);

	bindingId = weixinBindingId(creds.accountId);
	await scheduleOutbox.registerBinding({ version: 1, bindingId, ownerId: config.owner, accountId: creds.accountId });
	deliveryWorker = await scheduleOutbox.createWorker(
		bindingId,
		createWeixinScheduleAdapter(bot, {
			ownerId: config.owner,
			isAuthorized: (userId) => getRole(config, userId) !== undefined,
			onTextSent: (userId, text) =>
				recordMessage(userId, { timeMs: Date.now(), from: "bot", summary: text.slice(0, 500) }),
		}),
		(error) => log(`schedule delivery: ${error.message}`),
	);
	await scheduleHost.start();

	await bot.start();
}

void runBridge().catch(async (error: unknown) => {
	if (stopping) return;
	control.update({ phase: "error", error: startupError });
	if (!managed) console.error(error);
	try {
		await releaseLocks?.();
	} finally {
		process.exit(1);
	}
});
