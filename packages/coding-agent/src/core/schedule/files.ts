import { readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ScheduleRun } from "./types.ts";

/** Only remove exact per-run directories with matching scheduler ownership metadata. */
export async function cleanupScheduleExecution(storageDir: string, run: ScheduleRun): Promise<void> {
	if (!run.execution || !/^[\w-]+$/.test(run.id) || !/^[\w-]+$/.test(run.taskId)) return;
	const directory = resolve(storageDir, "executions", run.id);
	const artifactDir = resolve(run.binding.cwd, ".pi", "schedule-artifacts", run.taskId, run.id);
	if (
		resolve(run.execution.sessionFile) !== join(directory, "session.jsonl") ||
		resolve(run.execution.artifactDir) !== artifactDir
	)
		throw new Error("Refusing to clean an execution outside its owned directories.");
	let ownership: unknown;
	try {
		ownership = JSON.parse(await readFile(join(directory, "ownership.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (
		!ownership ||
		typeof ownership !== "object" ||
		!("runId" in ownership) ||
		ownership.runId !== run.id ||
		!("taskId" in ownership) ||
		ownership.taskId !== run.taskId ||
		!("artifactDir" in ownership) ||
		ownership.artifactDir !== artifactDir
	)
		throw new Error("Execution ownership metadata does not match; files were retained.");
	const expectedLog = join(await realpath(storageDir), "executions", run.id);
	if ((await realpath(directory)) !== expectedLog) throw new Error("Refusing to clean redirected execution logs.");
	try {
		const expectedArtifacts = join(await realpath(run.binding.cwd), ".pi", "schedule-artifacts", run.taskId, run.id);
		if ((await realpath(artifactDir)) !== expectedArtifacts)
			throw new Error("Refusing to clean redirected execution artifacts.");
		await rm(artifactDir, { recursive: true, force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await rm(directory, { recursive: true, force: true });
}
