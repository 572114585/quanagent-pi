import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
	type ScheduleDeliveryAdapter,
	ScheduleDeliveryContextError,
	type ScheduleDeliveryPart,
} from "@earendil-works/pi-coding-agent";
import { NoContextError, stripMarkdown, type WeChatBot } from "@wechatbot/wechatbot";
import { chunkText, extractMediaPaths } from "./media.ts";

export function weixinBindingId(accountId: string): string {
	return `weixin-${createHash("sha256").update(accountId).digest("hex").slice(0, 24)}`;
}

export function createWeixinScheduleAdapter(
	bot: Pick<WeChatBot, "send">,
	options: {
		ownerId: string;
		isAuthorized(userId: string): boolean;
		onTextSent?(userId: string, text: string): void;
	},
): ScheduleDeliveryAdapter {
	return {
		authorize: options.isAuthorized,
		async prepare(notice) {
			const target = notice.binding.delivery;
			if (target.channel !== "weixin" || !options.isAuthorized(target.userId))
				throw new ScheduleDeliveryContextError("Unauthorized Weixin recipient.");
			if (notice.kind === "task-created")
				return [
					{
						kind: "text",
						text: `定时任务已创建：${notice.title}\n任务 ID：${notice.taskId}\n计划时间：${notice.nextAt}\n时区：${notice.timeZone}\n执行方式：独立后台会话，宿主须保持运行。`,
					},
				];
			const run = notice.run;
			const raw =
				run.result ?? `执行${run.status === "interrupted" ? "中断" : "失败"}：${run.error ?? "没有可用结果"}`;
			const paths = extractMediaPaths(raw);
			const allowed = paths.filter((path) => {
				if (target.userId === options.ownerId) return true;
				const rel = relative(resolve(run.binding.cwd), resolve(path));
				return (
					rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel))
				);
			});
			let text = raw;
			for (const path of allowed) text = text.split(path).join("");
			const prefix = `定时任务：${run.title}\n计划时间：${run.occurrenceAt}\n\n`;
			const parts: ScheduleDeliveryPart[] = chunkText(`${prefix}${stripMarkdown(text).trim()}`, 4000).map(
				(text) => ({
					kind: "text",
					text,
				}),
			);
			for (const path of allowed) parts.push({ kind: "file", path: resolve(path) });
			return parts;
		},
		async send(userId, part) {
			if (!options.isAuthorized(userId))
				throw new ScheduleDeliveryContextError("This user is no longer authorized.");
			try {
				if (part.kind === "text") {
					await bot.send(userId, part.text);
					options.onTextSent?.(userId, part.text);
				} else await bot.send(userId, { file: await readFile(part.path), fileName: basename(part.path) });
			} catch (error) {
				if (error instanceof NoContextError) throw new ScheduleDeliveryContextError(error.message);
				throw error;
			}
		},
	};
}
