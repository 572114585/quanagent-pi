import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { acquireBridgeLocks } from "../src/control.ts";
import type { WeixinStatus } from "../src/protocol.ts";

test("source startup loads configuration from the selected data directory before connecting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-weixin-startup-"));
	try {
		const result = spawnSync(
			process.execPath,
			["--import", "../coding-agent/src/experimental/source-resolver.ts", "src/daemon.ts"],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env: { ...process.env, PI_WEIXIN_BRIDGE_HOME: directory },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		assert.ifError(result.error);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /ENOENT/);
		assert.ok(result.stderr.includes(join(directory, "config.json").replaceAll("\\", "\\\\")));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test(
	"real managed daemon pairs, persists owner, excludes another process, restores and releases locks",
	{ timeout: 20000 },
	async (context) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-weixin-managed-"));
		const agentDir = join(directory, "agent");
		const root = join(directory, "bridge");
		const storage = join(directory, "wechat");
		await mkdir(agentDir);
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					offline: {
						baseUrl: "https://example.invalid",
						api: "openai-completions",
						models: [
							{
								id: "offline",
								name: "Offline",
								reasoning: false,
								input: ["text"],
								contextWindow: 32000,
								maxTokens: 1000,
							},
						],
					},
				},
			}),
		);
		const children: ReturnType<typeof spawn>[] = [];
		context.after(async () => {
			for (const child of children) {
				if (child.exitCode !== null || child.signalCode !== null) continue;
				child.kill();
				await once(child, "exit");
			}
			await rm(directory, { recursive: true, force: true });
		});
		function launch() {
			const child = spawn(
				process.execPath,
				[
					"--import",
					new URL("../../coding-agent/src/experimental/source-resolver.ts", import.meta.url).href,
					"--import",
					new URL("./fixtures/mock-sdk-loader.ts", import.meta.url).href,
					fileURLToPath(new URL("../src/daemon.ts", import.meta.url)),
				],
				{
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: agentDir,
						PI_WEIXIN_BRIDGE_HOME: root,
						PI_WEIXIN_STORAGE_DIR: storage,
						PI_WEIXIN_MANAGED: "1",
						PI_WEIXIN_SETUP_PROVIDER: "offline",
						PI_WEIXIN_SETUP_MODEL: "offline",
						PI_WEIXIN_PROVIDER: "offline",
						PI_WEIXIN_MODEL: "offline",
					},
					stdio: ["ignore", "ignore", "pipe", "ipc"],
					windowsHide: true,
				},
			);
			children.push(child);
			const states: WeixinStatus[] = [];
			let errors = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				errors += chunk.toString();
			});
			child.on("message", (message: unknown) => {
				if (
					message &&
					typeof message === "object" &&
					"type" in message &&
					message.type === "weixin-status" &&
					"status" in message
				)
					states.push(message.status as WeixinStatus);
			});
			async function waitFor(phase: WeixinStatus["phase"], retry = false): Promise<WeixinStatus> {
				const deadline = Date.now() + 6000;
				while (Date.now() < deadline) {
					const status = states.findLast((state) => state.phase === phase && (!retry || state.codeRetry));
					if (status) return status;
					if (child.exitCode !== null) assert.fail(`Daemon exited: ${JSON.stringify(states)} ${errors}`);
					await delay(10);
				}
				assert.fail(`Missing ${phase}: ${JSON.stringify(states)} ${errors}`);
			}
			return { child, states, waitFor };
		}
		const cancelled = launch();
		await cancelled.waitFor("verify_code");
		cancelled.child.send({ type: "stop" });
		await once(cancelled.child, "exit");
		assert.equal(cancelled.child.exitCode, 0);
		await assert.rejects(readFile(join(root, "config.json")), { code: "ENOENT" });
		const first = launch();
		const pairing = await first.waitFor("verify_code");
		assert.ok(first.states.some((state) => state.phase === "qr" && state.qrContent === "offline-qr-content"));
		await assert.rejects(acquireBridgeLocks(root, storage), { code: "ELOCKED" });
		first.child.send({
			type: "verify-code",
			attemptId: pairing.attemptId,
			challengeId: pairing.challengeId,
			code: "9999",
		});
		const retry = await first.waitFor("verify_code", true);
		first.child.send({
			type: "verify-code",
			attemptId: retry.attemptId,
			challengeId: retry.challengeId,
			code: "1234",
		});
		await first.waitFor("connected");
		const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
		assert.equal(config.owner, "scan-owner");
		assert.deepEqual(config.allowlist, []);
		assert.ok(!JSON.stringify(first.states).includes("offline-secret-token"));
		const duplicate = launch();
		await duplicate.waitFor("error");
		assert.equal(duplicate.states.at(-1)?.error, "bridge_busy");
		if (duplicate.child.exitCode === null) await once(duplicate.child, "exit");
		first.child.send({ type: "stop" });
		await once(first.child, "exit");
		assert.equal(first.child.exitCode, 0);
		const restored = launch();
		await restored.waitFor("connected");
		assert.ok(!restored.states.some((state) => state.phase === "qr"));
		assert.deepEqual(JSON.parse(await readFile(join(root, "config.json"), "utf8")), config);
		// Losing the parent's IPC channel must stop polling and release both locks.
		restored.child.disconnect();
		await once(restored.child, "exit");
		const release = await acquireBridgeLocks(root, storage);
		await release();
	},
);
