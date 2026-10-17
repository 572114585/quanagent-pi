import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/core/schedule/store.ts";

const directories: string[] = [];
const stores: ScheduleStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(): Promise<ScheduleStore> {
	const directory = await mkdtemp(join(tmpdir(), "pi-schedule-store-"));
	directories.push(directory);
	const store = new ScheduleStore(directory, (error) => {
		throw error;
	});
	stores.push(store);
	return store;
}

describe("schedule storage", () => {
	it("owns one namespace, serializes writes and reopens committed data", async () => {
		const store = await setup();
		await store.start();
		const other = new ScheduleStore(store.directory, () => {});
		await expect(other.start()).rejects.toThrow("another process");
		await Promise.all([
			store.transact((state) => {
				state.weixinBinding = { bindingId: "bridge", userId: "owner" };
			}),
			store.transact((state) => state.tasks.length),
		]);
		await store.close();
		await store.start();
		expect(store.state.weixinBinding).toEqual({ bindingId: "bridge", userId: "owner" });
	});
	it("leaves corrupt and unsupported data untouched", async () => {
		const store = await setup();
		const path = join(store.directory, "state.json");
		for (const value of ["{broken", '{"version":2,"tasks":[],"runs":[]}', '{"version":1,"tasks":[{}],"runs":[]}']) {
			await writeFile(path, value);
			await expect(store.start()).rejects.toThrow("left unchanged");
			expect(await readFile(path, "utf8")).toBe(value);
		}
	});
	it("does not commit failed transactions", async () => {
		const store = await setup();
		await store.start();
		await expect(
			store.transact((state) => {
				state.weixinBinding = { bindingId: "bad", userId: "bad" };
				throw new Error("cancel");
			}),
		).rejects.toThrow("cancel");
		expect(store.state.weixinBinding).toBeUndefined();
		await store.transact((state) => {
			state.weixinBinding = { bindingId: "good", userId: "owner" };
		});
		expect(store.state.weixinBinding?.bindingId).toBe("good");
	});
});
