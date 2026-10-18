import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

export class SessionBusyError extends Error {
	readonly code = "session_busy";
	constructor(path: string) {
		super(`Session is in use by another client: ${path}`);
		this.name = "SessionBusyError";
	}
}

export interface SessionWriteLease {
	readonly path: string;
	assertOwned(): void;
	release(): void;
}

interface HeldLease {
	unlock: () => void;
	refs: number;
	compromised?: Error;
}

/**
 * Leases are per process, like POSIX `flock`: sessions may share a lock they
 * already own in this process, while other processes stay locked out.
 *
 * Shared leases are for session owners (`createAgentSession`), so a runtime can
 * replace a session with a file another in-process runtime still owns.
 * Maintenance operations (rename, archive) take an exclusive lease and fail
 * while any session in this process owns the file.
 */
const heldLeases = new Map<string, HeldLease>();

export interface AcquireLeaseOptions {
	/** Reuse a lock this process already owns instead of failing. */
	shared?: boolean;
}

/** Canonicalize the parent even before a new session file exists. */
function canonicalPath(path: string): string {
	return existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(resolve(path))), basename(path));
}

function leaseHandle(path: string, target: string, entry: HeldLease): SessionWriteLease {
	let released = false;
	return {
		path: resolve(path),
		assertOwned() {
			if (entry.compromised) throw entry.compromised;
			if (released) throw new Error("Session write lease has been released");
		},
		release() {
			if (released) return;
			released = true;
			entry.refs -= 1;
			if (entry.refs > 0) return;
			heldLeases.delete(target);
			if (!entry.compromised) entry.unlock();
		},
	};
}

export function acquireSessionWriteLease(path: string, options: AcquireLeaseOptions = {}): SessionWriteLease {
	const target = canonicalPath(path);
	const existing = heldLeases.get(target);
	if (existing) {
		if (!options.shared) throw new SessionBusyError(target);
		existing.refs += 1;
		return leaseHandle(path, target, existing);
	}
	const entry: HeldLease = { unlock: () => {}, refs: 1 };
	try {
		entry.unlock = lockfile.lockSync(target, {
			realpath: false,
			stale: 30_000,
			update: 10_000,
			onCompromised: (error) => {
				entry.compromised = error;
			},
		});
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") throw new SessionBusyError(target);
		throw error;
	}
	heldLeases.set(target, entry);
	return leaseHandle(path, target, entry);
}

/**
 * True while any client owns the file, including sessions in this process.
 * Callers use it to present a session as read-only before opening it.
 */
export function isSessionBusy(path: string): boolean {
	const target = canonicalPath(path);
	return lockfile.checkSync(target, { realpath: false, stale: 30_000 });
}
