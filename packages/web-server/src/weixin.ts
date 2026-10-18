import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { loadConfig } from "../../weixin-bridge/src/config.ts";
import { bridgePaths } from "../../weixin-bridge/src/control.ts";
import type { BridgeCommand, WeixinSnapshot, WeixinStatus } from "../../weixin-bridge/src/protocol.ts";
import { HttpError } from "./auth.ts";
import { object } from "./protocol.ts";

interface ManagedState {
	enabled: boolean;
	provider?: string;
	model?: string;
}
interface WeixinOptions {
	agentDir: string;
	bridgeRoot?: string;
	validateModel: (provider: string, model: string) => Promise<boolean>;
	launch?: (env: NodeJS.ProcessEnv) => ChildProcess;
}

/** One administrator-controlled bridge, independent of browser connections and chat sessions. */
export class WeixinManager {
	private readonly options: WeixinOptions;
	private readonly paths: ReturnType<typeof bridgePaths>;
	private readonly statePath: string;
	private state: ManagedState = { enabled: false };
	private status: WeixinStatus = { phase: "disconnected" };
	private child?: ChildProcess;
	private exited?: Promise<void>;
	private operation: Promise<unknown> = Promise.resolve();
	private closing = false;
	private release?: () => Promise<void>;
	private codeReply?: { attemptId: string; challengeId: string; resolve: (accepted: boolean) => void };
	constructor(options: WeixinOptions) {
		this.options = options;
		this.paths = bridgePaths(options.agentDir);
		if (options.bridgeRoot) this.paths.root = options.bridgeRoot;
		this.statePath = join(this.paths.root, "web-control.json");
	}
	private serial<T>(action: () => Promise<T>): Promise<T> {
		const work = this.operation.then(action);
		this.operation = work.catch(() => {});
		return work;
	}
	async initialize(): Promise<void> {
		await mkdir(this.paths.root, { recursive: true, mode: 0o700 });
		try {
			this.release = await lockfile.lock(this.paths.root, {
				lockfilePath: join(this.paths.root, ".web-control.lock"),
				retries: 0,
			});
		} catch {
			this.status = { phase: "error", error: "bridge_busy" };
			return;
		}
		try {
			const saved = object(JSON.parse(await readFile(this.statePath, "utf8")));
			if (
				typeof saved.enabled !== "boolean" ||
				(saved.provider !== undefined && typeof saved.provider !== "string") ||
				(saved.model !== undefined && typeof saved.model !== "string")
			)
				throw new Error("invalid_state");
			this.state = {
				enabled: saved.enabled,
				provider: saved.provider as string | undefined,
				model: saved.model as string | undefined,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.status = { phase: "error", error: "configuration_invalid" };
				return;
			}
		}
		if (this.state.enabled) {
			try {
				await this.connect({});
			} catch {
				this.status = { phase: "error", error: "configuration_invalid" };
			}
		}
	}
	async snapshot(): Promise<WeixinSnapshot> {
		try {
			const config = await loadConfig(this.paths.root);
			return {
				...this.status,
				enabled: this.state.enabled,
				configured: true,
				provider: config.provider,
				model: config.model,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				return { phase: "error", error: "configuration_invalid", enabled: this.state.enabled, configured: true };
			return { ...this.status, ...this.state, configured: false };
		}
	}
	private async save(): Promise<void> {
		const temporary = `${this.statePath}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600, flag: "wx" });
			await rename(temporary, this.statePath);
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}
	connect(body: Record<string, unknown>): Promise<WeixinSnapshot> {
		return this.serial(async () => {
			if (this.closing) throw new HttpError(503, "server_closing");
			if (!this.release) throw new HttpError(409, "bridge_busy");
			if (body.force !== undefined && typeof body.force !== "boolean")
				throw new HttpError(400, "invalid_weixin_request");
			if (this.child && body.force !== true && this.status.phase !== "error") return this.snapshot();
			let provider = this.state.provider;
			let model = this.state.model;
			try {
				const config = await loadConfig(this.paths.root);
				provider = config.provider;
				model = config.model;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HttpError(400, "configuration_invalid");
				if (typeof body.provider === "string") provider = body.provider;
				if (typeof body.model === "string") model = body.model;
			}
			if (!provider || !model || !(await this.options.validateModel(provider, model)))
				throw new HttpError(400, "model_unavailable");
			await this.stopChild();
			this.state = { enabled: true, provider, model };
			await this.save();
			this.status = { phase: "starting" };
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PI_CODING_AGENT_DIR: this.options.agentDir,
				PI_WEIXIN_BRIDGE_HOME: this.paths.root,
				PI_WEIXIN_MANAGED: "1",
				PI_WEIXIN_SETUP_PROVIDER: provider,
				PI_WEIXIN_SETUP_MODEL: model,
				PI_WEIXIN_FORCE_LOGIN: body.force === true ? "1" : "0",
			};
			// The child has no reason to receive the Web administrator's password.
			delete env.PI_WEB_PASSWORD;
			delete env.PI_WEB_USERNAME;
			try {
				const child = this.options.launch
					? this.options.launch(env)
					: spawn(
							process.execPath,
							[
								"--import",
								new URL("../../coding-agent/src/experimental/source-resolver.ts", import.meta.url).href,
								fileURLToPath(new URL("../../weixin-bridge/src/daemon.ts", import.meta.url)),
							],
							{
								env,
								stdio: ["ignore", "ignore", "ignore", "ipc"],
								windowsHide: true,
							},
						);
				this.child = child;
				this.exited = new Promise<void>((resolveExit) => {
					const finish = () => {
						this.codeReply?.resolve(false);
						if (this.child === child) {
							this.child = undefined;
							if (this.status.phase !== "stopping" && this.status.phase !== "error")
								this.status = { phase: "error", error: "bridge_exited" };
						}
						resolveExit();
					};
					child.once("exit", finish);
					child.once("error", finish);
				});
				child.on("message", (message: unknown) => {
					if (this.child !== child) return;
					if (this.status.phase === "stopping") {
						void this.send({ type: "stop" }).catch(() => {});
						return;
					}
					const event = object(message);
					if (event.type === "verify-result") {
						if (
							event.attemptId === this.codeReply?.attemptId &&
							event.challengeId === this.codeReply?.challengeId
						)
							this.codeReply?.resolve(event.accepted === true);
						return;
					}
					if (event.type !== "weixin-status") return;
					const status = object(event.status);
					const phase = status.phase;
					if (
						![
							"starting",
							"qr",
							"scanned",
							"expired",
							"verify_code",
							"connected",
							"error",
							"disconnected",
						].includes(String(phase))
					)
						return;
					// Explicit allowlist: even a malformed child message cannot return tokens or codes.
					this.status = {
						phase: phase as WeixinStatus["phase"],
						attemptId: typeof status.attemptId === "string" ? status.attemptId : undefined,
						qrContent: typeof status.qrContent === "string" ? status.qrContent : undefined,
						challengeId: typeof status.challengeId === "string" ? status.challengeId : undefined,
						codeRetry: status.codeRetry === true,
						accountId: typeof status.accountId === "string" ? status.accountId : undefined,
						error: [
							"bridge_busy",
							"configuration_invalid",
							"model_unavailable",
							"login_failed",
							"connection_failed",
							"pairing_timeout",
						].includes(String(status.error))
							? String(status.error)
							: undefined,
					};
				});
			} catch {
				this.status = { phase: "error", error: "bridge_exited" };
			}
			return this.snapshot();
		});
	}
	verifyCode(body: Record<string, unknown>): Promise<WeixinSnapshot> {
		return this.serial(async () => {
			if (typeof body.code !== "string" || !/^\d{1,32}$/.test(body.code))
				throw new HttpError(400, "invalid_pairing_code");
			if (
				!this.child ||
				this.status.phase !== "verify_code" ||
				typeof body.attemptId !== "string" ||
				typeof body.challengeId !== "string" ||
				body.attemptId !== this.status.attemptId ||
				body.challengeId !== this.status.challengeId
			)
				throw new HttpError(409, "pairing_expired");
			const attemptId = body.attemptId;
			const challengeId = body.challengeId;
			let timer: NodeJS.Timeout | undefined;
			const reply = new Promise<boolean>((resolveReply) => {
				this.codeReply = { attemptId, challengeId, resolve: resolveReply };
				timer = setTimeout(() => resolveReply(false), 5000);
			});
			try {
				await this.send({ type: "verify-code", attemptId, challengeId, code: body.code });
				if (!(await reply)) throw new HttpError(409, "pairing_expired");
			} finally {
				clearTimeout(timer);
				this.codeReply = undefined;
			}
			return this.snapshot();
		});
	}
	private send(command: BridgeCommand): Promise<void> {
		return new Promise((resolveSend, reject) => {
			if (!this.child?.connected) {
				reject(new HttpError(409, "bridge_exited"));
				return;
			}
			this.child.send(command, (error) => {
				if (error) reject(new HttpError(409, "bridge_exited"));
				else resolveSend();
			});
		});
	}
	private async stopChild(): Promise<void> {
		if (!this.child) return;
		this.status = { phase: "stopping" };
		await this.send({ type: "stop" }).catch(() => {});
		await this.exited;
		this.status = { phase: "disconnected" };
	}
	disconnect(): Promise<WeixinSnapshot> {
		return this.serial(async () => {
			if (!this.release) throw new HttpError(409, "bridge_busy");
			this.state.enabled = false;
			await this.save();
			await this.stopChild();
			this.status = { phase: "disconnected" };
			return this.snapshot();
		});
	}
	close(): Promise<void> {
		this.closing = true;
		return this.serial(async () => {
			await this.stopChild();
			await this.release?.();
			this.release = undefined;
		});
	}
}
