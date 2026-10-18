import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { HttpError } from "./auth.ts";
import { type FileInfo, parseFileInfo } from "./protocol.ts";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function fileMime(data: Uint8Array): string {
	const header = Buffer.from(data.subarray(0, 16));
	if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
	if (/^GIF8[79]a/.test(header.toString("ascii"))) return "image/gif";
	if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	if (header.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
	return "application/octet-stream";
}

export function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../"));
}

export class FileStore {
	readonly directory: string;
	private readonly cwd: string;
	constructor(directory: string, cwd: string) {
		this.directory = directory;
		this.cwd = cwd;
	}
	async save(sessionId: string, name: string, data: Buffer, kind: FileInfo["kind"]): Promise<FileInfo> {
		if (data.length > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large");
		const id = randomUUID();
		const info: FileInfo = {
			id,
			sessionId,
			name:
				basename(name.replace(/\\/g, "/"))
					.replace(/[\x00-\x1f\x7f]/g, "")
					.slice(0, 200) || "file",
			mime: fileMime(data),
			size: data.length,
			kind,
			url: `/api/files/${id}`,
		};
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await writeFile(join(this.directory, id), data, { flag: "wx", mode: 0o600 });
		const metadata = join(this.directory, `${id}.json`);
		await writeFile(`${metadata}.tmp`, JSON.stringify(info), { flag: "wx", mode: 0o600 });
		await rename(`${metadata}.tmp`, metadata);
		return info;
	}
	async get(id: string, sessionId?: string): Promise<{ info: FileInfo; path: string }> {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, "file_not_found");
		let info: FileInfo | undefined;
		try {
			info = parseFileInfo(JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")));
		} catch {
			throw new HttpError(404, "file_not_found");
		}
		if (!info || info.id !== id || (sessionId !== undefined && info.sessionId !== sessionId))
			throw new HttpError(404, "file_not_found");
		try {
			const root = await realpath(this.directory);
			const path = await realpath(join(root, id));
			const details = await stat(path);
			if (!inside(root, path) || !details.isFile() || details.size > MAX_FILE_BYTES)
				throw new HttpError(404, "file_not_found");
			return { info, path };
		} catch {
			throw new HttpError(404, "file_not_found");
		}
	}
	async publish(sessionId: string, path: string): Promise<FileInfo> {
		const root = await realpath(this.cwd);
		const source = await realpath(isAbsolute(path) ? path : join(root, path));
		const details = await stat(source);
		if (!inside(root, source) || !details.isFile()) throw new HttpError(403, "file_outside_workspace");
		if (details.size > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large");
		// Snapshot the file so later agent edits do not change an already-delivered artifact.
		return this.save(sessionId, basename(source), await readFile(source), "artifact");
	}
}
