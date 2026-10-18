import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message = code) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export class WebAuth {
	private readonly salt = randomBytes(16);
	private readonly passwordHash: Buffer;
	private readonly username: string;
	private readonly secure: boolean;
	private readonly origin: string;
	private readonly clock: () => number;
	private readonly sessions = new Map<string, number>();
	private readonly attempts = new Map<string, { count: number; until: number }>();
	constructor(username: string, password: string, origin: string, clock = Date.now) {
		if (!username || password.length < 12)
			throw new Error("Set PI_WEB_USERNAME and PI_WEB_PASSWORD (at least 12 characters)");
		const url = new URL(origin);
		if (url.origin !== origin || !["https:", "http:"].includes(url.protocol))
			throw new Error("PI_WEB_ORIGIN must be an origin without a path");
		if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
			throw new Error("Public access requires an HTTPS origin");
		this.username = username;
		this.passwordHash = scryptSync(password, this.salt, 64);
		this.origin = origin;
		this.secure = url.protocol === "https:";
		this.clock = clock;
	}
	checkOrigin(request: IncomingMessage): void {
		if (request.headers.origin !== this.origin) throw new HttpError(403, "invalid_origin");
	}
	private token(request: IncomingMessage): string {
		return (
			request.headers.cookie
				?.split(";")
				.map((part) => part.trim())
				.find((part) => part.startsWith("pi_web="))
				?.slice(7) ?? ""
		);
	}
	private digest(token: string): string {
		return createHash("sha256").update(token).digest("hex");
	}
	check(request: IncomingMessage): number {
		const key = this.digest(this.token(request));
		const expiry = this.sessions.get(key) ?? 0;
		if (expiry <= this.clock()) {
			this.sessions.delete(key);
			throw new HttpError(401, "unauthorized");
		}
		return expiry;
	}
	login(request: IncomingMessage, response: ServerResponse, username: string, password: string): void {
		this.checkOrigin(request);
		const address = request.socket.remoteAddress ?? "unknown";
		const now = this.clock();
		for (const [key, item] of this.attempts) if (item.until <= now) this.attempts.delete(key);
		for (const [key, expiry] of this.sessions) if (expiry <= now) this.sessions.delete(key);
		const attempt = this.attempts.get(address) ?? { count: 0, until: now + 60_000 };
		if (attempt.count >= 5) throw new HttpError(429, "too_many_attempts");
		attempt.count++;
		this.attempts.set(address, attempt);
		const candidate = scryptSync(password, this.salt, 64);
		if (username !== this.username || !timingSafeEqual(candidate, this.passwordHash))
			throw new HttpError(401, "invalid_credentials");
		this.attempts.delete(address);
		const token = randomBytes(32).toString("hex");
		this.sessions.set(this.digest(token), now + 7 * 24 * 3600_000);
		response.setHeader(
			"Set-Cookie",
			`pi_web=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${this.secure ? "; Secure" : ""}`,
		);
	}
	logout(request: IncomingMessage, response: ServerResponse): void {
		this.sessions.delete(this.digest(this.token(request)));
		response.setHeader(
			"Set-Cookie",
			`pi_web=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secure ? "; Secure" : ""}`,
		);
	}
}
