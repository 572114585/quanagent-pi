import type { AgentSession } from "../agent-session.ts";

export type ScheduleRule =
	| { kind: "after"; seconds: number; at: string }
	| { kind: "at"; at: string }
	| { kind: "every"; seconds: number; anchor: string }
	| { kind: "daily"; time: string; timeZone: string }
	| { kind: "weekly"; time: string; timeZone: string; weekdays: number[] }
	| { kind: "cron"; expression: string; timeZone: string };

export interface ScheduleTimingInput {
	after_seconds?: number;
	at?: string;
	every_seconds?: number;
	daily?: { time: string; time_zone: string };
	weekly?: { time: string; time_zone: string; weekdays: number[] };
	cron?: { expression: string; time_zone: string };
}

export type ScheduleDeliveryTarget = { channel: "local" } | { channel: "weixin"; bindingId: string; userId: string };

/** Captured by the host, never supplied by the model. */
export interface ScheduleBinding {
	ownerId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	agentDir: string;
	/** Host-captured callable tool names for cold execution. */
	toolNames?: string[];
	delivery: ScheduleDeliveryTarget;
}

export interface ScheduleTask {
	id: string;
	revision: number;
	title: string;
	prompt: string;
	rule: ScheduleRule;
	binding: ScheduleBinding;
	status: "active" | "paused" | "completed";
	nextAt: string | null;
	createdAt: string;
}

export interface ScheduleRun {
	id: string;
	taskId: string;
	title: string;
	prompt: string;
	binding: ScheduleBinding;
	occurrenceAt: string;
	timeZone?: string;
	manual: boolean;
	status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";
	startedAt?: string;
	finishedAt?: string;
	result?: string;
	error?: string;
	delivery: "pending" | "sent";
	execution?: ScheduleExecution;
}

export interface ScheduleTaskSummary extends ScheduleTask {
	latestRun?: Pick<ScheduleRun, "id" | "status" | "delivery" | "startedAt" | "finishedAt" | "error">;
}

export interface ScheduleExecution {
	sourceSessionId: string;
	sourceSessionFile: string;
	snapshotLeafId: string | null;
	sessionId: string;
	sessionFile: string;
	artifactDir: string;
}

export interface ScheduleCreatedNotification {
	kind: "task-created";
	id: string;
	taskId: string;
	title: string;
	binding: ScheduleBinding;
	createdAt: string;
	nextAt: string;
	timeZone: string;
	delivery: "pending" | "sent";
}

export type ScheduleNotification =
	| ScheduleCreatedNotification
	| {
			kind: "run-result";
			id: string;
			binding: ScheduleBinding;
			run: ScheduleRun;
	  };

export interface ScheduleState {
	version: 2;
	tasks: ScheduleTask[];
	runs: ScheduleRun[];
	creationNotices: ScheduleCreatedNotification[];
	weixinBinding?: { bindingId: string; userId: string };
}

export interface ScheduleSessionLease {
	session: AgentSession;
	execution: ScheduleExecution;
	release(): Promise<void> | void;
}

export interface ScheduleHostOptions {
	storageDir: string;
	createExecutionSession(run: ScheduleRun, signal: AbortSignal): Promise<ScheduleSessionLease>;
	/** Return after the result has been durably accepted by the output channel. */
	deliverResult?(run: ScheduleRun, resend?: boolean): Promise<"pending" | "sent">;
	deliverNotification?(notification: ScheduleNotification, resend?: boolean): Promise<"pending" | "sent">;
	onError?(error: Error): void;
	clock?: () => number;
	concurrency?: number;
	/** Optional per-owner cap, used by the Weixin bridge. */
	ownerConcurrency?: number;
	runTimeoutMs?: number;
}
