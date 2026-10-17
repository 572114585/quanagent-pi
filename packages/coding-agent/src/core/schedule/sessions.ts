import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSession, ExtensionBindings } from "../agent-session.ts";
import { emitSessionShutdownEvent } from "../extensions/runner.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions } from "../resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk.ts";
import { type FileEntry, type SessionEntry, SessionManager } from "../session-manager.ts";
import { SettingsManager } from "../settings-manager.ts";
import { getBranchSelection } from "../virtual-models.ts";
import { writeScheduleJson } from "./store.ts";
import type { ScheduleExecution, ScheduleRun, ScheduleSessionLease } from "./types.ts";

export class ScheduleExecutionPreparationError extends Error {
	readonly execution: ScheduleExecution;
	constructor(cause: unknown, execution: ScheduleExecution) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.execution = execution;
	}
}

export const SCHEDULE_MUTATING_TOOLS = [
	"schedule_create",
	"schedule_update",
	"schedule_delete",
	"schedule_run",
	"schedule_resend",
];
const settledLeaves = new WeakMap<AgentSession, string | null>();

/** Observe boundaries without waiting for or changing the original session. */
export function trackScheduleSource(session: AgentSession): () => void {
	settledLeaves.set(session, completedLeaf(session.sessionManager, !session.isIdle));
	return session.subscribe((event) => {
		if (event.type === "agent_settled") settledLeaves.set(session, completedLeaf(session.sessionManager));
	});
}

function completedLeaf(manager: SessionManager, skipLastRound = false): string | null {
	const branch = manager.getBranch();
	const lastUser = skipLastRound
		? branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user")
		: -1;
	const filtered = withoutIncompleteRounds(
		SessionManager.inMemory(manager.getCwd(), undefined, [
			manager.getHeader()!,
			...(lastUser >= 0 ? branch.slice(0, lastUser) : branch),
		]),
	);
	const hasContext = filtered
		.getBranch()
		.some(
			(entry) =>
				entry.type === "compaction" ||
				entry.type === "branch_summary" ||
				(entry.type === "message" &&
					entry.message.role === "assistant" &&
					(entry.message.stopReason === "stop" || entry.message.stopReason === "length")),
		);
	return hasContext ? filtered.getLeafId() : null;
}

/** Earlier failed or abandoned rounds must not leave orphan tool calls in the snapshot either. */
function withoutIncompleteRounds(manager: SessionManager): SessionManager {
	const branch = manager.getBranch();
	const excluded = new Set<string>();
	let round: SessionEntry[] = [];
	let complete = false;
	let failed = false;
	const pending = new Set<string>();
	const finishRound = () => {
		if (!complete)
			for (const entry of round)
				if (entry.type === "custom_message" || (entry.type === "message" && entry.message.role !== "system"))
					excluded.add(entry.id);
		round = [];
		complete = false;
		failed = false;
		pending.clear();
	};
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "user" && (complete || failed)) finishRound();
		round.push(entry);
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			failed = entry.message.stopReason === "error" || entry.message.stopReason === "aborted";
			for (const part of entry.message.content) if (part.type === "toolCall") pending.add(part.id);
			complete =
				(entry.message.stopReason === "stop" || entry.message.stopReason === "length") && pending.size === 0;
		} else if (entry.message.role === "toolResult") {
			pending.delete(entry.message.toolCallId);
			complete = false;
		}
	}
	finishRound();
	let parentId: string | null = null;
	const entries = branch
		.filter(
			(entry) =>
				!excluded.has(entry.id) &&
				!(entry.type === "context_edit" && excluded.has(entry.targetId)) &&
				!(entry.type === "label" && excluded.has(entry.targetId)) &&
				!(entry.type === "compaction" && excluded.has(entry.firstKeptEntryId)),
		)
		.map((entry) => {
			const copy = { ...entry, parentId };
			parentId = entry.id;
			return copy;
		});
	return SessionManager.inMemory(manager.getCwd(), undefined, [manager.getHeader()!, ...entries]);
}

