import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getDefaultSessionDir, SessionManager } from "@earendil-works/pi-coding-agent";

/** Pins a user to a concrete session; a missing pinned file is never silently recreated. */
export async function openUserSession(userId: string, userDir: string, cwd: string): Promise<SessionManager> {
	const agentDir = join(userDir, ".pi-agent");
	let pointer: unknown;
	try {
		pointer = JSON.parse(await readFile(join(userDir, "current-session.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (pointer === undefined) return SessionManager.continueRecent(cwd, getDefaultSessionDir(cwd, agentDir));
	if (
		!pointer ||
		typeof pointer !== "object" ||
		!("version" in pointer) ||
		pointer.version !== 1 ||
		!("userId" in pointer) ||
		pointer.userId !== userId ||
		!("sessionId" in pointer) ||
		typeof pointer.sessionId !== "string" ||
		!("sessionFile" in pointer) ||
		typeof pointer.sessionFile !== "string"
	)
		throw new Error("Invalid saved user session mapping.");
	const path = resolve(pointer.sessionFile);
	const rel = relative(resolve(agentDir, "sessions"), path);
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../"))
		throw new Error("The saved session is outside this user's session directory.");
	const content = await readFile(path, "utf8");
	const header: unknown = JSON.parse(content.split(/\r?\n/, 1)[0] ?? "");
	if (
		!header ||
		typeof header !== "object" ||
		!("id" in header) ||
		header.id !== pointer.sessionId ||
		!("cwd" in header) ||
		typeof header.cwd !== "string" ||
		resolve(header.cwd) !== resolve(cwd)
	)
		throw new Error("The saved session identity or working directory changed.");
	return SessionManager.open(path);
}

export async function saveUserSession(userId: string, userDir: string, manager: SessionManager): Promise<void> {
	await mkdir(userDir, { recursive: true });
	const path = join(userDir, "current-session.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(
				JSON.stringify({
					version: 1,
					userId,
					sessionId: manager.getSessionId(),
					sessionFile: manager.getSessionFile(),
				}),
			);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
