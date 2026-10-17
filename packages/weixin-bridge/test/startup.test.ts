import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
