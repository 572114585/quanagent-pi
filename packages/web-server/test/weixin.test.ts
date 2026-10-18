import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebAuth } from "../src/auth.ts";
import { WebHost } from "../src/host.ts";
import type { WeixinSnapshot } from "../src/protocol.ts";
import { createWebServer } from "../src/server.ts";
import { WeixinManager } from "../src/weixin.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-weixin-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const children: ChildProcess[] = [];
	const options = {
		agentDir: join(directory, "agent"),
		bridgeRoot: join(directory, "bridge"),
		validateModel: async (provider: string, model: string) => provider === "faux" && model === "faux-1",
		launch: (env: NodeJS.ProcessEnv) => {
			assert.equal(env.PI_WEB_PASSWORD, undefined);
			const child = spawn(
				process.execPath,
				[fileURLToPath(new URL("./fixtures/weixin-child.ts", import.meta.url))],
				{
					env,
					stdio: ["ignore", "ignore", "ignore", "ipc"],
					windowsHide: true,
				},
			);
			children.push(child);
			return child;
		},
	};
	const manager = new WeixinManager(options);
	cleanup.push(() => manager.close());
	await manager.initialize();
	return { directory, children, manager, options };
}

async function until(manager: WeixinManager, predicate: (status: WeixinSnapshot) => boolean): Promise<WeixinSnapshot> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const status = await manager.snapshot();
		if (predicate(status)) return status;
		await delay(10);
	}
	assert.fail(`Timed out waiting for bridge: ${JSON.stringify(await manager.snapshot())}`);
}

test("concurrent connects share a child; QR, pairing, stale tabs, force login and crash are managed", async () => {
	const { manager, children, directory } = await fixture();
	await assert.rejects(manager.connect({}), /model_unavailable/);
	await Promise.all([manager.connect({ provider: "faux", model: "faux-1" }), manager.connect({})]);
	assert.equal(children.length, 1);
	const child = children[0];
	await until(manager, (status) => status.phase === "qr");
	child.send({ type: "simulate", action: "expired" });
	await until(manager, (status) => status.qrContent === "replacement-qr");
	child.send({ type: "simulate", action: "code" });
	const challenge = await until(manager, (status) => status.phase === "verify_code");
	await assert.rejects(manager.verifyCode({ ...challenge, attemptId: "old", code: "1234" }), /pairing_expired/);
	await assert.rejects(manager.verifyCode({ ...challenge, code: "bad" }), /invalid_pairing_code/);
	await manager.verifyCode({ ...challenge, code: "1234" });
	await assert.rejects(manager.verifyCode({ ...challenge, code: "1234" }), /pairing_expired/);
	child.send({ type: "simulate", action: "retry" });
	const retry = await until(manager, (status) => status.phase === "verify_code" && !!status.codeRetry);
	assert.notEqual(retry.challengeId, challenge.challengeId);
	await assert.rejects(manager.verifyCode({ ...challenge, code: "1234" }), /pairing_expired/);
	child.send({ type: "simulate", action: "confirmed" });
	const connected = await until(manager, (status) => status.phase === "connected");
	assert.equal(connected.configured, true);
	assert.ok(!JSON.stringify(connected).includes("never-expose"));
	assert.equal(JSON.parse(await readFile(join(directory, "bridge", "config.json"), "utf8")).owner, "scan-owner");
	await manager.connect({ force: true });
	assert.equal(children.length, 2);
	assert.notEqual(child.exitCode, null);
	await until(manager, (status) => status.qrContent === "forced-qr");
	children[1].send({ type: "simulate", action: "crash" });
	await until(manager, (status) => status.error === "bridge_exited");
	await manager.disconnect();
	assert.equal((await manager.snapshot()).enabled, false);
});

test("enabled connections resume after Web restart; disconnect persists and existing config is preserved", async () => {
	const { manager, directory, options, children } = await fixture();
	const config = { owner: "existing-owner", allowlist: ["alice"], provider: "faux", model: "faux-1" };
	const path = join(directory, "bridge", "config.json");
	await writeFile(path, JSON.stringify(config));
	await manager.connect({ provider: "ignored", model: "ignored" });
	await until(manager, (status) => status.phase === "qr");
	await manager.close();
	assert.notEqual(children[0].exitCode, null);
	const restarted = new WeixinManager(options);
	cleanup.push(() => restarted.close());
	await restarted.initialize();
	await until(restarted, (status) => status.phase === "qr");
	assert.equal(children.length, 2);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config);
	await restarted.disconnect();
	await restarted.close();
	const disabled = new WeixinManager(options);
	cleanup.push(() => disabled.close());
	await disabled.initialize();
	assert.equal(children.length, 2);
	assert.equal((await disabled.snapshot()).phase, "disconnected");
});

test("only one Web manager owns state and cancellation during startup stops its child", async () => {
	const { manager, options, children } = await fixture();
	const other = new WeixinManager(options);
	cleanup.push(() => other.close());
	await other.initialize();
	assert.equal((await other.snapshot()).error, "bridge_busy");
	await assert.rejects(other.connect({ provider: "faux", model: "faux-1" }), /bridge_busy/);
	await manager.connect({ provider: "faux", model: "faux-1" });
	await manager.disconnect();
	assert.notEqual(children[0].exitCode, null);
	assert.equal((await manager.snapshot()).phase, "disconnected");
});

test("Weixin endpoints require administrator auth, enforce Origin and reject stale pairing codes", async () => {
	const { manager, directory } = await fixture();
	const origin = "http://localhost:1420";
	// Weixin routes do not access the chat host; its prototype supplies the nominal type without a model runtime.
	const host: WebHost = Object.create(WebHost.prototype);
	const server = createWebServer({
		host,
		weixin: manager,
		auth: new WebAuth("admin", "test-password-long", origin),
		staticDir: directory,
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	assert.equal((await fetch(`${base}/api/weixin`)).status, 401);
	const headers = { Origin: origin, "Content-Type": "application/json" };
	assert.equal((await fetch(`${base}/api/weixin/connect`, { method: "POST", headers, body: "{}" })).status, 401);
	const login = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers,
		body: JSON.stringify({ username: "admin", password: "test-password-long" }),
	});
	const authenticated = { ...headers, Cookie: login.headers.get("set-cookie")!.split(";")[0] };
	for (const action of ["connect", "verify-code", "disconnect"]) {
		assert.equal(
			(
				await fetch(`${base}/api/weixin/${action}`, {
					method: "POST",
					headers: { ...authenticated, Origin: "https://other.invalid" },
					body: "{}",
				})
			).status,
			403,
		);
	}
	assert.equal(
		(
			await fetch(`${base}/api/weixin/connect`, {
				method: "POST",
				headers: authenticated,
				body: JSON.stringify({ provider: "faux", model: "faux-1" }),
			})
		).status,
		202,
	);
	assert.equal(
		(
			await fetch(`${base}/api/weixin/verify-code`, {
				method: "POST",
				headers: authenticated,
				body: JSON.stringify({ attemptId: "old", challengeId: "old", code: "1234" }),
			})
		).status,
		409,
	);
	assert.equal((await fetch(`${base}/api/weixin/disconnect`, { method: "POST", headers: authenticated })).status, 200);
});
