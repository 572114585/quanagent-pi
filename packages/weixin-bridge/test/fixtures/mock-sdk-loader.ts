import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@wechatbot/wechatbot" && context.parentURL !== new URL("./mock-sdk.ts", import.meta.url).href)
			return { url: new URL("./mock-sdk.ts", import.meta.url).href, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
