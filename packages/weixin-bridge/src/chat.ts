import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Correlate only this prompt's events; a failed turn must never reuse an older answer. */
export async function promptForReply(
	session: Pick<AgentSession, "subscribe" | "prompt" | "waitForIdle">,
	text: string,
	options?: Parameters<AgentSession["prompt"]>[1],
): Promise<{ text?: string; error?: string }> {
	let reply: string | undefined;
	let error: string | undefined;
	let settled = false;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				error = event.message.errorMessage ?? event.message.stopReason;
				reply = undefined;
			} else if (event.message.stopReason !== "toolUse") {
				error = undefined;
				reply = event.message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("")
					.trim();
			}
		}
		if (event.type === "agent_settled") {
			settled = true;
			if (event.aborted) error = "Execution aborted.";
		}
	});
	try {
		await session.prompt(text, options);
		await session.waitForIdle();
		return error
			? { error }
			: settled && reply
				? { text: reply }
				: { error: "This request produced no completed reply." };
	} catch (cause) {
		return { error: cause instanceof Error ? cause.message : String(cause) };
	} finally {
		unsubscribe();
	}
}
