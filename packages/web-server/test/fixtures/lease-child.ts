import { SessionManager } from "@earendil-works/pi-coding-agent";

try {
	const manager = SessionManager.open(process.argv[2]);
	const release = manager.acquireWriteLease();
	process.stdout.write("ready\n");
	process.stdin.resume();
	process.stdin.once("end", () => {
		release();
		process.exit(0);
	});
} catch (error) {
	process.stdout.write(error instanceof Error && "code" in error ? String(error.code) : "error");
	process.exitCode = 1;
}
