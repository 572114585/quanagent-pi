/**
 * 媒体消息入站与出站处理。
 *
 * 入站：微信媒体（图片/语音/视频/文件）→ downloadRaw 下载解密 →
 * 保存到用户工作区 inbox/ → 组装 pi prompt（图片走 vision 输入，
 * 其余降级为描述文本 + 本地路径）。
 *
 * 出站：从 pi 回复中提取本地媒体路径 → 读文件 → 按扩展名自动路由
 * 发回微信；可选携带引用消息（用户引用某条消息时，回复挂上 ref_msg）。
 *
 * 安全：非 owner 用户出站路径限制在其工作区内；引用回复不改变该约束。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type CDNMedia,
	categorizeByMime,
	getMimeFromFilename,
	type IncomingMessage,
	MediaType,
	MessageBuilder,
	MessageItemType,
	silkToWav,
	stripMarkdown,
	type WeChatBot,
	type WireMessageItem,
} from "@wechatbot/wechatbot";

export interface PiPrompt {
	text: string;
	images?: ImageContent[];
}

export type RefMessage = NonNullable<WireMessageItem["ref_msg"]>;

/** 取入站消息携带的引用结构（协议只带 msg_id，不带内容）。 */
export function getQuotedRef(msg: IncomingMessage): RefMessage | undefined {
	for (const item of msg.raw.item_list) {
		if (item.ref_msg) return item.ref_msg;
	}
	return undefined;
}

