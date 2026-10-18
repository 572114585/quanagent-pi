/**
 * Phase 0.3: verify WeChat iLink bot eligibility.
 * Run from the repository root: npm run login:weixin -- [--force]
 * Scan the LATEST QR code with WeChat, confirm on phone.
 * Retries the whole login flow on transient failures (e.g. poll timeout).
 *
 * Pairing code flow: WeChat may show digits to type in (need_verifycode).
 * This script runs without a terminal, so the code is read from
 * src/demo/verifycode.txt — write the digits there (one line) when asked.
 */

import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WeChatBot } from "@wechatbot/wechatbot";
import qrTerminal from "qrcode-terminal";
import { acquireBridgeLocks, bridgePaths } from "../control.ts";

const MAX_ATTEMPTS = 5;
const VERIFYCODE_FILE = new URL("./verifycode.txt", import.meta.url);

async function waitForVerifyCode(): Promise<string> {
	console.error(`WeChat is showing a pairing code. Waiting for ${VERIFYCODE_FILE.pathname} ...`);
	for (let i = 0; i < 180; i++) {
		try {
			const raw = (await readFile(VERIFYCODE_FILE, "utf8")).trim();
			if (raw) {
				await writeFile(VERIFYCODE_FILE, "", "utf8");
				return raw;
			}
		} catch {
			// file not created yet
		}
		await delay(1_000);
	}
	throw new Error("No pairing code provided within 180s");
}

const paths = bridgePaths(getAgentDir());
const release = await acquireBridgeLocks(paths.root, paths.storage);
process.once("SIGINT", () => {
	void release().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
	void release().finally(() => process.exit(0));
});
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
	const bot = new WeChatBot({ storage: "file", logLevel: "info" });
	try {
		console.error(`\n=== Login attempt ${attempt}/${MAX_ATTEMPTS} ===`);
		const creds = await bot.login({
			force: process.argv.includes("--force"),
			callbacks: {
				onQrUrl: (url: string) => {
					console.error("\nScan this QR code with WeChat:\n");
					qrTerminal.generate(url, { small: true }, (qr: string) => {
						console.error(qr);
					});
					console.error(`(QR url: ${url})\n`);
				},
				onScanned: () => console.error("Scanned. Confirm on your phone..."),
				onExpired: () => console.error("QR expired, requesting a new one..."),
				onVerifyCode: async (isRetry: boolean) => {
					console.error(`Pairing code needed${isRetry ? " (retry)" : ""}.`);
					return waitForVerifyCode();
				},
			},
		});
		console.log(
			"Login OK:",
			JSON.stringify({ accountId: creds.accountId, userId: creds.userId, baseUrl: creds.baseUrl }, null, 2),
		);
		await release();
		process.exit(0);
	} catch (err) {
		console.error(`Attempt ${attempt} failed:`, err instanceof Error ? err.message : String(err));
		if (attempt < MAX_ATTEMPTS) {
			console.error("Retrying in 2s...");
			await delay(2_000);
		}
	}
}

console.error("All login attempts failed.");
await release();
process.exit(1);
