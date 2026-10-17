declare module "qrcode-terminal" {
	interface Options {
		small?: boolean;
	}
	const qrcodeTerminal: {
		generate(text: string, options?: Options, callback?: (qr: string) => void): void;
	};
	export default qrcodeTerminal;
}