const TEXT_FILE_EXTS = new Set([
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
const MAX_INLINE_TEXT = 10000;
const MAX_TEXT_CHUNK = 4000;
const MEDIA_PATH_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp|mp4|mov|webm|avi|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz)$/i;

function detectMime(data: Buffer): string {
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
	if (data.length >= 8 && data.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
	if (
		data.length >= 16 &&
		data.subarray(0, 4).toString("ascii") === "RIFF" &&
		data.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	if (
		data.length >= 6 &&
		(data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")
	) {
		return "image/gif";
	}
	return "image/jpeg";
}

function extForMime(mime: string): string {
	switch (mime) {
		case "image/png":
			return ".png";
		case "image/webp":
			return ".webp";
		case "image/gif":
			return ".gif";
		default:
			return ".jpg";
	}
}

async function saveInbox(cwd: string, fileName: string, data: Buffer): Promise<string> {
	const dir = join(cwd, "inbox");
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, fileName);
	await writeFile(filePath, data);
	return filePath;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 微信消息 → pi prompt。不依赖 msg.type（它只看第一个 item），
 * 而是按 images/voices/files/videos 数组逐项处理，支持"文本+图片"混合消息。
 *
 * quotedText：入站引用的文本内容。协议层 ref_msg 只带 msg_id 不带内容，
 * 需由调用方从历史消息中查出；传字符串表示有内容，传 null 表示有引用但查不到。
 */
export async function buildPiPrompt(
	msg: IncomingMessage,
	bot: WeChatBot,
	cwd: string,
	quotedText?: string | null,
): Promise<PiPrompt> {
	const parts: string[] = [];

	if (typeof quotedText === "string" && quotedText.trim()) {
		parts.push(`[用户引用了一条消息]: ${quotedText.trim()}`);
	} else if (quotedText === null) {
		parts.push("[用户引用了一条消息，但引用内容不可用（如引用的是较早的消息或机器人回复）。]");
	}

	for (const item of msg.raw.item_list) {
		if (item.type === MessageItemType.TEXT && item.text_item?.text?.trim()) {
			parts.push(item.text_item.text.trim());
		}
	}

	const images: ImageContent[] = [];
	const savedImagePaths: string[] = [];
	if (msg.images.length > 0) {
		let index = 0;
		for (const img of msg.images) {
			if (!img.media) continue;
			try {
				const data = await bot.downloadRaw(img.media, img.aeskey);
				const mimeType = detectMime(data);
				const path = await saveInbox(cwd, `image-${Date.now()}-${index}${extForMime(mimeType)}`, data);
				savedImagePaths.push(path);
				images.push({ type: "image", data: data.toString("base64"), mimeType });
				index++;
			} catch {
				// 单张失败跳过，继续下一张
			}
		}
		if (images.length > 0) {
			parts.push(`用户发送了 ${images.length} 张图片，已保存到: ${savedImagePaths.join(" , ")}`);
		} else {
			parts.push("[收到图片但下载失败，请用户重发。]");
		}
	}

	if (msg.voices.length > 0) {
		const voice = msg.voices[0];
		if (voice?.text?.trim()) {
			parts.push(`[语音消息，微信已自动转文字]: ${voice.text.trim()}`);
		} else if (voice?.media) {
			const silk = await bot.downloadRaw(voice.media);
			const wav = await silkToWav(silk);
			const data = wav ?? silk;
			const format = wav ? "wav" : "silk";
			const path = await saveInbox(cwd, `voice-${Date.now()}.${format}`, data);
			parts.push(
				`[收到语音消息（${format}，${data.length} 字节，已保存到 ${path}），无法转写文字，请用户改用文字输入。]`,
			);
		} else {
			parts.push("[收到语音消息但无法下载，请用户改用文字输入。]");
		}
	}

	if (msg.files.length > 0) {
		const file = msg.files[0];
		const fileName = sanitizeFileName(file?.fileName ?? "file.bin");
		const sizeText = file?.size ? ` (${formatFileSize(file.size)})` : "";
		if (file?.media) {
			const data = await bot.downloadRaw(file.media);
			const path = await saveInbox(cwd, fileName, data);
			if (TEXT_FILE_EXTS.has(extname(fileName).toLowerCase())) {
				const text = data.toString("utf-8");
				const truncated = text.length > MAX_INLINE_TEXT ? `${text.slice(0, MAX_INLINE_TEXT)}\n... [已截断]` : text;
				parts.push(`[收到文本文件: ${fileName}${sizeText}，已保存到 ${path}]\n内容:\n${truncated}`);
			} else {
				parts.push(`[收到文件: ${fileName}${sizeText}，已保存到 ${path}。需要处理时可用工具读取该路径。]`);
			}
		} else {
			parts.push(`[收到文件: ${fileName}${sizeText}，但无法下载。]`);
		}
	}

	if (msg.videos.length > 0) {
		const video = msg.videos[0];
		const duration = video?.durationMs ? ` (${Math.round(video.durationMs / 1000)}s)` : "";
		if (video?.media) {
			const data = await bot.downloadRaw(video.media);
			const path = await saveInbox(cwd, `video-${Date.now()}.mp4`, data);
			parts.push(`[收到视频${duration}，已保存到 ${path}。可用工具读取该文件做处理。]`);
		} else {
			parts.push(`[收到视频${duration}但无法下载。]`);
		}
	}

	if (parts.length === 0) {
		return { text: msg.text?.trim() || "[空消息]" };
	}
	return { text: parts.join("\n\n"), images: images.length > 0 ? images : undefined };
}

function sanitizeFileName(name: string): string {
	const base = basename(name).replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, "_");
	return base.length > 0 && base !== "." && base !== ".." ? base : "file";
}

/** 从回复文本中提取媒体文件的绝对路径（支持正反斜杠）。 */
export function extractMediaPaths(text: string): string[] {
	const paths: string[] = [];
	const pathRegex =
		/(?:^|[\s：:，,("'`<])((?:[A-Za-z]:[\\/]|[\\/]{1,2})[^<>"'`\r\n|]*?\.(?:png|jpg|jpeg|gif|webp|bmp|mp4|mov|webm|avi|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz))(?=$|[\s：:，,。；;)"'`\]>])/gim;
	for (const match of text.matchAll(pathRegex)) {
		const p = match[1].trim();
		if (MEDIA_PATH_EXTS.test(p)) paths.push(p);
	}
	return [...new Set(paths)];
}

/** Windows 路径统一为反斜杠，避免读文件时正反斜杠不一致。 */
function normalizePathSlashes(p: string): string {
	return /^[A-Za-z]:/.test(p) ? p.replace(/\//g, "\\") : p;
}

function isInsideDir(dir: string, filePath: string): boolean {
	const rel = relative(resolve(dir), resolve(filePath));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function removeMediaPaths(text: string, paths: string[]): string {
	let result = text;
	for (const p of paths) {
		result = result.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");
	}
	return result.replace(/\n{3,}/g, "\n\n").trim();
}

export function chunkText(text: string, limit: number): string[] {
	if (text.length <= limit) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > limit) {
		const window = remaining.slice(0, limit);
		let splitAt = -1;
		const para = window.lastIndexOf("\n\n");
		if (para > limit * 0.3) splitAt = para + 2;
		if (splitAt === -1) {
			const line = window.lastIndexOf("\n");
			if (line > limit * 0.3) splitAt = line + 1;
		}
		if (splitAt === -1) splitAt = limit;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt);
	}
	chunks.push(remaining);
	return chunks;
}

async function sendTextQuoted(
	bot: WeChatBot,
	msg: IncomingMessage,
	text: string,
	quoted: RefMessage | undefined,
): Promise<void> {
	if (!quoted) {
		await bot.reply(msg, text);
		return;
	}
	const chunks = chunkText(text, MAX_TEXT_CHUNK);
	for (let i = 0; i < chunks.length; i++) {
		const payload = MessageBuilder.to(msg.userId, msg._contextToken).text(chunks[i]).build();
		if (i === 0) payload.item_list[0].ref_msg = quoted;
		await bot.sendRaw(payload);
	}
}

export interface SendReplyOptions {
	/** 用户工作目录；非 owner 出站路径必须在此目录内 */
	workDir: string;
	/** owner 允许发送工作区外的文件 */
	allowExternalPaths: boolean;
}

/**
 * 发送 pi 回复：先提取媒体路径，再对剩余文本做 stripMarkdown
 * （顺序不能反：stripMarkdown 的斜体规则会破坏含下划线的文件路径），
 * 路径逐个回传微信。若入站消息带引用，所有回复消息都挂上 ref_msg。
 */
export async function sendReply(
	bot: WeChatBot,
	msg: IncomingMessage,
	rawText: string,
	opts: SendReplyOptions,
): Promise<void> {
	const quoted = getQuotedRef(msg);
	const rawPaths = extractMediaPaths(rawText);
	const mediaPaths = rawPaths.map(normalizePathSlashes);
	const allowedPairs: Array<{ raw: string; normalized: string }> = [];
	for (let i = 0; i < mediaPaths.length; i++) {
		if (opts.allowExternalPaths || isInsideDir(opts.workDir, mediaPaths[i])) {
			allowedPairs.push({ raw: rawPaths[i], normalized: mediaPaths[i] });
		}
	}
	const textWithoutPaths = stripMarkdown(
		removeMediaPaths(
			rawText,
			allowedPairs.map((p) => p.raw),
		),
	);

	if (textWithoutPaths.trim()) {
		await sendTextQuoted(bot, msg, textWithoutPaths.trim(), quoted);
	}

	for (const { normalized: filePath } of allowedPairs) {
		try {
			const data = await readFile(filePath);
			const fileName = basename(filePath);
			const result = await bot.upload({ data, userId: msg.userId, mediaType: mediaTypeForFile(fileName) });
			const builder = MessageBuilder.to(msg.userId, msg._contextToken);
			appendMediaItem(builder, fileName, result.media, result.encryptedFileSize, data.length);
			const payload = builder.build();
			if (quoted) payload.item_list[0].ref_msg = quoted;
			await bot.sendRaw(payload);
		} catch (e) {
			const reason = e instanceof Error ? `${e.message}` : String(e);
			console.error(`media send failed for ${filePath}: ${reason}`);
			await bot.reply(msg, `[发送文件失败: ${basename(filePath)}: ${reason}]`).catch(() => {});
		}
	}
}

function mediaTypeForFile(fileName: string): MediaType {
	const category = categorizeByMime(getMimeFromFilename(fileName));
	if (category === "image") return MediaType.IMAGE;
	if (category === "video") return MediaType.VIDEO;
	return MediaType.FILE;
}

function appendMediaItem(
	builder: MessageBuilder,
	fileName: string,
	media: CDNMedia,
	encryptedSize: number,
	rawSize: number,
): void {
	const category = categorizeByMime(getMimeFromFilename(fileName));
	if (category === "image") {
		builder.image({ media, midSize: encryptedSize });
	} else if (category === "video") {
		builder.video({ media, videoSize: encryptedSize });
	} else {
		builder.file({ media, fileName, size: rawSize });
	}
}
