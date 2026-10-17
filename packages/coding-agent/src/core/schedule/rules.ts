/**
 * Wall-clock rules follow DeepSeek Harness Schedule's five-field Vixie dialect:
 * https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/schedule/schedule
 * This implementation uses Temporal explicitly; it never reads the process time zone.
 */
import { Temporal } from "@js-temporal/polyfill";
import type { ScheduleRule, ScheduleTimingInput } from "./types.ts";

export const DEFAULT_SCHEDULE_TIME_ZONE = "Asia/Shanghai";
const HORIZON_DAYS = 146_097;

function instant(value: string): number {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
		throw new Error("An absolute time must include seconds and an explicit UTC offset.");
	}
	const epoch = Temporal.Instant.from(value).epochMilliseconds;
	if (!Number.isSafeInteger(epoch)) throw new Error("Time is outside the supported range.");
	return epoch;
}

function zone(value: string): string {
	if (value !== "UTC" && !/^[A-Za-z][\w+.-]*(?:\/[\w+.-]+)+$/.test(value)) {
		throw new Error("An explicit IANA time zone is required.");
	}
	new Intl.DateTimeFormat("en", { timeZone: value });
	return value;
}

function clockTime(value: string): string {
	if (!/^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) throw new Error("Use HH:mm or HH:mm:ss.");
	return Temporal.PlainTime.from(value).toString({ smallestUnit: "millisecond" });
}

interface CronField {
	values: number[];
	star: boolean;
}

function cronFields(expression: string): CronField[] {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error("Cron requires five fields: minute hour day month weekday.");
	return fields.map((text, index) => {
		const min = index === 2 || index === 3 ? 1 : 0;
		const max = [59, 23, 31, 12, 7][index]!;
		const values = new Set<number>();
		for (const part of text.split(",")) {
			const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
			if (!match)
				throw new Error(`Invalid cron field ${index + 1}. Only numbers, *, lists, ranges and steps are supported.`);
			const base = match[1]!;
			const step = match[2] === undefined ? 1 : Number(match[2]);
			if (!Number.isSafeInteger(step) || step < 1) throw new Error("Cron steps must be positive integers.");
			if (match[2] !== undefined && base !== "*" && !base.includes("-"))
				throw new Error("A step requires * or a range.");
			const [start, end] = base === "*" ? [min, max] : base.split("-").map(Number);
			const last = end ?? start!;
			if (start! < min || last > max || start! > last) throw new Error(`Cron field ${index + 1} is out of range.`);
			for (let value = start!; value <= last; value += step) values.add(index === 4 && value === 7 ? 0 : value);
		}
		return { values: [...values].sort((a, b) => a - b), star: text.startsWith("*") };
	});
}

export function createScheduleRule(input: ScheduleTimingInput, now: number): ScheduleRule {
	if (
		[input.after_seconds, input.at, input.every_seconds, input.daily, input.weekly, input.cron].filter(
			(v) => v !== undefined,
		).length !== 1
	) {
		throw new Error("Supply exactly one timing selector.");
	}
	if (input.after_seconds !== undefined) {
		if (!Number.isSafeInteger(input.after_seconds) || input.after_seconds <= 0)
			throw new Error("Delay must be positive whole seconds.");
		return {
			kind: "after",
			seconds: input.after_seconds,
			at: new Date(now + input.after_seconds * 1000).toISOString(),
		};
	}
	if (input.at !== undefined) {
		const epoch = instant(input.at);
		if (epoch <= now) throw new Error("The absolute target must be in the future.");
		return { kind: "at", at: new Date(epoch).toISOString() };
	}
	if (input.every_seconds !== undefined) {
		if (!Number.isSafeInteger(input.every_seconds) || input.every_seconds < 60)
			throw new Error("The minimum fixed interval is 60 whole seconds.");
		return { kind: "every", seconds: input.every_seconds, anchor: new Date(now).toISOString() };
	}
	if (input.daily) return { kind: "daily", time: clockTime(input.daily.time), timeZone: zone(input.daily.time_zone) };
	if (input.weekly) {
		const weekdays = [...new Set(input.weekly.weekdays)].sort((a, b) => a - b);
		if (
			!weekdays.length ||
			weekdays.length !== input.weekly.weekdays.length ||
			weekdays.some((v) => !Number.isInteger(v) || v < 1 || v > 7)
		) {
			throw new Error("Weekly weekdays must be distinct ISO weekdays from 1 (Monday) through 7 (Sunday).");
		}
		return { kind: "weekly", time: clockTime(input.weekly.time), timeZone: zone(input.weekly.time_zone), weekdays };
	}
	if (!input.cron) throw new Error("Missing cron selector.");
	const expression = input.cron.expression.trim().replace(/\s+/g, " ");
	cronFields(expression);
	return { kind: "cron", expression, timeZone: zone(input.cron.time_zone) };
}

