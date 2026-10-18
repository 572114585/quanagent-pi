import { randomUUID } from "node:crypto";
import { type ExtensionUIContext, type ExtensionUIDialogOptions, initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../coding-agent/src/modes/interactive/theme/theme.ts";
import { HttpError } from "./auth.ts";
import type { Dialog } from "./protocol.ts";

export class WebDialogs {
	private readonly pending = new Map<string, { dialog: Dialog; finish: (value?: string | boolean) => void }>();
	private readonly emit: (event: unknown) => void;
	constructor(emit: (event: unknown) => void) {
		this.emit = emit;
	}
	list(): Dialog[] {
		return [...this.pending.values()].map((item) => item.dialog);
	}
	cancelAll(): void {
		for (const item of [...this.pending.values()]) item.finish();
	}
	answer(id: string, value?: string | boolean): void {
		const item = this.pending.get(id);
		if (!item) throw new HttpError(409, "dialog_expired");
		if (value !== undefined && item.dialog.method === "confirm" && typeof value !== "boolean")
			throw new HttpError(400, "invalid_answer");
		if (value !== undefined && item.dialog.method !== "confirm" && typeof value !== "string")
			throw new HttpError(400, "invalid_answer");
		if (item.dialog.method === "select" && typeof value === "string" && !item.dialog.options?.includes(value))
			throw new HttpError(400, "invalid_answer");
		item.finish(value);
	}
	private ask(dialog: Omit<Dialog, "id">, options?: ExtensionUIDialogOptions): Promise<string | boolean | undefined> {
		if (options?.signal?.aborted) return Promise.resolve(undefined);
		const id = randomUUID();
		return new Promise((resolve) => {
			const abort = () => finish();
			const timer = setTimeout(abort, options?.timeout ?? 5 * 60_000);
			const finish = (value?: string | boolean) => {
				if (!this.pending.delete(id)) return;
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", abort);
				this.emit({ type: "dialog_closed", id });
				resolve(value);
			};
			this.pending.set(id, { dialog: { ...dialog, id }, finish });
			options?.signal?.addEventListener("abort", abort, { once: true });
			this.emit({ type: "dialog", dialog: { ...dialog, id } });
		});
	}
	context(): ExtensionUIContext {
		initTheme("dark", false);
		const notify = (message: string) => this.emit({ type: "notice", message });
		return {
			select: async (title, options, opts) => {
				const value = await this.ask({ method: "select", title, options }, opts);
				return typeof value === "string" ? value : undefined;
			},
			confirm: async (title, message, opts) =>
				(await this.ask({ method: "confirm", title, message }, opts)) === true,
			input: async (title, placeholder, opts) => {
				const value = await this.ask({ method: "input", title, message: placeholder }, opts);
				return typeof value === "string" ? value : undefined;
			},
			editor: async (title, prefill) => {
				const value = await this.ask({ method: "editor", title, prefill });
				return typeof value === "string" ? value : undefined;
			},
			notify,
			onTerminalInput: () => () => {},
			setStatus: (_key, value) => {
				if (value) notify(value);
			},
			setWorkingMessage: (message) => {
				if (message) notify(message);
			},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: (_key, content) => {
				if (Array.isArray(content)) notify(content.join("\n"));
			},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => {
				throw new Error("Terminal custom components are unavailable in the web client");
			},
			pasteToEditor: (text) => this.emit({ type: "editor_text", text }),
			setEditorText: (text) => this.emit({ type: "editor_text", text }),
			getEditorText: () => "",
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Use the web appearance setting" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}
}
