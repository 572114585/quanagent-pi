/**
 * 桥接配置：白名单准入。
 * owner 与 allowlist 内其他用户均拥有默认完整工具集；名单外拒绝。
 * role 目前仅用于日志与出站媒体路径策略。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface BridgeConfig {
	schedule: { runTimeoutMinutes: number };
	owner: string;
	allowlist: string[];
	// 模型：provider/model 需与宿主 ~/.pi/agent/models.json 中的配置项一致
	provider: string;
	model: string;
	// 可选：bash 工具使用的 shell 路径（如非标准安装位置的 Git Bash）
	shellPath?: string;
}

export type UserRole = "owner" | "user";

export async function loadConfig(bridgeRoot: string): Promise<BridgeConfig> {
	const raw = await readFile(join(bridgeRoot, "config.json"), "utf8");
	const parsed = JSON.parse(raw) as {
		owner?: string;
		allowlist?: unknown;
		provider?: unknown;
		model?: unknown;
		shellPath?: unknown;
		schedule?: { runTimeoutMinutes?: unknown };
	};
	if (typeof parsed.owner !== "string" || !parsed.owner) {
		throw new Error("config.json: owner must be a non-empty string");
	}
	if (!Array.isArray(parsed.allowlist) || parsed.allowlist.some((u) => typeof u !== "string")) {
		throw new Error("config.json: allowlist must be an array of strings");
	}
	if (parsed.shellPath !== undefined && typeof parsed.shellPath !== "string") {
		throw new Error("config.json: shellPath must be a string when present");
	}
	// 环境变量优先，便于不把模型名写进配置文件
	const provider = process.env.PI_WEIXIN_PROVIDER ?? parsed.provider;
	const model = process.env.PI_WEIXIN_MODEL ?? parsed.model;
	if (typeof provider !== "string" || !provider)
		throw new Error("config.json: provider must be a non-empty string (or set PI_WEIXIN_PROVIDER)");
	if (typeof model !== "string" || !model)
		throw new Error("config.json: model must be a non-empty string (or set PI_WEIXIN_MODEL)");
	if (
		parsed.schedule !== undefined &&
		(parsed.schedule === null || typeof parsed.schedule !== "object" || Array.isArray(parsed.schedule))
	)
		throw new Error("config.json: schedule must be an object");
	const minutes = parsed.schedule?.runTimeoutMinutes ?? 60;
	if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 35791)
		throw new Error("config.json: schedule.runTimeoutMinutes must be an integer from 1 to 35791");
	return {
		schedule: { runTimeoutMinutes: minutes },
		owner: parsed.owner,
		allowlist: parsed.allowlist as string[],
		provider,
		model,
		shellPath: parsed.shellPath,
	};
}

export function getRole(config: BridgeConfig, userId: string): UserRole | undefined {
	if (userId === config.owner) return "owner";
	if (config.allowlist.includes(userId)) return "user";
	return undefined;
}