export interface ScheduleExecutionSessionOptions {
	storageDir: string;
	/** Identity authorization belongs to the embedding host; pass only its authenticated source. */
	source?: AgentSession;
	signal?: AbortSignal;
	session?: Pick<CreateAgentSessionOptions, "modelRuntime" | "model" | "tools" | "excludeTools" | "noTools">;
	resources?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	projectTrusted?: boolean;
	bindings?: ExtensionBindings;
}

/** Read-only snapshot of the current branch, then initialize a separate durable SDK session. */
export async function createScheduleExecutionSession(
	run: ScheduleRun,
	options: ScheduleExecutionSessionOptions,
): Promise<ScheduleSessionLease> {
	const { binding } = run;
	if (!/^[\w-]+$/.test(run.id) || !/^[\w-]+$/.test(run.taskId)) throw new Error("Invalid execution identity.");
	options.signal?.throwIfAborted();
	const source = options.source;
	if (
		source &&
		(source.sessionId !== binding.sessionId || resolve(source.sessionFile ?? "") !== resolve(binding.sessionFile))
	)
		throw new Error("The active source does not match the task's original conversation.");
	// Capture live memory synchronously. A subsequent prompt, branch or disposal cannot mutate this copy.
	const liveEntries = source
		? structuredClone([source.sessionManager.getHeader()!, ...source.sessionManager.getBranch()])
		: undefined;
	const liveBusy = source !== undefined && !source.isIdle;
	const liveLeaf = source && liveBusy && settledLeaves.has(source) ? settledLeaves.get(source) : undefined;
	const model = source?.model;
	const thinkingLevel = source?.thinkingLevel;
	const toolNames = source?.getCallableToolNames();
	const content = await readFile(binding.sessionFile, "utf8");
	const rows: FileEntry[] = content
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line: string) => JSON.parse(line) as FileEntry);
	const header = rows[0];
	if (
		header?.type !== "session" ||
		header.id !== binding.sessionId ||
		typeof header.cwd !== "string" ||
		resolve(header.cwd) !== resolve(binding.cwd)
	)
		throw new Error("The original session identity or working directory does not match its saved task.");
	if ((header.version ?? 1) >= 2) {
		const seen = new Set<string>();
		for (const entry of rows.slice(1)) {
			if (
				entry.type === "session" ||
				!entry.id ||
				seen.has(entry.id) ||
				(entry.parentId !== null && !seen.has(entry.parentId))
			)
				throw new Error("Invalid original session tree; no snapshot was created.");
			seen.add(entry.id);
		}
	}
	if (binding.delivery.channel === "weixin" && binding.delivery.userId !== binding.ownerId)
		throw new Error("The task recipient does not own the original conversation.");
	let reader = SessionManager.inMemory(binding.cwd, undefined, liveEntries ?? rows);
	const boundary = liveLeaf === undefined ? completedLeaf(reader, liveBusy) : liveLeaf;
	const branch = reader.getBranch();
	const boundaryIndex = boundary ? branch.findIndex((entry) => entry.id === boundary) : -1;
	const afterBoundary: SessionEntry[] = [];
	if (liveBusy && liveLeaf !== undefined) {
		for (const entry of branch.slice(boundaryIndex + 1)) {
			if (entry.type === "message" && entry.message.role !== "system") break;
			if (entry.type !== "custom_message") afterBoundary.push(entry);
		}
	}
	if (boundary && reader.getEntry(boundary)) reader.createBranchedSession(boundary);
	else reader.newSession({ parentSession: binding.sessionFile });
	reader = withoutIncompleteRounds(reader);
	// A completed-context compaction or edit can happen while the next run is starting.
	// Keep those safe records without admitting its before_agent_start messages or user round.
	const retained = new Set(reader.getEntries().map((entry) => entry.id));
	let parentId = reader.getLeafId();
	const safeEntries: SessionEntry[] = [];
	for (const entry of afterBoundary) {
		if (
			(entry.type === "context_edit" && !retained.has(entry.targetId)) ||
			(entry.type === "compaction" &&
				entry.firstKeptEntryId !== entry.id &&
				!retained.has(entry.firstKeptEntryId)) ||
			(entry.type === "label" && !retained.has(entry.targetId))
		)
			continue;
		safeEntries.push({ ...entry, parentId });
		parentId = entry.id;
		retained.add(entry.id);
	}
	if (safeEntries.length)
		reader = SessionManager.inMemory(binding.cwd, undefined, [
			reader.getHeader()!,
			...reader.getEntries(),
			...safeEntries,
		]);
	// Retain model selection even when the first conversation has not completed.
	const original = SessionManager.inMemory(binding.cwd, undefined, structuredClone(liveEntries ?? rows));
	const selection = getBranchSelection(original.getBranch(), (provider, modelId) =>
		options.session?.modelRuntime?.getModel(provider, modelId),
	);
	const selectedModel =
		model ??
		(selection
			? options.session?.modelRuntime?.getModel(selection.provider, selection.modelId)
			: options.session?.model);
	if (!selectedModel) throw new Error("The original model cannot be restored.");
	reader.appendModelChange(selectedModel.provider, selectedModel.id);
	if (thinkingLevel) reader.appendThinkingLevelChange(thinkingLevel);
	const directory = join(options.storageDir, "executions", run.id);
	const artifactDir = join(binding.cwd, ".pi", "schedule-artifacts", run.taskId, run.id);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await mkdir(artifactDir, { recursive: true, mode: 0o700 });
	const sessionFile = join(directory, "session.jsonl");
	const temporary = join(directory, `${randomUUID()}.tmp`);
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(
				`${[{ ...reader.getHeader()!, parentSession: binding.sessionFile }, ...reader.getEntries()]
					.map((entry) => JSON.stringify(entry))
					.join("\n")}\n`,
			);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, sessionFile);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
	const execution: ScheduleExecution = {
		sourceSessionId: binding.sessionId,
		sourceSessionFile: binding.sessionFile,
		snapshotLeafId: boundary ?? null,
		sessionId: reader.getSessionId(),
		sessionFile,
		artifactDir,
	};
	try {
		await writeScheduleJson(join(directory, "ownership.json"), { runId: run.id, taskId: run.taskId, artifactDir });
		options.signal?.throwIfAborted();
		const settingsManager = SettingsManager.create(binding.cwd, binding.agentDir, {
			projectTrusted: options.projectTrusted ?? false,
		});
		const resourceLoader = new DefaultResourceLoader({
			...options.resources,
			cwd: binding.cwd,
			agentDir: binding.agentDir,
			settingsManager,
		});
		await resourceLoader.reload();
		const errors = resourceLoader.getExtensions().errors;
		if (errors.length)
			throw new Error(`Failed restoring session resources: ${errors.map((item) => item.error).join("; ")}`);
		options.signal?.throwIfAborted();
		const { session, modelFallbackMessage } = await createAgentSession({
			...options.session,
			modelRuntime: source?.modelRuntime ?? options.session?.modelRuntime,
			model: selectedModel,
			thinkingLevel,
			tools: options.session?.tools ?? toolNames ?? binding.toolNames,
			excludeTools: [...(options.session?.excludeTools ?? []), ...SCHEDULE_MUTATING_TOOLS],
			cwd: binding.cwd,
			agentDir: binding.agentDir,
			sessionManager: SessionManager.open(sessionFile),
			settingsManager,
			resourceLoader,
		});
		try {
			if (modelFallbackMessage || !session.model)
				throw new Error(modelFallbackMessage ?? "The original model cannot be restored.");
			options.signal?.throwIfAborted();
			let confirmationError: Error | undefined;
			const unavailable = async (): Promise<never> => {
				confirmationError = new Error("Background execution requires interactive confirmation or input.");
				throw confirmationError;
			};
			await session.bindExtensions({
				...options.bindings,
				mode: "print",
				uiContext: {
					...(options.bindings?.uiContext ?? session.extensionRunner.getUIContext()),
					confirm: unavailable,
					select: unavailable,
					input: unavailable,
					editor: unavailable,
					custom: unavailable,
				},
				onError: (error) => {
					throw new Error(error.error);
				},
			});
			if (confirmationError) throw confirmationError;
		} catch (error) {
			session.dispose();
			throw error;
		}
		return {
			session,
			execution,
			release: async () => {
				await session.abort();
				try {
					await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
				} finally {
					session.dispose();
				}
			},
		};
	} catch (cause) {
		throw new ScheduleExecutionPreparationError(cause, execution);
	}
}
