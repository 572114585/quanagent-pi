import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { BridgeCommand, WeixinStatus } from "./protocol.ts";

export function bridgePaths(agentDir: string) {
	return {
		root: resolve(process.env.PI_WEIXIN_BRIDGE_HOME ?? join(agentDir, "weixin-bridge")),
		storage: resolve(process.env.PI_WEIXIN_STORAGE_DIR ?? join(homedir(), ".wechatbot")),
	};
}

/** Both directories must be owned before any SDK login or polling begins. */
export async function acquireBridgeLocks(root: string, storage: string): Promise<() => Promise<void>> {
	const releases: Array<() => Promise<void>> = [];
	try {
		const directories = new Set<string>();
		for (const path of [root, storage]) {
			await mkdir(path, { recursive: true, mode: 0o700 });
			directories.add(await realpath(path));
		}
		for (const path of [...directories].sort()) {
			releases.push(await lockfile.lock(path, { lockfilePath: join(path, ".bridge.lock"), retries: 0 }));
		}
	} catch (error) {
		for (const release of releases.reverse()) await release();
		throw error;
	}
	return async () => {
		for (const release of releases.reverse()) await release();
	};
}

/** Contains only browser-safe state. Credentials never cross the IPC boundary. */
export class BridgeControl {
	private readonly publish: (status: WeixinStatus) => void;
	private state: WeixinStatus = { phase: "starting" };
	private pending?: { resolve: (code: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
	constructor(publish: (status: WeixinStatus) => void) {
		this.publish = publish;
	}
	status(): WeixinStatus {
		return { ...this.state };
	}
	update(status: WeixinStatus): void {
		this.state = status;
		this.publish(this.status());
	}
	begin(): void {
		this.cancelCode();
		this.update({ phase: "starting", attemptId: randomUUID() });
	}
	qr(content: string): void {
		this.cancelCode();
		this.update({ phase: "qr", attemptId: this.state.attemptId, qrContent: content });
	}
	scanned(): void {
		this.update({ phase: "scanned", attemptId: this.state.attemptId });
	}
	expired(): void {
		this.cancelCode();
		this.update({ phase: "expired", attemptId: this.state.attemptId });
	}
	requestCode(retry: boolean, timeoutMs = 180_000): Promise<string> {
		this.cancelCode();
		const promise = new Promise<string>((resolveCode, reject) => {
			const timer = setTimeout(() => {
				this.pending = undefined;
				this.update({ phase: "error", error: "pairing_timeout" });
				reject(new Error("pairing_timeout"));
			}, timeoutMs);
			this.pending = { resolve: resolveCode, reject, timer };
		});
		this.update({
			phase: "verify_code",
			attemptId: this.state.attemptId,
			challengeId: randomUUID(),
			codeRetry: retry,
		});
		return promise;
	}
	submit(command: BridgeCommand): boolean {
		if (
			command.type !== "verify-code" ||
			!this.pending ||
			command.attemptId !== this.state.attemptId ||
			command.challengeId !== this.state.challengeId ||
			!/^\d{1,32}$/.test(command.code)
		)
			return false;
		const pending = this.pending;
		this.pending = undefined;
		clearTimeout(pending.timer);
		this.scanned();
		pending.resolve(command.code);
		return true;
	}
	cancelCode(): void {
		if (!this.pending) return;
		clearTimeout(this.pending.timer);
		this.pending.reject(new Error("login_cancelled"));
		this.pending = undefined;
	}
}
