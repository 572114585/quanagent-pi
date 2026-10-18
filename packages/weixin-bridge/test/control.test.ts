import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Credentials, WeChatBot } from "@wechatbot/wechatbot";
import { BridgeBot } from "../src/bot.ts";
import { acquireBridgeLocks, BridgeControl } from "../src/control.ts";
import type { WeixinStatus } from "../src/protocol.ts";

test("QR replacement, code retries, cancellation and timeout invalidate old challenges", async () => {
	const events: WeixinStatus[] = [];
	const control = new BridgeControl((status) => events.push(status));
	control.begin();
	const attemptId = control.status().attemptId!;
	control.qr("first");
	control.scanned();
	control.expired();
	assert.equal(control.status().qrContent, undefined);
	control.qr("second");
	const first = control.requestCode(false);
	const challengeId = control.status().challengeId!;
	assert.equal(control.submit({ type: "verify-code", attemptId: "old", challengeId, code: "1234" }), false);
	assert.equal(control.submit({ type: "verify-code", attemptId, challengeId, code: "bad" }), false);
	assert.equal(control.submit({ type: "verify-code", attemptId, challengeId, code: "1234" }), true);
	assert.equal(await first, "1234");
	assert.equal(control.status().challengeId, undefined);
	const retry = control.requestCode(true);
	assert.equal(control.status().codeRetry, true);
	assert.equal(control.submit({ type: "verify-code", attemptId, challengeId, code: "1234" }), false);
	const cancelled = assert.rejects(retry, /login_cancelled/);
	control.begin();
	await cancelled;
	assert.notEqual(control.status().attemptId, attemptId);
	await assert.rejects(control.requestCode(false, 1), /pairing_timeout/);
	assert.equal(control.status().error, "pairing_timeout");
	assert.ok(!JSON.stringify(events).includes("1234"));
});

test("bridge locks exclude shared credentials and shared data, releasing partial acquisitions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-weixin-lock-"));
	try {
		const root = join(directory, "a-root");
		const storage = join(directory, "z-storage");
		const release = await acquireBridgeLocks(root, storage);
		try {
			await assert.rejects(acquireBridgeLocks(root, join(directory, "other-storage")), { code: "ELOCKED" });
			await assert.rejects(acquireBridgeLocks(join(directory, "b-other-root"), storage), { code: "ELOCKED" });
			const partial = await acquireBridgeLocks(join(directory, "b-other-root"), join(directory, "new-storage"));
			await partial();
		} finally {
			await release();
		}
		const next = await acquireBridgeLocks(root, storage);
		await next();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("automatic re-login retains callbacks and restarts the poll loop with new credentials", async (context) => {
	let running = false;
	let token = 0;
	let stopPoll: (() => void) | undefined;
	let pollCount = 0;
	let qrCount = 0;
	let loginCount = 0;
	const credentials: Credentials = {
		token: "secret",
		userId: "owner",
		accountId: "bot",
		baseUrl: "https://example.invalid",
		savedAt: "now",
	};
	context.mock.method(WeChatBot.prototype, "login", async (options: Parameters<WeChatBot["login"]>[0]) => {
		token++;
		options?.callbacks?.onQrUrl?.("qr-content");
		options?.callbacks?.onScanned?.();
		return { ...credentials, token: String(token) };
	});
	const tokens: number[] = [];
	context.mock.method(WeChatBot.prototype, "start", async () => {
		pollCount++;
		tokens.push(token);
		running = true;
		await new Promise<void>((resolve) => {
			stopPoll = resolve;
		});
	});
	context.mock.method(WeChatBot.prototype, "stop", () => {
		running = false;
		stopPoll?.();
	});
	class TestBot extends BridgeBot {
		override get isRunning(): boolean {
			return running;
		}
	}
	const bot = new TestBot(
		{ storage: "memory", logLevel: "silent" },
		{
			onQrUrl: () => {
				qrCount++;
			},
		},
		() => {
			loginCount++;
		},
	);
	await bot.login();
	const polling = bot.start();
	assert.equal(pollCount, 1);
	await bot.login({ force: true });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(pollCount, 2);
	assert.deepEqual(tokens, [1, 2]);
	assert.equal(qrCount, 2);
	assert.equal(loginCount, 2);
	bot.stop();
	await polling;
});
