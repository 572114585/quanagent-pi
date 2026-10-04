import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type ExecutionEnv, type FileInfo, getOrThrow, type Result, type ShellOutputInfo } from "../env/index.ts";
import type { EnvConformanceCase, EnvConformanceOptions } from "./types.ts";

const context = BACKGROUND_CONTEXT;
const decoder = new TextDecoder();

type EnvTest = (env: ExecutionEnv) => Promise<void>;

function abortedContext(): Context {
	const controller = new AbortController();
	controller.abort();
	return withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
}

function errorCode(result: Result<unknown, { code: string }>): string | undefined {
	return result.ok ? undefined : result.error.code;
}

async function readAll(
	env: ExecutionEnv,
	path: string,
	maxEntries: number,
): Promise<{ pages: FileInfo[][]; done: boolean }> {
	const reader = getOrThrow(await env.openDirReader(path, context));
	const pages: FileInfo[][] = [];
	try {
		for (let page = 0; page < 1000; page++) {
			const next = getOrThrow(await reader.next(maxEntries, context));
			pages.push(next.entries);
			if (next.done) return { pages, done: true };
		}
		return { pages, done: false };
	} finally {
		await reader.close(context);
	}
}

/**
 * Creates runner-independent cases for an `ExecutionEnv`. `withEnv` must call and await its callback exactly once per
 * case with an environment whose `cwd` is a fresh, empty, writable directory.
 */
