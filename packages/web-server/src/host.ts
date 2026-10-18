import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	getDefaultSessionDir,
	hasTrustRequiringProjectResources,
	isSessionBusy,
	type ModelRuntime,
	ProjectTrustStore,
	SessionManager,
	toJsonEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HttpError } from "./auth.ts";
import { WebDialogs } from "./dialogs.ts";
import { FileStore } from "./files.ts";
import {
	applyPiEvent,
	type Envelope,
	type FileInfo,
	newView,
	object,
	parseFileInfo,
	type SessionItem,
	type Snapshot,
	textContent,
	type ViewState,
} from "./protocol.ts";
import { ProviderSettings } from "./providers.ts";

interface SessionRecord {
	id: string;
	createdAt: number;
	path: string;
	draft?: SessionManager;
	session?: AgentSession;
	view?: ViewState;
	runId?: string;
	work?: Promise<void>;
	sequence: number;
	events: Array<{ envelope: Envelope; bytes: number }>;
	bytes: number;
	listeners: Set<(envelope: Envelope) => void>;
	dialogs: WebDialogs;
	files: FileInfo[];
	controller?: AbortController;
}
export interface HostOptions {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	dataDir: string;
	sessionDir?: string;
}

export class WebHost {
	readonly files: FileStore;
	readonly providers: ProviderSettings;
	readonly cwd: string;
	private readonly options: HostOptions;
	private readonly records = new Map<string, SessionRecord>();
	private readonly epoch = randomUUID();
	private readonly sessionDir: string;
	private readonly trust: ProjectTrustStore;
	private readonly trusted = new Map<string, boolean>();
	private closing = false;
	private configuring = false;
	constructor(options: HostOptions) {
		this.options = options;
		this.cwd = options.cwd;
		this.sessionDir = options.sessionDir ?? getDefaultSessionDir(options.cwd, options.agentDir);
		this.files = new FileStore(join(options.dataDir, "files"), options.cwd);
		this.providers = new ProviderSettings(options.agentDir, options.modelRuntime);
		this.trust = new ProjectTrustStore(options.agentDir);
	}
	hasWork(): boolean {
		return [...this.records.values()].some((record) => record.runId !== undefined);
	}
	async configure(action: () => Promise<void>): Promise<void> {
		if (this.hasWork() || this.configuring) throw new HttpError(409, "agent_running");
		this.configuring = true;
		try {
			await action();
		} finally {
			this.configuring = false;
		}
	}
	private record(id: string): SessionRecord {
		const found = this.records.get(id);
		if (found) return found;
		if (!/^[A-Za-z0-9._-]{1,160}$/.test(id)) throw new HttpError(404, "session_not_found");
		const path = SessionManager.findById(this.cwd, id, this.sessionDir);
		if (!path) throw new HttpError(404, "session_not_found");
		return this.register(id, path);
	}
	private register(id: string, path: string, draft?: SessionManager): SessionRecord {
		const record: SessionRecord = {
			id,
			createdAt: Date.now(),
			path,
			draft,
			sequence: 0,
			events: [],
			bytes: 0,
			listeners: new Set(),
			files: [],
			dialogs: new WebDialogs((event) => this.emit(record, event)),
		};
		this.records.set(id, record);
		return record;
	}
	private emit(record: SessionRecord, event: unknown): void {
		const envelope: Envelope = {
			id: `${this.epoch}.${++record.sequence}`,
			sessionId: record.id,
			runId: record.runId,
			event,
		};
		const bytes = Buffer.byteLength(JSON.stringify(envelope));
		record.events.push({ envelope, bytes });
		record.bytes += bytes;
		while (record.events.length > 2000 || record.bytes > 8 * 1024 * 1024)
			record.bytes -= record.events.shift()!.bytes;
		for (const listener of record.listeners) listener(envelope);
	}
	private manager(record: SessionRecord): SessionManager {
		const manager =
			record.session?.sessionManager ??
			(existsSync(record.path) ? SessionManager.openReadOnly(record.path) : record.draft!);
		if (!manager) throw new HttpError(404, "session_not_found");
		return manager;
	}
	async list(): Promise<SessionItem[]> {
		const sessions = await SessionManager.list(this.cwd, this.sessionDir);
		const items: SessionItem[] = sessions.map((session) => ({
			id: session.id,
			name: session.name || session.firstMessage.slice(0, 40),
			preview: session.firstMessage.slice(0, 100),
			updatedAt: session.modified.getTime(),
			busy: isSessionBusy(session.path),
		}));
		for (const record of this.records.values())
			if (record.draft && !items.some((item) => item.id === record.id)) {
				items.push({
					id: record.id,
					name: record.draft.getSessionName() || "新对话",
					preview: "",
					updatedAt: record.createdAt,
					busy: !!record.runId,
				});
			}
		return items.sort((a, b) => b.updatedAt - a.updatedAt);
	}
	create(): Snapshot {
		const manager = SessionManager.create(this.cwd, this.sessionDir);
		return this.snapshotRecord(this.register(manager.getSessionId(), manager.getSessionFile()!, manager));
	}
	private snapshotRecord(record: SessionRecord): Snapshot {
		const manager = this.manager(record);
		const view = record.view ?? newView();
		if (!record.view)
			for (const entry of manager.getBranch())
				if (entry.type === "message") applyPiEvent(view, { type: "message_end", message: entry.message });
		const files = manager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "web_file")
			.map((entry) => parseFileInfo("data" in entry ? entry.data : undefined))
			.filter((file): file is FileInfo => file !== undefined && file.sessionId === record.id);
		const context = manager.buildSessionContext();
		return {
			...view,
			id: record.id,
			name:
				manager.getSessionName() ||
				textContent(view.messages.find((message) => message.role === "user")?.content).slice(0, 40) ||
				"新对话",
			cursor: `${this.epoch}.${record.sequence}`,
			busy: isSessionBusy(record.path),
			runId: record.runId,
			files: [...new Map([...files, ...record.files].map((file) => [file.id, file])).values()],
			dialogs: record.dialogs.list(),
			model: record.session?.model
				? { provider: record.session.model.provider, id: record.session.model.id }
				: context.model
					? { provider: context.model.provider, id: context.model.modelId }
					: undefined,
			thinkingLevel: record.session?.thinkingLevel ?? context.thinkingLevel,
		};
	}
	snapshot(id: string): Snapshot {
		return this.snapshotRecord(this.record(id));
	}
	subscribe(
		id: string,
		after: string | null,
		listener: (envelope: Envelope | { snapshot: Snapshot }) => void,
	): () => void {
		const record = this.record(id);
		const cursor = `${this.epoch}.${record.sequence}`;
		const index = record.events.findIndex((item) => item.envelope.id === after);
		if (after === cursor) {
			/* already current */
		} else if (index >= 0) for (const item of record.events.slice(index + 1)) listener(item.envelope);
		else listener({ snapshot: this.snapshotRecord(record) });
		record.listeners.add(listener);
		return () => record.listeners.delete(listener);
	}
	async rename(id: string, name: string): Promise<void> {
		const record = this.record(id);
		if (record.runId) throw new HttpError(409, "session_busy");
		const manager = existsSync(record.path) ? SessionManager.open(record.path) : record.draft!;
		const release = manager.acquireWriteLease();
		try {
			manager.appendSessionInfo(name.slice(0, 200));
		} finally {
			release();
		}
	}
	async archive(id: string): Promise<void> {
		const record = this.record(id);
		if (record.runId) throw new HttpError(409, "session_busy");
		if (existsSync(record.path)) {
			const manager = SessionManager.open(record.path);
			const release = manager.acquireWriteLease();
			try {
				const archive = join(this.sessionDir, ".archive");
				await mkdir(archive, { recursive: true });
				await rename(record.path, join(archive, basename(record.path)));
			} finally {
				release();
			}
		}
		this.records.delete(id);
	}
	async upload(id: string, name: string, data: Buffer): Promise<FileInfo> {
		const record = this.record(id);
		const info = await this.files.save(id, name, data, "upload");
		record.files.push(info);
		return info;
	}
	answer(id: string, dialogId: string, value?: string | boolean): void {
		this.record(id).dialogs.answer(dialogId, value);
	}
	async stop(id: string): Promise<void> {
		const record = this.record(id);
		record.controller?.abort();
		record.dialogs.cancelAll();
		await record.session?.abort();
	}
	start(id: string, input: unknown): string {
		const record = this.record(id);
		if (this.closing || this.configuring || record.runId) throw new HttpError(409, "session_busy");
		const body = object(input);
		if (typeof body.message !== "string" || body.message.length > 200_000)
			throw new HttpError(400, "invalid_message");
		if (
			body.attachments !== undefined &&
			(!Array.isArray(body.attachments) ||
				body.attachments.length > 8 ||
				body.attachments.some((item) => typeof item !== "string"))
		)
			throw new HttpError(400, "invalid_attachments");
		if (!body.message.trim() && (!Array.isArray(body.attachments) || body.attachments.length === 0))
			throw new HttpError(400, "empty_message");
		if (isSessionBusy(record.path)) throw new HttpError(409, "session_busy");
		const runId = randomUUID();
		record.runId = runId;
		record.controller = new AbortController();
		record.view = this.snapshotRecord(record);
		record.view.running = true;
		record.view.status = "正在准备";
		this.emit(record, { type: "run_started" });
		record.work = this.run(record, body);
		return runId;
	}
	private async run(record: SessionRecord, body: Record<string, unknown>): Promise<void> {
		let unsubscribe: (() => void) | undefined;
		try {
			const manager = existsSync(record.path) ? SessionManager.open(record.path) : record.draft!;
			const ui = record.dialogs.context();
			const services = await createAgentSessionServices({
				cwd: this.cwd,
				agentDir: this.options.agentDir,
				modelRuntime: this.options.modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [
						{ name: "codemode", builtin: true, factory: createCodemodeExtension() },
						{ name: "tool_search", builtin: true, factory: createToolSearchExtension() },
						{ name: "mcp", builtin: true, factory: createMcpExtension() },
					],
					appendSystemPrompt: [
						"Deliver generated files with the publish_artifact tool so the web user receives a download link.",
					],
				},
				resourceLoaderReloadOptions: {
					resolveProjectTrust: async () => {
						const trusted = this.trusted.get(this.cwd) ?? this.trust.get(this.cwd);
						if (trusted !== null && trusted !== undefined) return trusted;
						if (!hasTrustRequiringProjectResources(this.cwd)) return true;
						const decision = await ui.confirm("信任工作目录", `是否加载 ${this.cwd} 中的项目扩展、技能和配置？`);
						this.trusted.set(this.cwd, decision);
						return decision;
					},
				},
			});
			record.controller?.signal.throwIfAborted();
			const selected = object(body.model);
			const model =
				typeof selected.provider === "string" && typeof selected.id === "string"
					? this.options.modelRuntime.getModel(selected.provider, selected.id)
					: undefined;
			if (body.model !== undefined && !model) throw new HttpError(400, "model_not_found");
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			if (body.thinkingLevel !== undefined && !levels.includes(String(body.thinkingLevel)))
				throw new HttpError(400, "invalid_thinking_level");
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager: manager,
				model,
				thinkingLevel: body.thinkingLevel as ThinkingLevel | undefined,
				customTools: [
					{
						name: "publish_artifact",
						label: "交付文件",
						description: "Publish a generated file inside the workspace as a downloadable web artifact.",
						parameters: Type.Object({ path: Type.String() }),
						execute: async (_id, args, signal) => {
							if (typeof object(args).path !== "string") throw new HttpError(400, "invalid_path");
							signal?.throwIfAborted();
							const file = await this.files.publish(record.id, object(args).path as string);
							signal?.throwIfAborted();
							manager.appendCustomEntry("web_file", file);
							record.files.push(file);
							this.emit(record, { type: "file", file });
							return { content: [{ type: "text", text: `[${file.name}](${file.url})` }], details: { file } };
						},
					},
				],
			});
			record.session = session;
			unsubscribe = session.subscribe((event) => {
				const json = toJsonEvent(event);
				applyPiEvent(record.view!, json);
				this.emit(record, json);
			});
			await session.bindExtensions({
				uiContext: ui,
				mode: "rpc",
				onError: (error) => this.emit(record, { type: "notice", message: error.error }),
			});
			record.controller?.signal.throwIfAborted();
			const images: ImageContent[] = [];
			let message = body.message as string;
			for (const id of (body.attachments ?? []) as string[]) {
				const { info, path } = await this.files.get(id, record.id);
				manager.appendCustomEntry("web_file", info);
				if (info.mime.startsWith("image/")) {
					if (!session.model?.input.includes("image")) throw new HttpError(400, "model_does_not_support_images");
					images.push({ type: "image", mimeType: info.mime, data: (await readFile(path)).toString("base64") });
				} else message += `\n\nAttached file ${JSON.stringify(info.name)} is available at ${JSON.stringify(path)}.`;
			}
			record.controller?.signal.throwIfAborted();
			await session.prompt(message, { images });
			await session.waitForIdle();
		} catch (error) {
			if (!record.controller?.signal.aborted)
				this.emit(record, {
					type: "run_error",
					message: error instanceof HttpError ? error.code : error instanceof Error ? error.message : "Run failed",
				});
		} finally {
			record.dialogs.cancelAll();
			try {
				await record.session?.abort();
			} catch {
				this.emit(record, { type: "notice", message: "Could not stop the session cleanly" });
			} finally {
				unsubscribe?.();
				try {
					record.session?.dispose();
				} catch {
					this.emit(record, { type: "notice", message: "Could not release the session cleanly" });
				} finally {
					record.session = undefined;
					record.runId = undefined;
					record.view = undefined;
					if (existsSync(record.path)) record.draft = undefined;
					this.emit(record, { type: "run_finished" });
				}
			}
		}
	}
	async close(): Promise<void> {
		this.closing = true;
		for (const record of this.records.values()) {
			record.controller?.abort();
			record.dialogs.cancelAll();
			await record.session?.abort();
		}
		await Promise.all([...this.records.values()].map((record) => record.work));
	}
}
