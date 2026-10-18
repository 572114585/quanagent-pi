/** Public state only; SDK credentials and pairing code values are never included. */
export type WeixinPhase =
	| "disconnected"
	| "starting"
	| "qr"
	| "scanned"
	| "expired"
	| "verify_code"
	| "connected"
	| "stopping"
	| "error";

export interface WeixinStatus {
	phase: WeixinPhase;
	attemptId?: string;
	qrContent?: string;
	challengeId?: string;
	codeRetry?: boolean;
	accountId?: string;
	error?: string;
}

export interface WeixinSnapshot extends WeixinStatus {
	enabled: boolean;
	configured: boolean;
	provider?: string;
	model?: string;
}

export type BridgeCommand =
	| { type: "stop" }
	| { type: "verify-code"; attemptId: string; challengeId: string; code: string };
