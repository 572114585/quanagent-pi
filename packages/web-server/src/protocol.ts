/** Browser-safe view of Pi's native JSON events. No server imports belong here. */
export type { WeixinPhase, WeixinSnapshot } from "../../weixin-bridge/src/protocol.ts";
export interface Block {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	data?: string;
	mimeType?: string;
}
export interface ChatMessage {
	id: string;
	role: string;
	content: Block[];
	toolCallId?: string;
	toolName?: string;
	status: string;
	error?: string;
}
export interface FileInfo {
	id: string;
	sessionId: string;
	name: string;
	mime: string;
	size: number;
	kind: "upload" | "artifact";
	url: string;
}
export interface Dialog {
	id: string;
	method: "confirm" | "select" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	prefill?: string;
}
export interface ToolView {
	name: string;
	args?: unknown;
	output?: string;
	status: string;
}
export interface ViewState {
	messages: ChatMessage[];
	tools: Record<string, ToolView>;
	running: boolean;
	status: string;
	activeMessage?: number;
}
export interface Snapshot extends ViewState {
	id: string;
	name: string;
	cursor: string;
	busy: boolean;
	runId?: string;
	model?: { provider: string; id: string };
	thinkingLevel: string;
	files: FileInfo[];
	dialogs: Dialog[];
}
export interface Envelope {
	id: string;
	sessionId: string;
	runId?: string;
	event: unknown;
}
export interface SessionItem {
	id: string;
	name: string;
	preview: string;
	updatedAt: number;
	busy: boolean;
}

export function parseFileInfo(value: unknown): FileInfo | undefined {
	const file = object(value);
	const allowedMime = [
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"application/pdf",
		"application/octet-stream",
	];
	if (
		typeof file.id !== "string" ||
		!/^[a-f0-9-]{36}$/.test(file.id) ||
		typeof file.sessionId !== "string" ||
		typeof file.name !== "string" ||
		typeof file.mime !== "string" ||
		typeof file.size !== "number" ||
		!Number.isInteger(file.size) ||
		file.size < 0 ||
		file.size > 20 * 1024 * 1024 ||
		!allowedMime.includes(file.mime) ||
		(file.kind !== "upload" && file.kind !== "artifact") ||
		file.url !== `/api/files/${file.id}`
	)
		return undefined;
	return {
		id: file.id,
		sessionId: file.sessionId,
		name: file.name,
		mime: file.mime,
		size: file.size,
		kind: file.kind,
		url: file.url,
	};
}

export function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
export function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	return Array.isArray(value)
		? value
				.map((item) => object(item).text)
				.filter((text): text is string => typeof text === "string")
				.join("\n")
		: "";
}
export function newView(): ViewState {
	return { messages: [], tools: {}, running: false, status: "" };
}

export function messageView(value: unknown): ChatMessage {
	const message = object(value);
	const role = String(message.role ?? "custom");
	const content: Block[] =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: Array.isArray(message.content)
				? message.content.map((block) => ({ ...object(block), type: String(object(block).type) }))
				: [];
	return {
		id: `${role}:${String(message.timestamp ?? "")}:${String(message.toolCallId ?? "")}`,
		role,
		content,
		toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
		toolName: typeof message.toolName === "string" ? message.toolName : undefined,
		status: String(message.stopReason ?? "complete"),
		error: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
	};
}

/** Same reducer reconstructs both initial history and live, delta-only events. */
export function applyPiEvent(state: ViewState, value: unknown): void {
	const event = object(value);
	if (event.type === "agent_start") {
		state.running = true;
		state.status = "运行中";
	}
	if (event.type === "agent_settled") {
		state.running = false;
		state.status = event.aborted ? "已停止" : "";
	}
	if (event.type === "compaction_start") state.status = "正在整理上下文";
	if (event.type === "auto_retry_start") state.status = `正在重试 (${String(event.attempt)})`;
	if (event.type === "message_start" || event.type === "message_end") {
		const message = messageView(event.message);
		const index =
			event.type === "message_end" && state.activeMessage !== undefined
				? state.activeMessage
				: state.messages.length;
		message.id = `message:${index}`;
		state.messages[index] = message;
		state.activeMessage = event.type === "message_start" ? index : undefined;
		for (const block of message.content) {
			if (block.type === "toolCall" && block.id)
				state.tools[block.id] = {
					...state.tools[block.id],
					name: block.name ?? "tool",
					args: block.arguments,
					status: state.tools[block.id]?.status ?? "pending",
				};
		}
		if (message.role === "toolResult" && message.toolCallId)
			state.tools[message.toolCallId] = {
				...state.tools[message.toolCallId],
				name: message.toolName ?? "tool",
				output: textContent(object(event.message).content),
				status: object(event.message).isError ? "failed" : "completed",
			};
	}
	if (event.type === "message_update") {
		const update = object(event.assistantMessageEvent);
		const message = state.activeMessage === undefined ? undefined : state.messages[state.activeMessage];
		const index = Number(update.contentIndex);
		if (!message || !Number.isInteger(index) || index < 0 || index > 1000) return;
		const kind = String(update.type);
		if (kind === "text_start") message.content[index] = { type: "text", text: "" };
		if (kind === "thinking_start") message.content[index] = { type: "thinking", thinking: "" };
		if (kind === "text_delta" || kind === "text_end") {
			const block = message.content[index] ?? { type: "text", text: "" };
			block.text =
				kind === "text_end" ? String(update.content ?? "") : (block.text ?? "") + String(update.delta ?? "");
			message.content[index] = block;
		}
		if (kind === "thinking_delta" || kind === "thinking_end") {
			const block = message.content[index] ?? { type: "thinking", thinking: "" };
			block.thinking =
				kind === "thinking_end"
					? String(update.content ?? "")
					: (block.thinking ?? "") + String(update.delta ?? "");
			message.content[index] = block;
		}
		if (kind === "toolcall_start")
			message.content[index] = {
				type: "toolCall",
				id: String(update.id),
				name: String(update.toolName),
				arguments: "",
			};
		if (kind === "toolcall_delta") {
			const block = message.content[index];
			if (block) block.arguments = String(block.arguments ?? "") + String(update.delta ?? "");
		}
		if (kind === "toolcall_end") message.content[index] = { ...object(update.toolCall), type: "toolCall" };
	}
	if (
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	) {
		const id = String(event.toolCallId);
		state.tools[id] = {
			name: String(event.toolName),
			args: event.args ?? state.tools[id]?.args,
			output: textContent(object(event.result ?? event.partialResult).content),
			status: event.type === "tool_execution_end" ? (event.isError ? "failed" : "completed") : "running",
		};
	}
}