export function createEnvConformance(options: EnvConformanceOptions): readonly EnvConformanceCase[] {
	const assert = options.assertions;
	const shell = options.shell ?? ["sh", "-c"];
	const symlinks = options.symlinks ?? true;
	const createCase = (name: string, test: EnvTest): EnvConformanceCase => ({
		name,
		run: () => options.withEnv(test),
	});
	const execCollect = async (env: ExecutionEnv, command: string | readonly string[], cwd?: string) => {
		const output: Record<ShellOutputInfo["stream"], string> = { stdout: "", stderr: "" };
		const result = await env.exec(
			command,
			{
				...(cwd === undefined ? {} : { cwd }),
				onOutput: (text, _context, info) => {
					output[info.stream] += text;
				},
			},
			context,
		);
		return { result, ...output };
	};

	const cases: EnvConformanceCase[] = [
		createCase("binary reader reads byte ranges of the opened file", async (env) => {
			getOrThrow(await env.writeFile("data.txt", "hello world", context));
			const reader = getOrThrow(await env.openBinaryReader("data.txt", undefined, context));
			const info = getOrThrow(await reader.info(context));
			assert.partialDeepEqual(info, { name: "data.txt", kind: "file", size: 11 });
			assert.strictEqual(decoder.decode(getOrThrow(await reader.read(0, 5, context))), "hello");
			assert.strictEqual(decoder.decode(getOrThrow(await reader.read(6, 100, context))), "world");
			assert.strictEqual(getOrThrow(await reader.read(11, 4, context)).length, 0);
			assert.strictEqual(getOrThrow(await reader.read(50, 1, context)).length, 0);
			assert.strictEqual(getOrThrow(await reader.read(3, 0, context)).length, 0);
			assert.strictEqual(errorCode(await reader.read(-1, 1, context)), "invalid");
			assert.strictEqual(errorCode(await reader.read(0, 1.5, context)), "invalid");
			assert.strictEqual(errorCode(await reader.read(0, 1, abortedContext())), "aborted");
			await reader.close(context);
			await reader.close(context);
			assert.strictEqual(errorCode(await reader.read(0, 1, context)), "invalid");
			assert.strictEqual(errorCode(await reader.info(context)), "invalid");
		}),

		createCase("binary reader keeps reading the file it opened after a rename", async (env) => {
			getOrThrow(await env.writeFile("a.txt", "one", context));
			const reader = getOrThrow(await env.openBinaryReader("a.txt", undefined, context));
			try {
				getOrThrow(await env.renameFile("a.txt", "b.txt", context));
				getOrThrow(await env.writeFile("a.txt", "two", context));
				assert.strictEqual(decoder.decode(getOrThrow(await reader.read(0, 10, context))), "one");
			} finally {
				await reader.close(context);
			}
		}),

		createCase("binary reader refuses directories, missing files and aborted opens", async (env) => {
			getOrThrow(await env.createDir("dir", undefined, context));
			getOrThrow(await env.writeFile("file.txt", "x", context));
			assert.strictEqual(errorCode(await env.openBinaryReader("dir", undefined, context)), "is_directory");
			assert.strictEqual(errorCode(await env.openBinaryReader("missing.txt", undefined, context)), "not_found");
			assert.strictEqual(errorCode(await env.openBinaryReader("file.txt", undefined, abortedContext())), "aborted");
		}),

		createCase("directory reader pages every entry exactly once", async (env) => {
			const names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
			for (const name of names) getOrThrow(await env.writeFile(name, name, context));
			getOrThrow(await env.createDir("sub", undefined, context));
			const { pages, done } = await readAll(env, ".", 2);
			assert.ok(done, "directory reader reached the end");
			for (const page of pages) assert.ok(page.length <= 2, "page within maxEntries");
			const entries = pages.flat();
			assert.deepEqual(entries.map((entry) => entry.name).sort(), [...names, "sub"].sort());
			assert.strictEqual(entries.find((entry) => entry.name === "sub")?.kind, "directory");
			assert.partialDeepEqual(
				entries.find((entry) => entry.name === "a.txt"),
				{ kind: "file", size: 5 },
			);
		}),

		createCase("directory reader reports the end and refuses use after close", async (env) => {
			getOrThrow(await env.createDir("empty", undefined, context));
			const reader = getOrThrow(await env.openDirReader("empty", context));
			assert.deepEqual(getOrThrow(await reader.next(10, context)), { entries: [], done: true });
			assert.deepEqual(getOrThrow(await reader.next(10, context)), { entries: [], done: true });
			assert.strictEqual(errorCode(await reader.next(0, context)), "invalid");
			assert.strictEqual(errorCode(await reader.next(1, abortedContext())), "aborted");
			await reader.close(context);
			await reader.close(context);
			assert.strictEqual(errorCode(await reader.next(1, context)), "invalid");
		}),

		createCase("directory reader refuses missing paths and files", async (env) => {
			getOrThrow(await env.writeFile("file.txt", "x", context));
			assert.strictEqual(errorCode(await env.openDirReader("missing", context)), "not_found");
			const file = await env.openDirReader("file.txt", context);
			assert.strictEqual(errorCode(file), "not_directory");
			assert.strictEqual(errorCode(await env.openDirReader(".", abortedContext())), "aborted");
		}),

		createCase("directory reader skips entries removed during enumeration", async (env) => {
			getOrThrow(await env.createDir("dir", undefined, context));
			for (const name of ["x", "y", "z"]) getOrThrow(await env.writeFile(`dir/${name}`, name, context));
			const reader = getOrThrow(await env.openDirReader("dir", context));
			try {
				for (const name of ["x", "y", "z"]) getOrThrow(await env.remove(`dir/${name}`, undefined, context));
				const entries: FileInfo[] = [];
				for (let page = 0; page < 10; page++) {
					const next = getOrThrow(await reader.next(10, context));
					entries.push(...next.entries);
					if (next.done) break;
				}
				assert.deepEqual(entries, []);
			} finally {
				await reader.close(context);
			}
		}),

		createCase("argv exec passes arguments to the program without shell parsing", async (env) => {
			const hostile = "it's $(touch pwned) `touch pwned` *; touch pwned";
			const { result, stdout } = await execCollect(env, [
				...shell,
				'printf "%s|%s" "$1" "$2"',
				"argv0",
				hostile,
				"a b",
			]);
			assert.strictEqual(getOrThrow(result).exitCode, 0);
			assert.strictEqual(stdout, `${hostile}|a b`);
			assert.strictEqual(getOrThrow(await env.exists("pwned", context)), false);
		}),

		createCase("exec reports the stream of every chunk in both forms", async (env) => {
			const script = "printf out; printf err >&2; printf more";
			const argv = await execCollect(env, [...shell, script]);
			assert.strictEqual(getOrThrow(argv.result).exitCode, 0);
			assert.strictEqual(argv.stdout, "outmore");
			assert.strictEqual(argv.stderr, "err");
			const string = await execCollect(env, script);
			assert.strictEqual(getOrThrow(string.result).exitCode, 0);
			assert.strictEqual(string.stdout, "outmore");
			assert.strictEqual(string.stderr, "err");
		}),

		createCase("argv exec honors cwd and exit codes", async (env) => {
			getOrThrow(await env.createDir("sub", undefined, context));
			const made = await execCollect(env, [...shell, "printf x > made.txt; exit 3"], "sub");
			assert.strictEqual(getOrThrow(made.result).exitCode, 3);
			assert.strictEqual(getOrThrow(await env.readTextFile("sub/made.txt", context)), "x");
		}),

		createCase("argv exec reports missing programs and empty argv as spawn errors", async (env) => {
			assert.strictEqual(
				errorCode(await env.exec(["pi-durable-conformance-missing-program"], undefined, context)),
				"spawn_error",
			);
			assert.strictEqual(errorCode(await env.exec([], undefined, context)), "spawn_error");
		}),

		createCase("argv exec distinguishes timeout from abort", async (env) => {
			const timedOut = await env.exec([...shell, "sleep 5"], { timeout: 0.1 }, context);
			assert.strictEqual(errorCode(timedOut), "timeout");
			const controller = new AbortController();
			const running = env.exec([...shell, "sleep 5"], undefined, withAbortSignal(controller.signal, context));
			setTimeout(() => controller.abort(), 100);
			assert.strictEqual(errorCode(await running), "aborted");
		}),
	];

	if (symlinks) {
		cases.push(
			createCase("binary reader follows symlinks unless noFollow refuses the final one", async (env) => {
				getOrThrow(await env.writeFile("target.txt", "target", context));
				getOrThrow(await env.createDir("sub", undefined, context));
				getOrThrow(await env.writeFile("sub/inner.txt", "inner", context));
				const linked = await env.exec(
					[...shell, "ln -s target.txt link.txt && ln -s sub dirlink"],
					undefined,
					context,
				);
				assert.strictEqual(getOrThrow(linked).exitCode, 0);

				const followed = getOrThrow(await env.openBinaryReader("link.txt", undefined, context));
				assert.strictEqual(decoder.decode(getOrThrow(await followed.read(0, 10, context))), "target");
				await followed.close(context);

				assert.strictEqual(
					errorCode(await env.openBinaryReader("link.txt", { noFollow: true }, context)),
					"invalid",
				);

				// Only the final component is refused; earlier symlinked directories still resolve.
				const inner = getOrThrow(await env.openBinaryReader("dirlink/inner.txt", { noFollow: true }, context));
				assert.strictEqual(decoder.decode(getOrThrow(await inner.read(0, 10, context))), "inner");
				await inner.close(context);
			}),
		);
	}

	return cases;
}
