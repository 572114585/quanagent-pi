import { type Credentials, WeChatBot as SdkBot } from "@wechatbot/wechatbot";

export * from "@wechatbot/wechatbot";

/** Exercises the real daemon and its IPC lifecycle without contacting Weixin. */
export class WeChatBot extends SdkBot {
	private saved?: Credentials;
	private polling = false;
	private endPoll?: () => void;
	override async login(options: Parameters<SdkBot["login"]>[0] = {}): Promise<Credentials> {
		const stored = await this.storage.get<Credentials>("credentials");
		if (stored && !options.force) {
			this.saved = stored;
			return stored;
		}
		options.callbacks?.onQrUrl?.("offline-qr-content");
		options.callbacks?.onScanned?.();
		let code = await options.callbacks?.onVerifyCode?.(false);
		while (code !== "1234") code = await options.callbacks?.onVerifyCode?.(true);
		this.saved = {
			token: "offline-secret-token",
			baseUrl: "https://example.invalid",
			accountId: "offline-bot",
			userId: "scan-owner",
			savedAt: new Date().toISOString(),
		};
		await this.storage.set("credentials", this.saved);
		return this.saved;
	}
	override getCredentials(): Credentials | undefined {
		return this.saved;
	}
	override async start(): Promise<void> {
		this.polling = true;
		this.emit("poll:start");
		await new Promise<void>((resolve) => {
			this.endPoll = resolve;
		});
	}
	override stop(): void {
		super.stop();
		this.polling = false;
		this.endPoll?.();
	}
	override get isRunning(): boolean {
		return this.polling;
	}
}
