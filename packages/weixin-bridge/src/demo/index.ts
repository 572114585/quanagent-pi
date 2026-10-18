/**
 * 微信桥接扩展（阶段一验证用）
 *
 * 移植自 corespeed-io/wechatbot 的 pi-agent 扩展（MIT），适配本地
 * @earendil-works/pi-coding-agent。在 pi 交互模式输入 /wechat：
 * 扫码登录（已有凭证则免扫码）→ 微信消息注入当前会话 → 回复发回微信。
 *
 * 已知限制（阶段二处理）：
 * - pendingReply 单槽，连发消息时回复目标会被覆盖
 * - 全部微信消息与当前终端会话共享上下文
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type IncomingMessage, stripMarkdown, WeChatBot } from "@wechatbot/wechatbot";
import qrTerminal from "qrcode-terminal";
import { acquireBridgeLocks, bridgePaths } from "../control.ts";

export default function wechatBridge(pi: ExtensionAPI) {
	let bot: WeChatBot | null = null;
	let connected = false;
	let pendingReply: IncomingMessage | null = null;
	let assistantText = "";
	let isStreaming = false;
	let releaseLocks: (() => Promise<void>) | undefined;
	let pollWork: Promise<void> | undefined;
	async function stopWechat(): Promise<void> {
		bot?.stop();
		const release = releaseLocks;
		releaseLocks = undefined;
		await pollWork;
		await release?.();
		bot = null;
		connected = false;
		pendingReply = null;
	}

	// 连接期间向 system prompt 注入微信桥接说明
	pi.on("before_agent_start", async (event) => {
		if (!connected || !bot || !pendingReply) return;
		return {
			systemPrompt:
				event.systemPrompt +
				`

## WeChat Bridge (Active)

You are currently bridged to WeChat via the wechat extension.
A real WeChat user is chatting with you — your response will be sent back to them.

Key behaviors:
- No markdown: WeChat does not render markdown. Write plain text, use line breaks for structure.
- Send files: To send a file (image, video, document) back to WeChat, mention its absolute path in your response. The bridge auto-detects paths ending in media extensions and sends them as attachments.
- Concise replies: WeChat is a mobile chat app. Keep responses short and conversational.
- Media received: Images arrive as vision input. Videos/voice/files are described with metadata.
`,
		};
	});

	// run 结束后取最终文本发回微信
	pi.on("agent_end", async (event, ctx) => {
		if (!bot || !connected || !pendingReply) return;

		const reply = pendingReply;
		pendingReply = null;
		isStreaming = false;

		let finalText = "";
		for (const msg of event.messages ?? []) {
			if (msg.role === "assistant") {
				for (const block of msg.content) {
					if (block.type === "text") finalText += block.text;
				}
			}
		}
		if (!finalText.trim()) finalText = assistantText || "[No response]";

		// 微信不渲染 markdown，转纯文本
		const cleanText = stripMarkdown(finalText);

		try {
			await bot.stopTyping(reply.userId);

			// 回复中提到的媒体文件路径自动作为附件发送
			const mediaFiles = extractMediaPaths(finalText);
			if (mediaFiles.length > 0) {
				const textWithoutPaths = removeMediaPaths(cleanText, mediaFiles);
				if (textWithoutPaths.trim()) {
					await bot.reply(reply, textWithoutPaths);
				}
				for (const filePath of mediaFiles) {
					try {
						const data = await readFile(filePath);
						await bot.reply(reply, { file: data, fileName: basename(filePath) });
					} catch {
						await bot.reply(reply, `[Failed to send file: ${basename(filePath)}]`);
					}
				}
			} else {
				await bot.reply(reply, cleanText);
			}

			ctx.ui.setStatus("wechat", "wechat: replied");
		} catch (e) {
			ctx.ui.setStatus("wechat", `wechat: reply failed: ${e instanceof Error ? e.message : e}`);
		}
		assistantText = "";
	});

	// 流式累积 assistant 文本（agent_end 的兜底）
	pi.on("message_update", async (event) => {
		if (!isStreaming) return;
		if (event.message.role === "assistant") {
			let text = "";
			for (const block of event.message.content) {
				if (block.type === "text") text += block.text;
			}
			assistantText = text;
		}
	});

	const startWechat = async (_args: string, ctx: ExtensionCommandContext) => {
		if (connected && bot) {
			const action = await ctx.ui.select("WeChat is connected", ["Reconnect", "Disconnect", "Status", "Cancel"]);
			if (action === "Reconnect") {
				ctx.ui.setStatus("wechat", "wechat: reconnecting...");
				await stopWechat();
			} else if (action === "Disconnect") {
				await stopWechat();
				ctx.ui.setStatus("wechat", undefined);
				ctx.ui.notify("WeChat disconnected", "info");
				return;
			} else if (action === "Status") {
				const creds = bot.getCredentials();
				ctx.ui.notify(`Account: ${creds?.accountId}\nUser: ${creds?.userId}`, "info");
				return;
			} else {
				return;
			}
		}

		ctx.ui.setStatus("wechat", "wechat: connecting...");

		try {
			if (bot) await stopWechat();
			const paths = bridgePaths(getAgentDir());
			releaseLocks = await acquireBridgeLocks(paths.root, paths.storage);
			// 优先使用已存凭证，避免每次重启都扫码
			bot = new WeChatBot({ storage: "file", storageDir: paths.storage, logLevel: "warn" });
			const creds = await bot.login({
				force: false,
				callbacks: {
					onQrUrl: (url) => {
						qrTerminal.generate(url, { small: true }, (qr: string) => {
							process.stderr.write("\n  Scan this QR code in WeChat:\n\n");
							for (const line of qr.split("\n")) {
								process.stderr.write(`  ${line}\n`);
							}
							process.stderr.write("\n");
						});
						ctx.ui.setStatus("wechat", "wechat: scan QR to connect...");
					},
					onScanned: () => {
						ctx.ui.setStatus("wechat", "wechat: scanned, confirm on phone...");
					},
					onExpired: () => {
						ctx.ui.setStatus("wechat", "wechat: QR expired, refreshing...");
					},
				},
			});

			ctx.ui.setStatus("wechat", `wechat: ${creds.accountId}`);
			ctx.ui.notify(`WeChat connected\nAccount: ${creds.accountId}`, "info");
			connected = true;

			bot.onMessage(async (msg: IncomingMessage) => {
				pendingReply = msg;
				isStreaming = true;
				assistantText = "";

				try {
					await bot!.sendTyping(msg.userId);
				} catch {
					// typing 失败不影响主流程
				}

				const piContent = await buildPiContent(msg, bot!);

				if (typeof piContent === "string") {
					ctx.ui.setStatus("wechat", `wechat: ${piContent.slice(0, 60)}`);
				} else {
					const preview = piContent.find((b) => b.type === "text");
					ctx.ui.setStatus("wechat", `wechat: ${preview?.text.slice(0, 60) ?? "[media]"}`);
				}
				pi.sendUserMessage(piContent);
			});

			bot.on("error", (err) => {
				ctx.ui.setStatus("wechat", `wechat error: ${err instanceof Error ? err.message : String(err)}`);
			});
			bot.on("session:expired", () => {
				ctx.ui.setStatus("wechat", "wechat: session expired, re-login...");
			});
			bot.on("session:restored", (c) => {
				ctx.ui.setStatus("wechat", `wechat: reconnected ${c.accountId}`);
			});

			pollWork = bot.start().catch((e) => {
				ctx.ui.setStatus("wechat", `wechat: poll error: ${e instanceof Error ? e.message : e}`);
				connected = false;
			});
		} catch (e) {
			ctx.ui.setStatus("wechat", undefined);
			ctx.ui.notify(`Login failed: ${e instanceof Error ? e.message : e}`, "error");
			await stopWechat();
		}
	};

	pi.registerCommand("wechat", {
		description: "Connect WeChat — chat with pi from your phone",
		handler: startWechat,
	});

	pi.on("session_shutdown", async () => {
		await stopWechat();
	});

	pi.on("session_start", async (_event, ctx) => {
		if (connected && bot) {
			ctx.ui.setStatus("wechat", `wechat: ${bot.getCredentials()?.accountId ?? "connected"}`);
		}
	});
}

// 微信消息 → pi 消息内容（文本；图片转 base64；其余降级为描述文本）
type PiContent = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

async function buildPiContent(msg: IncomingMessage, bot: WeChatBot): Promise<PiContent> {
	switch (msg.type) {
		case "text":
			return msg.text || "[empty message]";

		case "image": {
			const media = await bot.download(msg);
			if (!media) return "[Image received but could not be downloaded]";
			const content: PiContent = [];
			content.push({ type: "text", text: msg.text !== "[image]" ? msg.text : "User sent an image from WeChat:" });
			content.push({ type: "image", data: media.data.toString("base64"), mimeType: "image/jpeg" });
			return content;
		}

		case "voice": {
			const voice = msg.voices[0];
			if (voice?.text) return `[Voice message, transcribed]: ${voice.text}`;
			const media = await bot.download(msg);
			if (media) {
				return `[Voice message received (${media.format}, ${media.data.length} bytes). No transcription available — please ask the user to type their message.]`;
			}
			return "[Voice message received but could not be downloaded]";
		}

		case "file": {
			const file = msg.files[0];
			const fileName = file?.fileName ?? "unknown file";
			const fileSize = file?.size ? ` (${formatFileSize(file.size)})` : "";

			const textExts = new Set([
				".txt",
				".md",
				".csv",
				".json",
				".xml",
				".html",
				".yaml",
				".yml",
				".toml",
				".log",
				".py",
				".js",
				".ts",
				".go",
				".rs",
				".java",
				".c",
				".cpp",
				".h",
			]);
			if (textExts.has(extname(fileName).toLowerCase())) {
				try {
					const media = await bot.download(msg);
					if (media) {
						const text = media.data.toString("utf-8");
						const truncated = text.length > 10000 ? `${text.slice(0, 10000)}\n... [truncated]` : text;
						return `[File: ${fileName}${fileSize}]\n\n\`\`\`\n${truncated}\n\`\`\``;
					}
				} catch {
					// 下载失败走降级分支
				}
			}
			return `[File received: ${fileName}${fileSize}. To process this file, ask the user to share its content as text.]`;
		}

		case "video": {
			const video = msg.videos[0];
			const duration = video?.durationMs ? ` (${Math.round(video.durationMs / 1000)}s)` : "";
			try {
				const media = await bot.download(msg);
				if (media) {
					const tmpDir = await mkdtemp(join(tmpdir(), "wechat-video-"));
					const videoPath = join(tmpDir, "video.mp4");
					await writeFile(videoPath, media.data);
					return `[Video received${duration}, saved to: ${videoPath}. You can access this file for processing.]`;
				}
			} catch {
				// 下载失败走降级分支
			}
			return `[Video received${duration} but could not be downloaded.]`;
		}

		default:
			return `[${msg.type} message received — not supported yet]`;
	}
}

// 从回复文本中提取媒体文件绝对路径
function extractMediaPaths(text: string): string[] {
	const paths: string[] = [];
	const mediaExts = /\.(png|jpg|jpeg|gif|webp|bmp|svg|mp4|mov|webm|avi|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz)$/i;
	const pathRegex = /(?:^|\s)((?:\/[\w./-]+|\.\/[\w./-]+|[A-Za-z]:\\(?:[\w.-]|\\)+))/gm;
	for (const match of text.matchAll(pathRegex)) {
		const p = match[1].trim();
		if (mediaExts.test(p)) paths.push(p);
	}
	return [...new Set(paths)];
}

function removeMediaPaths(text: string, paths: string[]): string {
	let result = text;
	for (const p of paths) {
		result = result.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");
	}
	return result.replace(/\n{3,}/g, "\n\n").trim();
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
