import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WebAuth } from "./auth.ts";
import { WebHost } from "./host.ts";
import { createWebServer } from "./server.ts";
import { WeixinManager } from "./weixin.ts";

const { values } = parseArgs({
	options: {
		cwd: { type: "string", default: process.cwd() },
		port: { type: "string", default: "8000" },
		host: { type: "string", default: "127.0.0.1" },
	},
});
const cwd = await realpath(resolve(values.cwd));
const agentDir = getAgentDir();
const origin = process.env.PI_WEB_ORIGIN ?? `http://127.0.0.1:${values.port}`;
const auth = new WebAuth(process.env.PI_WEB_USERNAME ?? "", process.env.PI_WEB_PASSWORD ?? "", origin);
const runtime = await ModelRuntime.create({
	authPath: join(agentDir, "auth.json"),
	modelsPath: join(agentDir, "models.json"),
});
const host = new WebHost({
	cwd,
	agentDir,
	modelRuntime: runtime,
	dataDir: join(agentDir, "web", createHash("sha256").update(cwd).digest("hex").slice(0, 24)),
	sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
});
const weixin = new WeixinManager({
	agentDir,
	validateModel: async (provider, id) => {
		await runtime.refresh({ allowNetwork: false });
		return runtime.getAvailableSnapshot().some((model) => model.provider === provider && model.id === id);
	},
});
const server = createWebServer({
	host,
	auth,
	weixin,
	staticDir: fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url)),
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
await weixin.initialize();
server.listen(port, values.host, () => console.log(`Pi Web: ${origin}\nWorkspace: ${cwd}`));
let closing = false;
async function shutdown(): Promise<void> {
	if (closing) return;
	closing = true;
	server.close();
	await Promise.all([host.close(), weixin.close()]);
	server.closeAllConnections();
}
process.once("SIGINT", () => {
	void shutdown();
});
process.once("SIGTERM", () => {
	void shutdown();
});
