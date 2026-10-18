import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { SessionBusyError } from "@earendil-works/pi-coding-agent";
import { HttpError, type WebAuth } from "./auth.ts";
import { inside, MAX_FILE_BYTES } from "./files.ts";
import type { WebHost } from "./host.ts";
import { object } from "./protocol.ts";
import type { WeixinManager } from "./weixin.ts";

export async function readBody(request: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request.iterator({ destroyOnReturn: false })) {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
		size += data.length;
		if (size > limit) {
			request.resume();
			throw new HttpError(413, "request_too_large");
		}
		chunks.push(data);
	}
	return Buffer.concat(chunks);
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	if (!request.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "expected_json");
	try {
		return object(JSON.parse((await readBody(request)).toString("utf8")));
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(400, "invalid_json");
	}
}
function json(response: ServerResponse, value: unknown, status = 200): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

export function createWebServer(options: { host: WebHost; auth: WebAuth; staticDir: string; weixin?: WeixinManager }) {
	const { host, auth } = options;
	const server = createServer((request, response) => {
		response.on("error", () => response.destroy());
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "same-origin");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
		);
		void route(request, response).catch((error: unknown) => {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			const failure =
				error instanceof HttpError
					? error
					: error instanceof SessionBusyError
						? new HttpError(409, "session_busy")
						: new HttpError(500, "request_failed");
			json(response, { error: failure.code }, failure.status);
		});
	});
	server.headersTimeout = 15_000;
	server.requestTimeout = 120_000;

	async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const path = url.pathname;
		const method = request.method ?? "GET";
		if (!path.startsWith("/api/")) {
			await serveStatic(path, response);
			return;
		}
		if (!["GET", "HEAD"].includes(method)) auth.checkOrigin(request);
		if (path === "/api/auth/login" && method === "POST") {
			const body = await readJson(request);
			if (typeof body.username !== "string" || typeof body.password !== "string" || body.password.length > 4096)
				throw new HttpError(400, "invalid_credentials");
			auth.login(request, response, body.username, body.password);
			json(response, { authenticated: true });
			return;
		}
		const expiresAt = auth.check(request);
		if (path === "/api/auth" && method === "GET") {
			json(response, { authenticated: true, cwd: host.cwd });
			return;
		}
		if (path === "/api/auth/logout" && method === "POST") {
			auth.logout(request, response);
			json(response, {});
			return;
		}
		if (path === "/api/weixin" || path.startsWith("/api/weixin/")) {
			if (!options.weixin) throw new HttpError(503, "weixin_unavailable");
			if (path === "/api/weixin" && method === "GET") {
				json(response, await options.weixin.snapshot());
				return;
			}
			if (method === "POST" && path === "/api/weixin/connect") {
				json(response, await options.weixin.connect(await readJson(request)), 202);
				return;
			}
			if (method === "POST" && path === "/api/weixin/verify-code") {
				json(response, await options.weixin.verifyCode(await readJson(request)));
				return;
			}
			if (method === "POST" && path === "/api/weixin/disconnect") {
				json(response, await options.weixin.disconnect());
				return;
			}
			throw new HttpError(404, "not_found");
		}
		if (path === "/api/models" && method === "GET") {
			json(response, await host.providers.list());
			return;
		}
		const providerModels = /^\/api\/providers\/([A-Za-z0-9._-]+)\/models$/.exec(path);
		if (providerModels && method === "DELETE") {
			const body = await readJson(request);
			const modelId = body.modelId;
			if (typeof modelId !== "string") throw new HttpError(400, "invalid_model");
			await host.configure(() => host.providers.removeModel(providerModels[1], modelId));
			json(response, {});
			return;
		}
		const provider = /^\/api\/providers\/([A-Za-z0-9._-]+)$/.exec(path);
		if (provider && (method === "PUT" || method === "DELETE")) {
			const body = method === "PUT" ? await readJson(request) : undefined;
			await host.configure(() =>
				method === "PUT" ? host.providers.save(provider[1], body) : host.providers.removeKey(provider[1]),
			);
			json(response, {});
			return;
		}
		if (path === "/api/sessions") {
			if (method === "GET") {
				json(response, { sessions: await host.list() });
				return;
			}
			if (method === "POST") {
				json(response, host.create(), 201);
				return;
			}
		}
		const session =
			/^\/api\/sessions\/([A-Za-z0-9._-]+)(?:\/(messages|events|stop|uploads|dialogs)(?:\/([a-f0-9-]+))?)?$/.exec(
				path,
			);
		if (session) {
			const [, id, action, dialogId] = session;
			if (!action && method === "GET") {
				json(response, host.snapshot(id));
				return;
			}
			if (!action && method === "PATCH") {
				const body = await readJson(request);
				if (typeof body.name !== "string") throw new HttpError(400, "invalid_name");
				await host.rename(id, body.name);
				json(response, {});
				return;
			}
			if (!action && method === "DELETE") {
				await host.archive(id);
				json(response, {});
				return;
			}
			if (action === "messages" && method === "POST") {
				json(response, { runId: host.start(id, await readJson(request)) }, 202);
				return;
			}
			if (action === "stop" && method === "POST") {
				await host.stop(id);
				json(response, {});
				return;
			}
			if (action === "dialogs" && dialogId && method === "POST") {
				const body = await readJson(request);
				if (body.value !== undefined && typeof body.value !== "string" && typeof body.value !== "boolean")
					throw new HttpError(400, "invalid_answer");
				host.answer(id, dialogId, body.value);
				json(response, {});
				return;
			}
			if (action === "uploads" && method === "POST") {
				const name = request.headers["x-file-name"];
				if (typeof name !== "string") throw new HttpError(400, "missing_filename");
				let decoded: string;
				try {
					decoded = decodeURIComponent(name);
				} catch {
					throw new HttpError(400, "invalid_filename");
				}
				json(response, await host.upload(id, decoded, await readBody(request, MAX_FILE_BYTES)), 201);
				return;
			}
			if (action === "events" && method === "GET") {
				host.snapshot(id);
				response.writeHead(200, {
					"Content-Type": "text/event-stream",
					"X-Accel-Buffering": "no",
					Connection: "keep-alive",
				});
				response.flushHeaders();
				const unsubscribe = host.subscribe(
					id,
					String(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? ""),
					(event) => {
						if (response.destroyed || response.writableEnded) return;
						if (response.writableLength > 2 * 1024 * 1024) {
							response.destroy();
							return;
						}
						if ("snapshot" in event)
							response.write(
								`event: snapshot\nid: ${event.snapshot.cursor}\ndata: ${JSON.stringify(event.snapshot)}\n\n`,
							);
						else response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
					},
				);
				const heartbeat = setInterval(() => {
					try {
						auth.check(request);
					} catch {
						response.end();
						return;
					}
					if (Date.now() >= expiresAt) {
						response.end();
						return;
					}
					response.write(": heartbeat\n\n");
				}, 15_000);
				response.on("close", () => {
					clearInterval(heartbeat);
					unsubscribe();
				});
				return;
			}
		}
		const file = /^\/api\/files\/([a-f0-9-]+)$/.exec(path);
		if (file && method === "GET") {
			const stored = await host.files.get(file[1]);
			host.snapshot(stored.info.sessionId);
			response.setHeader("Content-Type", stored.info.mime);
			response.setHeader(
				"Content-Disposition",
				`${url.searchParams.has("download") || stored.info.mime === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(stored.info.name)}`,
			);
			response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
			createReadStream(stored.path)
				.on("error", () => response.destroy())
				.pipe(response);
			return;
		}
		throw new HttpError(404, "not_found");
	}
	async function serveStatic(path: string, response: ServerResponse): Promise<void> {
		let root: string;
		try {
			root = await realpath(options.staticDir);
		} catch {
			throw new HttpError(503, "frontend_not_built");
		}
		let decoded: string;
		try {
			decoded = decodeURIComponent(path);
		} catch {
			throw new HttpError(400, "invalid_path");
		}
		let file = join(root, decoded);
		if (!inside(root, file)) throw new HttpError(404, "not_found");
		try {
			if (!(await stat(file)).isFile()) file = join(root, "index.html");
		} catch {
			if (extname(decoded)) throw new HttpError(404, "not_found");
			file = join(root, "index.html");
		}
		file = await realpath(file);
		if (!inside(root, file)) throw new HttpError(404, "not_found");
		const types: Record<string, string> = {
			".html": "text/html; charset=utf-8",
			".js": "text/javascript; charset=utf-8",
			".mjs": "text/javascript; charset=utf-8",
			".wasm": "application/wasm",
			".css": "text/css; charset=utf-8",
			".svg": "image/svg+xml",
			".png": "image/png",
			".woff2": "font/woff2",
			".ttf": "font/ttf",
		};
		response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
		response.end(await readFile(file));
	}
	return server;
}
