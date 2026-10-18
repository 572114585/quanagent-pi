import { type Credentials, type QrLoginCallbacks, WeChatBot } from "@wechatbot/wechatbot";
import { STORAGE_KEYS } from "@wechatbot/wechatbot/storage";

/** SDK 2.2's automatic re-login omits callbacks and leaves the poller on its old token. */
export class BridgeBot extends WeChatBot {
	private readonly callbacks: QrLoginCallbacks;
	private readonly onLogin: () => void;
	private restartPolling = false;
	private ending = false;
	private loginWork?: Promise<Credentials>;
	constructor(options: ConstructorParameters<typeof WeChatBot>[0], callbacks: QrLoginCallbacks, onLogin: () => void) {
		super(options);
		this.callbacks = callbacks;
		this.onLogin = onLogin;
	}
	override login(options: Parameters<WeChatBot["login"]>[0] = {}): Promise<Credentials> {
		if (this.loginWork) return this.loginWork;
		this.onLogin();
		this.loginWork = this.storage
			.get<Credentials>(STORAGE_KEYS.CREDENTIALS)
			.then(async (previous) => {
				const credentials = await super.login({ ...options, callbacks: options.callbacks ?? this.callbacks });
				if (!this.isRunning && previous && previous.token !== credentials.token) {
					await Promise.all(
						[STORAGE_KEYS.CURSOR, STORAGE_KEYS.CONTEXT_TOKENS, STORAGE_KEYS.TYPING_TICKETS].map((key) =>
							this.storage.delete(key),
						),
					);
				}
				if (this.isRunning) {
					this.restartPolling = true;
					super.stop();
				}
				return credentials;
			})
			.finally(() => {
				this.loginWork = undefined;
			});
		return this.loginWork;
	}
	override async start(): Promise<void> {
		do {
			this.restartPolling = false;
			await super.start();
		} while (this.restartPolling && !this.ending);
	}
	override stop(): void {
		this.ending = true;
		super.stop();
	}
}