/** Direction -1 includes the boundary; direction 1 is strictly future. */
export function scheduleOccurrence(rule: ScheduleRule, boundary: number, direction: 1 | -1): string | null {
	if (rule.kind === "at" || rule.kind === "after") {
		const at = instant(rule.at);
		return (direction === 1 ? at > boundary : at <= boundary) ? rule.at : null;
	}
	if (rule.kind === "every") {
		const anchor = instant(rule.anchor);
		const interval = rule.seconds * 1000;
		const periods = Math.floor((boundary - anchor) / interval) + (direction === 1 ? 1 : 0);
		return periods < 1
			? direction === 1
				? new Date(anchor + interval).toISOString()
				: null
			: new Date(anchor + periods * interval).toISOString();
	}
	const localBoundary = Temporal.Instant.fromEpochMilliseconds(boundary).toZonedDateTimeISO(rule.timeZone);
	let date = localBoundary.toPlainDate();
	const fields = rule.kind === "cron" ? cronFields(rule.expression) : undefined;
	const times =
		rule.kind === "cron"
			? fields![1]!.values.flatMap((hour) =>
					fields![0]!.values.map((minute) => Temporal.PlainTime.from({ hour, minute })),
				)
			: [Temporal.PlainTime.from(rule.time)];
	if (direction === -1) times.reverse();
	for (let day = 0; day <= HORIZON_DAYS; day++, date = date.add({ days: direction })) {
		if (date.year < 1 || date.year > 9999) return null;
		if (rule.kind === "weekly" && !rule.weekdays.includes(date.dayOfWeek)) continue;
		if (fields) {
			if (!fields[3]!.values.includes(date.month)) continue;
			const monthDay = fields[2]!.values.includes(date.day);
			const weekDay = fields[4]!.values.includes(date.dayOfWeek % 7);
			if (!(fields[2]!.star || fields[4]!.star ? monthDay && weekDay : monthDay || weekDay)) continue;
		}
		for (const time of times) {
			const local = date.toPlainDateTime(time);
			const zoned = local.toZonedDateTime(rule.timeZone, { disambiguation: "earlier" });
			if (!zoned.toPlainDateTime().equals(local)) continue;
			const at = zoned.epochMilliseconds;
			if (direction === 1 ? at > boundary : at <= boundary) return new Date(at).toISOString();
		}
	}
	return null;
}

export function validateScheduleRule(rule: ScheduleRule): void {
	if (rule.kind === "at" || rule.kind === "after") {
		instant(rule.at);
		if (rule.kind === "after" && (!Number.isSafeInteger(rule.seconds) || rule.seconds <= 0))
			throw new Error("Invalid stored delay.");
	} else if (rule.kind === "every") {
		instant(rule.anchor);
		if (!Number.isSafeInteger(rule.seconds) || rule.seconds < 60) throw new Error("Invalid stored interval.");
	} else {
		zone(rule.timeZone);
		if (rule.kind === "cron") cronFields(rule.expression);
		else {
			clockTime(rule.time);
			if (
				rule.kind === "weekly" &&
				(!rule.weekdays.length ||
					new Set(rule.weekdays).size !== rule.weekdays.length ||
					rule.weekdays.some((v) => !Number.isInteger(v) || v < 1 || v > 7))
			)
				throw new Error("Invalid stored weekdays.");
		}
	}
}
