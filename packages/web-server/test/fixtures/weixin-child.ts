import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BridgeControl } from "../../../weixin-bridge/src/control.ts";
import type { BridgeCommand } from "../../../weixin-bridge/src/protocol.ts";

const control = new BridgeControl((status) => process.send?.({ type: "weixin-status", status }));
process.on("message", (value: unknown) => {
	if (!value || typeof value !== "object" || !("type" in value)) return;
	if (value.type === "stop") process.exit(0);
	if (value.type === "verify-code") {
		const command = value as BridgeCommand & { type: "verify-code" };
		process.send?.({
			type: "verify-result",
			attemptId: command.attemptId,
			challengeId: command.challengeId,
			accepted: control.submit(command),
		});
	}
	if (value.type !== "simulate" || !("action" in value)) return;
	if (value.action === "expired") {
		control.expired();
		control.qr("replacement-qr");
	}
	if (value.action === "scanned") control.scanned();
	if (value.action === "code" || value.action === "retry") {
		void control.requestCode(value.action === "retry").catch(() => {});
	}
	if (value.action === "confirmed") {
		void writeFile(
			join(process.env.PI_WEIXIN_BRIDGE_HOME!, "config.json"),
			JSON.stringify({
				owner: "scan-owner",
				allowlist: [],
				provider: process.env.PI_WEIXIN_SETUP_PROVIDER,
				model: process.env.PI_WEIXIN_SETUP_MODEL,
			}),
			{ flag: "wx" },
		)
			.catch(() => {})
			.then(() => {
				process.send?.({
					type: "weixin-status",
					status: { phase: "connected", accountId: "bot", token: "never-expose-token", code: "never-expose-code" },
				});
			});
	}
	if (value.action === "crash") process.exit(1);
});
process.once("disconnect", () => process.exit(0));
control.begin();
control.qr(process.env.PI_WEIXIN_FORCE_LOGIN === "1" ? "forced-qr" : "initial-qr");
