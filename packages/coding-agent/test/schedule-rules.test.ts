import { describe, expect, it } from "vitest";
import { createScheduleRule, scheduleOccurrence } from "../src/core/schedule/rules.ts";

const now = Date.parse("2026-10-17T00:00:00Z");

describe("schedule timing rules", () => {
	it("supports all six selectors with explicit wall-clock zones", () => {
		const inputs = [
			{ after_seconds: 5 },
			{ at: "2026-10-17T09:00:00+08:00" },
			{ every_seconds: 60 },
			{ daily: { time: "09:00", time_zone: "Asia/Shanghai" } },
			{ weekly: { time: "09:00", time_zone: "Asia/Shanghai", weekdays: [1, 3] } },
			{ cron: { expression: "*/15 9-17 * * 1-5", time_zone: "Asia/Shanghai" } },
		];
		expect(inputs.map((input) => scheduleOccurrence(createScheduleRule(input, now), now, 1))).toEqual([
			"2026-10-17T00:00:05.000Z",
			"2026-10-17T01:00:00.000Z",
			"2026-10-17T00:01:00.000Z",
			"2026-10-17T01:00:00.000Z",
			"2026-10-19T01:00:00.000Z",
			"2026-10-19T01:00:00.000Z",
		]);
	});
	it("rejects ambiguous selectors, bad times, short intervals and extended cron syntax", () => {
		for (const input of [
			{},
			{ at: "2026-10-18T00:00:00" },
			{ after_seconds: 0 },
			{ every_seconds: 59 },
			{ after_seconds: 1, every_seconds: 60 },
			{ daily: { time: "99:00", time_zone: "Asia/Shanghai" } },
			{ weekly: { time: "09:00", time_zone: "UTC", weekdays: [1, 1] } },
		]) {
			expect(() => createScheduleRule(input, now)).toThrow();
		}
		for (const expression of ["* * * * * *", "@daily", "0 0 L * *", "0 0 * JAN MON", "*/0 * * * *", "60 * * * *"]) {
			expect(() => createScheduleRule({ cron: { expression, time_zone: "UTC" } }, now)).toThrow();
		}
	});
	it("skips daylight-saving gaps and fires only at the earlier overlap", () => {
		const spring = Date.parse("2026-03-08T05:00:00Z");
		const daily = createScheduleRule({ daily: { time: "02:30", time_zone: "America/New_York" } }, spring);
		expect(scheduleOccurrence(daily, spring, 1)).toBe("2026-03-09T06:30:00.000Z");
		const fall = Date.parse("2026-11-01T04:00:00Z");
		const cron = createScheduleRule({ cron: { expression: "30 1 * * *", time_zone: "America/New_York" } }, fall);
		expect(scheduleOccurrence(cron, fall, 1)).toBe("2026-11-01T05:30:00.000Z");
		expect(scheduleOccurrence(cron, Date.parse("2026-11-01T05:31:00Z"), 1)).toBe("2026-11-02T06:30:00.000Z");
		expect(scheduleOccurrence(cron, Date.parse("2026-11-01T06:15:00Z"), -1)).toBe("2026-11-01T05:30:00.000Z");
	});
	it("preserves interval anchors and finds only the latest missed occurrence", () => {
		const rule = createScheduleRule({ every_seconds: 60 }, now);
		expect(scheduleOccurrence(rule, now + 10 * 60_000 + 15_000, -1)).toBe("2026-10-17T00:10:00.000Z");
		expect(scheduleOccurrence(rule, now + 10 * 60_000 + 15_000, 1)).toBe("2026-10-17T00:11:00.000Z");
	});
	it("uses Vixie day matching and handles leap-day searches", () => {
		const rule = createScheduleRule({ cron: { expression: "0 0 29 2 *", time_zone: "UTC" } }, now);
		expect(scheduleOccurrence(rule, now, 1)).toBe("2028-02-29T00:00:00.000Z");
		const either = createScheduleRule({ cron: { expression: "0 0 19 * 0", time_zone: "UTC" } }, now);
		expect(scheduleOccurrence(either, now, 1)).toBe("2026-10-18T00:00:00.000Z");
	});
});
