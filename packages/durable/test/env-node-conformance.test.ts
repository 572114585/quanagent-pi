import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { registerEnvConformance } from "../src/testing/index.ts";

const windows = process.platform === "win32";
const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
const context = BACKGROUND_CONTEXT;

registerEnvConformance(
	{ describe, expect, it },
	"NodeExecutionEnv conformance",
	async (use) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-durable-env-conformance-"));
		try {
			await use(new NodeExecutionEnv({ cwd }));
		} finally {
			// On Windows, `taskkill /T` runs asynchronously, so a killed command's descendants can still hold the
			// directory briefly after `exec` settles; retry on EBUSY.
			rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	},
	// Git Bash's `ln -s` copies instead of linking unless native symlinks are enabled.
	windows ? { shell: [gitBash, "-c"], symlinks: false } : {},
);

describe("NodeExecutionEnv readers", () => {
	const dirs: string[] = [];
	const tempDir = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "pi-durable-env-readers-"));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	});

	it("reads ranges spanning several internal chunks exactly", async () => {
		const cwd = tempDir();
		const bytes = new Uint8Array(2.5 * 1024 * 1024);
		for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31) % 251;
		writeFileSync(join(cwd, "big.bin"), bytes);
		const reader = getOrThrow(await new NodeExecutionEnv({ cwd }).openBinaryReader("big.bin", undefined, context));
		try {
			const all = getOrThrow(await reader.read(0, bytes.length + 10, context));
			expect(all.length).toBe(bytes.length);
			expect(Buffer.from(all).equals(Buffer.from(bytes))).toBe(true);
			const middle = getOrThrow(await reader.read(1024 * 1024 - 3, 7, context));
			expect([...middle]).toEqual([...bytes.subarray(1024 * 1024 - 3, 1024 * 1024 + 4)]);
		} finally {
			await reader.close(context);
		}
	});

	it.skipIf(windows)("refuses a FIFO without waiting for a writer", async () => {
		const cwd = tempDir();
		execFileSync("mkfifo", [join(cwd, "pipe")]);
		const result = await new NodeExecutionEnv({ cwd }).openBinaryReader("pipe", undefined, context);
		expect(result).toMatchObject({ ok: false, error: { code: "invalid" } });
	});
});
