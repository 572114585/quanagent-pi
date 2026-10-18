import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { Compile } from "typebox/compile";
import { ModelConfig, ModelsConfigSchema } from "../../coding-agent/src/core/model-config.ts";
import { stripJsonComments } from "../../coding-agent/src/utils/json.ts";
import { HttpError } from "./auth.ts";
import { object } from "./protocol.ts";

const validate = Compile(ModelsConfigSchema);
export class ProviderSettings {
	private readonly path: string;
	private readonly runtime: ModelRuntime;
	constructor(agentDir: string, runtime: ModelRuntime) {
		this.path = join(agentDir, "models.json");
		this.runtime = runtime;
	}
	async list(): Promise<unknown> {
		await this.runtime.refresh({ allowNetwork: false });
		const config = await ModelConfig.load(this.path);
		return {
			providers: this.runtime.getProviders().map((provider) => ({
				id: provider.id,
				name: provider.name,
				configured: this.runtime.getProviderAuthStatus(provider.id).configured,
				authType: this.runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key",
				configuration: (() => {
					const saved = config.getProvider(provider.id);
					if (!saved?.baseUrl || !saved.models) return undefined;
					let url: URL;
					try {
						url = new URL(saved.baseUrl);
					} catch {
						return undefined;
					}
					// Existing manually configured URLs can contain secrets. Never return those.
					if (url.username || url.password || url.search || url.hash) return undefined;
					return {
						baseUrl: saved.baseUrl,
						api: saved.api,
						models: saved.models.map((model) => ({
							id: model.id,
							name: model.name,
							reasoning: model.reasoning,
							vision: model.input?.includes("image"),
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
						})),
					};
				})(),
			})),
			models: this.runtime.getAvailableSnapshot().map((model) => ({
				id: model.id,
				provider: model.provider,
				name: model.name,
				reasoning: model.reasoning,
				input: model.input,
			})),
		};
	}
	async save(providerId: string, value: unknown): Promise<void> {
		if (
			!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(providerId) ||
			["__proto__", "constructor", "prototype"].includes(providerId)
		)
			throw new HttpError(400, "invalid_provider");
		const body = object(value);
		if (body.apiKey !== undefined && (typeof body.apiKey !== "string" || !body.apiKey.trim()))
			throw new HttpError(400, "invalid_api_key");
		if (body.apiKey === undefined && body.baseUrl === undefined) throw new HttpError(400, "empty_configuration");
		if (body.baseUrl !== undefined) {
			if (typeof body.baseUrl !== "string" || typeof body.modelId !== "string" || !body.modelId.trim())
				throw new HttpError(400, "invalid_model");
			let url: URL;
			try {
				url = new URL(body.baseUrl);
			} catch {
				throw new HttpError(400, "invalid_url");
			}
			if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
				throw new HttpError(400, "invalid_url");
			if (body.api !== "openai-completions" && body.api !== "openai-responses")
				throw new HttpError(400, "invalid_api");
			await mkdir(dirname(this.path), { recursive: true });
			const release = await lockfile.lock(dirname(this.path), { lockfilePath: `${this.path}.lock`, retries: 0 });
			try {
				let current: Record<string, unknown> = {};
				try {
					current = object(
						JSON.parse(stripJsonComments((await readFile(this.path, "utf8")).replace(/^\uFEFF/, ""))),
					);
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				}
				const providers = object(current.providers);
				const provider = object(providers[providerId]);
				const models: unknown[] = Array.isArray(provider.models) ? [...provider.models] : [];
				const model = {
					...object(models.find((entry) => object(entry).id === body.modelId)),
					id: body.modelId,
					name: typeof body.modelName === "string" && body.modelName.trim() ? body.modelName.trim() : body.modelId,
					reasoning: body.reasoning === true,
					input: body.vision === true ? ["text", "image"] : ["text"],
					...(typeof body.contextWindow === "number" ? { contextWindow: body.contextWindow } : {}),
					...(typeof body.maxTokens === "number" ? { maxTokens: body.maxTokens } : {}),
				};
				const index = models.findIndex((entry) => object(entry).id === body.modelId);
				if (index < 0) models.push(model);
				else models[index] = model;
				const next = {
					...current,
					providers: { ...providers, [providerId]: { ...provider, baseUrl: body.baseUrl, api: body.api, models } },
				};
				if (!validate.Check(next)) throw new HttpError(400, "invalid_model_configuration");
				const temporary = `${this.path}.${process.pid}.tmp`;
				await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
				await rename(temporary, this.path);
			} finally {
				await release();
			}
			await this.runtime.refresh({ allowNetwork: false });
		}
		if (body.apiKey !== undefined) {
			if (typeof body.apiKey !== "string" || !body.apiKey.trim()) throw new HttpError(400, "invalid_api_key");
			await this.runtime.login(providerId, "api_key", {
				prompt: async (prompt) => {
					if (prompt.type !== "secret") throw new HttpError(400, "provider_requires_extra_fields");
					return body.apiKey as string;
				},
				notify: () => {},
			});
		}
	}
	async removeModel(providerId: string, modelId: string): Promise<void> {
		if (
			!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(providerId) ||
			["__proto__", "constructor", "prototype"].includes(providerId)
		)
			throw new HttpError(400, "invalid_provider");
		if (!modelId.trim()) throw new HttpError(400, "invalid_model");
		await mkdir(dirname(this.path), { recursive: true });
		const release = await lockfile.lock(dirname(this.path), { lockfilePath: `${this.path}.lock`, retries: 0 });
		try {
			let current: Record<string, unknown> = {};
			try {
				current = object(JSON.parse(stripJsonComments((await readFile(this.path, "utf8")).replace(/^\uFEFF/, ""))));
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
			const providers = object(current.providers);
			const provider = object(providers[providerId]);
			const models: unknown[] = Array.isArray(provider.models) ? [...provider.models] : [];
			const index = models.findIndex((entry) => object(entry).id === modelId);
			if (index < 0) throw new HttpError(404, "model_not_found");
			models.splice(index, 1);
			const next = { ...current, providers: { ...providers, [providerId]: { ...provider, models } } };
			if (!validate.Check(next)) throw new HttpError(400, "invalid_model_configuration");
			const temporary = `${this.path}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			await rename(temporary, this.path);
		} finally {
			await release();
		}
		await this.runtime.refresh({ allowNetwork: false });
	}
	async removeKey(providerId: string): Promise<void> {
		await this.runtime.logout(providerId);
	}
}
